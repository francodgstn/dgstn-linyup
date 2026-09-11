/**
 * Stamp `teams/{teamId}/counters/contacts` for every team.
 *
 * ── WHY IT IS NEEDED ────────────────────────────────────────────────────────
 * The operator console reads the live-contact count off that document instead
 * of running a `count()` aggregation per tenant on every page view
 * (docs/scalability-2026-09.md §17 B8). Two writers keep it: the
 * `trackContacts` trigger applies deltas, and the nightly platform-metrics job
 * reconciles with an authoritative count. Both only ever fire AFTER they are
 * deployed, so until the first nightly run every team that existed before the
 * trigger has no counter at all.
 *
 * The console renders a missing counter as unknown ("—") and excludes it from
 * the platform total, saying so — which is honest, and still not what an
 * operator should be looking at the morning after a deploy. This closes that
 * window without waiting for midnight.
 *
 * DEPLOY ORDER: functions first (so the trigger is live and no write is lost
 * while this runs), then this, then the console. Running it before the trigger
 * is deployed is not wrong, only short-lived — every contact written in between
 * would go uncounted until the nightly reconciliation.
 *
 * ── WHAT IT READS ───────────────────────────────────────────────────────────
 * One `count()` aggregation per team — the same query, with the same LIVE
 * definition (`deleted_at` and `archived_at` both null, externals included),
 * that the nightly job runs. That is the very fan-out this whole change exists
 * to remove from the request path; here it is fine, because this runs once,
 * offline, and is what makes the request path cheap.
 *
 * ── WHAT IT WRITES ──────────────────────────────────────────────────────────
 * An ABSOLUTE `live` value — never an increment — plus the two timestamps, on
 * a document no client may write (firestore.rules) and no trigger watches. It
 * cannot touch a contact, a team, or anything a studio sees.
 *
 * ── RE-RUNNABLE ─────────────────────────────────────────────────────────────
 * It computes the count from the contacts themselves, exactly as the nightly
 * job does, so a second run agrees with the first and with the trigger.
 *
 * Auth: gcloud Application Default Credentials (ADC), like the other scripts.
 * Against the emulator, set FIRESTORE_EMULATOR_HOST and use the demo project.
 *
 * Usage:
 *   tsx scripts/backfill-contact-counts.ts --project linyup-staging [--team t1] [--apply]
 *
 * Without --apply it only reports what it would write.
 */

import { parseArgs } from 'node:util'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { FieldValue } from 'firebase-admin/firestore'
import {
  CONTACTS_COLLECTION,
  TEAMS_COLLECTION,
  TEAM_COUNTERS_SUBCOLLECTION,
  TEAM_CONTACT_COUNTER_DOC,
} from '@linyup/shared'

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    team: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
})

if (!values.project) {
  console.error(
    '❌ --project is required (e.g. --project linyup-staging, or demo-linyup for the emulator)'
  )
  process.exit(1)
}

admin.initializeApp({ credential: applicationDefault(), projectId: values.project })
const db = admin.firestore()

const stats = { teams: 0, written: 0, unchanged: 0, failed: 0 }

async function liveContactCount(teamId: string): Promise<number> {
  const agg = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .where('deleted_at', '==', null)
    .where('archived_at', '==', null)
    .count()
    .get()
  return agg.data().count
}

async function main() {
  console.log(
    `\n🔧 Team contact-counter backfill on '${values.project}'${
      values.team ? ` (team ${values.team})` : ''
    } ${values.apply ? '(APPLY)' : '(dry-run)'}\n`
  )

  const teamsSnap = values.team
    ? [await db.collection(TEAMS_COLLECTION).doc(values.team).get()]
    : (await db.collection(TEAMS_COLLECTION).get()).docs

  for (const teamDoc of teamsSnap) {
    if (!teamDoc.exists) {
      console.error(`   ⚠️  team ${teamDoc.id} does not exist`)
      stats.failed++
      continue
    }
    stats.teams++
    const counterRef = db
      .collection(TEAMS_COLLECTION)
      .doc(teamDoc.id)
      .collection(TEAM_COUNTERS_SUBCOLLECTION)
      .doc(TEAM_CONTACT_COUNTER_DOC)
    try {
      const [live, existing] = await Promise.all([liveContactCount(teamDoc.id), counterRef.get()])
      if (existing.exists && existing.data()?.live === live) {
        stats.unchanged++
        continue
      }
      const name = (teamDoc.data()?.name as string | undefined) ?? teamDoc.id
      console.log(
        `   ${teamDoc.id} (${name}): ${existing.exists ? (existing.data()?.live ?? '?') : 'none'} → ${live}`
      )
      if (values.apply) {
        await counterRef.set(
          {
            live,
            updated_at: FieldValue.serverTimestamp(),
            reconciled_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      }
      stats.written++
    } catch (err) {
      console.error(`   ❌ ${teamDoc.id}: ${err instanceof Error ? err.message : String(err)}`)
      stats.failed++
    }
  }

  console.log(
    `\n${values.apply ? '✅ wrote' : 'ℹ️  would write'} ${stats.written} counter(s) · ` +
      `${stats.unchanged} already correct · ${stats.failed} failed · ${stats.teams} team(s)\n`
  )
  if (!values.apply) console.log('   Re-run with --apply to write.\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
