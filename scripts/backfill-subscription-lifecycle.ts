/**
 * Repair the subscription lifecycle fields the pre-Dahlia Stripe reads never wrote.
 *
 * ── WHY A SCRIPT, WHEN THE WEBHOOK NOW SELF-HEALS ───────────────────────────
 * It does self-heal, and that was checked before this file was written rather
 * than assumed — but only on the LIVE events, which is the whole point.
 * `handleSubscription` (Connect) and the SaaS `subscription.created|updated`
 * branches write every lifecycle field they own unconditionally, nulls included,
 * so the next such event rewrites a broken doc completely. The SaaS
 * `subscription.cancelled` branch does NOT: it forces the pair false/null,
 * writes the record fields only when the payload states them, and writes no
 * period at all (see `payload()`). So the question is when the next LIVE event
 * arrives — and for the two symptoms the answers are different:
 *
 *   • `current_period_start`/`current_period_end: null` heals at the next
 *     RENEWAL, because a period advance is a `customer.subscription.updated`.
 *     That is up to a month away on a monthly plan and up to a YEAR away on an
 *     annual one. The two moved onto the subscription ITEM together and were
 *     nulled together, and both rails store the pair — the SaaS rail from the
 *     start (settings/billing and the operator console's account detail render
 *     the period as a PAIR, and fixing only the end leaves each of them
 *     half-right), the Connect rail since 2026-08-31 (accrual readiness, see
 *     docs/finance-accrual.md) — so both are repaired together, and a run over
 *     older member docs is what fills their missing starts.
 *
 *   • `cancel_at_period_end: false` on a subscription canceled in the billing
 *     portal does NOT heal in any useful window. The `updated` event carrying
 *     `cancel_at` has already been delivered, answered 200, and recorded its id
 *     in `last_event_id`; Stripe will not redeliver it. The next event on that
 *     subscription is the `deleted` one — which fires when the cancellation
 *     TAKES EFFECT. So the entire period during which a studio needs to know
 *     "this member is leaving on the 15th" is exactly the period in which
 *     nothing tells them, and then the member is simply gone.
 *
 * The second bullet is the reason this script exists. The first is why it is
 * worth running now rather than waiting: the two interact. A STORED doc from
 * that window carries the boolean and no `cancel_at` — not because Stripe sent
 * only a boolean (on Dahlia an API cancel sets `cancel_at` too), but because
 * nothing was reading that field — so `subscriptionEndsAt()` falls back to
 * `current_period_end`, which is null on the very same doc. Its third state
 * therefore stays DATELESS even after the code fix.
 *
 * ── IT RE-FETCHES; IT DOES NOT RECOMPUTE ────────────────────────────────────
 * There is nothing stored to recompute from — these fields were never written.
 * Stripe holds the truth, so every doc is repaired from a live retrieve, read
 * through THE SAME readers the webhook uses (`readSubscriptionPeriod` /
 * `readSubscriptionCancellation`). A backfill with its own copy of that mapping
 * is the next drift; there is deliberately no second implementation here.
 *
 * Sharing the READERS is not the same as writing the same BYTES, though: the two
 * rails' handlers do not store the same FIELDS, and do not agree with each other
 * about an already-ended subscription. So `payload()` is per-rail and reproduces
 * each handler's rule. See the comment there — a repair that disagrees with the
 * live writer is a second truth, not a fix.
 *
 * ── WHAT IT WILL NOT TOUCH ──────────────────────────────────────────────────
 * Only the fields the defect corrupted. In particular it REPORTS a `status`
 * that disagrees with Stripe but does not fix it: a stale status means a webhook
 * event was missed entirely, which is a different defect with a different blast
 * radius (it moves contacts between rollup states), and a repair that quietly
 * widens its own scope is a migration wearing a repair's clothes.
 *
 * That report compares through `expectedStoredStatus()` rather than by string
 * equality, because only ONE of the two rails stores Stripe's vocabulary. See
 * the comment there.
 *
 * ── RE-RUNNABLE ─────────────────────────────────────────────────────────────
 * Each doc's target values are compared against what is stored and written only
 * when something actually differs, so a second run reports zero changes and
 * writes nothing. That comparison is also what makes the dry-run honest — it
 * lists the real deltas, not "would touch N docs".
 *
 * The write goes through the Admin SDK, so `onMemberSubscriptionWrite` fires and
 * re-materializes `Contact.active_subscriptions[].cancels_at_ms`. That trigger
 * is itself idempotent, so a no-change run costs nothing.
 *
 * ── AUTH ────────────────────────────────────────────────────────────────────
 * Firestore: gcloud Application Default Credentials (ADC), like the other
 * backfills. Against the emulator, set FIRESTORE_EMULATOR_HOST and use
 * --project demo-linyup.
 * Stripe: STRIPE_SECRET_KEY, or the project's Secret Manager `stripe-secret-key`
 * (the same value the deployed functions use, so it cannot drift from them).
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   tsx scripts/backfill-subscription-lifecycle.ts --project linyup-staging
 *   tsx scripts/backfill-subscription-lifecycle.ts --project linyup-staging --apply
 *   … [--team t1] [--rail connect|saas|both]
 *
 * Without --apply it only reports what it would write. Exits non-zero if any doc
 * could not be repaired.
 */

