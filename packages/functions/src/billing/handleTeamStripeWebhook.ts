/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
// handleTeamStripeWebhook — BYO Stripe gateway: a studio charging its students on
// the studio's OWN Stripe account (no platform fee; money never touches Linyup).
//
// This is the BYO sibling of handlePayrexxWebhook, and is DISTINCT from:
//   • handleStripeWebhook  — Linyup's own SaaS billing (saas-billing/)
//   • handleConnectWebhook — Stripe Connect (member → studio + platform fee)
//
// BYO is deliberately MINIMAL: we only RECORD the payment as an ExternalPayment
// and (when uniquely matched) link it to a contact. Linyup holds NO Stripe
// credentials and makes NO Stripe API calls — the webhook signing secret (stored
// per-team in Firestore, owners only) is all that's needed to verify the signature.
//
// URL: POST /handleTeamStripeWebhook?teamId={teamId}
// Signature: Stripe-Signature header, verified with the team's webhook_signing_secret.
// Idempotency: payment_events/stripe:{paymentRef} written create-or-skip, so a
//   webhook redelivery — or a manager's later reassignment — is never clobbered.
//
// WHICH EVENTS A STUDIO SHOULD SUBSCRIBE TO, and why it matters:
//
//   ✓ payment_intent.succeeded  — one row per payment
//   ✓ charge.succeeded          — never a row of its own; it only fills in the
//                                 payer's email on a row another event wrote (it
//                                 is the last object still carrying that email)
//   ✓ checkout.session.completed
//   ✗ invoice.payment_succeeded — subscribe to this AS WELL as the two above and
//                                 recurring payments are recorded TWICE
//
// The last line is not a preference. Stripe removed `invoice.payment_intent` (its
// replacement is expand-only) and `payment_intent.invoice` in the same change, so
// neither an invoice event nor a payment event can name the other — and BYO holds
// no credentials with which to bridge them. Rows written on a key that is not the
// payment carry `gateway_ref_kind: 'fallback'` so the divergence shows up in the
// data rather than only in the totals.
//
// WHAT HAPPENS WHEN A STUDIO SUBSCRIBES TO BOTH ANYWAY (decided 2026-08-18):
// the endpoint is TOLD, and nothing is repaired. `raw_status` on each recorded
// row is the literal event type that wrote it, so the set of families this
// endpoint actually delivers is readable from the rows themselves —
// `detectByoStripeDoubleRecording` (@linyup/shared) counts them and Settings →
// Payments warns the owner, who is the only person who can change the
// subscription. Deduping across keys was refused, not deferred: matching two
// rows by amount and time is a guess, and a wrong guess deletes a real second
// payment. Do not add a merge here.

import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import Stripe from 'stripe'
import { to } from '../utils/async'
import { resolveSingleContact } from '../utils/contacts'
import {
  TEAMS_COLLECTION,
  CONTACTS_COLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  PAYMENT_EVENTS_SUBCOLLECTION,
  buildExternalPaymentTxn,
  financeTxnId,
} from '@linyup/shared'
import type { StripeGatewayConfig } from '@linyup/shared'
import { linkFinanceTxnContact, recordFinanceTransaction } from '../finance/journal'
import {
  readChargeBillingEmail,
  readInvoicePaymentIntentId,
  readPaymentIntentEmail,
  reportStripeShape,
} from '../utils/stripe/objectShape'
import { withLedgerExpiry } from '../utils/ledgerRetention'

// Stripe SDK instance used ONLY for webhook signature verification. Verification
// is pure crypto (HMAC of the raw body against the signing secret) — no API key is
// needed for constructEventAsync, so a placeholder satisfies the constructor and
// we never call the Stripe API from the BYO rail.
const stripe = new Stripe('sk_byo_webhook_verification_only')

interface ExtractedPayment {
  /** Stable per-payment reference (PaymentIntent / invoice / session id). */
  ref: string
  /**
   * What `ref` actually points at. `'payment'` is the intended key — every event
   * about one payment converges on it. `'fallback'` means the event did not name
   * its PaymentIntent and we keyed on the event's own object instead, so a second
   * event about the SAME money will not dedupe against this row. Stamped onto the
   * doc so that divergence is visible in the data rather than only in the totals.
   */
  refKind: 'payment' | 'fallback'
  /**
   * Whether this event is allowed to CREATE the payment row.
   *
   * `'record'` — it is the payment, and writes the row create-or-skip.
   * `'enrich'` — it describes a payment some OTHER event records, and may only
   *   fill blanks on a row that already exists. It must never create one, because
   *   it cannot prove no sibling row for the same money exists under a different
   *   key. See the `charge.succeeded` case.
   */
  role: 'record' | 'enrich'
  email: string | null
  amount: number | null // minor units (Rappen/cents)
  currency: string
  subscriptionTypeId: string | null
}

