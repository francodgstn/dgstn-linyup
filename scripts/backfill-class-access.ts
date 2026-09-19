/**
 * Rewrite every class into the DERIVED access shape (docs/class-access-derived.md,
 * stage 5) — and take the legacy fields off activities and sessions.
 *
 * ── WHAT CHANGES IN THE DATA ────────────────────────────────────────────────
 * A class keeps two stored answers: `accessRule.audience` (the "only people who
 * signed up with you" wall) and `accessRule.subscriptionTypeIds` (the plans that
 * include it). "Plan required" is derived on every read from those and the
 * drop-in, so the stored `accessRule.type`, `accessRule.requirePlan`,
 * `Activity.isFreeTrial` and `dropIn.enabled` go, and `dropIn.mode` is written
 * explicitly. Sessions lose `isFreeTrial`. An appointment loses any access rule,
 * drop-in or trial flag it still carries — the price is its only gate.
 *
 * ── THE ONE MAPPING ─────────────────────────────────────────────────────────
 * `migrateClassAccess` in @linyup/shared (utils/classAccess.ts) decides every
 * class. It preserves who may book wherever the derived rule can say it, and
 * NAMES each rewrite it had to make — this script prints them per class, so a
 * studio whose class changed can be told exactly how:
 *   legacy_open_door_closed / legacy_members_door_closed — a stored price that
 *     never fired is stated as off.
 *   plan_required_door_closed — "plan required" with a price: kept plan
 *     holders only by closing the door (their member rate goes with it).
 *   inert_plans_cleared — plans listed on a free class did nothing; cleared so
 *     it stays free.
 *   dead_end_reopened — "plan required" with no plan: nobody could book it.
 *
 * The studio's usual drop-in price is read per team (it decides whether a class
 * that follows it has a door), from the same document the app reads.
 *
 * ── DEPLOY ORDER ────────────────────────────────────────────────────────────
 * Run it right AFTER deploying stage 5. Until it runs, the new code reads an
 * un-rewritten class with the derived rule, which differs from the old reading
 * in exactly the noted cases above. Nothing is running on prod (2026-09-18).
 *
 * ── SIDE EFFECTS ────────────────────────────────────────────────────────────
 * Each written activity fires `syncActivityPublicProfile`, which rewrites its
 * mirror. Session writes fire the session mirror sync. Both are idempotent.
 *
 * ── MIRRORS: THE TRIGGER IS NOT ENOUGH ──────────────────────────────────────
 * The trigger only fires for a document this pass WRITES. An appointment whose
 * document was already clean, or a class already in the derived shape, is never
 * written, so its mirror keeps whatever the pre-stage-5 sync put there. The first
 * sandbox run (2026-09-19) left `isFreeTrial: false` on every appointment mirror,
 * which is the legacy spelling of "members only", and several public readers
 * still fall back to it. Without the functions emulator no trigger runs at all,
 * so a rewritten class keeps its stale mirror too.
 *
 * So this pass also rebuilds every active activity's mirror itself, with the
 * trigger's own `buildActivityPublicProfile`, from the document as this pass
 * leaves it, and rewrites any stored mirror that differs. It prints the keys
 * that differ. The trigger's copy for a rewritten class is identical, so the
 * second write changes nothing. It never creates a missing mirror and never
 * touches an inactive activity's: those are the trigger's create and delete
 * paths, not class access.
 *
 * ── RE-RUNNABLE ─────────────────────────────────────────────────────────────
 * A class already in the derived shape, and a mirror already equal to what the
 * trigger would write, are left alone, so a second run writes nothing.
 *
 * Auth: gcloud Application Default Credentials (ADC), like the other backfills.
 * Against the emulator, set FIRESTORE_EMULATOR_HOST and use the demo project.
 *
 * Usage:
 *   pnpm backfill:class-access --project linyup-staging [--team t1] [--apply]
 *
 * Without --apply it only reports what it would write.
 */

