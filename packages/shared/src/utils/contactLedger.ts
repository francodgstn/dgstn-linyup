// THE contact "Overview" ledger — one period-scoped answer to the only question
// a studio actually asks a contact's money page: "in period X, what did this
// person pay for, and what plan or allowance did they hold while they paid it?"
//
// It lives here, pure, for the same reason `subscriptionRollup` does: the answer
// has to be identical wherever it is asked. The contact detail page renders it,
// but nothing about it is React — plain numbers in, plain rows out.
//
// DELIBERATELY MINIMAL, PROJECTED INPUTS. This takes `{ paymentId, atMs,
// amountMinor, … }`, not `UnifiedPaymentRow`, not a `MemberPayment`, and not a
// Firestore `Timestamp`. Following `detectByoStripeDoubleRecording`, which takes
// `{ gateway, raw_status, processedAtMs }` rather than a whole `payment_events`
// document: the projection is what lets this sit in `shared` at all, and it is
// what lets the Connect rail and the BYO rail — whose stored shapes agree about
// almost nothing — be answered by ONE implementation instead of two that drift.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROHIBITION. A payment's plan attribution is either SUPPLIED or ABSENT.
// This module NEVER infers one — not from a plan span that happens to overlap
// the payment's date, not from the contact's current plan, and not from
// proximity in time to a neighboring attributed payment. Two independent
// reasons, either of which alone is disqualifying:
//
//   1. THE LINK IS TO A TYPE, NEVER TO AN INSTANCE. `PaymentLineItem` carries
//      `subscriptionTypeId` — the studio's plan type. Nothing in the system
//      writes a subscription *instance* id onto a payment, so an overlapping
//      span is not evidence that THIS payment paid for THAT subscription. A
//      contact holding two plans at once (or the same plan twice, resubscribed)
//      makes every overlap-based guess a coin flip, and the guess would be
//      rendered indistinguishably from a real attribution.
//
//   2. THE ABSENCE IS STRUCTURAL, NOT NOISE. The plan id is genuinely missing on
//      a real slice of rows: legacy rows written before line items existed, a
//      renewal whose payment webhook landed ahead of its subscription webhook,
//      and a BYO gateway row whose label is a per-gateway default rather than a
//      link. These are not almost-attributed rows waiting to be repaired — they
//      are rows about which the studio's own data says nothing, and a filled-in
//      guess destroys the only signal that says so.
//
// So `attribution: 'none'` goes in and `attribution: 'none'` comes out, and
// `flags.hasUnattributed` reports it honestly instead of hiding it.
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT IS NOT HERE: historical credit BALANCE. A credit pack records a total and
// a bare `creditsUsed` counter with no per-spend timeline, so "how many credits
// did they have on 3 March" is not reconstructible from the stored data and is
// not attempted. Grant WINDOWS are reconstructible — a grant happened at a known
// instant and expires at a known instant — so those are events the ledger emits;
// the pack's counters ride along on the grant unchanged and must never be
// presented as an as-of-that-date figure.

/** Where a payment's plan link came from — or that there is none. */
export type LedgerAttribution = 'line_item' | 'legacy_field' | 'none'

/**
 * The projection of one payment row (Connect `member_payments` or BYO
 * `payment_events`, already normalized by the caller) that the ledger reads.
 */
export interface LedgerPaymentInput {
  paymentId: string
  /** Epoch ms. A row that cannot be dated cannot be placed in the window. */
  atMs: number
  amountMinor: number
  refundedMinor: number
  currency: string
  /** "What was paid", already resolved by the caller (line item → comment → default). */
  label: string
  /** Raw gateway status, passed through — this module never interprets it. */
  status: string
  /** Un-recorded manual row: inert, counts toward no total. */
  voided: boolean
  /** The plan TYPE this payment is linked to, never a subscription instance. */
  planTypeId: string | null
  planName: string | null
  attribution: LedgerAttribution
  gateway: string
}

/** One stretch of time a contact held a plan. `endMs: null` = still open. */
export interface LedgerPlanSpanInput {
  id: string
  typeId: string | null
  planName: string
  startMs: number
  /** null = open-ended; an open span never produces a `plan_ended` row. */
  endMs: number | null
  terminationReason?: string | null
}

/** One credit grant (a pack sold, or credits given). */
export interface LedgerCreditGrantInput {
  id: string
  planName: string | null
  typeId: string | null
  createdAtMs: number
  expiresAtMs: number | null
  creditsTotal: number
  /** CURRENT counter — see the module header: never an as-of-a-date figure. */
  creditsUsed: number
  source: 'stripe' | 'manual' | 'seed'
  /** The payment that bought it, when one exists. */
  paymentRef: string | null
}

export type LedgerRow =
  | { kind: 'payment'; atMs: number; payment: LedgerPaymentInput; grant?: LedgerCreditGrantInput }
  | { kind: 'plan_started'; atMs: number; planName: string; typeId: string | null }
  | {
      kind: 'plan_ended'
      atMs: number
      planName: string
      typeId: string | null
      reason?: string | null
    }
  | { kind: 'credit_granted'; atMs: number; grant: LedgerCreditGrantInput }
  | { kind: 'credit_expired'; atMs: number; grant: LedgerCreditGrantInput }

