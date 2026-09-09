import { onSchedule } from 'firebase-functions/v2/scheduler'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { to } from '../utils/async'
import { capturePlatformMailMetrics } from '../mail/mailMetrics'
import { capturePlatformMobileMetrics } from './mobileAdoptionMetrics'
import {
  computePlatformMetrics,
  platformMetricsToDoc,
  tenantHiddenFromPlatformMetrics,
  type AccountMetricInput,
  type SaasSubscription,
  PLATFORM_METRICS_COLLECTION,
  SAAS_SUBSCRIPTIONS_COLLECTION,
  TEAMS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  CONTACTS_COLLECTION,
} from '@linyup/shared'

// Canonical "active contact" definition (matches getActiveContacts): a contact
// whose deleted_at and archived_at are both null. count() keeps this cheap.
async function countActiveContacts(
  db: admin.firestore.Firestore,
  teamId: string,
): Promise<number> {
  const [err, snap] = await to(
    db
      .collection(CONTACTS_COLLECTION)
      .where('teamId', '==', teamId)
      .where('deleted_at', '==', null)
      .where('archived_at', '==', null)
      .count()
      .get(),
  )
  if (err || !snap) return 0
  return snap.data().count
}

// Date key in the business timezone (Europe/Zurich). en-CA → YYYY-MM-DD.
function dateKey(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date())
}

// ─── capturePlatformMetrics ─────────────────────────────────────────────────
// Daily snapshot of platform-wide operator metrics → platform_metrics/{date}.
// Idempotent: re-running a given day overwrites that day's doc. Gauges (status
// mix, MRR, active counts) can't be reconstructed after the fact, so this is the
// only way to build a trend series — hence the daily cron.
export const capturePlatformMetrics = onSchedule(
  { schedule: 'every day 00:15', timeZone: 'Europe/Zurich', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const db = admin.firestore()
    const nowMs = Date.now()
    const date = dateKey()

    const [teamsErr, teamsSnap] = await to(db.collection(TEAMS_COLLECTION).get())
    const [orgsErr, orgsSnap] = await to(db.collection(ORGANIZATIONS_COLLECTION).get())
    const [subsErr, subsSnap] = await to(db.collection(SAAS_SUBSCRIPTIONS_COLLECTION).get())
    if (teamsErr || orgsErr || subsErr || !teamsSnap || !orgsSnap || !subsSnap) {
      console.error('capturePlatformMetrics: read failed', { teamsErr, orgsErr, subsErr })
      return
    }

    const subs = new Map<string, SaasSubscription>()
    for (const doc of subsSnap.docs) {
      const sub = doc.data() as SaasSubscription
      subs.set(sub.entity_id ?? doc.id, sub)
    }

    // HOW MANY STUDIOS EACH ORGANISATION IS BILLED FOR — the organisation tier is
    // priced per studio, so this is its subscription amount, not a statistic.
    // Counted from the teams already loaded rather than by reading every org's
    // `org_teams` subcollection: `Team.org_id` is set in the SAME batch as the
    // membership row, and this loop has all the teams in hand.
    const studiosPerOrg = new Map<string, number>()
    for (const doc of teamsSnap.docs) {
      const orgId = doc.data().org_id as string | undefined
      if (orgId) studiosPerOrg.set(orgId, (studiosPerOrg.get(orgId) ?? 0) + 1)
    }

    const inputs: AccountMetricInput[] = []

    // Active-contact counts per team, in parallel.
    const teamIds = teamsSnap.docs.map((d) => d.id)
    const counts = await Promise.all(teamIds.map((id) => countActiveContacts(db, id)))
    const contactCount = new Map<string, number>()
    teamIds.forEach((id, i) => contactCount.set(id, counts[i] ?? 0))

    for (const doc of teamsSnap.docs) {
      const team = doc.data()
      // Internal tenants (e.g. the prod smoke-test studio) never count toward
      // platform metrics. Filtered in memory — `flags.internal` is a nested field
      // (no top-level boolean to query on) and all teams are already loaded.
      // The rule itself lives in `tenantHiddenFromPlatformMetrics`, so the org
      // loop below and the operator console cannot answer it differently.
      if (tenantHiddenFromPlatformMetrics(team.flags)) continue
      const sub = subs.get(doc.id)
      inputs.push({
        type: 'team',
        plan: sub?.plan ?? team.plan ?? null,
        status: sub?.status ?? team.plan_status ?? null,
        createdMs: team.created?.toMillis?.() ?? 0,
        trialEndsAtMs: sub?.trial_ends_at?.toMillis?.() ?? team.trial_ends_at?.toMillis?.() ?? null,
        contactCount: contactCount.get(doc.id) ?? 0,
        comped: team.flags?.comped === true,
        // Its organisation pays for it — see `monthlyChfFor`.
        billedByOrg: typeof team.org_id === 'string' && team.org_id.length > 0,
      })
    }

    for (const doc of orgsSnap.docs) {
      const org = doc.data()
      // Same rule as the teams loop above — this check was MISSING here, so an
      // internal organisation counted toward every platform number while an
      // internal team did not.
      if (tenantHiddenFromPlatformMetrics(org.flags)) continue
      const sub = subs.get(doc.id)
      inputs.push({
        type: 'org',
        plan: sub?.plan ?? org.plan ?? 'organization',
        status: sub?.status ?? org.plan_status ?? null,
        createdMs: org.created?.toMillis?.() ?? 0,
        trialEndsAtMs: sub?.trial_ends_at?.toMillis?.() ?? null,
        contactCount: null,
        comped: org.flags?.comped === true,
        studioCount: studiosPerOrg.get(doc.id) ?? 0,
      })
    }

    const metrics = computePlatformMetrics(inputs, nowMs)
    const docData = platformMetricsToDoc(date, metrics)

    // Mail volume is aggregated over the `mail_sends` ledger rather than derived
    // from the account inputs, so it is fetched separately and merged in. A null
    // means the aggregation failed: the snapshot is still worth writing without
    // it, and `mail` is optional precisely so a day can lack the block.
    const mail = await capturePlatformMailMetrics(db, date)

    // Member-app adoption, from our own `Contact.mobile_app` telemetry rather
    // than from either store — see mobileAdoptionMetrics.ts for why that is a
    // different question from anything App Store Connect or Play can answer.
    // Same null-means-omit contract as `mail` above.
    const mobile = await capturePlatformMobileMetrics(db, nowMs)

    const [writeErr] = await to(
      db
        .collection(PLATFORM_METRICS_COLLECTION)
        .doc(date)
        .set(
          {
            ...docData,
            ...(mail ? { mail } : {}),
            ...(mobile ? { mobile } : {}),
            captured_at: FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
    )
    if (writeErr) {
      console.error('capturePlatformMetrics: write failed', writeErr)
      return
    }
    console.log(`capturePlatformMetrics: wrote ${date} (${metrics.accounts.total} accounts)`)
  },
)
