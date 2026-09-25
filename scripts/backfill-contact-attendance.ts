/**
 * RECOUNT A CONTACT'S ATTENDANCE SUMMARY FROM THE ROWS IT SUMMARIZES.
 *
 *   pnpm backfill:contact-attendance --target staging --org hmd --dry-run
 *   pnpm backfill:contact-attendance --target staging --org hmd
 *   pnpm backfill:contact-attendance --target emulator --team <teamId>
 *
 * ── WHAT IT FIXES ───────────────────────────────────────────────────────────
 *
 * `Contact.last_session_at` and `Contact.total_sessions` are denormalised by
 * `trackSessionParticipants` (functions/src/analytics/index.ts), one attendance
 * row at a time. Until 2026-09-13 that trigger wrote `last_session_at` as THE
 * SESSION IT WAS HANDED, unconditionally — so whichever trigger ran LAST won.
 * In ordinary use rows arrive in date order and that happens to be right; an
 * import writes years of attendance at once, the triggers finish in any order,
 * and the stored "last session" becomes an arbitrary old one. On the HMD
 * staging sample that was 75 of 123 attending contacts, and it is what made
 * people with a class last week read "Stopped" (the engagement band derives
 * from this field) and made the AI summary say their last session was years
 * ago (its dossier reads the same field). `total_sessions` also ran a little
 * short, because a bulk import outruns trigger delivery.
 *
 * The trigger now only moves the date forward. This script repairs what was
 * written before that — and it is the post-import step for a migration, because
 * no trigger-by-trigger counter survives a bulk write intact.
 *
 * ── WHAT IT WRITES — ABSOLUTE VALUES, NEVER INCREMENTS ──────────────────────
 *
 *   total_sessions   the number of `sessions/{s}/participants/{contactId}` rows
 *   last_session_at  the START of the session holding the most recent row
 *                    (falling back to that row's `checkedInAt`) — the same
 *                    meaning the trigger gives the field
 *
 * Rows are found through the collection-group index the contact's attendance
 * history already uses (`contactId` + `checkedInAt desc`). A row missing either
 * field is not in that index and is not counted — the same rows the attendance
 * history cannot show.
 *
 * Only contacts whose stored values differ are written. Re-runnable.
 *
 * ── SCOPE IS EXPLICIT ───────────────────────────────────────────────────────
 *
 * Staging carries other people's test tenants, so a cloud run names what it
 * touches: `--org <id>` (every team whose `org_id` is it), `--team <id>`, or
 * `--all`. A cloud write asks for the project id typed back unless `--yes`.
 */
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    org: { type: 'string' },
    team: { type: 'string' },
    all: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
})

const TARGETS: Record<string, { projectId: string; emulator: boolean }> = {
  emulator: { projectId: 'demo-linyup', emulator: true },
  staging: { projectId: 'linyup-staging', emulator: false },
  production: { projectId: 'linyup-prod', emulator: false },
}
const target = TARGETS[values.target ?? '']
if (!target) {
  console.error(`❌ --target must be one of: ${Object.keys(TARGETS).join(' | ')}`)
  process.exit(1)
}
const scopes = [values.org, values.team, values.all ? 'all' : undefined].filter(Boolean)
if (scopes.length !== 1) {
  console.error('❌ name exactly one scope: --org <id>, --team <id>, or --all')
  process.exit(1)
}
if (target.emulator) {
  const slot = Number(process.env.LINYUP_SLOT ?? 0) || 0
  process.env.FIRESTORE_EMULATOR_HOST ??= `localhost:${8080 + slot * 10000}`
} else if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('❌ Refusing to run against a cloud project with FIRESTORE_EMULATOR_HOST set.')
  process.exit(1)
}
admin.initializeApp(
  target.emulator
    ? { projectId: target.projectId }
    : { credential: applicationDefault(), projectId: target.projectId },
)
const db = admin.firestore()
const dryRun = values['dry-run'] ?? false
const { FieldValue } = admin.firestore