export interface LedgerTotal {
  currency: string
  grossMinor: number
  refundedMinor: number
  netMinor: number
  count: number
}

export interface LedgerResult {
  /** Newest first. */
  rows: LedgerRow[]
  /**
   * What the contact already held when the window opened.
   *
   * THIS IS THE POINT OF THE WHOLE MODULE. A 30-day window over a two-year
   * membership contains zero plan events, so a ledger without this shows a
   * column of payments against an apparently plan-less contact — the reader
   * concludes the plan history is missing when in fact nothing happened in the
   * period they chose. Empty when `fromMs` is null, because then every event
   * there has ever been is already a row.
   */
  openingState: {
    plans: { planName: string; typeId: string | null; sinceMs: number }[]
  }
  /** PER CURRENCY — money in different currencies is never summed. */
  totals: LedgerTotal[]
  flags: {
    /** At least one in-window payment carries no plan link at all. */
    hasUnattributed: boolean
    /**
     * Plan type ids that an in-window payment is attributed to, but for which no
     * supplied span covers that payment's date. The honest, COMPUTED signal that
     * the plan history handed in is incomplete for this contact — it replaces a
     * blanket "history may be incomplete" disclaimer that was equally true and
     * equally useless on every contact.
     */
    attributedTypesWithoutSpan: string[]
  }
}

/**
 * At an equal instant, ties break by kind in this order. The payment leads
 * because it is the thing the page is about; the plan and credit events sharing
 * its timestamp are its consequences and read as such underneath it.
 */
const KIND_RANK: Record<LedgerRow['kind'], number> = {
  payment: 0,
  plan_started: 1,
  plan_ended: 2,
  credit_granted: 3,
  credit_expired: 4,
}

