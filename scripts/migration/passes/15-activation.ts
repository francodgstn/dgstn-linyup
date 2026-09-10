/**
 * Pass 15 — ACTIVATION: which clubs may reach their people.
 *
 * The whole federation is imported at once — the org's events carry check-ins
 * from every club, so a partial import leaves dangling references — but only
 * the clubs on `--live` go live. This pass is what makes the rest DORMANT for
 * mail and SMS: a messaging policy per club, `live` for the activation list and
 * `silent` for every other club, `live` for the organisation itself.
 *
 * Without it, a full import into production would hand the seeded automations
 * (trial follow-ups, birthday mail, the lot) thirteen clubs' worth of contacts
 * who have never heard of Linyup, on a target whose env default is `live`. That
 * is why a full run into a real project REFUSES to start without `--live`.
 *
 * CUMULATIVE, by construction: every club not named is written `silent`, so a
 * later wave passes every club that is live by then, not only the new one.
 *
 *   pnpm migrate:hmd ... --only activation --live "Basel,Ardovini,Marzella"
 *
 * Iterates the SOURCE club list rather than the target's `teams` collection on
 * purpose: staging holds testers' studios and production holds the review
 * studio, and a `silent` policy stamped on one of those would be a silent
 * outage for a tenant this migration has no business touching.
 */
import { Timestamp } from 'firebase-admin/firestore'
import type { MigrationConfig } from '../config'
import { sourceDb, targetDb, ORG_ID, EXCLUDED_SOURCE_TEAMS, matchesTeamSample } from '../config'
import { BatchWriter } from '../batch-writer'

// Mirrors @linyup/shared MESSAGING_POLICIES_COLLECTION / MessagingPolicy.
const MESSAGING_POLICIES_COLLECTION = 'messaging_policies'

function policy(entityId: string, mode: 'live' | 'silent', note: string) {
  return { entityId, mode, note, updated_at: Timestamp.now(), updated_by: 'migration' }
}

export async function pass15Activation(cfg: MigrationConfig): Promise<void> {
  console.log('Pass 15: activation — messaging policies')
  if (!cfg.live?.length) {
    console.log('  no --live list — skipped; the env default applies to every tenant')
    return
  }
  const src = sourceDb()
  const tgt = targetDb()

  const clubs = (await src.collection('teams').get()).docs.filter(
    (d) => !EXCLUDED_SOURCE_TEAMS.includes(d.id),
  )
  const nameOf = (d: { id: string; data(): Record<string, unknown> }) => String(d.data().name ?? '')

  // FAIL LOUDLY on a live name that matches no club — the same rule as
  // `--teams`. A misspelt club would otherwise be written silent and look
  // exactly like a club whose wave has not come.
  const unmatched = cfg.live.filter((want) => !clubs.some((d) => matchesTeamSample([want], d.id, nameOf(d))))
  if (unmatched.length > 0) {
    console.error(`\n❌ --live named ${unmatched.length} club(s) that do not exist in the source: ${unmatched.join(', ')}`)
    process.exit(1)
  }

  const bw = new BatchWriter(tgt, cfg.dryRun)
  bw.set(
    tgt.collection(MESSAGING_POLICIES_COLLECTION).doc(ORG_ID),
    policy(ORG_ID, 'live', 'HMD organisation — live from the first wave'),
  )

  let live = 0
  let silent = 0
  let absent = 0
  for (const d of clubs) {
    // A policy for a club that was never written to this target is harmless but
    // misleading in the ops console; write only for clubs that exist here.
    const exists = (await tgt.collection('teams').doc(d.id).get()).exists
    if (!exists) { absent++; continue }
    const isLive = matchesTeamSample(cfg.live, d.id, nameOf(d))
    bw.set(
      tgt.collection(MESSAGING_POLICIES_COLLECTION).doc(d.id),
      isLive
        ? policy(d.id, 'live', `${nameOf(d)} — activated`)
        : policy(d.id, 'silent', `${nameOf(d)} — migrated, dormant until its wave (re-run activation with it on --live)`),
    )
    if (isLive) live++
    else silent++
    console.log(`    ${isLive ? 'LIVE   ' : 'silent '} ${nameOf(d)} [${d.id}]`)
  }
  await bw.done()
  console.log(`  → org live · ${live} club(s) live · ${silent} silent${absent ? ` · ${absent} not on target (no policy written)` : ''}`)
}