/**
 * Pull the bits we record from the supported success events. We key on the
 * underlying PAYMENT (not the event id) so checkout.session.completed and the
 * matching payment_intent.succeeded converge to one ExternalPayment doc.
 *
 * ⚠ THE ONE PLACE THAT INVARIANT CANNOT HOLD, and why: an `invoice.*` payload no
 * longer names its PaymentIntent at all (the field was removed, and its
 * replacement — `payments` — is expand-only), while a `payment_intent.*` /
 * `charge.*` payload no longer names its invoice either (removed in the same
 * change). BYO holds NO Stripe credentials by design, so it cannot expand or
 * retrieve to bridge the two. A studio subscribed to BOTH an invoice event and a
 * payment event therefore gets TWO rows for one payment.
 *
 * That is a webhook-endpoint configuration the STUDIO owns, not one Linyup can
 * fix from here, so the fix is to make it visible (`refKind: 'fallback'` + a
 * loud [stripe-shape] log) and to tell the studio to subscribe to the payment
 * events, not the invoice ones.
 *
 * What Linyup CAN control is not making that set any bigger, which is why
 * `charge.succeeded` returns `role: 'enrich'` and never records a row of its own.
 */
export function extractPayment(
  eventType: string,
  obj: any,
  fallbackSubTypeId: string | null
): ExtractedPayment | null {
  const md = (obj.metadata ?? {}) as Record<string, string>
  const subscriptionTypeId =
    (md.subscriptionTypeId && md.subscriptionTypeId.trim()) || fallbackSubTypeId || null

  switch (eventType) {
    case 'checkout.session.completed': {
      if (obj.payment_status && obj.payment_status !== 'paid') return null
      const pi =
        typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id
      const email = (obj.customer_details?.email ?? obj.customer_email ?? null) as string | null
      return {
        // A mode:'subscription' session has always had payment_intent null, so
        // this falls back to the session id — see the caveat above.
        ref: pi ?? obj.id,
        refKind: pi ? 'payment' : 'fallback',
        role: 'record',
        email,
        amount: obj.amount_total ?? null,
        currency: obj.currency ?? 'chf',
        subscriptionTypeId,
      }
    }
    case 'payment_intent.succeeded': {
      // `pi.charges` was removed in 2022-11-15, so the old fallback here had been
      // dead for years: an invoice-generated PI has receipt_email null, and this
      // rail cannot call Stripe to expand latest_charge. `charge.succeeded` below
      // is where that email is actually recoverable.
      const email = readPaymentIntentEmail(obj).value
      return {
        ref: obj.id,
        refKind: 'payment',
        role: 'record',
        email,
        amount: obj.amount_received ?? obj.amount ?? null,
        currency: obj.currency ?? 'chf',
        subscriptionTypeId,
      }
    }
    case 'charge.succeeded': {
      // ENRICHMENT ONLY — this event never creates a row, and that restriction is
      // the whole reason it can be handled at all.
      //
      // It is here for one thing: `billing_details.email` — the only place a
      // recurring BYO payment's payer is nameable at all, since
      // `payment_intent.receipt_email` is null on an invoice-generated PI and
      // this rail holds no credentials to expand `latest_charge`.
      //
      // ⚠ BUT IT IS NOT ALWAYS THERE, and the earlier note here said it was.
      // It claimed live verification that the email is populated "for an
      // invoice-driven subscription charge", which reads as a property of
      // subscription charges. It is not one. A charge COPIES `billing_details`
      // from the PAYMENT METHOD, so the email is present exactly when the
      // payment method carries one: Stripe Checkout stamps the address it
      // collected onto the PM, while a PM created or attached through the API
      // without `billing_details.email` (raw token, some portal and off-session
      // flows) has none, and every charge it ever makes has none either.
      //
      // Re-verified on the live test account (2026-04-22.dahlia) across eight
      // charges: `charge.billing_details.email` matched
      // `payment_method.billing_details.email` in ALL of them, null for null —
      // including two `description: "Subscription creation"` charges and one
      // `"Subscription update"` renewal that carried no email at all. Being
      // invoice-driven predicts nothing.
      //
      // So this branch RAISES the assignment rate; it does not guarantee it.
      // `readChargeBillingEmail` falls back to `receipt_email`, which on this
      // rail is null too, and the payment then stays unassigned for a manager to
      // handle by hand — which is the designed floor, not a new failure.
      //
      // But it cannot be allowed to RECORD one. It keys on the PaymentIntent, so
      // it dedupes correctly against `payment_intent.succeeded` — and cannot
      // dedupe at all against `invoice.payment_succeeded`, which keys on the
      // invoice id because Dahlia leaves it nothing else. On Dahlia the charge
      // has NO `invoice` field either (verified: removed, no replacement on the
      // object), so there is no key by which the two could ever be reconciled
      // from inside a rail that holds no Stripe credentials.
      //
      // A studio subscribed to charge.succeeded + invoice.payment_succeeded would
      // therefore have had every recurring payment recorded TWICE. Double-counted
      // money is a worse failure than an unassigned payment a manager can assign
      // by hand, so the row is left to the events that own it and this one only
      // fills in what it alone knows.
      const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id
      if (!pi) return null
      return {
        ref: pi,
        refKind: 'payment',
        role: 'enrich',
        email: readChargeBillingEmail(obj),
        amount: obj.amount_captured ?? obj.amount ?? null,
        currency: obj.currency ?? 'chf',
        subscriptionTypeId,
      }
    }
    case 'invoice.payment_succeeded': {
      const email = (obj.customer_email ?? null) as string | null
      const piRead = readInvoicePaymentIntentId(obj)
      reportStripeShape('invoice.payment_intent', obj.id, piRead.source, 'BYO rail (no expand available)')
      return {
        ref: piRead.value ?? obj.id,
        refKind: piRead.value ? 'payment' : 'fallback',
        role: 'record',
        email,
        amount: obj.amount_paid ?? null,
        currency: obj.currency ?? 'chf',
        subscriptionTypeId,
      }
    }
    default:
      return null
  }
}

