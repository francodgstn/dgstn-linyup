// EXPORT BEFORE TEARDOWN — the gate Franco adopted as Q13.
//
// ── THE PROBLEM IT CLOSES ───────────────────────────────────────────────────
// `TENANT_DATA_COLLECTIONS` sweeps `documents` by `teamId`, and every per-team
// teardown uses `recursiveDelete`. So deleting a team destroys the acceptance
// events, the immutable version snapshots and the signer rows along with it —
// every signature that team ever collected — and until this file there was no
// export step anywhere on the teardown path.
//
// "Production teardown is a separate operation" was the earlier answer, and it
// is true and is not an answer: a liability release is the ONE artefact a studio
// needs AFTER the relationship ends, and the window over which it is needed is
// measured in years rather than in account lifetime.
//
// ── WHY IT IS A FILE ON DISK AND NOT A CALLABLE ─────────────────────────────
// The callable (`exportContactConsentHistory`) answers for ONE contact and needs
// somebody signed in. A teardown runs from a terminal, against a tenant that is
// about to stop existing, and the thing worth keeping is the whole ledger — so
// this reads it directly through the Admin SDK and writes one JSON file per
// team. It is deliberately raw rather than rendered: an archive is read by
// whoever asks in three years, and the fewest assumptions about what they will
// want is the safest shape.
//
// ── THE GATE, AND ITS ONE ESCAPE HATCH ──────────────────────────────────────
// A teardown REFUSES when the export fails. That is the point of a gate. The
// escape hatch is `--no-consent-export`, which has to be typed: a caller who
// genuinely means "this tenant never had a signature and I know it" can say so,
// and the flag appears in the console record of what was run.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Firestore } from 'firebase-admin/firestore'
import { readTeamConsentLedger } from '../../packages/functions/src/waivers/consentExport'

export interface ConsentExportResult {
  teamId: string
  documents: number
  versions: number
  acceptances: number
  signers: number
  file: string | null
}

/**
 * Read every waiver-shaped artefact belonging to one team and write it to disk.
 *
 * Returns `file: null` when the team carries NOTHING — no documents at all. That
 * is the ordinary case for a sandbox playground, and writing an empty file for
 * it would train whoever runs this to ignore the output.
 */
export async function exportConsentLedger(
  db: Firestore,
  teamId: string,
  outDir: string
): Promise<ConsentExportResult> {
  // The WHAT — which collections a signature is made of, and the skip-if-nothing
  // rule — lives in the ONE shared reader, so this path and the scheduled
  // GCS path (dailyTasks/purgeScheduledTeams.ts) can never disagree on it.
  const nowIso = new Date().toISOString()
  const ledger = await readTeamConsentLedger(db, teamId, nowIso)

  const result: ConsentExportResult = {
    teamId,
    documents: ledger.counts.documents,
    versions: ledger.counts.versions,
    acceptances: ledger.counts.acceptances,
    signers: ledger.counts.signers,
    file: null,
  }
  // Null archive = nothing was ever signed here. Write no file — an empty file
  // would train whoever runs this to ignore the output.
  if (!ledger.archive) return result

  fs.mkdirSync(outDir, { recursive: true })
  const stamp = nowIso.replace(/[:.]/g, '-')
  const file = path.join(outDir, `consent-ledger-${teamId}-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(ledger.archive, null, 2) + '\n')
  result.file = file
  return result
}

/**
 * The GATE itself: export every named team's ledger, print what was written, and
 * throw if any of it failed.
 *
 * Callers pass `skip: true` for `--no-consent-export`, which is echoed rather
 * than silently honored — the console output of a destructive run is its only
 * record.
 */
export async function requireConsentExport(
  db: Firestore,
  teamIds: string[],
  outDir: string,
  opts: { skip?: boolean } = {}
): Promise<void> {
  if (opts.skip) {
    console.log('\n⚠  --no-consent-export: the acceptance ledger will be DESTROYED unexported.')
    return
  }
  if (teamIds.length === 0) return

  console.log('\n0/…  Exporting consent ledgers before anything is deleted…')
  let wrote = 0
  for (const teamId of teamIds) {
    let res: ConsentExportResult
    try {
      res = await exportConsentLedger(db, teamId, outDir)
    } catch (err) {
      // REFUSE. A teardown that proceeds past a failed export is the exact
      // outcome this gate exists to prevent, and "it probably had nothing" is a
      // guess about the one artefact a departing studio most needs.
      console.error(`\n❌ Could not export the consent ledger for '${teamId}': ${(err as Error).message}`)
      console.error('   Nothing has been deleted. Fix the export, or re-run with --no-consent-export')
      console.error('   if you are certain this tenant holds no signatures.\n')
      throw err
    }
    if (res.file) {
      wrote += 1
      console.log(
        `   · ${teamId}: ${res.acceptances} acceptances, ${res.versions} versions → ${res.file}`
      )
    } else {
      console.log(`   · ${teamId}: nothing signed, no file written`)
    }
  }
  console.log(`   ${wrote} ledger file(s) written.`)
}
