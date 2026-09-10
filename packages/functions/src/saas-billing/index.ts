/* eslint-disable no-console */
import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { getSecret } from '../utils/secrets'
import { withErrorReporting } from '../utils/reportError'
import { hasTeamRole } from '../utils/teams'
import { getHostingUrl } from '../utils/env'
import { downgradeTeamToFree } from './downgrade'
import { lapseOrganization } from '../orgs/lifecycle'
import { StripeAdapter } from '../utils/gateway/stripe'
import {
  getPlatformStripeAdapter,
  cancelSubscriptionFor,
  reactivateSubscriptionFor,
  billingPortalUrlFor,
  invoicesFor,
} from './actions'
import {
  readGatewayData,
  legacyGatewayDataFields,
  tenantExemptFromTrialSweep,
  trialSweepExemption,
} from '@linyup/shared'
import type { SaasPlan, TenantFlags } from '@linyup/shared'
import {
  PLUGIN_ADDONS,
  pluginIdForAddonLookupKey,
  TEAMS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  PLAN_PRICING,
} from '@linyup/shared'
import { sendEmail, buildEmailTemplate } from '../utils/email'

// Self-serve checkout is Coach & Studio only. Organisation is sales-led
// (base + per-studio, 2-studio minimum — see ORG_PER_STUDIO) and quoted on a
// call, so it's never created through the public createCheckoutSession path.
const VALID_PLANS: SaasPlan[] = ['coach', 'studio']

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * TEAM ownership, and only that — a read of `teams/{teamId}/team_members/{uid}`.
 *
 * Every callable in this file is therefore TEAM-ONLY. An organisation pays for
 * itself through the sibling rail in `../orgs/billing.ts`, guarded by
 * `assertOrgAdmin` against `organizations/{orgId}/org_members/{uid}`; the two
 * share their Stripe work via `./actions.ts` and nothing else. Passing an org id
 * here fails closed (an organisation has no `team_members`), which is the
 * behaviour that made UX-75 look like a permissions problem for a year.
 */
async function assertOwner(uid: string, teamId: string): Promise<void> {
  const isOwner = await hasTeamRole(uid, teamId, 'owner')
  if (!isOwner) throw new HttpsError('permission-denied', 'Owner access required')
}

/** Stripe lookup keys for a team's currently-active add-on plugins (carried
 * into checkout so trial add-ons keep working once the coach pays). */
async function activeAddonLookupKeys(teamId: string): Promise<string[]> {
  const snap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(INSTALLED_PLUGINS_SUBCOLLECTION)
    .where('status', '==', 'active')
    .get()
  const keys: string[] = []
  for (const d of snap.docs) {
    const addon = PLUGIN_ADDONS[d.id]
    if (addon) keys.push(addon.stripeLookupKey)
  }
  return keys
}

// ─────────────────────────────────────────────────────────────────────────────
// createCheckoutSession — redirects team owner to hosted payment page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A COMPED TENANT MUST NOT BE ABLE TO BUY A SUBSCRIPTION.
 *
 * The comp is a decision the platform made, recorded on the tenant. Nothing
 * removes the Subscribe / Upgrade buttons from that tenant's own billing page
 * (they are rendered from plan state, which for a comped tenant reads exactly
 * like an ordinary un-subscribed one), so without this the studio owner or org
 * admin can put a real card on a real recurring charge with one click — for a
 * tenant the platform has promised to bill nothing.
 *
 * Refusing at the callable rather than only hiding the button is the point:
 * the UI is a courtesy, this is the guarantee. The hidden button follows in the
 * web app, but a stale tab, a deep link or a direct call cannot get past here.
 */
async function assertNotComped(
  collection: string,
  entityId: string,
  label: string
): Promise<void> {
  const snap = await admin.firestore().collection(collection).doc(entityId).get()
  const flags = snap.data()?.flags as TenantFlags | undefined
  if (flags?.comped === true) {
    throw new HttpsError(
      'failed-precondition',
      `This ${label} is on a comped plan and is not billed. Contact Linyup to change that.`,
      { reason: 'tenant_comped' }
    )
  }
}