/**
 * Fill in what an `'enrich'` event alone knows, on a row some other event wrote.
 *
 * NEVER CREATES. If the row is not there, this does nothing and says so — the
 * event that owns the money will write it, with or without an email. That is the
 * deliberate cost of not double-counting: `charge.succeeded` and
 * `payment_intent.succeeded` are delivered without an ordering guarantee, so a
 * charge that arrives first finds nothing to enrich and the payment lands
 * unassigned. An unassigned payment is one click for a manager; a duplicated one
 * is wrong money in the studio's books.
 *
 * Only ever fills BLANKS — it will not overwrite an email or reassign a contact,
 * so a manager's later reassignment survives a webhook redelivery.
 */
async function enrichPaymentRow(
  db: admin.firestore.Firestore,
  teamId: string,
  extracted: ExtractedPayment
): Promise<{ result: string; contactId: string | null }> {
  const eventRef = db.doc(
    `${TEAMS_COLLECTION}/${teamId}/${PAYMENT_EVENTS_SUBCOLLECTION}/stripe:${extracted.ref}`
  )
  const [readErr, snap] = await to(eventRef.get())
  if (readErr || !snap) return { result: 'read_failed', contactId: null }
  if (!snap.exists) return { result: 'no_row_yet', contactId: null }

  const data = snap.data() ?? {}
  if (data.contact_id) return { result: 'already_assigned', contactId: data.contact_id as string }
  if (data.email) return { result: 'already_has_email', contactId: null }
  if (!extracted.email) return { result: 'nothing_to_add', contactId: null }

  const { contactId } = await resolveSingleContact(teamId, extracted.email)

  // Guarded write: only claims the blanks it read, so a concurrent recording
  // event that filled them first wins and this becomes a no-op.
  const [txErr] = await to(
    db.runTransaction(async (tx) => {
      const fresh = await tx.get(eventRef)
      const d = fresh.data() ?? {}
      if (!fresh.exists || d.contact_id || d.email) throw new Error('raced')
      tx.set(
        eventRef,
        {
          email: extracted.email,
          ...(contactId ? { contact_id: contactId, assignment_status: 'assigned' } : {}),
        },
        { merge: true }
      )
      if (contactId) {
        const update: Record<string, unknown> = { last_payment_at: FieldValue.serverTimestamp() }
        const typeId = (d.subscription_type_id as string | null) ?? extracted.subscriptionTypeId
        if (typeId) update.subscription_type_id = typeId
        tx.update(db.collection(CONTACTS_COLLECTION).doc(contactId), update)
      }
    })
  )
  if (txErr) {
    if ((txErr as Error).message === 'raced') return { result: 'raced', contactId: null }
    console.error(`[handleTeamStripeWebhook] enrich tx failed team=${teamId}:`, txErr)
    return { result: 'enrich_failed', contactId: null }
  }

  if (!contactId) return { result: 'email_only', contactId: null }

  await to(
    db
      .collection(CONTACTS_COLLECTION)
      .doc(contactId)
      .collection('activity_log')
      .add(withLedgerExpiry('activity_log', {
        type: 'payment_received',
        source: 'stripe',
        message: 'Payment confirmed via Stripe',
        timestamp: FieldValue.serverTimestamp(),
      }))
  )
  // Keep the journal from disagreeing with payment_events: the charge row was
  // booked unassigned by the recording event, so stamp the contact onto it too.
  await to(
    linkFinanceTxnContact(teamId, financeTxnId('byo_stripe', 'charge', extracted.ref), contactId)
  )
  return { result: 'assigned', contactId }
}

