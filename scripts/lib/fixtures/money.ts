/**
 * Shared money-ledger seeding — `member_subscriptions`, `member_payments`, and
 * the contact-level rollup they imply.
 *
 * ── THE RULE THIS FILE BREAKS, AND WHY ───────────────────────────────────────
 * `scripts/lib/appointments.ts` says seeded bookings are always free-path-shaped,
 * "because a paid one would need a matching `member_payments` ledger doc
 * (webhook-written in production) and no such seeding pipeline exists". That
 * rule existed to stop a HALF-RECORD: a session stamped as paid with no money
 * behind it. The answer to a half-record is the whole record, not an empty
 * screen — and the empty screen was `/payments`, `/contacts/[id]` → Payments,
 * and `Contact.subscription_status`, on every demo tenant, in a payments-first
 * product (docs/seed-truth-2026-08.md → decision 1, settled 2026-08-19).
 *
 * So the pipeline is here, and the obligation the old rule protected gets
 * STRICTER rather than dropped:
 *
 *   • A paid thing and its ledger row are written TOGETHER or not at all.
 *   • The shapes are the ones `connect/webhook.ts` writes — amounts in RAPPEN,
 *     ids shaped like Stripe's, `application_fee_amount` present — so a demo row
 *     and a real row are the same row.
 *   • The contact rollup goes through `rollupMemberSubscriptions`
 *     (@linyup/shared), the SAME function `onMemberSubscriptionWrite` runs, so
 *     seeded data lands in the state the trigger would have produced. No trigger
 *     fires on an Admin-SDK write, which is exactly why this must not be a
 *     second implementation.
 *
 * ── WHAT IS NOT SEEDED, DELIBERATELY ─────────────────────────────────────────
 * No Stripe objects exist behind these rows. A demo cannot open the billing
 * portal, issue a refund or replay a webhook from them — those need a real test
 * account (see scripts/lib/connect.ts). These are ledger rows for the screens
 * that read ledger rows, and nothing more.
 *
 * Path constants mirror @linyup/shared (same convention as lib/storefront.ts).
 */

import admin from 'firebase-admin'
import {
  buildConnectChargeTxn,
  buildConnectRefundTxn,
  rollupMemberSubscriptions,
} from '@linyup/shared'
import type { PaymentLineItem, SubscriptionCancellationDetails } from '@linyup/shared'

// ── Firestore path constants (mirror @linyup/shared/paths) ────────────────────
const TEAMS_COLLECTION = 'teams'
const CONTACTS_COLLECTION = 'contacts'
const MEMBER_PAYMENTS_SUBCOLLECTION = 'member_payments'
const FINANCE_TRANSACTIONS_SUBCOLLECTION = 'finance_transactions'
const MEMBER_SUBSCRIPTIONS_SUBCOLLECTION = 'member_subscriptions'
const SUBSCRIPTION_TYPES_SUBCOLLECTION = 'subscription_types'
const SESSIONS_COLLECTION = 'sessions'
const COURSES_COLLECTION = 'courses'
const COURSE_PURCHASES_SUBCOLLECTION = 'purchases'

const tsOf = (d: Date) => admin.firestore.Timestamp.fromDate(d)
function daysFrom(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}

/** Major units → Rappen, the unit every Connect row stores. */
const rappen = (major: number) => Math.round(major * 100)

/**
 * The platform fee a seeded charge carries. Kept as a plain percentage rather
 * than imported from `computePlatformFee`, because that helper reads a team's
 * plan and take-rate config and a seeded row only needs to look plausible on a
 * dashboard — the exact number is never reconciled against anything.
 */
const SEED_FEE_PERCENT = 0.02

export type SeedSubscriptionState =
  | 'active'
  /** Live, but scheduled to stop — the THIRD state, and the only one that
   *  renders `cancel_at` / `canceled_at` / `cancellation_details` anywhere. */
  | 'cancelling'
  | 'past_due'
  | 'paused'

