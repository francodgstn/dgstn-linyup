import type { SaasPlan, SaasStatus } from './team'
import { ORG_MIN_STUDIOS, PLAN_PRICING, orgMonthlyForStudios } from './plan'

// ─── Platform-wide operator metrics ─────────────────────────────────────────
// A single source of truth for the operator console. The same pure reducer
// powers BOTH the live Overview (admin app, Admin SDK) and the daily snapshot
// (capturePlatformMetrics Cloud Function) so the two can never drift.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/** One account (team or org) reduced to just the fields metrics need. */
export interface AccountMetricInput {
  type: 'team' | 'org'
  plan: SaasPlan | null
  status: SaasStatus | null
  createdMs: number
  trialEndsAtMs: number | null
  /** Active contacts (teams only); null for orgs (they aggregate their teams). */
  contactCount: number | null
  /**
   * A REAL customer the platform bills nothing (`TenantFlags.comped`).
   *
   * COUNTED in every account, contact and signup figure — that is the whole
   * point of the flag, and hiding them (as `internal` does) would understate the
   * platform at exactly the moment its largest tenant arrives. But EXCLUDED from
   * MRR: a comped org sits on `plan_status: 'active'` with no Stripe
   * subscription, so charging it the plan's list price to the revenue line would
   * invent money that no invoice exists for.
   */
  comped?: boolean
  /**
   * ORGS ONLY — active member studios, which is what the organisation is billed
   * for (`orgMonthlyForStudios`). Absent falls back to the tier's minimum, which
   * under-states rather than invents.
   */
  studioCount?: number | null
  /**
   * TEAMS ONLY — this studio belongs to an organisation, so the ORGANISATION is
   * the paying entity and this row contributes nothing to MRR.
   *
   * Without it every member studio was counted at the organisation tier's own
   * price: a five-studio federation reported six subscriptions rather than one.
   */
  billedByOrg?: boolean
}

export interface PlatformMetrics {
  accounts: {
    total: number
    teams: number
    orgs: number
    byStatus: Record<SaasStatus, number>
    byPlan: Record<SaasPlan, number>
    /** Of `total`, how many are comped — real usage that bills nothing. Reported
     *  separately so "active accounts" and "paying accounts" stop being read as
     *  the same number. */
    comped: number
  }
  /** Indicative MRR in CHF from active subscriptions (Stripe is authoritative). */
  mrr: { estimatedChf: number; byPlan: Record<SaasPlan, number> }
  contacts: { totalActive: number }
  trials: { active: number; expiring7d: number }
  signups: { last7d: number; last30d: number; cumulative: number }
}

/**
 * What ONE account contributes to MRR each month.
 *
 * ── THE PAYING ENTITY IS THE ORGANISATION, NOT ITS STUDIOS ──────────────────
 * Joining an organisation sets a studio's `plan` to 'organization', and this
 * reducer receives every studio AND the org as separate rows — so charging each
 * row the tier's price counted a five-studio federation as six subscriptions.
 * At the old CHF 79 base that reported 474 against a true 139 (Franco,
 * 2026-08-28: attribute the payment to the org, not the single teams).
 *
 * ── AND THE ORGANISATION'S PRICE IS NOT A SCALAR ────────────────────────────
 * It is CHF 25 per studio, so it cannot be read off `PLAN_PRICING.baseMonthly`
 * like the other three — that field is 0 for this tier, deliberately, and a
 * reducer that trusted it would report every federation as free.
 */
function monthlyChfFor(a: AccountMetricInput): number {
  if (a.type === 'team' && a.billedByOrg) return 0
  if (a.type === 'org') return orgMonthlyForStudios(a.studioCount ?? ORG_MIN_STUDIOS)
  return PLAN_PRICING[a.plan!].baseMonthly
}

const emptyStatus = (): Record<SaasStatus, number> => ({
  trial: 0,
  active: 0,
  past_due: 0,
  cancelled: 0,
  expired: 0,
})

const emptyPlan = (): Record<SaasPlan, number> => ({ free: 0, coach: 0, studio: 0, organization: 0 })

export function computePlatformMetrics(
  accounts: AccountMetricInput[],
  nowMs: number,
): PlatformMetrics {
  const byStatus = emptyStatus()
  const byPlan = emptyPlan()
  const mrrByPlan = emptyPlan()
  let teams = 0
  let orgs = 0
  let totalActive = 0
  let estimatedChf = 0
  let trialsActive = 0
  let trialsExpiring7d = 0
  let last7d = 0
  let last30d = 0
  let comped = 0

  for (const a of accounts) {
    if (a.type === 'org') orgs += 1
    else teams += 1
    if (a.status) byStatus[a.status] += 1
    if (a.plan) byPlan[a.plan] += 1
    if (a.contactCount) totalActive += a.contactCount
    if (a.comped) comped += 1

    const age = nowMs - a.createdMs
    if (age <= SEVEN_DAYS_MS) last7d += 1
    if (age <= THIRTY_DAYS_MS) last30d += 1

    if (a.status === 'trial') {
      trialsActive += 1
      if (a.trialEndsAtMs != null && a.trialEndsAtMs >= nowMs && a.trialEndsAtMs <= nowMs + SEVEN_DAYS_MS) {
        trialsExpiring7d += 1
      }
    }

    // MRR: only paying (active) subscriptions count. No per-contact overage
    // (caps are enforced by upgrade/blocks, not metering).
    // A COMPED account is 'active' and has a plan, and pays nothing for it.
    if (a.status === 'active' && a.plan && !a.comped) {
      const amount = monthlyChfFor(a)
      estimatedChf += amount
      mrrByPlan[a.plan] += amount
    }
  }

  return {
    accounts: { total: accounts.length, teams, orgs, byStatus, byPlan, comped },
    mrr: { estimatedChf, byPlan: mrrByPlan },
    contacts: { totalActive },
    trials: { active: trialsActive, expiring7d: trialsExpiring7d },
    signups: { last7d, last30d, cumulative: accounts.length },
  }
}

