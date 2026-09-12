/* eslint-disable no-console */
// GOOGLE CLOUD SPEND, pushed to us by the billing budget.
//
// ── WHY THIS AND NOT A COST API ─────────────────────────────────────────────
// There is no Cloud Billing API call that returns consumption. `cloudbilling`
// serves billing-account metadata and the SKU price catalogue; actual cost data
// otherwise means enabling a BigQuery billing export — opt-in, hours of delay,
// and billable itself — which is a lot of machinery for one number on one page.
//
// A billing budget, which we already run for the alerts (infra/modules/budget),
// publishes its evaluation to a Pub/Sub topic for free, several times a day,
// carrying both the month-to-date cost and the budget it is measured against.
// So the budget does double duty: it pages a human on a runaway, and it is the
// cost feed. Nothing new is provisioned but a topic.
//
// ── WHAT ARRIVES ────────────────────────────────────────────────────────────
// The message data is base64 JSON with the fields below. `costAmount` and
// `budgetAmount` are numbers in `currencyCode`; `costIntervalStart` is an
// RFC3339 instant at the start of the BILLING PERIOD, which is why the figure
// this writes is month-to-date rather than daily. Fields are treated as
// optional throughout: this is an external payload, the shape can change under
// us, and a missing `costAmount` must mean "write nothing" rather than zero.
//
// ── IDEMPOTENCE ─────────────────────────────────────────────────────────────
// Pub/Sub is at-least-once, and the handler is a last-writer-wins merge of one
// map onto today's snapshot doc — so a redelivery rewrites the same fields with
// the same values and there is nothing to guard. The one ordering hazard is a
// redelivery of an OLDER message arriving after a newer one, which would move
// the cost figure backwards; `received_at_ms` is compared before writing so a
// stale message is dropped rather than applied.
import * as admin from 'firebase-admin'
import { onMessagePublished } from 'firebase-functions/v2/pubsub'
import { FieldValue } from 'firebase-admin/firestore'
import {
  PLATFORM_METRICS_COLLECTION,
  type GcpCostSnapshot,
  type PlatformMetricsDoc,
} from '@linyup/shared'
import { to } from '../utils/async'

/** The topic terraform creates (infra/modules/budget). Must match exactly. */
export const BILLING_BUDGET_TOPIC = 'linyup-billing-budget'

/** Date key in the business timezone, matching `capturePlatformMetrics`. */
function dateKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(now)
}

interface BudgetNotification {
  budgetDisplayName?: unknown
  costAmount?: unknown
  budgetAmount?: unknown
  currencyCode?: unknown
  costIntervalStart?: unknown
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** RFC3339 → 'YYYY-MM-DD', or null if it is not a usable instant. */
function intervalStartDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null
}

/**
 * PURE — the whole decision, so it can be tested without Pub/Sub or Firestore.
 * Returns the block to write, or null when the payload cannot support one.
 */
export function budgetNotificationToSnapshot(
  payload: unknown,
  receivedAtMs: number,
): GcpCostSnapshot | null {
  if (!payload || typeof payload !== 'object') return null
  const n = payload as BudgetNotification

  // The cost is the only field worth writing for. A notification without it
  // (a malformed message, or a schema change) writes NOTHING — a zero here
  // would read as "we spent nothing this month", which is a claim, not a gap.
  const cost = asNumber(n.costAmount)
  if (cost === null) return null

  const currency = typeof n.currencyCode === 'string' && n.currencyCode ? n.currencyCode : null
  if (!currency) return null

  return {
    month_to_date: cost,
    budget_amount: asNumber(n.budgetAmount),
    currency,
    interval_start: intervalStartDate(n.costIntervalStart),
    received_at_ms: receivedAtMs,
  }
}

export const handleBudgetNotification = onMessagePublished(
  { topic: BILLING_BUDGET_TOPIC, retry: false },
  async (event) => {
    const receivedAtMs = Date.now()

    // `event.data.message.json` throws on a non-JSON body; the raw base64 is
    // the fallback, and an unparseable message is dropped with a log rather
    // than retried — a malformed payload will not become well-formed.
    let payload: unknown
    try {
      payload = event.data.message.json
    } catch {
      console.error('[budget-cost] message body was not JSON; dropping')
      return
    }

    const block = budgetNotificationToSnapshot(payload, receivedAtMs)
    if (!block) {
      console.warn('[budget-cost] notification carried no usable cost; wrote nothing')
      return
    }

    const db = admin.firestore()
    const date = dateKey()
    const ref = db.collection(PLATFORM_METRICS_COLLECTION).doc(date)

    // Drop a message that is older than what is already recorded for today.
    // Pub/Sub can redeliver out of order, and the cost figure only ever moves
    // forward within a billing period — letting a stale redelivery overwrite a
    // newer one would show spend going down.
    const [readErr, existing] = await to(ref.get())
    if (readErr) {
      console.error('[budget-cost] could not read the day snapshot', readErr)
      return
    }
    const priorMs = (existing?.data() as PlatformMetricsDoc | undefined)?.providers?.gcp
      ?.received_at_ms
    if (typeof priorMs === 'number' && priorMs > block.received_at_ms) {
      console.log('[budget-cost] a newer reading is already stored; dropping this one')
      return
    }

    // `merge: true` DEEP-merges the nested map, which is load-bearing here and
    // for once desirable: `providers.brevo` / `providers.deepl` are written by
    // the daily capture job and must survive this write, and vice versa. (Note
    // the same behaviour is a documented HAZARD where a partial write must not
    // leave stale siblings standing — see the cancellation-record rules in
    // CLAUDE.md. Here the two writers own disjoint keys by construction.)
    const [writeErr] = await to(
      ref.set(
        {
          date,
          providers: { gcp: block },
          providers_updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ),
    )
    if (writeErr) {
      console.error('[budget-cost] write failed', writeErr)
      return
    }
    console.log(
      `[budget-cost] ${date}: ${block.month_to_date} ${block.currency} month-to-date` +
        (block.budget_amount !== null ? ` of ${block.budget_amount}` : ''),
    )
  },
)
