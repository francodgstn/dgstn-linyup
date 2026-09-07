/**
 * REPAIR MIGRATED ATTENDANCE ROWS — give them back the identity the migration
 * dropped.
 *
 *   tsx --tsconfig tsconfig.scripts.json scripts/repair-participant-identity.ts \
 *     --source-creds keys/hmd-prod-sa.json \
 *     --target-creds keys/linyup-staging-sa.json [--team <id>] [--apply]
 *
 * `transformParticipant` used to write a shape of its own that shared one field
 * with what the product writes (see its header for the three consequences).
 * That transform is fixed, but a fix to a migration repairs nothing already
 * migrated — hence this.
 *
 * ── WHY NOT JUST RE-RUN PASS 6 WITH `--overwrite` ───────────────────────────
 * Because that pass also re-stamps every BOOKING from the source, and a booking
 * on a live target has since been confirmed, cancelled or marked no-show by a
 * real person. Repairing attendance must not roll back attendance's neighbour.
 *
 * ── IDEMPOTENT, AND CHEAP ON A SECOND RUN ───────────────────────────────────
 * A session whose rows all carry `checkedInAt` is already canonical and is
 * skipped before the source is read at all. A target row with no source
 * counterpart was written by the product and is left alone — this script is not
 * a second writer of anything the app owns.
 */

import { parseArgs } from 'node:util'
import { readFileSync } from 'fs'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { transformParticipant } from './migration/transforms/sessions'

const { values } = parseArgs({
  options: {
    'source-creds': { type: 'string' },
    'target-creds': { type: 'string' },
    team: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (!values['source-creds'] || !values['target-creds']) {
  console.error('Error: --source-creds and --target-creds are both required')
  process.exit(1)
}

const apply = values.apply ?? false

function db(path: string, name: string): Firestore {
  const sa = JSON.parse(readFileSync(path, 'utf8'))
  return getFirestore(initializeApp({ credential: cert(sa), projectId: sa.project_id }, name))
}

const src = db(values['source-creds']!, 'src')
const tgt = db(values['target-creds']!, 'tgt')

async function main() {
  console.log(apply ? '=== APPLY ===' : '=== DRY RUN — pass --apply to write ===')

  const teams = values.team
    ? [values.team]
    : (await tgt.collection('teams').where('org_id', '==', 'hmd').get()).docs.map((d) => d.id)
  console.log(`teams: ${teams.length}`)

  let sessionsSeen = 0
  let sessionsRepaired = 0
  let rowsRepaired = 0
  let rowsAlreadyOk = 0
  let rowsNoSource = 0
  let rowsNoName = 0

  for (const teamId of teams) {
    const sessions = await tgt.collection('sessions').where('teamId', '==', teamId).get()
    let teamRows = 0

    for (const s of sessions.docs) {
      const parts = await s.ref.collection('participants').get()
      if (parts.empty) continue
      sessionsSeen += 1

      const broken = parts.docs.filter((p) => !('checkedInAt' in p.data()))
      if (broken.length === 0) {
        rowsAlreadyOk += parts.size
        continue
      }
      rowsAlreadyOk += parts.size - broken.length

      // Only now is the source worth a read.
      const srcParts = await src.collection('sessions').doc(s.id).collection('participants').get()
      const srcById = new Map(srcParts.docs.map((d) => [d.id, d.data() as Record<string, unknown>]))

      const start = (s.data() as Record<string, unknown>).start ?? null
      const batch = tgt.batch()
      let n = 0

      for (const p of broken) {
        const source = srcById.get(p.id)
        if (!source) {
          // Written by the product after the migration, or a row the source no
          // longer has. Either way not ours to rewrite.
          rowsNoSource += 1
          continue
        }
        if (!source.firstname && !source.lastname) rowsNoName += 1
        batch.set(p.ref, transformParticipant(p.id, source, teamId, s.id, start))
        n += 1
      }

      if (n === 0) continue
      if (apply) await batch.commit()
      rowsRepaired += n
      teamRows += n
      sessionsRepaired += 1
    }

    if (teamRows > 0) console.log(`  ${teamId}: ${teamRows} row(s)`)
  }

  console.log('')
  console.log(`sessions with participants : ${sessionsSeen}`)
  console.log(`sessions repaired          : ${sessionsRepaired}`)
  console.log(`rows repaired              : ${rowsRepaired}${apply ? '' : ' (dry run)'}`)
  console.log(`rows already canonical     : ${rowsAlreadyOk}`)
  console.log(`rows with no source row    : ${rowsNoSource}`)
  if (rowsNoName > 0) console.log(`⚠️  rows whose SOURCE had no name: ${rowsNoName}`)
}

main().then(() => process.exit(0))