function finiteMs(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function minorUnits(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.round(v)
}

/** Bucket key AND display value: 'chf' and 'CHF' are one currency, not two. */
function currencyKey(c: unknown): string {
  return typeof c === 'string' ? c.trim().toUpperCase() : ''
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Build the period-scoped ledger for one contact.
 *
 * The window is `[fromMs, toMs]`, both ends INCLUSIVE; `fromMs: null` means all
 * time. Inputs may arrive in any order and may contain an open span, a grant
 * with no expiry, or nothing at all.
 *
 * Undated rows are dropped rather than counted, the same rule
 * `detectByoStripeDoubleRecording` applies: a row that cannot be placed in the
 * window cannot support a claim about the window, and silently sorting it to
 * epoch 0 is worse than omitting it.
 */
export function buildContactLedger(input: {
  payments: LedgerPaymentInput[]
  planSpans: LedgerPlanSpanInput[]
  creditGrants: LedgerCreditGrantInput[]
  fromMs: number | null
  toMs: number
}): LedgerResult {
  const from = input.fromMs == null ? null : finiteMs(input.fromMs)
  const to = finiteMs(input.toMs) ?? Number.POSITIVE_INFINITY
  const payments = input.payments ?? []
  const planSpans = input.planSpans ?? []
  const creditGrants = input.creditGrants ?? []

  const inWindow = (ms: number): boolean => (from === null || ms >= from) && ms <= to

  // ── payments in window ────────────────────────────────────────────────────
  const windowPayments: { p: LedgerPaymentInput; atMs: number }[] = []
  for (const p of payments) {
    const at = finiteMs(p?.atMs)
    if (at == null || !inWindow(at)) continue
    windowPayments.push({ p, atMs: at })
  }

  // ── the ONE exact join ────────────────────────────────────────────────────
  // A grant attaches to a payment ROW only when that payment is itself in the
  // window; otherwise there is no row to attach to and the grant speaks for
  // itself. Grants are walked in a deterministic order so that the (pathological)
  // case of two grants naming one payment always resolves the same way.
  const paymentById = new Map<string, LedgerPaymentInput>()
  for (const { p } of windowPayments) {
    const id = text(p.paymentId)
    if (id && !paymentById.has(id)) paymentById.set(id, p)
  }

  const sortedGrants = [...creditGrants].sort((a, b) => {
    const ax = finiteMs(a?.createdAtMs) ?? 0
    const bx = finiteMs(b?.createdAtMs) ?? 0
    if (ax !== bx) return ax - bx
    return text(a?.id) < text(b?.id) ? -1 : text(a?.id) > text(b?.id) ? 1 : 0
  })

  /** paymentId → the grant rendered inside its row. */
  const grantForPayment = new Map<string, LedgerCreditGrantInput>()
  /** Grants that found a home and so must NOT also emit a `credit_granted` row. */
  const joinedGrantIds = new Set<string>()
  for (const g of sortedGrants) {
    // `paymentRef` first, then the grant's own doc id — the Stripe rail keys a
    // grant on the payment that bought it, and older rows only carry the ref.
    const ref = text(g?.paymentRef)
    const own = text(g?.id)
    const target =
      (ref && paymentById.has(ref) && ref) || (own && paymentById.has(own) && own) || ''
    if (!target || grantForPayment.has(target)) continue
    grantForPayment.set(target, g)
    joinedGrantIds.add(own)
  }

  // ── rows ──────────────────────────────────────────────────────────────────
  const emitted: { row: LedgerRow; id: string }[] = []

  for (const { p, atMs } of windowPayments) {
    const grant = grantForPayment.get(text(p.paymentId))
    emitted.push({
      row: grant
        ? { kind: 'payment', atMs, payment: p, grant }
        : { kind: 'payment', atMs, payment: p },
      id: text(p.paymentId),
    })
  }

  const openingPlans: { planName: string; typeId: string | null; sinceMs: number; id: string }[] =
    []
  for (const span of planSpans) {
    const start = finiteMs(span?.startMs)
    const end = span?.endMs == null ? null : finiteMs(span.endMs)
    if (start == null) continue
    const id = text(span.id)

    if (inWindow(start)) {
      emitted.push({
        row: {
          kind: 'plan_started',
          atMs: start,
          planName: span.planName,
          typeId: span.typeId ?? null,
        },
        id,
      })
    } else if (from !== null && start < from && (end == null || end >= from)) {
      // Started before the window and had not ended by the time it opened.
      openingPlans.push({
        planName: span.planName,
        typeId: span.typeId ?? null,
        sinceMs: start,
        id,
      })
    }

    // An OPEN span never ends: `endMs: null` is "still running", not "unknown".
    if (end != null && inWindow(end)) {
      emitted.push({
        row: {
          kind: 'plan_ended',
          atMs: end,
          planName: span.planName,
          typeId: span.typeId ?? null,
          reason: span.terminationReason ?? null,
        },
        id,
      })
    }
  }

  for (const g of sortedGrants) {
    const id = text(g?.id)
    const created = finiteMs(g?.createdAtMs)
    if (created != null && inWindow(created) && !joinedGrantIds.has(id)) {
      emitted.push({ row: { kind: 'credit_granted', atMs: created, grant: g }, id })
    }
    // Expiry is an event of its own: a grant that rode along inside a payment
    // row still expires, and that expiry is a separate instant worth showing.
    // `inWindow` already bounds it at `toMs`, which is exactly "has passed" —
    // a future expiry is a fact about the pack, not something that happened.
    const expires = g?.expiresAtMs == null ? null : finiteMs(g.expiresAtMs)
    if (expires != null && expires <= to && inWindow(expires)) {
      emitted.push({ row: { kind: 'credit_expired', atMs: expires, grant: g }, id })
    }
  }

  emitted.sort((a, b) => {
    if (b.row.atMs !== a.row.atMs) return b.row.atMs - a.row.atMs
    const rank = KIND_RANK[a.row.kind] - KIND_RANK[b.row.kind]
    if (rank !== 0) return rank
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  // ── totals, PER CURRENCY ──────────────────────────────────────────────────
  // Voided rows are excluded entirely (they are un-recorded, not refunded).
  // Nothing else is filtered by status: this module does not interpret a
  // gateway's status vocabulary — the caller hands in the rows it wants counted.
  const byCurrency = new Map<string, LedgerTotal>()
  for (const { p } of windowPayments) {
    if (p.voided) continue
    const currency = currencyKey(p.currency)
    let t = byCurrency.get(currency)
    if (!t) {
      t = { currency, grossMinor: 0, refundedMinor: 0, netMinor: 0, count: 0 }
      byCurrency.set(currency, t)
    }
    t.grossMinor += minorUnits(p.amountMinor)
    t.refundedMinor += minorUnits(p.refundedMinor)
    t.count += 1
  }
  for (const t of byCurrency.values()) t.netMinor = t.grossMinor - t.refundedMinor

  const totals = [...byCurrency.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0
  })

  // ── flags ─────────────────────────────────────────────────────────────────
  let hasUnattributed = false
  const typesWithoutSpan = new Set<string>()
  for (const { p, atMs } of windowPayments) {
    if (p.voided) continue // an un-recorded row proves nothing about plan history
    if (p.attribution === 'none') {
      hasUnattributed = true
      continue
    }
    const typeId = text(p.planTypeId)
    if (!typeId) continue
    const covered = planSpans.some((span) => {
      if (text(span?.typeId) !== typeId) return false
      const start = finiteMs(span?.startMs)
      if (start == null || start > atMs) return false
      const end = span?.endMs == null ? null : finiteMs(span.endMs)
      return end == null || atMs <= end
    })
    if (!covered) typesWithoutSpan.add(typeId)
  }

  return {
    rows: emitted.map((e) => e.row),
    openingState: {
      plans: openingPlans
        .sort((a, b) => {
          if (b.sinceMs !== a.sinceMs) return b.sinceMs - a.sinceMs
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        })
        .map(({ planName, typeId, sinceMs }) => ({ planName, typeId, sinceMs })),
    },
    totals,
    flags: {
      hasUnattributed,
      attributedTypesWithoutSpan: [...typesWithoutSpan].sort(),
    },
  }
}