export const createCheckoutSession = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { teamId?: string; plan?: string; locale?: string }
  if (!data?.teamId || !data?.plan) {
    throw new HttpsError('invalid-argument', 'teamId and plan are required')
  }
  if (!VALID_PLANS.includes(data.plan as SaasPlan)) {
    throw new HttpsError('invalid-argument', `Invalid plan: ${data.plan}`)
  }

  const { teamId, plan, locale = 'en' } = data as { teamId: string; plan: SaasPlan; locale: string }

  await assertOwner(request.auth.uid, teamId)
  await assertNotComped(TEAMS_COLLECTION, teamId, 'team')

  // A STUDIO INSIDE AN ORGANISATION DOES NOT OWN ITS OWN BILLING (UX-35), and
  // this callable never asked. `acceptOrgInvitation` puts the studio on the
  // organisation's plan and the ORG's subscription is what pays for it, so a
  // second subscription bought here is a second charge for one seat — and on
  // payment the webhook's team branch overwrites `plan`/`plan_status` on the
  // team document, knocking the studio off the organisation tier it is
  // legitimately on. Both halves are silent.
  const teamSnap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).get()
  const teamOrgId = teamSnap.data()?.org_id as string | undefined
  if (teamOrgId) {
    throw new HttpsError(
      'failed-precondition',
      'This studio is billed by its organisation. Ask an organisation admin about the plan.',
      { reason: 'billed_by_org' }
    )
  }

  // Rate limit: max 3 checkout session requests per team per hour
  const oneHourAgo = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000)
  const recentAttempts = await admin
    .firestore()
    .collection('saas_checkout_attempts')
    .where('teamId', '==', teamId)
    .where('created_at', '>', oneHourAgo)
    .get()
  if (recentAttempts.size >= 3) {
    throw new HttpsError(
      'resource-exhausted',
      'Too many checkout requests. Please try again in an hour.'
    )
  }

  // Get owner email for pre-filling checkout
  const ownerDoc = await admin.firestore().collection('users').doc(request.auth.uid).get()
  const customerEmail: string = ownerDoc.exists ? (ownerDoc.data()!.email ?? '') : ''

  const adapter = await getPlatformStripeAdapter()

  const hostingUrl = getHostingUrl()
  const idempotencyKey = `checkout:${teamId}:${plan}:${Math.floor(Date.now() / 60000)}` // 1-minute window

  // Coach carries any active (trial) add-ons into the paid subscription; Studio/Org
  // include all plugins, so no add-on line items are needed for them.
  const addonLookupKeys = plan === 'coach' ? await activeAddonLookupKeys(teamId) : []

  let session: { url: string; sessionId: string }
  try {
    session = await adapter.createCheckoutSession({
      teamId,
      plan,
      customerEmail,
      successUrl: `${hostingUrl}/${locale}/billing?checkout=success`,
      cancelUrl: `${hostingUrl}/${locale}/billing?checkout=cancelled`,
      idempotencyKey,
      addonLookupKeys,
    })
  } catch (err) {
    console.error('Checkout session creation failed:', err)
    throw new HttpsError('internal', 'Failed to create checkout session')
  }

  // Log attempt for rate limiting (non-blocking)
  admin
    .firestore()
    .collection('saas_checkout_attempts')
    .add({
      teamId,
      plan,
      sessionId: session.sessionId,
      created_at: FieldValue.serverTimestamp(),
    })
    .catch((err) => console.error('Failed to log checkout attempt:', err))

  return { url: session.url }
})

// ─────────────────────────────────────────────────────────────────────────────
// handleStripeWebhook — onRequest: validates signature, syncs saas_subscriptions
// ─────────────────────────────────────────────────────────────────────────────