export interface SeedMemberSubscriptionSpec {
  contactId: string
  /** The studio's stable subscription-type id — what the rollup dedupes on. */
  subscriptionTypeId: string
  subscriptionTypeName: string
  recurrence: string
  /** Major units per period. */
  amount: number
  currency?: string
  state?: SeedSubscriptionState
  /** How many past invoices to write as `member_payments` rows. Default 3. */
  invoices?: number
  /** Days since the subscription started. Default 200. */
  startedDaysAgo?: number
}

/**
 * Write one `member_subscriptions` record plus its past invoice charges.
 *
 * A `cancelling` subscription writes the WHOLE cancellation record — `cancel_at`
 * (when it stops), `canceled_at` (when it was asked for; the two bracket the
 * win-back window) and `cancellation_details`. That is the entire point of
 * seeding one: without it, `SubscriptionCancellationNote`, the operator
 * console's churn-reason column and the member's own Space have no state that
 * renders them, and the distinction the record exists for — `payment_failed`
 * versus `cancellation_requested`, the same stored state and completely
 * different studio actions — is undemoable.
 */
export async function seedMemberSubscription(
  teamId: string,
  spec: SeedMemberSubscriptionSpec
): Promise<void> {
  const db = admin.firestore()
  const state = spec.state ?? 'active'
  const currency = (spec.currency ?? 'CHF').toLowerCase()
  const startedDaysAgo = spec.startedDaysAgo ?? 200
  const amountRappen = rappen(spec.amount)
  const subscriptionId = `sub_seed_${spec.contactId}_${spec.subscriptionTypeId}`.slice(0, 60)
  const periodEnd = daysFrom(18)

  const cancellation: {
    cancel_at: admin.firestore.Timestamp | null
    canceled_at: admin.firestore.Timestamp | null
    cancellation_details: SubscriptionCancellationDetails | null
  } =
    state === 'cancelling'
      ? {
          cancel_at: tsOf(periodEnd),
          canceled_at: tsOf(daysFrom(-6)),
          cancellation_details: {
            reason: 'cancellation_requested',
            feedback: 'too_expensive',
            comment: 'Moving to a smaller plan after the summer.',
          },
        }
      : state === 'past_due'
        ? {
            cancel_at: null,
            canceled_at: null,
            // A dunning subscription has not been cancelled — but when it is,
            // this is the reason that will be on it, and it is the one a studio
            // must be able to tell apart from a member who chose to leave.
            cancellation_details: null,
          }
        : { cancel_at: null, canceled_at: null, cancellation_details: null }

  await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .doc(subscriptionId)
    .set({
      teamId,
      subscriptionId,
      customerId: `cus_seed_${spec.contactId}`.slice(0, 60),
      contactId: spec.contactId,
      priceId: `price_seed_${spec.subscriptionTypeId}`.slice(0, 60),
      subscriptionTypeId: spec.subscriptionTypeId,
      subscriptionTypeName: spec.subscriptionTypeName,
      recurrence: spec.recurrence,
      amount: amountRappen,
      currency,
      application_fee_percent: SEED_FEE_PERCENT * 100,
      status: state === 'cancelling' ? 'active' : state,
      current_period_end: tsOf(periodEnd),
      // TRUE for a subscription that will not renew. The billing portal instead
      // leaves this false and sets `cancel_at`; both shapes are live, and
      // `subscriptionIsCancelling` is what tells a reader they mean the same
      // thing — so a seed picks one and never invents a third.
      cancel_at_period_end: state === 'cancelling',
      ...cancellation,
      payment_method_kind: 'card',
      last_invoice_id: `in_seed_${spec.contactId}`.slice(0, 60),
      last_payment_status: state === 'past_due' ? 'failed' : 'paid',
      pause_collection: state === 'paused' ? { behavior: 'void' } : null,
      created_at: tsOf(daysFrom(-startedDaysAgo)),
      updated_at: tsOf(daysFrom(-1)),
    })

  // The invoice charges behind it. A subscription with no payments produces a
  // membership row on the contact and an empty payments dashboard — half of the
  // screen this exists to fill.
  const invoices = spec.invoices ?? 3
  for (let i = 0; i < invoices; i++) {
    const daysAgo = 30 * (i + 1)
    const failed = state === 'past_due' && i === 0
    // A studio refunding the last month of a member who cancelled is an ordinary
    // thing that happens, and it is the only way the refund arm of the payments
    // dashboard and the finance journal has any data behind it. Tying it to the
    // cancelling member rather than inventing an unrelated refund keeps the two
    // stories consistent with each other.
    const refunded = state === 'cancelling' && i === 0
    await seedMemberPayment(teamId, {
      contactId: spec.contactId,
      purpose: 'membership',
      kind: 'membership',
      subscriptionTypeName: spec.subscriptionTypeName,
      amount: spec.amount,
      currency,
      daysAgo,
      status: failed ? 'failed' : refunded ? 'refunded' : 'succeeded',
      idSuffix: `sub${i}`,
      lineItem: {
        kind: 'subscription',
        label: spec.subscriptionTypeName,
        subscriptionTypeId: spec.subscriptionTypeId,
      },
    })
  }
}