// ─── Stored snapshot ────────────────────────────────────────────────────────
// Persisted at platform_metrics/{YYYY-MM-DD}. snake_case to match Firestore
// conventions elsewhere in the repo. `captured_at` (a server Timestamp) is
// added by the writer and is not part of this serializable mapping.

/**
 * Outbound email volume for the snapshot day.
 *
 * NOT derived from `AccountMetricInput` — it is aggregated over the `mail_sends`
 * ledger, so it is written onto the snapshot doc by the capture job rather than
 * produced by `platformMetricsToDoc`, and it is OPTIONAL: every snapshot taken
 * before the ledger became a complete send log has no mail block at all, and a
 * reader that treated an absent block as zero would draw a flat line through
 * the whole pre-change history.
 *
 * `capturePlatformMetrics` writes it (via `capturePlatformMailMetrics`,
 * packages/functions/src/mail/mailMetrics.ts), omitting the block when the
 * aggregation fails. Readers must keep tolerating an absent block: every
 * snapshot from before that wiring landed has none.
 *
 * `*_yesterday` counts the calendar day BEFORE `date`, in Europe/Zurich — the
 * capture runs shortly after midnight, so the day it can report in full is the
 * one that just ended. Both studio mail and Linyup's own system mail count
 * here; the per-studio figures in the operator console are `team_id`-scoped and
 * so cover studio mail only.
 */
export interface PlatformMailMetrics {
  /** ADDRESSES handed to the provider — a ledger row is one provider call and
   *  may carry several, so this sums `recipient_count` rather than counting
   *  rows. "Emails", as an operator reads the word. */
  sent_yesterday: number
  /** SENDS dropped before the provider. Not addresses: a suppressed row reached
   *  nobody and carries `recipient_count: 0`. */
  suppressed_yesterday: number
  /** As `sent_yesterday`, since the ledger became complete — CARRIED FORWARD
   *  from the previous snapshot plus the days since, never re-summed over the
   *  ledger, which ages out after `LEDGER_RETENTION_DAYS.mail_sends`. The
   *  operator console's "total" reads this, not the ledger. */
  sent_cumulative: number
}

/**
 * Member-app adoption derived from OUR OWN data (`Contact.mobile_app`), not
 * from either store.
 *
 * Needs no credential and works today, which is the point: the App Store and
 * Play both report nothing until the app is published, while this is measurable
 * from the moment somebody opens the app. It answers the question a store
 * dashboard cannot — how many people are on an OLD build — because the store
 * knows about downloads and this knows about what is actually running.
 *
 * OPTIONAL for the same reason `PlatformMailMetrics` is: a day whose
 * aggregation fails LACKS the block. A zero here would claim nobody was running
 * the app, which is a different and much more alarming statement than "we could
 * not count".
 *
 * A contact counts as an install once it has ever written telemetry — there is
 * no uninstall signal in it, so `installs_seen` only ever grows. `active_30d`
 * is the figure to read as "people still using it".
 */
export interface PlatformMobileMetrics {
  /** Contacts that have ever written `mobile_app` telemetry — i.e. opened the app. */
  installs_seen: number
  /** Of those, seen in the last 30 days (`last_seen_at`). */
  active_30d: number
  /** App version → contacts. Key '(unknown)' when telemetry carries no version. */
  by_version: Record<string, number>
  /** OTA channel → contacts. Key '(unknown)' when absent. */
  by_ota_channel: Record<string, number>
  /** Still on the build's embedded update — no OTA has applied. */
  embedded: number
}

export interface PlatformMetricsDoc {
  date: string
  mail?: PlatformMailMetrics
  mobile?: PlatformMobileMetrics
  accounts: {
    total: number
    teams: number
    orgs: number
    by_status: Record<SaasStatus, number>
    by_plan: Record<SaasPlan, number>
    comped: number
  }
  mrr: { estimated_chf: number; by_plan: Record<SaasPlan, number> }
  contacts: { total_active: number }
  trials: { active: number; expiring_7d: number }
  signups: { last_7d: number; last_30d: number; cumulative: number }
}

export function platformMetricsToDoc(date: string, m: PlatformMetrics): PlatformMetricsDoc {
  return {
    date,
    accounts: {
      total: m.accounts.total,
      teams: m.accounts.teams,
      orgs: m.accounts.orgs,
      by_status: m.accounts.byStatus,
      by_plan: m.accounts.byPlan,
      comped: m.accounts.comped,
    },
    mrr: { estimated_chf: m.mrr.estimatedChf, by_plan: m.mrr.byPlan },
    contacts: { total_active: m.contacts.totalActive },
    trials: { active: m.trials.active, expiring_7d: m.trials.expiring7d },
    signups: {
      last_7d: m.signups.last7d,
      last_30d: m.signups.last30d,
      cumulative: m.signups.cumulative,
    },
  }
}