import { parseArgs } from 'node:util'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { FieldValue } from 'firebase-admin/firestore'
import {
  ACTIVITIES_COLLECTION,
  PUBLIC_PROFILE_SUBCOLLECTION,
  SESSIONS_COLLECTION,
  TEAMS_COLLECTION,
  migrateClassAccess,
  studioDropInOf,
  type ClassAccessInput,
  type ClassAccessMigrationNote,
  type DropInPrice,
} from '@linyup/shared'
// The trigger's own builder, so a rebuilt mirror cannot drift from a synced one
// (same arrangement as backfill-partner-apps and syncTeamPublicProfile).
import { buildActivityPublicProfile } from '../packages/functions/src/sync/syncActivityPublicProfile'

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    team: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
})

if (!values.project) {
  console.error('❌ --project is required (e.g. --project linyup-staging)')
  process.exit(1)
}

admin.initializeApp({ credential: applicationDefault(), projectId: values.project })
const db = admin.firestore()

const studioCache = new Map<string, DropInPrice | null>()
async function studioDropInFor(teamId: string): Promise<DropInPrice | null> {
  if (studioCache.has(teamId)) return studioCache.get(teamId)!
  const snap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(PUBLIC_PROFILE_SUBCOLLECTION)
    .doc(teamId)
    .get()
  const value = studioDropInOf(snap.data()?.bookingSettings)
  studioCache.set(teamId, value)
  return value
}

/** Stable JSON for comparing maps regardless of key order. */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([k, x]) => [k, norm(x)])
        )
      : v
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