export interface SeedMemberPaymentSpec {
  contactId: string | null
  /** Free-form purpose tag. */
  purpose: string
  /** Sale kind for display. The union is owned by `handlePaymentIntent`. */
  kind?:
    | 'product'
    | 'course'
    | 'course_block'
    | 'drop_in'
    | 'membership'
    | 'appointment'
    | 'gift_card'
    | 'policy_fee'
  /** Major units. */
  amount: number
  currency?: string
  daysAgo: number
  status?: 'succeeded' | 'failed' | 'refunded'
  /** Disambiguates the deterministic PaymentIntent id when one contact has many. */
  idSuffix: string
  /** Override the derived id — used when an entitlement already cites one and
   *  the payment must match it rather than the other way round. */
  paymentIntentId?: string
  sessionId?: string | null
  productName?: string | null
  courseName?: string | null
  subscriptionTypeName?: string | null
  /** TYPED, and that is the point. It was `Record<string, unknown>`, which let
   *  every call site below write the field names Firestore uses at the TOP level
   *  of a payment (`subscription_type_id`, `course_id`, `product_id`) instead of
   *  the ones `PaymentLineItem` declares inside `line_item`
   *  (`subscriptionTypeId`, `courseId`, `productId`). Nothing reads a snake_case
   *  key there, so every seeded row carried a line item that named nothing —
   *  `planTypeId` null, `planAttribution: 'none'`, and a contact ledger that
   *  could not say which plan a payment bought. Typecheck could not see it
   *  through an index signature; it can now. */
  lineItem?: PaymentLineItem | null
  comment?: string | null
}

/**
 * One `member_payments` row, shaped as `handlePaymentIntent` writes it.
 *
 * The doc id is the PaymentIntent id in production; here it is a deterministic
 * `pi_seed_…` so a re-run overwrites in place rather than accumulating.
 */
