import 'server-only'
import type { Team } from '@linyup/shared'
import type { Organization } from '@linyup/shared'
import type { SaasSubscription } from '@linyup/shared'
import type { SaasPlan, SaasStatus } from '@linyup/shared'
import {
  PLAN_PRICING,
  computePlatformMetrics,
  tenantHiddenFromPlatformMetrics,
  type AccountMetricInput,
  type PlatformMetrics,
} from '@linyup/shared'
import {
  TEAMS_COLLECTION,
  TEAM_COUNTERS_SUBCOLLECTION,
  TEAM_CONTACT_COUNTER_DOC,
  ORGANIZATIONS_COLLECTION,
  SAAS_SUBSCRIPTIONS_COLLECTION,
  USERS_COLLECTION,
} from '@linyup/shared'
import { adminDb } from '@/lib/firebase-admin'
import type { PaymentsStatus } from '@/components/status-badge'

export type AccountType = 'team' | 'org'

export interface AccountRow {
  type: AccountType
  id: string
  name: string
  plan: SaasPlan | null
  status: SaasStatus | null
  trialEndsAtMs: number | null
  /** Active contacts (teams only — orgs aggregate their teams, out of scope). */
  contactCount: number | null
  includedContacts: number | null
  ownerEmail: string | null
  createdMs: number
  /** Connect (member → studio) onboarding status. Teams only; null for orgs. */
  paymentsStatus: PaymentsStatus | null
  /** A real customer the platform bills nothing (`TenantFlags.comped`). Counted
   *  everywhere except MRR — see AccountMetricInput.comped. */
  comped: boolean
  /** Linyup's own tenant (`TenantFlags.internal`) — the demo/smoke studio. Still
   *  LISTED here (an operator has to be able to manage it) but excluded from the
   *  overview metrics, which is what the daily snapshot does too. */
  internal: boolean
  /** ORGS ONLY — active member studios, which is what the organisation pays for
   *  (the tier is priced per studio). Null for a team. */
  studioCount: number | null
  /** TEAMS ONLY — belongs to an organisation, which is the paying entity, so
   *  this row contributes nothing to MRR. See `monthlyChfFor` in @linyup/shared. */
  billedByOrg: boolean
}

/** Derive the compact Connect status from the team's payments mirror. */
function teamPaymentsStatus(team: Team): PaymentsStatus {
  const p = team.payments
  if (p?.connectEnabled === false) return 'disabled'
  if (!p?.connectAccountId) return 'not_setup'
  return (p.connectStatus as PaymentsStatus | undefined) ?? 'pending'
}

export type OverviewMetrics = PlatformMetrics & {
  recentSignups: AccountRow[]
  /**
   * Teams whose contact counter has not been written yet, and which therefore
   * contribute NOTHING to `contacts.totalActive`.
   *
   * Reported rather than hidden. The total is a sum of stored counters now, so
   * a tenant without one understates it — silently, and upwards-looking numbers
   * are the ones least likely to be questioned (the same failure
   * `lib/liveContacts.ts` in the web app exists to prevent). Nonzero here means
   * the nightly reconciliation has not run since those teams appeared; the
   * overview says so instead of quietly reporting a smaller platform.
   */
  contactCountsMissing: number
}

/** The line the overview shows when some counters are missing. */
export const CONTACT_COUNTER_NOTE =
  'Contact totals come from per-team counters, reconciled nightly. Teams counted as unknown are excluded from the total until then.'

/**
 * Live contacts per team, READ rather than counted.
 *
 * This ran one `count()` aggregation PER TEAM, in parallel, on every page view
 * of both the overview and the accounts table — a per-request fan-out that
 * grows with the TENANT count, which is the axis the platform actually scales
 * on (docs/scalability-2026-09.md §17 B8). The number now lives on
 * `teams/{id}/counters/contacts`, written by the `trackContacts` trigger and
 * reconciled nightly from an authoritative `count()`; see
 * `utils/contactCounter.ts` in shared.
 *
 * A MISSING counter is `null`, never 0. A team whose counter has never been
 * written (created since the last reconciliation, or predating the counter) is
 * not an empty studio, and a zero here would read as one — on the screen an
 * operator uses to decide who is close to their plan's cap.
 */
async function readContactCounters(teamIds: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (teamIds.length === 0) return out
  const refs = teamIds.map((id) =>
    adminDb
      .collection(TEAMS_COLLECTION)
      .doc(id)
      .collection(TEAM_COUNTERS_SUBCOLLECTION)
      .doc(TEAM_CONTACT_COUNTER_DOC),
  )
  // One round trip per chunk instead of one per team.
  const CHUNK = 300
  for (let i = 0; i < refs.length; i += CHUNK) {
    const snaps = await adminDb.getAll(...refs.slice(i, i + CHUNK))
    for (const snap of snaps) {
      const live = snap.exists ? (snap.data()?.live as unknown) : undefined
      out.set(snap.ref.parent.parent!.id, typeof live === 'number' ? live : null)
    }
  }
  return out
}

interface LoadResult {
  rows: AccountRow[]
  subscriptions: Map<string, SaasSubscription>
}