export const handleStripeWebhook = onRequest(
  { invoker: 'public' },
  withErrorReporting('handleStripeWebhook', async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed')
      return
    }

    const signature = req.headers['stripe-signature']
    if (!signature || typeof signature !== 'string') {
      console.error('Missing stripe-signature header')
      res.status(400).send('Missing stripe-signature header')
      return
    }

    let webhookSecret: string
    try {
      webhookSecret = await getSecret('stripe-webhook-secret')
    } catch (err) {
      console.error('Failed to load stripe-webhook-secret:', err)
      res.status(500).send('Internal error')
      return
    }

    // Verification-only adapter: parseWebhook is pure crypto (HMAC of the raw
    // body against the signing secret) — no API key needed, so don't fetch
    // 'stripe-secret-key' here. The old getPlatformStripeAdapter() call sat
    // OUTSIDE any try/catch, so a missing key 500'd every platform event with
    // no useful log. Same pattern as handleTeamStripeWebhook.
    const adapter = StripeAdapter.withSecretKey(
      { type: 'stripe', publishable_key: '', currency: 'chf' },
      'sk_webhook_verification_only'
    )

    let event: Awaited<ReturnType<typeof adapter.parseWebhook>>
    try {
      event = await adapter.parseWebhook({
        payload: req.rawBody ?? req.body,
        signature,
        secret: webhookSecret,
      })
    } catch (err) {
      console.error('Webhook signature verification failed:', err)
      res.status(400).send('Invalid webhook signature')
      return
    }

    // Either teamId or orgId must be present in the event metadata to route the update
    const entityId = event.teamId ?? event.orgId
    const entityType = event.orgId ? 'org' : 'team'
    if (!entityId) {
      console.log(`Webhook event ${event.eventId} has no teamId or orgId — skipping`)
      res.status(200).send('ok')
      return
    }

    const subRef = admin.firestore().collection('saas_subscriptions').doc(entityId)

    try {
      // Idempotency check — through readGatewayData, because a doc written before
      // the dotted-key fix keeps `last_event_id` as a literal field. Reading only
      // the nested map returned undefined for every such doc, so this check never
      // matched and a Stripe retry was processed a second time.
      const existing = await subRef.get()
      if (existing.exists) {
        const lastEventId = readGatewayData(existing.data()).last_event_id
        if (lastEventId === event.eventId) {
          console.log(`Webhook event ${event.eventId} already processed — skipping`)
          res.status(200).send('ok')
          return
        }
      }

      const now = FieldValue.serverTimestamp()

      // Add-on subscription items present on this subscription (Coach plugins).
      const addonActive = (event.items ?? [])
        .map((it) => ({
          itemId: it.itemId,
          pluginId: it.lookupKey ? pluginIdForAddonLookupKey(it.lookupKey) : undefined,
        }))
        .filter((x): x is { itemId: string; pluginId: string } => !!x.pluginId)

      // Map event to saas_subscriptions fields.
      //
      // `gateway_data` is built as a NESTED object and never as dotted keys: this
      // handler persists with `set(…, { merge: true })`, and `set()` takes a
      // dotted key literally — only `update()` reads it as a field path. Written
      // the old way, every one of these became a top-level field *named*
      // "gateway_data.subscription_id" and the map the readers want was never
      // created. `set` with merge still deep-merges a nested map, so writing only
      // the keys this event carries leaves the rest of gateway_data standing.
      const gatewayData: Record<string, unknown> = { last_event_id: event.eventId }
      const update: Record<string, unknown> = {
        entity_type: entityType,
        entity_id: entityId,
        teamId: entityId, // kept for backwards compatibility
        updated_at: now,
        gateway_type: 'stripe',
      }

      switch (event.type) {
        case 'subscription.created':
          update.status = 'active'
          gatewayData.subscription_id = event.subscriptionId
          gatewayData.customer_id = event.customerId
          if (event.plan) update.plan = event.plan
          if (event.currentPeriodStart)
            update.current_period_start = Timestamp.fromDate(event.currentPeriodStart)
          if (event.currentPeriodEnd)
            update.current_period_end = Timestamp.fromDate(event.currentPeriodEnd)
          update.cancel_at_period_end = false
          update.cancel_at = null
          update.canceled_at = null
          update.cancellation_details = null
          update.trial_ends_at = null
          gatewayData.activeAddOns = addonActive
          if (!existing.exists) {
            update.created_at = now
          }
          break

        case 'subscription.updated':
          if (event.plan) update.plan = event.plan
          if (event.currentPeriodStart)
            update.current_period_start = Timestamp.fromDate(event.currentPeriodStart)
          if (event.currentPeriodEnd)
            update.current_period_end = Timestamp.fromDate(event.currentPeriodEnd)
          if (event.cancelAtPeriodEnd !== undefined) {
            update.cancel_at_period_end = event.cancelAtPeriodEnd
            // The WHOLE record, written on every subscription.updated with nulls
            // included: a reactivation is exactly the event that must ERASE a
            // previous end date and reason, and an omitted key on a merge would
            // leave them standing. `cancellation_details` is set whole or nulled —
            // Firestore deep-merges a nested map, so a partial write would keep
            // the old cancellation's feedback behind the new reason.
            update.cancel_at = event.cancelAt ? Timestamp.fromDate(event.cancelAt) : null
            update.canceled_at = event.canceledAt ? Timestamp.fromDate(event.canceledAt) : null
            update.cancellation_details = event.cancellationDetails ?? null
          }
          if (event.subscriptionId) gatewayData.subscription_id = event.subscriptionId
          if (event.customerId) gatewayData.customer_id = event.customerId
          gatewayData.activeAddOns = addonActive
          break

        case 'subscription.cancelled':
          update.status = 'cancelled'
          // It has ENDED — there is no longer a future end to announce.
          update.cancel_at_period_end = false
          update.cancel_at = null
          // …but WHEN and WHY it was cancelled are KEPT, and this is the event that
          // carries them most reliably. Only overwritten when the payload actually
          // says something: a `deleted` event with no cancellation_details must not
          // erase the reason an earlier `updated` already recorded.
          if (event.canceledAt) update.canceled_at = Timestamp.fromDate(event.canceledAt)
          if (event.cancellationDetails) update.cancellation_details = event.cancellationDetails
          break

        case 'payment.succeeded':
          update.status = 'active'
          gatewayData.last_invoice_id = event.lastInvoiceId
          gatewayData.last_payment_status = 'succeeded'
          break

        case 'payment.failed':
          update.status = 'past_due'
          gatewayData.last_invoice_id = event.lastInvoiceId
          gatewayData.last_payment_status = 'failed'
          break
      }

      // Heal a doc still carrying the legacy dotted-literal fields: copy anything
      // this event is NOT itself writing into the nested map, then delete the
      // literal. The carry-over is not belt-and-braces — a `payment.succeeded`
      // event knows no subscription id, so deleting that literal without copying
      // it first would destroy the only copy on the document. Doing it here means
      // a doc converges on its next event whether or not the backfill has run.
      for (const field of legacyGatewayDataFields(existing.data())) {
        const key = field.slice('gateway_data.'.length)
        if (!(key in gatewayData)) gatewayData[key] = existing.data()![field]
        update[field] = FieldValue.delete()
      }
      update.gateway_data = gatewayData

      await subRef.set(update, { merge: true })

      // Sync plan + status to the owning entity so usePlan() / useOrg() stays accurate
      const entityUpdate: Record<string, unknown> = { updated_at: now }
      if (update.plan) entityUpdate.plan = update.plan
      if (update.status) entityUpdate.plan_status = update.status
      // Reactivation: paying clears any legacy wall-era suspension markers.
      if (update.status === 'active') {
        entityUpdate.suspended_at = FieldValue.delete()
        entityUpdate.purge_at = FieldValue.delete()
      }

      // A cancelled subscription lands the payer on what it now pays for, and the
      // TWO TIERS FOLLOW THE SAME RULE (UX-10) — a team lands on Free; an
      // organisation winds down through `lapseOrganization`, which puts each of
      // its studios on Free through this very same `downgradeTeamToFree`.
      //
      // `past_due` deliberately does NOT tear anything down, on either tier. It is
      // Stripe's dunning window — a card that failed on the first retry and
      // recovers two days later — and the teardown is partly ONE-WAY (course
      // public_profile mirrors are deleted and nothing rewrites them on
      // re-activation, UX-16). A team on past_due keeps its plan and its installs
      // and is refused server-side by `requirePlan` ('plan_inactive'); an org now
      // does exactly the same, propagating the status to its studios and nothing
      // more. If that answer is wrong it is wrong for both tiers — change it in
      // one place, not here alone.
      //
      // A COMPED TENANT IS EXEMPT FROM THE TEARDOWN ON BOTH TIERS. The org side
      // already refuses inside `lapseOrganization`; the team side did not, and
      // the asymmetry bites at exactly the wrong moment. Comping an existing
      // customer means cancelling the subscription it currently pays — which
      // fires this event — so without the check the act of comping a studio is
      // also the act of stripping it to Free: plugins off, site down, course
      // mirrors deleted one-way. The flag is the record that nothing upstream
      // can legitimately conclude this tenant stopped paying.
      // A STUDIO INSIDE AN ORGANISATION DOES NOT OWN ITS OWN BILLING (UX-35), AND
      // ITS OWN SUBSCRIPTION'S EVENTS MUST NOT SPEAK FOR IT.
      //
      // `acceptOrgInvitation` now refuses a studio that still has a live
      // subscription, and `createCheckoutSession` refuses a studio that is
      // already in an org — so the two should never coexist. This is the guard
      // for the gap between them: an event that arrives LATE for a subscription
      // that ended before the studio joined, or any state those two checks did
      // not foresee. Both halves matter and the second is destructive:
      //
      //   plan/plan_status — `subscription.updated` carries the OLD tier, so
      //   writing it knocks the studio off `plan: 'organization'` while `org_id`
      //   still says it belongs, breaking UX-35's invariant silently and moving
      //   the Connect take rate against the studio's own payouts.
      //
      //   the teardown — `downgradeTeamToFree` on a paid-up member of a
      //   federation deactivates its plugins, unpublishes its website and
      //   deletes its course mirrors ONE-WAY, and leaves `org_id` standing
      //   beside `plan: 'free'` (the state `orgs/lifecycle.ts` goes out of its
      //   way to avoid).
      //
      // The organisation's own subscription still governs the studio — that
      // event arrives on the `org` branch below and propagates from there.
      const teamDoc =
        entityType === 'team'
          ? await admin.firestore().collection(TEAMS_COLLECTION).doc(entityId).get()
          : null
      const teamBilledByOrg = !!teamDoc?.data()?.org_id
      if (teamBilledByOrg) {
        console.log(
          `[billing] ignored ${event.type} for team ${entityId}: billed by org ` +
            `${teamDoc?.data()?.org_id as string} — its own subscription does not govern it`
        )
      } else if (entityType === 'team' && update.status === 'cancelled') {
        const teamFlags = teamDoc?.data()?.flags as TenantFlags | undefined
        if (tenantExemptFromTrialSweep(teamFlags)) {
          console.log(
            `[billing] kept ${trialSweepExemption(teamFlags)} team ${entityId} on its plan after cancellation`
          )
        } else {
          await downgradeTeamToFree(entityId, { fromTrial: false, courseMirrors: 'tear_down' })
        }
      } else if (entityType === 'org') {
        await admin.firestore().collection('organizations').doc(entityId).update(entityUpdate)
        if (update.status === 'cancelled') {
          await lapseOrganization(entityId, { reason: 'subscription_cancelled' })
        } else if (update.status === 'past_due') {
          // Propagate the status to linked studios so their own gates refuse.
          const orgTeamsSnap = await admin
            .firestore()
            .collection('organizations')
            .doc(entityId)
            .collection('org_teams')
            .where('status', '==', 'active')
            .get()
          const batch = admin.firestore().batch()
          for (const doc of orgTeamsSnap.docs) {
            batch.update(admin.firestore().collection('teams').doc(doc.id), {
              plan_status: update.status,
              updated_at: now,
            })
          }
          await batch.commit()
        }
      } else {
        await admin.firestore().collection('teams').doc(entityId).update(entityUpdate)
      }

      // Reconcile plugin add-on installs against the subscription's items.
      // Handles trial→paid conversion (carried add-ons become paid items) and
      // external removals. Only touches paid add-on installs (config.addonItemId).
      //
      // SKIPPED for a studio billed by its organisation, for the same reason the
      // plan write above is: this DELETES installs whose add-on item is absent
      // from the subscription, and an ex-subscription's event carries none — so
      // a late event would strip paid plugins off a studio whose organisation is
      // what grants them ("org_id IS the grant", `useInstalledPlugins`).
      if (
        entityType === 'team' &&
        !teamBilledByOrg &&
        (event.type === 'subscription.created' || event.type === 'subscription.updated')
      ) {
        const installsCol = admin
          .firestore()
          .collection(TEAMS_COLLECTION)
          .doc(entityId)
          .collection(INSTALLED_PLUGINS_SUBCOLLECTION)
        const activeIds = new Set(addonActive.map((a) => a.pluginId))
        for (const a of addonActive) {
          await installsCol.doc(a.pluginId).set(
            {
              pluginId: a.pluginId,
              teamId: entityId,
              status: 'active',
              config: { addonItemId: a.itemId },
              updated_at: now,
            },
            { merge: true }
          )
        }
        const installsSnap = await installsCol.get()
        for (const d of installsSnap.docs) {
          const cfg = (d.data().config ?? {}) as { addonItemId?: string }
          if (cfg.addonItemId && !activeIds.has(d.id)) {
            await installsCol.doc(d.id).delete()
          }
        }
      }

      console.log(
        `Processed webhook ${event.type} (${event.eventId}) for ${entityType} ${entityId}`
      )
    } catch (err) {
      // Log but always return 200 so Stripe doesn't retry forever
      console.error(`Failed to process webhook event ${event.eventId}:`, err)
    }

    res.status(200).send('ok')
  })
)