export async function seedMemberPayment(
  teamId: string,
  spec: SeedMemberPaymentSpec
): Promise<void> {
  const db = admin.firestore()
  const status = spec.status ?? 'succeeded'
  const amountRappen = rappen(spec.amount)
  const paymentIntentId =
    spec.paymentIntentId ?? `pi_seed_${spec.contactId ?? 'anon'}_${spec.idSuffix}`.slice(0, 80)
  const at = tsOf(daysFrom(-spec.daysAgo))
  const refunded = status === 'refunded'

  await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_PAYMENTS_SUBCOLLECTION)
    .doc(paymentIntentId)
    .set({
      teamId,
      paymentIntentId,
      // A failed intent never produced a charge, so it carries no chargeId —
      // the one field that separates "we tried" from "money moved".
      ...(status === 'failed' ? {} : { chargeId: `ch_seed_${spec.idSuffix}` }),
      contactId: spec.contactId,
      purpose: spec.purpose,
      ...(spec.kind ? { kind: spec.kind } : {}),
      ...(spec.productName ? { productName: spec.productName } : {}),
      ...(spec.courseName ? { courseName: spec.courseName } : {}),
      ...(spec.subscriptionTypeName ? { subscriptionTypeName: spec.subscriptionTypeName } : {}),
      ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      ...(spec.lineItem ? { line_item: spec.lineItem } : {}),
      ...(spec.comment ? { comment: spec.comment } : {}),
      amount: amountRappen,
      currency: (spec.currency ?? 'CHF').toLowerCase(),
      application_fee_amount: Math.round(amountRappen * SEED_FEE_PERCENT),
      status,
      amount_refunded: refunded ? amountRappen : 0,
      refunds: refunded
        ? [
            {
              refundId: `re_seed_${spec.idSuffix}`,
              amount: amountRappen,
              feeReversed: Math.round(amountRappen * SEED_FEE_PERCENT),
              reason: 'requested_by_customer',
              created_at: at,
            },
          ]
        : [],
      created_at: at,
      updated_at: at,
    })

  // ── AND THE JOURNAL ROW THE WEBHOOK WOULD HAVE WRITTEN ────────────────────
  // In production `finance_transactions` is written by the Connect webhook, not
  // by the payment write — so a seed that only wrote `member_payments` left
  // every seeded tenant with an EMPTY journal. The consequence was invisible
  // until something read it: the monthly finance report, the CSV export and the
  // per-payment "what did this book" line were all blank on every demo and
  // every local run, and looked broken rather than unseeded.
  //
  // Built with `buildConnectChargeTxn` — the SAME builder the webhook uses — so
  // the seeded row cannot drift from the real one, and the deterministic id
  // means a re-run overwrites in place. A FAILED intent is skipped: no charge
  // happened, and the journal records money events, not attempts.
  if (status !== 'failed') {
    // Stripe's published CH card pricing: 2.9% + CHF 0.30. The exact number
    // does not matter to any assertion — that it is NON-ZERO does, because a
    // zero here is what made the refund breakdown look free.
    const stripeFeeRappen = Math.round(amountRappen * 0.029) + 30
    const platformFeeRappen = Math.round(amountRappen * SEED_FEE_PERCENT)
    const txn = buildConnectChargeTxn({
      teamId,
      paymentIntentId,
      amount: amountRappen,
      currency: spec.currency ?? 'CHF',
      applicationFeeAmount: platformFeeRappen,
      // The webhook FETCHES the balance transaction, so a real row carries
      // Stripe's own fee and `fee_source: 'balance_transaction'`. Seeding
      // `fees: null` looked like the modest choice and was the wrong one: it
      // modelled the DEGRADED path as the norm, so every demo showed "this is
      // an estimate" on rows that in production are exact, and — because
      // Stripe's fee was zero — hid the fact that a refund leaves the studio
      // out of pocket by it. Seed what Stripe would actually report.
      fees: {
        stripeFee: stripeFeeRappen,
        applicationFee: platformFeeRappen,
        net: amountRappen - stripeFeeRappen - platformFeeRappen,
        balanceTxnId: `txn_seed_${spec.idSuffix}`,
      },
      kind: spec.kind ?? null,
      contactId: spec.contactId ?? null,
      occurredAtMs: daysFrom(-spec.daysAgo).getTime(),
    })
    await db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(FINANCE_TRANSACTIONS_SUBCOLLECTION)
      .doc(txn.id)
      .set({
        ...txn,
        occurred_at: tsOf(new Date(txn.occurred_at_ms)),
        recorded_at: at,
        status: 'recorded',
      })

    // A refunded payment books a SECOND row, and its numbers are the point:
    // our platform fee comes back (positive) while Stripe's does NOT (zero), so
    // the studio ends up out of pocket by Stripe's cut. Seeding only the charge
    // left every demo unable to show that.
    if (refunded) {
      const refundTxn = buildConnectRefundTxn({
        teamId,
        refundId: `re_seed_${spec.idSuffix}`,
        paymentIntentId,
        amount: amountRappen,
        feeReversed: platformFeeRappen,
        currency: spec.currency ?? 'CHF',
        kind: spec.kind ?? null,
        contactId: spec.contactId ?? null,
        occurredAtMs: daysFrom(-spec.daysAgo).getTime(),
      })
      await db
        .collection(TEAMS_COLLECTION)
        .doc(teamId)
        .collection(FINANCE_TRANSACTIONS_SUBCOLLECTION)
        .doc(refundTxn.id)
        .set({
          ...refundTxn,
          occurred_at: tsOf(new Date(refundTxn.occurred_at_ms)),
          recorded_at: at,
          status: 'recorded',
        })
    }
  }
}