const DAY = 86_400_000
const millis = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null
}
const day = (m: number | null) => (m == null ? '—' : new Date(m).toISOString().slice(0, 10))

async function teamsInScope(): Promise<Array<{ id: string; name: string }>> {
  if (values.team) {
    const snap = await db.collection('teams').doc(values.team).get()
    if (!snap.exists) throw new Error(`teams/${values.team} does not exist on ${target.projectId}`)
    return [{ id: snap.id, name: (snap.data()?.name as string) ?? snap.id }]
  }
  const q = values.org ? db.collection('teams').where('org_id', '==', values.org) : db.collection('teams')
  const docs = (await q.get()).docs
  if (!docs.length) throw new Error(`no teams in scope on ${target.projectId}`)
  return docs.map((d) => ({ id: d.id, name: (d.data().name as string) ?? d.id }))
}

async function main() {
  const teams = await teamsInScope()
  console.log(`Contact attendance recount — ${target.projectId}${dryRun ? ' (dry run)' : ''}`)
  console.log(`  scope: ${teams.map((t) => t.name).join(', ')}`)

  if (!dryRun && !values.yes && !target.emulator) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\nType '${target.projectId}' to write: `)
    rl.close()
    if (answer.trim() !== target.projectId) { console.error('Aborted.'); process.exit(1) }
  }

  let scanned = 0
  let lastFixed = 0
  let totalFixed = 0
  let written = 0
  const examples: string[] = []

  for (const team of teams) {
    const contacts = (await db.collection('contacts').where('teamId', '==', team.id).get()).docs
    let teamWritten = 0
    for (const doc of contacts) {
      scanned++
      const stored = doc.data()
      const rows = db
        .collectionGroup('participants')
        .where('contactId', '==', doc.id)
        .orderBy('checkedInAt', 'desc')
      const [countSnap, latestSnap] = await Promise.all([rows.count().get(), rows.limit(1).get()])
      const total = countSnap.data().count

      let last: FirebaseFirestore.Timestamp | null = null
      const latest = latestSnap.docs[0]
      if (latest) {
        const session = await latest.ref.parent.parent!.get()
        last = (session.data()?.start as FirebaseFirestore.Timestamp | undefined) ?? (latest.data().checkedInAt as FirebaseFirestore.Timestamp)
      }

      const storedLast = millis(stored.last_session_at)
      const newLast = millis(last)
      const lastDiffers = storedLast == null ? newLast != null : newLast == null || Math.abs(storedLast - newLast) >= 1000
      const totalDiffers = stored.total_sessions !== total
      if (!lastDiffers && !totalDiffers) continue

      if (lastDiffers) lastFixed++
      if (totalDiffers) totalFixed++
      if (examples.length < 5 && lastDiffers && storedLast != null && newLast != null && Math.abs(storedLast - newLast) > 30 * DAY) {
        examples.push(`  ${team.name}: last ${day(storedLast)} → ${day(newLast)}, total ${stored.total_sessions ?? '—'} → ${total}`)
      }

      const patch: Record<string, unknown> = { total_sessions: total }
      patch.last_session_at = last ?? FieldValue.delete()
      if (!dryRun) await doc.ref.update(patch)
      written++
      teamWritten++
    }
    console.log(`  ${team.name}: ${contacts.length} contact(s), ${teamWritten} ${dryRun ? 'would be' : ''} corrected`)
  }

  const v = dryRun ? 'would correct' : 'corrected'
  console.log(`\n${scanned} contact(s) scanned; ${written} ${v} — last_session_at on ${lastFixed}, total_sessions on ${totalFixed}`)
  if (examples.length) {
    console.log('largest last-session corrections (no names):')
    for (const e of examples) console.log(e)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(`❌ ${e instanceof Error ? e.message : e}`); process.exit(1) })