import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { Timestamp } from 'firebase-admin/firestore'
import Stripe from 'stripe'
import {
  CONNECT_ACCOUNTS_COLLECTION,
  MEMBER_SUBSCRIPTIONS_SUBCOLLECTION,
  SAAS_SUBSCRIPTIONS_COLLECTION,
  TEAMS_COLLECTION,
  type SaasStatus,
  type SubscriptionCancellationDetails,
} from '@linyup/shared'
// DELIBERATE cross-package import, for the same reason
// scripts/backfill-document-versions.ts reaches into the sanitizer: the bytes
// this script writes must be IDENTICAL to what the webhook writes, and a copy of
// the field mapping is exactly the wrong answer. Same precedent, stronger case —
// a drift here is wrong data rather than wrong formatting.
import {
  readSubscriptionCancellation,
  readSubscriptionPeriod,
} from '../packages/functions/src/utils/stripe/objectShape'

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    team: { type: 'string' },
    rail: { type: 'string', default: 'both' },
    apply: { type: 'boolean', default: false },
  },
})

if (!values.project) {
  console.error(
    '❌ --project is required (e.g. --project linyup-staging, or demo-linyup for the emulator)'
  )
  process.exit(1)
}
const RAIL = values.rail ?? 'both'
if (RAIL !== 'both' && RAIL !== 'connect' && RAIL !== 'saas') {
  console.error(`❌ --rail must be one of connect | saas | both (got "${RAIL}")`)
  process.exit(1)
}
const DO_CONNECT = RAIL === 'both' || RAIL === 'connect'
const DO_SAAS = RAIL === 'both' || RAIL === 'saas'

// ─── Stripe key (same resolution order as scripts/stripe-sync.ts) ──────────────

const IS_WINDOWS = process.platform === 'win32'
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/i