// ─────────────────────────────────────────────────────────────────────────────
// The four TEAM billing callables. Each is one line of authorization plus the
// shared action from ./actions.ts; the organisation's four are in
// ../orgs/billing.ts and differ only in their guard. `teamId` on the wire is
// now TRUE of all four — an org id never reaches here (UX-75).
// ─────────────────────────────────────────────────────────────────────────────

// cancelSaasSubscription — marks subscription to cancel at period end
export const cancelSaasSubscription = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { teamId?: string }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  await assertOwner(request.auth.uid, data.teamId)
  await cancelSubscriptionFor(data.teamId)

  return { success: true }
})

// reactivateSaasSubscription — removes cancel_at_period_end flag
export const reactivateSaasSubscription = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { teamId?: string }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  await assertOwner(request.auth.uid, data.teamId)
  await reactivateSubscriptionFor(data.teamId)

  return { success: true }
})

// getBillingPortalUrl — Stripe billing portal session (payment method, receipts)
export const getBillingPortalUrl = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { teamId?: string; returnUrl?: string }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  await assertOwner(request.auth.uid, data.teamId)

  const returnUrl = data.returnUrl ?? `${getHostingUrl()}/billing`
  return { url: await billingPortalUrlFor(data.teamId, returnUrl) }
})