async function main() {
  console.log(
    `\n🔧 Class access backfill on '${values.project}'${values.team ? ` (team ${values.team})` : ''} ${
      values.apply ? '(APPLY)' : '(dry-run)'
    }\n`
  )

  let query: FirebaseFirestore.Query = db.collection(ACTIVITIES_COLLECTION)
  if (values.team) query = query.where('teamId', '==', values.team)
  const activities = await query.get()
  console.log(`   ${activities.size} activity document(s)\n`)

  const noteCounts = new Map<ClassAccessMigrationNote, number>()
  let rewrite = 0
  let unchanged = 0
  let appointmentsCleaned = 0
  let batch = db.batch()
  let pending = 0
  const flush = async (force = false) => {
    if (!values.apply) return
    if (pending >= 400 || (force && pending > 0)) {
      await batch.commit()
      batch = db.batch()
      pending = 0
    }
  }

  let mirrorsResynced = 0
  let mirrorsMissing = 0
  // Rebuild the mirror from `after` (the document as this pass leaves it) with
  // the trigger's builder, and rewrite the stored one when they differ. See
  // "MIRRORS" in the header for why the trigger alone does not do this.
  const syncMirror = async (
    snap: FirebaseFirestore.QueryDocumentSnapshot,
    after: FirebaseFirestore.DocumentData,
    studio: DropInPrice | null,
    label: string
  ) => {
    if (after.isActive === false) return
    const ref = snap.ref.collection(PUBLIC_PROFILE_SUBCOLLECTION).doc(snap.id)
    const stored = await ref.get()
    if (!stored.exists) {
      mirrorsMissing += 1
      return
    }
    // A JSON round trip drops undefined keys, as the trigger's write does.
    const want = JSON.parse(JSON.stringify(buildActivityPublicProfile(after, studio))) as Record<
      string,
      unknown
    >
    const have = stored.data() ?? {}
    const differing = [...new Set([...Object.keys(have), ...Object.keys(want)])]
      .filter((k) => !same(have[k] ?? null, want[k] ?? null))
      .sort()
    if (differing.length === 0) return
    mirrorsResynced += 1
    console.log(
      `   ${values.apply ? 're-sync' : 'would re-sync'} mirror ${label}: ${differing.join(', ')}`
    )
    if (values.apply) {
      batch.set(ref, want)
      pending += 1
      await flush()
    }
  }
  const without = (data: FirebaseFirestore.DocumentData, keys: string[]) =>
    Object.fromEntries(Object.entries(data).filter(([k]) => !keys.includes(k)))

  for (const snap of activities.docs) {
    const data = snap.data()
    const label = `${snap.id} [${data.teamId ?? '?'}] ${data.name ?? '?'}`

    if (data.type === 'appointment') {
      const stale = ['accessRule', 'dropIn', 'isFreeTrial'].filter((k) => k in data)
      if (stale.length) {
        appointmentsCleaned += 1
        console.log(
          `   ${values.apply ? 'clean' : 'would clean'} appointment ${label}: drop ${stale.join(', ')}`
        )
        if (values.apply) {
          batch.update(snap.ref, Object.fromEntries(stale.map((k) => [k, FieldValue.delete()])))
          pending += 1
          await flush()
        }
      }
      // An appointment never reads the studio default.
      await syncMirror(snap, without(data, stale), null, label)
      continue
    }

    const studio = typeof data.teamId === 'string' ? await studioDropInFor(data.teamId) : null
    const m = migrateClassAccess(data as ClassAccessInput, studio)
    const inShape =
      !('isFreeTrial' in data) &&
      same(data.accessRule ?? null, m.accessRule) &&
      same(data.dropIn ?? null, m.dropIn)
    if (inShape) {
      unchanged += 1
      await syncMirror(snap, data, studio, label)
      continue
    }

    rewrite += 1
    for (const n of m.notes) noteCounts.set(n, (noteCounts.get(n) ?? 0) + 1)
    console.log(
      `   ${values.apply ? 'rewrite' : 'would rewrite'} ${label}` +
        `\n      accessRule ${JSON.stringify(data.accessRule ?? null)} → ${JSON.stringify(m.accessRule)}` +
        `\n      dropIn     ${JSON.stringify(data.dropIn ?? null)} → ${JSON.stringify(m.dropIn)}` +
        (m.notes.length ? `\n      NOTE: ${m.notes.join(', ')}` : '')
    )
    if (values.apply) {
      batch.update(snap.ref, {
        accessRule: m.accessRule,
        dropIn: m.dropIn,
        isFreeTrial: FieldValue.delete(),
      })
      pending += 1
      await flush()
    }
    await syncMirror(
      snap,
      { ...without(data, ['isFreeTrial']), accessRule: m.accessRule, dropIn: m.dropIn },
      studio,
      label
    )
  }
  await flush(true)

  // Sessions: the legacy flag only. Queried by value so untouched sessions are
  // never read (a session collection grows with time).
  let sessionsCleaned = 0
  for (const flag of [true, false]) {
    let sq: FirebaseFirestore.Query = db
      .collection(SESSIONS_COLLECTION)
      .where('isFreeTrial', '==', flag)
    if (values.team) sq = sq.where('teamId', '==', values.team)
    const sessions = await sq.get()
    for (const s of sessions.docs) {
      sessionsCleaned += 1
      if (values.apply) {
        batch.update(s.ref, { isFreeTrial: FieldValue.delete() })
        pending += 1
        await flush()
      }
    }
  }
  await flush(true)

  console.log(
    `\n   classes rewritten: ${rewrite}   already in shape: ${unchanged}` +
      `   appointments cleaned: ${appointmentsCleaned}   sessions cleaned: ${sessionsCleaned}` +
      `\n   mirrors re-synced: ${mirrorsResynced}` +
      (mirrorsMissing
        ? `   active activities without a mirror (left alone): ${mirrorsMissing}`
        : '')
  )
  if (noteCounts.size) {
    console.log('   rewrites that changed who may book, or stated it differently:')
    for (const [n, c] of noteCounts) console.log(`     ${n}: ${c}`)
  }
  if (!values.apply && rewrite + appointmentsCleaned + sessionsCleaned + mirrorsResynced > 0) {
    console.log('\n   Re-run with --apply to write.')
  }
  console.log(values.apply ? '\n✅ Done.\n' : '\n✅ Dry-run complete.\n')
}

main().catch((err) => {
  console.error('❌ Backfill failed:', err)
  process.exit(1)
})