/**
 * Recompute `Contact.subscription_status` and `Contact.active_subscriptions`
 * from the team's member subscriptions, exactly as `onMemberSubscriptionWrite`
 * would.
 *
 * Call it AFTER seeding subscriptions. It exists because an Admin-SDK write
 * fires no trigger in a plain seed run — and where triggers ARE running (a local
 * emulator with functions, or a deployed project), it computes the same answer
 * through the same function, so it is idempotent rather than conflicting.
 */
export async function applySubscriptionRollups(teamId: string): Promise<number> {
  const db = admin.firestore()
  const subs = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .get()

  const byContact = new Map<string, admin.firestore.DocumentData[]>()
  for (const d of subs.docs) {
    const data = d.data()
    const contactId = data.contactId as string | undefined
    if (!contactId) continue
    const list = byContact.get(contactId) ?? []
    list.push(data)
    byContact.set(contactId, list)
  }

  let updated = 0
  for (const [contactId, records] of byContact) {
    const { status, activeSubscriptions } = rollupMemberSubscriptions(records)
    const ref = db.collection(CONTACTS_COLLECTION).doc(contactId)
    const snap = await ref.get()
    if (!snap.exists || snap.data()?.teamId !== teamId) continue
    await ref.update({ subscription_status: status, active_subscriptions: activeSubscriptions })
    updated += 1
  }
  return updated
}

/**
 * Give a team a believable money history: a subscription per contact that has a
 * subscription type, one of them winding down, one in dunning — and the invoice
 * charges behind all of them.
 *
 * Reads the contacts back for the same reason the waiver fixture does: the four
 * seeders build their pools in four different shapes, and the subscription-type
 * assignment already lives on the contact document by the time this runs.
 */