// getSaasInvoices — fetches invoice list live from Stripe (not stored in Firestore)
export const getSaasInvoices = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { teamId?: string; limit?: number }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  await assertOwner(request.auth.uid, data.teamId)
  return invoicesFor(data.teamId, data.limit ?? 10)
})

// ─────────────────────────────────────────────────────────────────────────────
// activatePluginAddon — Coach activates a paid add-on plugin
//   • paid coach → adds a Stripe subscription item + writes the install
//   • trialing / no subscription → writes the install free (exploration)
// Studio/Org include all plugins and install client-side, not via this function.
// ─────────────────────────────────────────────────────────────────────────────

export const activatePluginAddon = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { teamId?: string; pluginId?: string }
  if (!data?.teamId || !data?.pluginId) {
    throw new HttpsError('invalid-argument', 'teamId and pluginId are required')
  }
  const { teamId, pluginId } = data

  const addon = PLUGIN_ADDONS[pluginId]
  if (!addon) throw new HttpsError('invalid-argument', `${pluginId} is not an add-on plugin`)

  await assertOwner(request.auth.uid, teamId)

  const teamSnap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).get()
  const plan = teamSnap.data()?.plan as SaasPlan | undefined
  if (plan !== 'coach') {
    throw new HttpsError(
      'failed-precondition',
      'Add-ons apply to the Coach plan; Studio/Org include all plugins'
    )
  }

  const installRef = admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(INSTALLED_PLUGINS_SUBCOLLECTION)
    .doc(pluginId)

  const subSnap = await admin.firestore().collection('saas_subscriptions').doc(teamId).get()
  const sub = subSnap.exists ? subSnap.data()! : null
  const subscriptionId = readGatewayData(sub).subscription_id
  const status = sub?.status as string | undefined
  const isPaid = !!subscriptionId && (status === 'active' || status === 'past_due')

  if (isPaid) {
    const adapter = await getPlatformStripeAdapter()
    let itemId: string
    try {
      const res = await adapter.addSubscriptionItem({
        subscriptionId: subscriptionId!,
        lookupKey: addon.stripeLookupKey,
      })
      itemId = res.itemId
    } catch (err) {
      console.error('addSubscriptionItem failed:', err)
      throw new HttpsError('internal', 'Failed to add the add-on to your subscription')
    }
    const current = (readGatewayData(sub).activeAddOns ?? []).filter((a) => a.pluginId !== pluginId)
    await admin
      .firestore()
      .collection('saas_subscriptions')
      .doc(teamId)
      .set(
        {
          gateway_data: { activeAddOns: [...current, { pluginId, itemId }] },
          updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    await installRef.set(
      {
        pluginId,
        teamId,
        installedAt: FieldValue.serverTimestamp(),
        installedBy: request.auth.uid,
        status: 'active',
        config: { addonItemId: itemId },
      },
      { merge: true }
    )
    return { success: true, billed: true }
  }

  // Trial / no subscription → free during the trial.
  await installRef.set(
    {
      pluginId,
      teamId,
      installedAt: FieldValue.serverTimestamp(),
      installedBy: request.auth.uid,
      status: 'active',
      config: { addonFreeTrial: true },
    },
    { merge: true }
  )
  return { success: true, billed: false }
})