function resolveSecretKey(project: string): string {
  const fromEnv = process.env.STRIPE_SECRET_KEY?.trim()
  if (fromEnv) return fromEnv
  if (!SAFE_ID.test(project)) {
    console.error(`❌ Refusing to run gcloud: project "${project}" is not a plain identifier.`)
    process.exit(1)
  }
  try {
    const key = execFileSync(
      'gcloud',
      ['secrets', 'versions', 'access', 'latest', '--secret=stripe-secret-key', `--project=${project}`],
      { encoding: 'utf8', shell: IS_WINDOWS, stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()
    if (!key) throw new Error('gcloud returned an empty value')
    console.log(`Using stripe-secret-key from ${project}’s Secret Manager.`)
    return key
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string }
    console.error(`❌ Could not read stripe-secret-key from ${project}.`)
    const detail = String(e.stderr ?? e.message ?? '').trim()
    if (detail) console.error(detail.split('\n').slice(0, 4).map((l) => `  ${l}`).join('\n'))
    console.error('  Set STRIPE_SECRET_KEY to bypass Secret Manager.')
    process.exit(1)
  }
}

const stripe = new Stripe(resolveSecretKey(values.project))

// Against the emulator there are no credentials to find, and asking for ADC
// there fails for a reason that has nothing to do with the task.
const USING_EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST
admin.initializeApp(
  USING_EMULATOR
    ? { projectId: values.project }
    : { credential: applicationDefault(), projectId: values.project }
)
const db = admin.firestore()

// ─── the repair ────────────────────────────────────────────────────────────────

const stats = {
  scanned: 0,
  repaired: 0,
  alreadyCorrect: 0,
  skipped: 0,
  /** Docs this script could not repair. Non-empty ⇒ exit 1. */
  unfixable: [] as string[],
  /** Stripe disagrees about `status` — reported, never fixed. See the header. */
  statusDrift: [] as string[],
}

const ts = (seconds: number | null) => (seconds === null ? null : Timestamp.fromMillis(seconds * 1000))

/**
 * Statuses in which STRIPE says the subscription has already stopped.
 *
 * Stripe's own vocabulary only — this is compared against `sub.status` from a
 * live retrieve, never against our stored value (the SaaS rail spells it
 * `cancelled`, which is why the stored-side check lower down has its own set).
 */
const STRIPE_ENDED = new Set(['canceled', 'incomplete_expired'])

/** The lifecycle fields as Stripe currently states them, in stored shape. */
interface Target {
  /**
   * Written on BOTH rails — see `payload()` for how each writes it.
   *
   * The same defect nulled it (the period moved onto the subscription item as a
   * PAIR), and on the SaaS rail it is displayed in two places — settings/billing
   * renders "period start – end" and the operator console's account detail
   * prints the whole period — so repairing only the end leaves both half-fixed.
   *
   * The CONNECT rail declares and writes it too since 2026-08-31 (accrual
   * readiness — docs/finance-accrual.md, Phase 0), under that rail's
   * whole-record rule: nulls included, exactly as `handleSubscription` would
   * have written on receiving the same state. Docs from before that date carry
   * only the end; a run of this script is what fills their starts.
   */
  current_period_start: Timestamp | null
  current_period_end: Timestamp | null
  cancel_at_period_end: boolean
  cancel_at: Timestamp | null
  canceled_at: Timestamp | null
  cancellation_details: SubscriptionCancellationDetails | null
  /** Stripe's own status — compared, reported, never written. */
  stripeStatus: string
  /** Stripe says this subscription has already stopped. Changes what is written. */
  endedAtStripe: boolean
}

// `unknown`, not a Stripe type: the `Stripe.X` NAMESPACE is not reachable from
// the default import in this SDK build, so `Stripe.Response<Stripe.Subscription>`
// is not a type that can be written here at all. That is not a guess — it is why
// packages/functions/src/utils/stripe/objectShape.ts reaches the same interfaces
// the long way round, through `Awaited<ReturnType<…['retrieve']>>`, and that file
// IS typechecked (`turbo run typecheck`) where this one is not.
//
// ⚠ NOTHING TYPECHECKS THIS FILE. `tsx` strips types without checking them, and
// `tsc -p tsconfig.scripts.json` cannot build scripts/ at all today (it resolves
// no `@linyup/shared` and rejects the deliberate cross-package import above —
// both pre-existing, and true of every other script here). So a wrong annotation
// in this file fails silently rather than loudly: prefer `unknown` plus a
// narrowing cast at the point of use, as below.
function targetFrom(sub: unknown): Target {
  const period = readSubscriptionPeriod(sub)
  const cancellation = readSubscriptionCancellation(sub)
  const stripeStatus = String((sub as { status?: unknown }).status ?? '')
  return {
    current_period_start: ts(period.start),
    current_period_end: ts(period.end),
    cancel_at_period_end: cancellation.cancelsAtPeriodEnd,
    cancel_at: ts(cancellation.cancelAt),
    canceled_at: ts(cancellation.canceledAt),
    cancellation_details: cancellation.details,
    stripeStatus,
    endedAtStripe: STRIPE_ENDED.has(stripeStatus),
  }
}

const millis = (v: unknown): number | null => {
  if (!v) return null
  const t = v as { toMillis?: () => number; seconds?: number }
  if (typeof t.toMillis === 'function') return t.toMillis()
  return typeof t.seconds === 'number' ? t.seconds * 1000 : null
}

/**
 * The delta, as human-readable lines. Empty ⇒ nothing to write.
 *
 * Compared field by field rather than by whole-object equality so the report
 * says WHICH field was wrong — which is the difference between a log an operator
 * can act on and a count they have to trust.
 *
 * IT WALKS THE PAYLOAD, not a hardcoded field list. `payload()` is conditional
 * (the SaaS ended-rule omits keys rather than nulling them), so a diff with its
 * own idea of which fields exist would report deltas the write never makes — the
 * dry-run would lie, every run would claim work, and each one would re-fire the
 * rollup fan-out for nothing. Deriving one from the other makes that class of
 * drift unrepresentable.
 */
function diff(
  stored: FirebaseFirestore.DocumentData,
  written: Record<string, unknown>
): string[] {
  const out: string[] = []
  for (const [key, next] of Object.entries(written)) {
    if (key === 'cancellation_details') {
      const to = next as SubscriptionCancellationDetails | null
      if (!sameDetails(stored[key], to)) {
        out.push(`cancellation_details ${showDetails(stored[key])} → ${showDetails(to)}`)
      }
      continue
    }
    if (key === 'cancel_at_period_end') {
      if ((stored[key] ?? false) !== next) {
        out.push(`cancel_at_period_end ${stored[key] ?? false} → ${next}`)
      }
      continue
    }
    // Everything else is a Timestamp|null.
    if (millis(stored[key]) !== millis(next)) {
      out.push(`${key} ${fmt(millis(stored[key]))} → ${fmt(millis(next))}`)
    }
  }
  return out
}

/**
 * Compare the three keys, NOT the serialized objects.
 *
 * `JSON.stringify` compares key ORDER, and Firestore returns map keys in its own
 * (alphabetical) order rather than the order they were written. A stringify
 * comparison therefore reported a difference on every re-run, which would have
 * rewritten every repaired doc forever and re-fired the whole rollup fan-out with
 * it — caught only because the second run was actually executed and watched.
 */
function sameDetails(
  a: SubscriptionCancellationDetails | null | undefined,
  b: SubscriptionCancellationDetails | null
): boolean {
  if (!a || !b) return !a === !b
  return a.reason === b.reason && a.feedback === b.feedback && (a.comment ?? null) === b.comment
}

const showDetails = (d: SubscriptionCancellationDetails | null | undefined) =>
  d ? `${d.reason ?? '—'}/${d.feedback ?? '—'}${d.comment ? '/+comment' : ''}` : 'null'

const fmt = (ms: number | null) => (ms === null ? 'null' : new Date(ms).toISOString().slice(0, 10))

/** Which webhook writer this doc belongs to. The two do NOT write the same bytes. */
type Rail = 'connect' | 'saas'

/**
 * The fields written — EXACTLY what that rail's webhook would write for the
 * state Stripe currently reports.
 *
 * ── WHY THIS IS PER-RAIL ────────────────────────────────────────────────────
 * A repair script that disagrees with the live writer does not fix a doc, it
 * creates a SECOND TRUTH: the script's version stands until the next event, the
 * webhook's version replaces it, and the two look like flapping data with no
 * cause. So the rule is not "write what Stripe says", it is "write what the
 * handler for this rail would have written on receiving that state".
 *
 * CONNECT (`handleSubscription`, connect/webhook.ts) writes its fields
 * unconditionally from the same two readers on every event, nulls included,
 * whatever the status — including the `deleted` one, which webhook.ts feeds
 * straight into the same handler as `{ ...obj, status: 'canceled' }`. So that
 * rail has no ended-branch here.
 *
 * Since 2026-08-31 it writes the period as a PAIR: `current_period_start`
 * joined `current_period_end` for accrual readiness (which service period an
 * invoice bought — docs/finance-accrual.md, Phase 0), declared on
 * `MemberSubscription` and written by `handleSubscription` under the same rail
 * rule as the end (whole, nulls included). So this branch writes both, making a
 * run over pre-change docs the repair that fills the missing starts.
 * `dahliaReads.test.ts` pins the handler side, the type and the script side
 * together — all three move together or none do.
 *
 * SAAS (`handleStripeWebhook`'s `subscription.cancelled` branch,
 * saas-billing/index.ts) does something different once a subscription has
 * ENDED, and does it by hardcoding rather than by reading:
 *
 *     update.cancel_at_period_end = false      // "it has ENDED — there is no
 *     update.cancel_at            = null       //  longer a future end"
 *     if (event.canceledAt)          update.canceled_at          = …
 *     if (event.cancellationDetails) update.cancellation_details = …
 *
 * Three consequences, and the second is the one that loses data:
 *
 *   1. the pair is forced false/null regardless of the payload;
 *   2. `canceled_at` and `cancellation_details` are written ONLY when the
 *      payload carries them — deliberately, so a `deleted` event with no
 *      details cannot erase a reason an earlier `updated` already recorded.
 *      Writing them unconditionally (as this script did) means a repair run
 *      DELETES the churn reason on every ended SaaS subscription whose live
 *      object no longer states one. That is the migration-wearing-a-repair's-
 *      clothes failure the header warns about, committed by the header's own
 *      script.
 *   3. the BILLING PERIOD is not written at all on that branch, and this script
 *      wrote it — the second parity gap, closed rather than excused. It is not
 *      an omission in the handler: the adapter deliberately builds the
 *      `subscription.cancelled` event from `cancellation(obj)` WITHOUT the
 *      period, on the stated grounds that an ended subscription has no CURRENT
 *      period (utils/gateway/stripe.ts). Stripe's own object disagrees — a
 *      canceled subscription's items still carry the final period, so a live
 *      retrieve here happily produces one — and writing it would have stamped a
 *      "current" period onto docs the codebase says have none, permanently:
 *      `deleted` is terminal, so no later event ever corrects it.
 *
 * On the SaaS rail the period is also written only WHEN STRIPE STATES ONE, for
 * the same reason as `canceled_at`: both live branches guard with
 * `if (event.currentPeriodStart)`, so a null there is a value the handler would
 * never have written over a stored one.
 *
 * ── ON THE FORCED PAIR, HONESTLY ────────────────────────────────────────────
 * Checked against live Stripe rather than assumed: across all 19 subscriptions
 * in the test account (11 of them terminal, on both the platform and the
 * connected account, wire version 2026-04-22.dahlia), Stripe ITSELF clears the
 * pair the moment a subscription ends — every terminal one reported
 * `cancel_at: null` and `cancel_at_period_end: false`, with `canceled_at` and
 * `ended_at` set. So today the readers already produce false/null here and the
 * forcing changes nothing.
 *
 * It is kept anyway, because the SaaS handler hardcodes it. Matching a writer
 * only for as long as a third party happens to agree with it is not matching
 * it; if Stripe ever leaves a past `cancel_at` standing on a terminal
 * subscription, this script and the webhook must still say the same thing.
 */
function payload(target: Target, rail: Rail): Record<string, unknown> {
  // The whole cancellation record, nulls included — both rails' LIVE branches
  // write every one of these on every event, and a null is what a reactivation
  // uses to erase a dead end-date and reason.
  const cancellation = {
    cancel_at_period_end: target.cancel_at_period_end,
    cancel_at: target.cancel_at,
    canceled_at: target.canceled_at,
    cancellation_details: target.cancellation_details,
  }

  if (rail === 'connect') {
    return {
      current_period_start: target.current_period_start,
      current_period_end: target.current_period_end,
      ...cancellation,
    }
  }

  if (rail === 'saas' && target.endedAtStripe) {
    return {
      cancel_at_period_end: false,
      cancel_at: null,
      // Only when Stripe actually states them — never a null over a stored value.
      ...(target.canceled_at ? { canceled_at: target.canceled_at } : {}),
      ...(target.cancellation_details
        ? { cancellation_details: target.cancellation_details }
        : {}),
    }
  }

  return {
    ...(target.current_period_start
      ? { current_period_start: target.current_period_start }
      : {}),
    ...(target.current_period_end ? { current_period_end: target.current_period_end } : {}),
    ...cancellation,
  }
}

/**
 * Stripe's subscription statuses. Spelled out here because the `Stripe.X`
 * namespace is not reachable from this SDK's default import (see `targetFrom`),
 * so the map below cannot be keyed off the SDK's own union.
 */
type StripeSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'

/**
 * What the SAAS rail stores for each Stripe status — a case per status, with
 * the branch of `saas-billing/index.ts` that produces it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The drift report compared stored to Stripe with raw string equality. The
 * Connect rail survives that (see `expectedStoredStatus`); the SaaS rail does
 * not — it has its own five-value vocabulary (`SaasStatus`, shared/types/team.ts)
 * and Stripe's `canceled` is stored as `cancelled`. So EVERY correctly-canceled
 * studio was printed as drift, under a heading telling the operator a webhook
 * event had been missed. A report that cries wolf on its most common case does
 * not get read carefully, it gets skipped — which costs exactly the real drift
 * it exists to surface.
 *
 * `null` = this rail has no defined answer, so the comparison ABSTAINS rather
 * than guesses. Both nulls are statuses no SaaS branch was written for:
 * `incomplete` (a first payment still in flight — `subscription.created`
 * hardcodes 'active' whatever Stripe says, so a comparison here would report
 * the rail's own design as drift) and `paused` (needs
 * `trial_settings.end_behavior`, which the SaaS checkout never sets).
 *
 * A status absent from this map entirely — a future Stripe vocabulary — is
 * reported loudly instead of abstaining. See `repair`.
 */
const SAAS_STATUS_FOR_STRIPE: Record<StripeSubscriptionStatus, SaasStatus | null> = {
  active: 'active', // subscription.created / payment.succeeded
  trialing: 'active', // subscription.created, unconditionally — the stored
  //                     'trial' comes from team/org creation, never a webhook
  //                     (the SaaS checkout sets no trial_period_days).
  past_due: 'past_due', // payment.failed
  unpaid: 'past_due', // dunning exhausted; payment.failed was still the last
  //                     event to touch the status, so 'past_due' is what stands
  canceled: 'cancelled', // subscription.canceled
  incomplete_expired: 'cancelled', // Stripe fires customer.subscription.deleted
  incomplete: null,
  paused: null,
}

/**
 * The status this RAIL would store for the status Stripe currently reports.
 *
 * `known: false` means Stripe used a word this script has never been taught —
 * worth a line in the report on its own, because the alternative is a silent
 * abstention that looks identical to "no drift".
 *
 * CONNECT is the identity, and deliberately not mapped: `handleSubscription`
 * stores `sub.status` verbatim, so that rail's vocabulary IS Stripe's, and a
 * translation table there would be inventing a difference that does not exist.
 */
function expectedStoredStatus(
  stripeStatus: string,
  rail: Rail
): { stored: string | null; known: boolean } {
  if (rail === 'connect') return { stored: stripeStatus, known: true }
  return Object.prototype.hasOwnProperty.call(SAAS_STATUS_FOR_STRIPE, stripeStatus)
    ? { stored: SAAS_STATUS_FOR_STRIPE[stripeStatus as StripeSubscriptionStatus], known: true }
    : { stored: null, known: false }
}

async function repair(
  ref: FirebaseFirestore.DocumentReference,
  stored: FirebaseFirestore.DocumentData,
  target: Target,
  label: string,
  rail: Rail
): Promise<void> {
  const written = payload(target, rail)
  const delta = diff(stored, written)
  if (stored.status && target.stripeStatus) {
    // Reported, not repaired — see the header. A studio whose rollup is wrong
    // needs a person to look, not a script to overwrite the evidence.
    const expected = expectedStoredStatus(target.stripeStatus, rail)
    if (!expected.known) {
      stats.statusDrift.push(
        `${label}: Stripe reports "${target.stripeStatus}", which this script has no ${rail} ` +
          `equivalent for (stored "${stored.status}") — teach SAAS_STATUS_FOR_STRIPE before ` +
          `trusting this line either way`
      )
    } else if (expected.stored !== null && stored.status !== expected.stored) {
      stats.statusDrift.push(
        `${label}: stored "${stored.status}" vs Stripe "${target.stripeStatus}"` +
          (expected.stored === target.stripeStatus
            ? ''
            : ` (this rail stores "${expected.stored}" for that)`)
      )
    }
  }
  if (delta.length === 0) {
    stats.alreadyCorrect += 1
    return
  }
  console.log(`   ${values.apply ? '✔' : 'would fix'} ${label}`)
  for (const line of delta) console.log(`        ${line}`)
  if (values.apply) await ref.set(written, { merge: true })
  stats.repaired += 1
}

// ─── Connect rail: teams/{teamId}/member_subscriptions/{subId} ──────────────────

/** teamId → connected account id, resolved once per team. */
const accountCache = new Map<string, string | null>()

async function accountForTeam(teamId: string): Promise<string | null> {
  if (accountCache.has(teamId)) return accountCache.get(teamId)!
  const snap = await db
    .collection(CONNECT_ACCOUNTS_COLLECTION)
    .where('teamId', '==', teamId)
    .limit(1)
    .get()
  const id = snap.empty ? null : (snap.docs[0].data().stripeAccountId as string) ?? snap.docs[0].id
  accountCache.set(teamId, id)
  return id
}

/** Statuses in which a subscription Stripe has forgotten is expected residue. */
const TERMINAL = new Set(['canceled', 'cancelled', 'incomplete_expired'])

async function runConnectRail(): Promise<void> {
  console.log('── Connect rail (member subscriptions) ──')
  let query: FirebaseFirestore.Query = db.collectionGroup(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
  if (values.team) query = query.where('teamId', '==', values.team)
  const snap = await query.get()

  for (const doc of snap.docs) {
    stats.scanned += 1
    const data = doc.data()
    const teamId = (data.teamId as string) ?? doc.ref.parent.parent?.id
    const subId = (data.subscriptionId as string) ?? doc.id
    const label = `${teamId}/${subId}`

    if (!teamId || !subId) {
      stats.unfixable.push(`${doc.ref.path}: no teamId/subscriptionId to look up`)
      continue
    }

    const accountId = await accountForTeam(teamId)
    if (!accountId) {
      stats.unfixable.push(`${label}: team has no connect_accounts doc — cannot reach Stripe`)
      continue
    }

    try {
      const sub = await stripe.subscriptions.retrieve(subId, {}, { stripeAccount: accountId })
      await repair(doc.ref, data, targetFrom(sub), label, 'connect')
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode
      // A subscription Stripe no longer has, on a doc that is already terminal,
      // is residue — most often a deleted test subscription. Anything else is a
      // live subscription our data and Stripe's disagree about, and that is not
      // for a script to paper over.
      if (code === 404 && TERMINAL.has(String(data.status ?? ''))) {
        stats.skipped += 1
        console.log(`   – ${label} skipped (gone from Stripe, already terminal here)`)
        continue
      }
      stats.unfixable.push(`${label}: ${(err as Error).message}`)
    }
  }
}

// ─── SaaS rail: saas_subscriptions/{entityId} ──────────────────────────────────

/**
 * The Stripe subscription id on a `saas_subscriptions` doc — from WHEREVER that
 * doc actually keeps it.
 *
 * ── THE SHAPE IS NOT WHAT THE FIELD NAME SUGGESTS ───────────────────────────
 * This read was `data.gateway_data?.subscription_id`, which returns `undefined`
 * for every doc the webhook has ever written — so the SaaS half of this script
 * could not repair a single real document. It is worth being precise about why,
 * because the code that produces it looks exactly like a nested write:
 *
 *   saas-billing/index.ts builds a FLAT object with DOTTED STRING KEYS
 *     update['gateway_data.subscription_id'] = event.subscriptionId
 *   and persists it with
 *     await subRef.set(update, { merge: true })
 *
 * `update()` interprets a dotted key as a FIELD PATH and builds a nested map.
 * `set()` does NOT — it takes the key literally. Verified against the running
 * emulator rather than recalled: the same call shape stores a top-level field
 * whose NAME is the seven-character-plus-dot string `gateway_data.subscription_id`,
 * and there is no `gateway_data` map on the document at all. The same probe run
 * through `update()` produced a real nested map alongside it, which is how the
 * two can coexist on one doc.
 *
 * Confirmed on live data, not just a probe: `saas_subscriptions/hmd` in the
 * emulator, written by the SaaS webhook from event evt_1U4wq0Gz6xwscm1ePB35od9E,
 * carries `"gateway_data.subscription_id": "sub_1Tl8NiGz6xwscm1esVGryAv2"` as a
 * literal top-level field and no map.
 *
 * ── SO IT READS BOTH, AND THE ORDER IS NOT ARBITRARY ────────────────────────
 * The literal key comes FIRST because it is the one the webhook writes and
 * therefore the one that is current. A nested `gateway_data` map genuinely does
 * exist on some docs — `activatePluginAddon` / `deactivatePluginAddon` write
 * `{ gateway_data: { activeAddOns } }` as a real nested object, and the seeds and
 * `createOrganization` write `gateway_data: null` — so the fallback is not
 * defensive padding, it is the other half of a population this script has to
 * walk.
 *
 * ⚠ This helper deliberately does NOT "fix" the shape. ELEVEN other reads make
 * the same nested assumption — eight in `saas-billing/index.ts` (its own
 * `last_event_id` idempotency check, `cancelSaasSubscription`,
 * `reactivateSaasSubscription`, `getBillingPortalUrl`, `getSaasInvoices`,
 * `activatePluginAddon` ×2 and `deactivatePluginAddon`) and three in
 * `apps/admin/src/lib/queries/account.ts` — and that mismatch predates this
 * migration. A repair script is the wrong place to unify a storage shape used by
 * live handlers; it is reported in the run summary instead.
 */
function saasSubscriptionId(data: FirebaseFirestore.DocumentData): string | undefined {
  const literal = data['gateway_data.subscription_id']
  if (typeof literal === 'string' && literal) return literal
  const nested = (data.gateway_data as { subscription_id?: unknown } | null | undefined)
    ?.subscription_id
  return typeof nested === 'string' && nested ? nested : undefined
}

/**
 * How many SaaS docs keep their subscription id as the LITERAL dotted field.
 * Reported at the end — see `saasSubscriptionId` for why it is not repaired.
 */
let shapeDotted = 0

async function runSaasRail(): Promise<void> {
  console.log('── SaaS rail (studio → Linyup subscriptions) ──')
  const snap = await db.collection(SAAS_SUBSCRIPTIONS_COLLECTION).get()

  for (const doc of snap.docs) {
    const data = doc.data()
    if (values.team && doc.id !== values.team) continue
    // A manually managed subscription has no gateway and nothing to re-read.
    if (data.gateway_type !== 'stripe') {
      stats.skipped += 1
      continue
    }
    stats.scanned += 1
    const subId = saasSubscriptionId(data)
    if (!subId) {
      stats.unfixable.push(
        `saas/${doc.id}: gateway_type is stripe but no subscription id in either the ` +
          `literal "gateway_data.subscription_id" field or a nested gateway_data map`
      )
      continue
    }
    if (data.gateway_data?.subscription_id === undefined) shapeDotted += 1
    try {
      // The PLATFORM account — a studio's Linyup subscription is Linyup's own
      // customer record, not something on the studio's connected account.
      const sub = await stripe.subscriptions.retrieve(subId)
      await repair(doc.ref, data, targetFrom(sub), `saas/${doc.id}`, 'saas')
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode
      if (code === 404 && TERMINAL.has(String(data.status ?? ''))) {
        stats.skipped += 1
        console.log(`   – saas/${doc.id} skipped (gone from Stripe, already terminal here)`)
        continue
      }
      stats.unfixable.push(`saas/${doc.id}: ${(err as Error).message}`)
    }
  }
}

// ─── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `\n🔧 Subscription lifecycle backfill on '${values.project}'` +
      `${values.team ? ` (team ${values.team})` : ''} · rail ${RAIL} ` +
      `${values.apply ? '(APPLY)' : '(dry-run)'}\n`
  )

  if (DO_CONNECT) await runConnectRail()
  if (DO_SAAS) await runSaasRail()

  console.log(
    `\n📊 scanned ${stats.scanned} · ${values.apply ? 'repaired' : 'would repair'} ${stats.repaired} · ` +
      `${stats.alreadyCorrect} already correct · ${stats.skipped} skipped\n`
  )

  if (shapeDotted > 0) {
    console.warn(
      `⚠ ${shapeDotted} saas_subscriptions doc(s) keep their gateway ids as LITERAL dotted\n` +
        `  field names ("gateway_data.subscription_id") rather than a nested gateway_data map,\n` +
        `  because the webhook persists dotted keys through set() instead of update(). This\n` +
        `  script reads both. Eleven LIVE reads do not — eight in saas-billing/index.ts (cancel,\n` +
        `  reactivate, billing portal, invoices, the add-on callables, and its own last_event_id\n` +
        `  idempotency check) and three in apps/admin/src/lib/queries/account.ts all assume the\n` +
        `  nested map. Pre-existing and out of scope for a lifecycle repair, but it wants an owner.\n`
    )
  }

  if (stats.statusDrift.length) {
    console.warn(
      `⚠ ${stats.statusDrift.length} subscription(s) whose stored status disagrees with what this\n` +
        `  rail would store for Stripe's (SaaS spells Stripe's "canceled" as "cancelled", so the\n` +
        `  comparison goes through that map — these are real disagreements, not spelling).\n` +
        `  NOT repaired here: a missed lifecycle event moves contacts between rollup states and\n` +
        `  wants a person, not a sweep:`
    )
    for (const line of stats.statusDrift) console.warn(`   ${line}`)
    console.warn('')
  }

  if (!values.apply && stats.repaired > 0) {
    console.log('   Re-run with --apply to write.\n')
  }

  if (stats.unfixable.length) {
    console.error(`❗ ${stats.unfixable.length} subscription(s) could NOT be repaired:`)
    for (const line of stats.unfixable) console.error(`   ${line}`)
    console.error('')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