export async function seedTeamMoney(opts: {
  teamId: string
  currency?: string
  /** Cap on how many contacts get a subscription. Default 8. */
  limit?: number
  /**
   * Give the FIRST eligible contact a SECOND concurrent membership on a
   * DIFFERENT active subscription type, reusing `seedMemberSubscription` (which
   * already derives a per-(contact,type) doc id, so it can't collide with the
   * first). Default true; skipped when the team has fewer than two active
   * types — there is no "different" one to give.
   *
   * Every seeded contact used to hold AT MOST one plan, so no seeded tenant
   * ever exercised "several plans held at once" — the exact case
   * `onContactSubscriptionChange`'s reconciler (`resolveHeldPlans` +
   * `planSubscriptionHistory`, `@linyup/shared/utils/subscriptionHistory`)
   * exists to get right, and the one the contacts list' multi-plan chips render.
   * `scripts/lib/fixtures/subscriptionHistory.ts` reads this back to seed a
   * REAL two-track history instead of one.
   */
  concurrentPlans?: boolean
}): Promise<{ subscriptions: number; contactsRolledUp: number }> {
  const db = admin.firestore()
  const { teamId } = opts
  const concurrentPlans = opts.concurrentPlans ?? true
  const contacts = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .limit(opts.limit ?? 8)
    .get()

  // Only contacts the seed already gave a subscription type to — inventing a
  // membership for someone the studio never sold one to would put a row on the
  // payments dashboard that contradicts the contact's own profile.
  const withType = contacts.docs.filter((d) => !!d.data().subscription_type_id)

  let subscriptions = 0
  for (let i = 0; i < withType.length; i++) {
    const d = withType[i]
    const c = d.data() as {
      subscription_type_id: string
      subscription_type_name?: string
      subscription_recurrence?: string
      subscription_amount?: number
    }
    // One winding down and one in dunning per team, and only when the team has
    // enough members that neither is the whole picture.
    const state: SeedSubscriptionState =
      withType.length >= 3 && i === 1
        ? 'cancelling'
        : withType.length >= 4 && i === 2
          ? 'past_due'
          : 'active'
    await seedMemberSubscription(teamId, {
      contactId: d.id,
      subscriptionTypeId: c.subscription_type_id,
      subscriptionTypeName: c.subscription_type_name ?? 'Membership',
      recurrence: c.subscription_recurrence ?? 'monthly',
      amount: c.subscription_amount ?? 89,
      currency: opts.currency,
      state,
      startedDaysAgo: 120 + i * 15,
    })
    subscriptions += 1
  }

  if (concurrentPlans && withType.length > 0) {
    const typesSnap = await db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
      .get()
    // `active` is default-true, same convention `seed-emulator.ts` uses when it
    // writes these docs (`public: st.active !== false`) — only an EXPLICIT
    // `false` marks a type retired.
    const activeTypes = typesSnap.docs
      .map((t) => ({
        id: t.id,
        data: t.data() as { name?: string; active?: boolean; prices?: Array<{ amount?: number; recurrence?: string }> },
      }))
      .filter((t) => t.data.active !== false)

    const firstContact = withType[0]
    const firstTypeId = (firstContact.data() as { subscription_type_id: string }).subscription_type_id
    const secondType = activeTypes.find((t) => t.id !== firstTypeId)
    if (secondType) {
      const price = secondType.data.prices?.[0]
      await seedMemberSubscription(teamId, {
        contactId: firstContact.id,
        subscriptionTypeId: secondType.id,
        subscriptionTypeName: secondType.data.name ?? secondType.id,
        recurrence: price?.recurrence ?? 'monthly',
        amount: price?.amount ?? 49,
        currency: opts.currency,
        state: 'active',
        // Started well after the first plan, so a "held two at once, one
        // newer" read is plausible rather than two identical join dates.
        startedDaysAgo: 60,
      })
      subscriptions += 1
    }
  }

  const contactsRolledUp = await applySubscriptionRollups(teamId)
  return { subscriptions, contactsRolledUp }
}

// ── One-off sales: drop-ins, course purchases, product orders ─────────────────

/**
 * The NON-MEMBERSHIP rails.
 *
 * `seedTeamMoney` only ever wrote membership invoices, so `/payments` showed a
 * studio that had never sold a drop-in, a course or a T-shirt — and the finance
 * journal inherited that same single-category shape. This fills the other rails.
 *
 * EVERY PAYMENT IS SEEDED WITH THE THING IT PAID FOR, in the same pass:
 *
 *   • a drop-in payment stamps its BOOKING `payment_status: 'paid'` +
 *     `payment_intent_id`, exactly as the Connect webhook's confirm effect does;
 *   • a course payment is written to match an entitlement that already exists,
 *     so `CoursePurchase.paymentIntentId` names a row that is really there.
 *
 * That second one is a repair, not a nicety: `seedCoursePurchase` wrote an
 * entitlement citing `pi_seed_…_course` while nothing wrote the payment, so the
 * provenance field pointed at a document that did not exist. Same half-record as
 * the phantom `bookings_count` — a reference no query can resolve.
 *
 * NOT SEEDED: paid APPOINTMENTS. A paid one is not just a row — it is a hold
 * that expires, a Checkout Session that can be resumed, and a webhook that
 * confirms it, and a ledger row cannot stand in for any of that. See
 * scripts/lib/appointments.ts.
 *
 * Run AFTER the fixtures that create bookings and entitlements, and BEFORE
 * `seedTeamFinance`, which replays every `member_payments` row into the journal.
 */