async function loadAccounts(): Promise<LoadResult> {
  const [teamsSnap, orgsSnap, subsSnap] = await Promise.all([
    adminDb.collection(TEAMS_COLLECTION).get(),
    adminDb.collection(ORGANIZATIONS_COLLECTION).get(),
    adminDb.collection(SAAS_SUBSCRIPTIONS_COLLECTION).get(),
  ])

  const subscriptions = new Map<string, SaasSubscription>()
  for (const doc of subsSnap.docs) {
    const sub = doc.data() as SaasSubscription
    subscriptions.set(sub.entity_id ?? doc.id, sub)
  }

  // Resolve owner emails for teams via users/{createdBy}.
  const ownerUids = Array.from(
    new Set(teamsSnap.docs.map((d) => (d.data() as Team).createdBy).filter(Boolean)),
  )
  const ownerEmail = new Map<string, string>()
  if (ownerUids.length) {
    const refs = ownerUids.map((uid) => adminDb.collection(USERS_COLLECTION).doc(uid))
    const userDocs = await adminDb.getAll(...refs)
    for (const ud of userDocs) {
      const email = (ud.data() as { email?: string } | undefined)?.email
      if (email) ownerEmail.set(ud.id, email)
    }
  }

  // Live-contact counts per team, read from the stored counters.
  const teamIds = teamsSnap.docs.map((d) => d.id)
  const contactCount = await readContactCounters(teamIds)

  // Studios per organisation — the organisation tier is priced per studio, so
  // this is its subscription amount rather than a statistic. Counted from the
  // teams already loaded: `Team.org_id` is written in the same batch as the
  // membership row, so no extra read is needed.
  const studiosPerOrg = new Map<string, number>()
  for (const doc of teamsSnap.docs) {
    const orgId = (doc.data() as Team).org_id
    if (orgId) studiosPerOrg.set(orgId, (studiosPerOrg.get(orgId) ?? 0) + 1)
  }

  const rows: AccountRow[] = []

  for (const doc of teamsSnap.docs) {
    const team = doc.data() as Team
    const sub = subscriptions.get(doc.id)
    const plan = sub?.plan ?? team.plan ?? null
    const status = sub?.status ?? team.plan_status ?? null
    const trialEndsAtMs = sub?.trial_ends_at?.toMillis?.() ?? team.trial_ends_at?.toMillis?.() ?? null
    rows.push({
      type: 'team',
      id: doc.id,
      name: team.name ?? '(unnamed team)',
      plan,
      status,
      trialEndsAtMs,
      contactCount: contactCount.get(doc.id) ?? null,
      includedContacts: plan ? PLAN_PRICING[plan].includedContacts : null,
      ownerEmail: ownerEmail.get(team.createdBy) ?? null,
      createdMs: team.created?.toMillis?.() ?? 0,
      paymentsStatus: teamPaymentsStatus(team),
      comped: team.flags?.comped === true,
      internal: tenantHiddenFromPlatformMetrics(team.flags),
      studioCount: null,
      billedByOrg: typeof team.org_id === 'string' && team.org_id.length > 0,
    })
  }

  for (const doc of orgsSnap.docs) {
    const org = doc.data() as Organization
    const sub = subscriptions.get(doc.id)
    const plan = sub?.plan ?? org.plan ?? 'organization'
    const status = sub?.status ?? org.plan_status ?? null
    rows.push({
      type: 'org',
      id: doc.id,
      name: org.name ?? '(unnamed org)',
      plan,
      status,
      trialEndsAtMs: sub?.trial_ends_at?.toMillis?.() ?? null,
      contactCount: null,
      includedContacts: plan ? PLAN_PRICING[plan].includedContacts : null,
      ownerEmail: ownerEmail.get(org.createdBy) ?? null,
      createdMs: org.created?.toMillis?.() ?? 0,
      paymentsStatus: null,
      comped: org.flags?.comped === true,
      internal: tenantHiddenFromPlatformMetrics(org.flags),
      studioCount: studiosPerOrg.get(doc.id) ?? 0,
      billedByOrg: false,
    })
  }

  rows.sort((a, b) => b.createdMs - a.createdMs)
  return { rows, subscriptions }
}

export interface AccountFilters {
  search?: string
  plan?: SaasPlan
  status?: SaasStatus
}

export async function listAccounts(filters: AccountFilters = {}): Promise<AccountRow[]> {
  const { rows } = await loadAccounts()
  const search = filters.search?.trim().toLowerCase()
  return rows.filter((r) => {
    if (filters.plan && r.plan !== filters.plan) return false
    if (filters.status && r.status !== filters.status) return false
    if (search) {
      const hay = `${r.name} ${r.ownerEmail ?? ''}`.toLowerCase()
      if (!hay.includes(search)) return false
    }
    return true
  })
}

/** Map an account row to the reducer input shape. */
function toMetricInput(r: AccountRow): AccountMetricInput {
  return {
    type: r.type,
    plan: r.plan,
    status: r.status,
    createdMs: r.createdMs,
    trialEndsAtMs: r.trialEndsAtMs,
    contactCount: r.contactCount,
    comped: r.comped,
    studioCount: r.studioCount,
    billedByOrg: r.billedByOrg,
  }
}

export async function getOverviewMetrics(nowMs: number): Promise<OverviewMetrics> {
  const { rows } = await loadAccounts()
  // Same reducer AND the same exclusion the daily snapshot applies. The reducer
  // was already shared and the comment already claimed "single source of truth",
  // but the filter was not — so an internal tenant left the snapshot and stayed
  // in these KPIs, and the two disagreed by exactly one studio.
  const counted = rows.filter((r) => !r.internal)
  const metrics = computePlatformMetrics(counted.map(toMetricInput), nowMs)
  const contactCountsMissing = counted.filter(
    (r) => r.type === 'team' && r.contactCount == null,
  ).length
  // Recent signups is a LIST, not a metric — it keeps every row, so a newly
  // provisioned demo tenant is visible to the operator who just made it.
  return { ...metrics, recentSignups: rows.slice(0, 8), contactCountsMissing }
}