export const handleTeamStripeWebhook = onRequest({ invoker: 'public' }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, reason: 'method_not_allowed' })
    return
  }

  // ── 1. Identify team ────────────────────────────────────────────────────────
  const teamId = typeof req.query.teamId === 'string' ? req.query.teamId : null
  if (!teamId) {
    res.status(400).json({ ok: false, reason: 'missing_team_id' })
    return
  }

  const db = admin.firestore()

  // ── 2. Load the team's BYO Stripe integration (Admin SDK) ────────────────────
  const [intErr, intSnap] = await to(
    db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection('integrations')
      .where('type', '==', 'payment_gateway')
      .where('config.type', '==', 'stripe')
      .limit(1)
      .get()
  )
  if (intErr || !intSnap || intSnap.empty) {
    // 200 so Stripe stops retrying for a misconfigured team.
    res.status(200).json({ ok: false, reason: 'no_integration' })
    return
  }
  const cfg = intSnap.docs[0].data().config as StripeGatewayConfig
  const signingSecret = cfg.webhook_signing_secret ?? ''

  // ── 3. Verify signature ──────────────────────────────────────────────────────
  const sig = req.headers['stripe-signature']
  if (!sig || typeof sig !== 'string') {
    res.status(401).json({ ok: false, reason: 'missing_signature' })
    return
  }
  if (!signingSecret) {
    console.warn(`[handleTeamStripeWebhook] No signing secret configured for team=${teamId}`)
    res.status(400).json({ ok: false, reason: 'no_signing_secret' })
    return
  }

  let event: any
  try {
    const rawBody: Buffer =
      (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body))
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, signingSecret)
  } catch (err) {
    console.warn(
      `[handleTeamStripeWebhook] signature verification failed team=${teamId}:`,
      (err as Error).message
    )
    res.status(400).json({ ok: false, reason: 'invalid_signature' })
    return
  }

  // ── 4. Record the payment (always 200 past this point) ───────────────────────
  try {
    const obj = event.data?.object ?? {}
    const extracted = extractPayment(event.type, obj, cfg.default_subscription_type_id ?? null)
    if (!extracted || !extracted.ref || !extracted.amount || extracted.amount <= 0) {
      res.status(200).json({ ok: true, ignored: event.type })
      return
    }

    // Enrichment events fill blanks; they never open a row. Split off BEFORE the
    // recording path so there is exactly one `tx.set` on the payment doc and it
    // is unreachable from here.
    if (extracted.role === 'enrich') {
      const outcome = await enrichPaymentRow(db, teamId, extracted)
      console.log(
        `[handleTeamStripeWebhook] team=${teamId} ref=${extracted.ref} enrich(${event.type}) → ${outcome.result}`
      )
      res.status(200).json({ ok: true, enriched: outcome.result, contact_id: outcome.contactId })
      return
    }

    // Default "what was paid" suggestion: the subscription-type name when mapped,
    // else a generic Stripe label. A manager can edit it via updatePaymentRecord.
    let comment = 'Stripe payment'
    if (extracted.subscriptionTypeId) {
      const [, typeSnap] = await to(
        db
          .collection(TEAMS_COLLECTION)
          .doc(teamId)
          .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
          .doc(extracted.subscriptionTypeId)
          .get()
      )
      const name = typeSnap?.exists ? (typeSnap.data()?.name as string | undefined) : undefined
      if (name) comment = name
    }

    // Match the contact (UNIQUE active email match only); none/ambiguous → unassigned.
    const { contactId } = await resolveSingleContact(teamId, extracted.email)
    const assignmentStatus = contactId ? 'assigned' : 'unassigned'

    const eventRef = db.doc(
      `${TEAMS_COLLECTION}/${teamId}/${PAYMENT_EVENTS_SUBCOLLECTION}/stripe:${extracted.ref}`
    )

    const [txErr] = await to(
      db.runTransaction(async (tx) => {
        const existing = await tx.get(eventRef)
        if (existing.exists) throw new Error('already_processed')
        tx.set(eventRef, {
          gateway: 'stripe',
          gatewayRef: extracted.ref,
          // 'fallback' ⇒ this row is keyed on something other than the payment,
          // so a sibling event about the same money would write a SECOND row.
          gateway_ref_kind: extracted.refKind,
          contact_id: contactId,
          assignment_status: assignmentStatus,
          email: extracted.email,
          amount: extracted.amount,
          currency: extracted.currency,
          subscription_type_id: extracted.subscriptionTypeId,
          // Structured link — a manager can enrich it (course/product/price) on assign.
          line_item: extracted.subscriptionTypeId
            ? { kind: 'subscription', subscriptionTypeId: extracted.subscriptionTypeId, label: comment }
            : null,
          membership_expiration: null,
          comment,
          raw_status: event.type,
          processed_at: FieldValue.serverTimestamp(),
        })
        if (contactId) {
          const update: Record<string, unknown> = { last_payment_at: FieldValue.serverTimestamp() }
          if (extracted.subscriptionTypeId) update.subscription_type_id = extracted.subscriptionTypeId
          tx.update(db.collection(CONTACTS_COLLECTION).doc(contactId), update)
        }
      })
    )

    if (txErr) {
      if ((txErr as Error).message === 'already_processed') {
        res.status(200).json({ ok: true, contact_id: contactId, duplicate: true })
        return
      }
      console.error(`[handleTeamStripeWebhook] tx failed team=${teamId}:`, txErr)
      res.status(200).json({ ok: false, reason: 'processing_error' })
      return
    }

    // Activity log on first record (assigned only).
    if (contactId) {
      await to(
        db
          .collection(CONTACTS_COLLECTION)
          .doc(contactId)
          .collection('activity_log')
          .add(withLedgerExpiry('activity_log', {
            type: 'payment_received',
            source: 'stripe',
            message: 'Payment confirmed via Stripe',
            timestamp: FieldValue.serverTimestamp(),
          }))
      )
    }

    console.log(
      `[handleTeamStripeWebhook] team=${teamId} ref=${extracted.ref} ${assignmentStatus}` +
        (contactId ? ` contact=${contactId}` : ` email=${extracted.email ?? 'none'}`)
    )

    // Finance journal (core infrastructure, best-effort — a failure never breaks
    // payment recording; the backfill reconciles). BYO rails are fee-blind.
    try {
      await recordFinanceTransaction(
        buildExternalPaymentTxn({
          teamId,
          gateway: 'stripe',
          gatewayRef: extracted.ref,
          amount: extracted.amount,
          currency: extracted.currency,
          contactId,
          lineItemKind: extracted.subscriptionTypeId ? 'subscription' : null,
          description: comment,
          occurredAtMs: typeof obj.created === 'number' ? obj.created * 1000 : Date.now(),
          eventId: event.id as string | undefined,
        })
      )
    } catch (err) {
      console.error(`[handleTeamStripeWebhook] finance journal write failed team=${teamId}:`, err)
    }
    res.status(200).json({ ok: true, contact_id: contactId, assignment_status: assignmentStatus })
  } catch (err) {
    console.error(`[handleTeamStripeWebhook] processing error team=${teamId}:`, err)
    res.status(200).json({ ok: false, reason: 'processing_error' })
  }
})