export async function seedTeamSales(opts: {
  teamId: string
  currency?: string
}): Promise<{ dropIns: number; courses: number; products: number }> {
  const db = admin.firestore()
  const { teamId } = opts
  const currency = opts.currency ?? 'CHF'
  let dropIns = 0
  let courses = 0
  let products = 0

  // ── drop-ins ────────────────────────────────────────────────────────────────
  // A drop-in is a seat someone paid for per class, so it needs a real booking
  // underneath. Take bookings the seeders already wrote rather than inventing
  // attendees nobody else knows about.
  // DETERMINISTIC selection, so a reseed overwrites the same rows instead of
  // adding more. An earlier version skipped bookings that were already paid,
  // which meant every rerun found NEW ones and the drop-in count grew — a seed
  // that is not idempotent, against this repo's own rule that deterministic ids
  // plus set() make a rerun an overwrite.
  const sessionDocs = (await db.collection(SESSIONS_COLLECTION).where('teamId', '==', teamId).get())
    .docs.filter((d) => d.data().activityType !== 'appointment')
    .sort((a, b) => a.id.localeCompare(b.id))
  for (const session of sessionDocs) {
    if (dropIns >= 3) break
    const sd = session.data()
    const bookings = (await session.ref.collection('bookings').get()).docs.sort((a, b) =>
      a.id.localeCompare(b.id)
    )
    // ONE per session. Three people paying a drop-in for the same class reads as
    // a glitch; spread across classes it reads as a studio that sells drop-ins.
    for (const b of bookings.slice(0, 1)) {
      const bd = b.data()
      const contactId = bd.contact as string | undefined
      if (!contactId) continue
      const amount = typeof sd.dropInPriceAmount === 'number' ? sd.dropInPriceAmount : 25
      const paymentIntentId = `pi_seed_${contactId}_dropin_${session.id}`.slice(0, 80)
      await seedMemberPayment(teamId, {
        contactId,
        purpose: 'drop_in',
        kind: 'drop_in',
        amount,
        currency,
        daysAgo: 5 + dropIns * 3,
        idSuffix: `dropin${dropIns}`,
        sessionId: session.id,
        comment: 'Drop-in class',
        lineItem: { kind: 'drop_in', label: 'Drop-in class' },
        paymentIntentId,
      })
      // The booking's half of the pair — the same fields the webhook stamps.
      await b.ref.set(
        { status: 'confirmed', payment_status: 'paid', payment_intent_id: paymentIntentId },
        { merge: true }
      )
      dropIns += 1
    }
  }

  // ── course purchases ────────────────────────────────────────────────────────
  const courseDocs = await db.collection(COURSES_COLLECTION).where('teamId', '==', teamId).get()
  for (const c of courseDocs.docs) {
    const purchases = await c.ref.collection(COURSE_PURCHASES_SUBCOLLECTION).get()
    for (const p of purchases.docs) {
      const pd = p.data()
      const paymentIntentId = pd.paymentIntentId as string | undefined
      if (!paymentIntentId) continue
      await seedMemberPayment(teamId, {
        contactId: p.id,
        purpose: 'course',
        kind: 'course',
        // The entitlement stores Rappen; member_payments takes major units.
        amount: ((pd.amount as number | undefined) ?? 0) / 100,
        currency: (pd.currency as string | undefined) ?? currency,
        daysAgo: 21,
        idSuffix: `course_${c.id}`,
        courseName: (c.data().title as string | undefined) ?? null,
        comment: 'Online course',
        lineItem: { kind: 'course', label: (c.data().title as string) ?? 'Course', courseId: c.id },
        paymentIntentId,
      })
      courses += 1
    }
  }

  // ── product orders ──────────────────────────────────────────────────────────
  const productDocs = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection('products')
    .limit(2)
    .get()
  const buyers = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .limit(4)
    .get()
  for (let i = 0; i < productDocs.docs.length && i < buyers.docs.length; i++) {
    const prod = productDocs.docs[i]
    const price = prod.data().priceAmount as number | undefined
    if (typeof price !== 'number') continue
    await seedMemberPayment(teamId, {
      contactId: buyers.docs[i].id,
      purpose: 'shop',
      kind: 'product',
      amount: price,
      currency,
      daysAgo: 9 + i * 4,
      idSuffix: `product_${prod.id}`,
      productName: (prod.data().name as string | undefined) ?? null,
      comment: 'Shop order',
      lineItem: { kind: 'product', label: (prod.data().name as string) ?? 'Product', productId: prod.id },
    })
    products += 1
  }

  return { dropIns, courses, products }
}