// ─────────────────────────────────────────────────────────────────────────────
// deactivatePluginAddon — removes the add-on (and its Stripe item if billed)
// ─────────────────────────────────────────────────────────────────────────────

export const deactivatePluginAddon = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { teamId?: string; pluginId?: string }
  if (!data?.teamId || !data?.pluginId) {
    throw new HttpsError('invalid-argument', 'teamId and pluginId are required')
  }
  const { teamId, pluginId } = data

  await assertOwner(request.auth.uid, teamId)

  const installRef = admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(INSTALLED_PLUGINS_SUBCOLLECTION)
    .doc(pluginId)
  const installSnap = await installRef.get()
  if (!installSnap.exists) return { success: true }

  const itemId = (installSnap.data()?.config as { addonItemId?: string } | undefined)?.addonItemId

  if (itemId) {
    const adapter = await getPlatformStripeAdapter()
    try {
      await adapter.removeSubscriptionItem({ itemId })
    } catch (err) {
      console.error('removeSubscriptionItem failed:', err)
      throw new HttpsError('internal', 'Failed to remove the add-on from your subscription')
    }
    const subSnap = await admin.firestore().collection('saas_subscriptions').doc(teamId).get()
    const current = (
      (readGatewayData(subSnap.data()).activeAddOns ?? []) as Array<{
        pluginId: string
        itemId: string
      }>
    ).filter((a) => a.pluginId !== pluginId)
    await admin
      .firestore()
      .collection('saas_subscriptions')
      .doc(teamId)
      .set(
        { gateway_data: { activeAddOns: current }, updated_at: FieldValue.serverTimestamp() },
        { merge: true }
      )
  }

  await installRef.delete()
  return { success: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// (The one-time self-service trial extension was retired in the 2026-06 pricing
//  overhaul — the trial is now a flat 30 days with no opt-in extension.)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Trial lifecycle: lapsed trials (and cancelled paid subscriptions) land on
// the Free plan — data kept, app fully usable within Free's limits. Daily
// scheduled job. The old wall + 90-day purge are retired.
// ─────────────────────────────────────────────────────────────────────────────

// `downgradeTeamToFree` — THE one writer — now lives in ./downgrade.ts, imported
// above. It moved out of this file so `orgs/lifecycle.ts` can call the SAME
// function for every studio a lapsed organisation was paying for, without
// importing a module whose top level registers every billing function. There is
// one downgrade path for both tiers; do not write a second one.

// `purgeTeam` — THE one implementation — now lives in ./purgeTeam.ts, re-exported
// below. It moved out of this file for the same reason `downgradeTeamToFree` did:
// `scripts/purge-team.ts` needs to call it, and importing a module whose top level
// registers every billing function drags the Cloud Functions runtime into a CLI.
// Re-exported here so anything already importing it from `./saas-billing` still
// resolves. There is one tenant-erase path; do not write a second one.
export { purgeTeam } from './purgeTeam'

/** Notify the owner that the trial ended and the team is now on the Free plan. */
async function sendTrialExpiredEmail(
  teamId: string,
  team: FirebaseFirestore.DocumentData
): Promise<void> {
  const db = admin.firestore()
  let ownerEmail: string | undefined

  const ownerUid = team.primaryContact as string | undefined
  if (ownerUid) ownerEmail = (await db.collection('users').doc(ownerUid).get()).data()?.email
  if (!ownerEmail) {
    const m = await db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection('team_members')
      .where('role', '==', 'owner')
      .limit(1)
      .get()
    if (!m.empty) {
      const uid = m.docs[0].data().userId as string
      ownerEmail = (await db.collection('users').doc(uid).get()).data()?.email
    }
  }
  if (!ownerEmail) return

  const billingUrl = `${getHostingUrl()}/billing`
  const { html, text } = buildEmailTemplate({
    title: 'Your Linyup trial has ended',
    body:
      `Your free trial of <strong>${team.name ?? 'Linyup'}</strong> has ended, and your ` +
      `account is now on the <strong>Free plan</strong> — up to ` +
      `${PLAN_PRICING.free.includedContacts} active contacts, single user. ` +
      `All your data is kept and everything keeps working within those limits. ` +
      `Upgrade any time to lift them.<br><br><a href="${billingUrl}">See plans &amp; upgrade</a>`,
  })
  await sendEmail({ to: ownerEmail, subject: 'Your Linyup trial has ended', html, text })
}

export const handleTrialLifecycle = onSchedule(
  { schedule: 'every day 01:00', timeZone: 'Europe/Zurich', timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const db = admin.firestore()
    const nowTs = Timestamp.fromMillis(Date.now())

    // Phase 1 — lapsed trials land on the Free plan (data kept, no wall).
    const expiring = await db
      .collection(TEAMS_COLLECTION)
      .where('plan_status', '==', 'trial')
      .where('trial_ends_at', '<=', nowTs)
      .limit(200)
      .get()
    for (const doc of expiring.docs) {
      const teamId = doc.id
      // Exempt teams never auto-downgrade — an internal smoke-test studio, a
      // founder mid-validation, or a customer the platform bills nothing must not
      // lapse to Free (see docs/launch/). The predicate is shared with the org
      // phase below so the two tiers cannot answer this differently.
      const flags = doc.data().flags as TenantFlags | undefined
      if (tenantExemptFromTrialSweep(flags)) {
        console.log(`[trial] skipped ${trialSweepExemption(flags)} team ${teamId}`)
        continue
      }
      // A TEAM INSIDE AN ORGANISATION DOES NOT OWN ITS OWN BILLING (UX-35).
      // `acceptOrgInvitation` sets org_id together with plan 'organization' and
      // copies the ORG's plan_status onto the team — so a member studio of an
      // org that is itself on trial matches this query, on the strength of a
      // `trial_ends_at` left over from its own signup months earlier, and used
      // to be reset to Free: plugins deactivated, website unpublished, course
      // mirrors deleted. Meanwhile `useInstalledPlugins` keeps merging the ORG's
      // plugin installs in (org_id is still set), which is exactly the
      // "affiliated studio holding features its plan does not include" state
      // UX-35 reports — reached from the opposite direction.
      //
      // The org's own subscription is the one that governs these teams, and the
      // webhook already propagates a lapse to every active org_team. Nothing
      // here may downgrade one.
      if (doc.data().org_id) {
        console.log(
          `[trial] skipped org-affiliated team ${teamId} (org ${doc.data().org_id} bills it)`
        )
        continue
      }
      try {
        await downgradeTeamToFree(teamId, { fromTrial: true, courseMirrors: 'tear_down' })
        await sendTrialExpiredEmail(teamId, doc.data()).catch((e) =>
          console.error(`[trial] email failed ${teamId}:`, e)
        )
        console.log(`[trial] downgraded lapsed trial ${teamId} to free`)
      } catch (err) {
        console.error(`[trial] downgrade failed ${teamId}:`, err)
      }
    }

    // Phase 2 — lapsed ORGANISATION trials (UX-9).
    //
    // This sweep reads `organizations`, and it has to: phase 1 above cannot see
    // an org's trial, and it is forbidden from touching an org's studios (UX-35),
    // so before this block existed NOTHING ended an org trial. An unpaid
    // organisation — and every studio it billed — sat on the top tier forever.
    //
    // Same shape as phase 1, same exemptions, and the deadline is READ from the
    // document rather than derived from `created`: extending a hand-onboarded
    // customer's trial is editing `trial_ends_at`, and `tenantExemptFromTrialSweep`
    // (internal / pilot / comped) opts an org out of the sweep altogether.
    const expiringOrgs = await db
      .collection(ORGANIZATIONS_COLLECTION)
      .where('plan_status', '==', 'trial')
      .where('trial_ends_at', '<=', nowTs)
      .limit(200)
      .get()
    for (const doc of expiringOrgs.docs) {
      const orgId = doc.id
      const flags = doc.data().flags as TenantFlags | undefined
      if (tenantExemptFromTrialSweep(flags)) {
        console.log(`[trial] skipped ${trialSweepExemption(flags)} org ${orgId}`)
        continue
      }
      try {
        // The ONE org wind-down: org installs off, org site unpublished, every
        // member studio moved to Free through `downgradeTeamToFree` and unlinked.
        // Idempotent and resumable — see orgs/lifecycle.ts.
        await lapseOrganization(orgId, { reason: 'trial_lapsed' })
        console.log(`[trial] lapsed org trial ${orgId}`)
      } catch (err) {
        console.error(`[trial] org lapse failed ${orgId}:`, err)
      }
    }

    // Transitional sweep (wall era → free era): convert teams stranded on the
    // legacy 'expired' status to the Free plan. Remove this block once no
    // 'expired' teams remain in any environment.
    const legacy = await db
      .collection(TEAMS_COLLECTION)
      .where('plan_status', '==', 'expired')
      .limit(200)
      .get()
    for (const doc of legacy.docs) {
      // THE SAME TWO SKIPS AS PHASE 1 ABOVE. This block queries a different
      // status and was written without them, so an exempt or org-affiliated
      // team that reached 'expired' by any route — legacy data, a hand-edit, a
      // half-run repair — was torn down anyway: plugins deactivated, site
      // unpublished, course mirrors deleted, none of it reversible by
      // re-installing. A tenant the platform bills nothing is exactly the one
      // that must never be swept, and 'expired' is a state it can be left in by
      // a cancellation that arrives before the comp does.
      const expiredFlags = doc.data().flags as TenantFlags | undefined
      if (tenantExemptFromTrialSweep(expiredFlags)) {
        console.log(`[trial] skipped ${trialSweepExemption(expiredFlags)} expired team ${doc.id}`)
        continue
      }
      if (doc.data().org_id) {
        console.log(`[trial] skipped org-affiliated expired team ${doc.id}`)
        continue
      }
      try {
        await downgradeTeamToFree(doc.id, { fromTrial: true, courseMirrors: 'tear_down' })
        console.log(`[trial] converted legacy expired team ${doc.id} to free`)
      } catch (err) {
        console.error(`[trial] legacy conversion failed ${doc.id}:`, err)
      }
    }
  }
)
