// EXPORT-BEFORE-TEARDOWN — the whole-tenant consent ledger, read once and
// written by BOTH teardown paths so a departing studio's signatures survive it.
//
// NOT to be confused with its sibling `consentLedger.ts`, which loads the
// `consent` FILTER dimension (one document's signer map, for matchesFilter). This
// file is the ARCHIVE: every waiver-shaped artefact a team holds, serialized for
// keeping.
//
// `TENANT_DATA_COLLECTIONS` sweeps `documents` by `teamId`, and every per-team
// teardown recursively deletes it — so erasing a team destroys the acceptance
// events, the immutable version snapshots and the signer rows with it, every
// signature that team ever collected. A liability release is the ONE artefact a
// studio needs AFTER the relationship ends, over a window measured in years, so
// no teardown may proceed until the ledger is exported.
//
// Two paths tear a team down and BOTH gate on this:
//   • the CLI `scripts/purge-team.ts` (the GDPR-erasure tool) → writes to disk
//     through scripts/lib/exportConsentLedger.ts;
//   • the scheduled self-service purge `dailyTasks/purgeScheduledTeams.ts`,
//     which runs in a Cloud Function with NO local disk → writes to GCS via
//     `requireTeamConsentExportToGcs` below.
//
// This module is the single READER both share, so the two can never drift on
// WHAT a signature is made of — the four subcollections named in
// CONSENT_LEDGER_SUBCOLLECTIONS.

import * as admin from 'firebase-admin'
import type { Firestore } from 'firebase-admin/firestore'

// The subcollections that make a signature mean something: the frozen TEXT (an
// acceptance stores only its hash, so without the versions the events are
// fingerprints of nothing), the append-only EVENTS, the current-state SIGNER
// rows, and the declared-but-unwritten NOTICE rows.
export const CONSENT_LEDGER_SUBCOLLECTIONS = ['versions', 'acceptances', 'signers', 'notices'] as const

export interface TeamConsentLedgerArchive {
  exported_at: string
  teamId: string
  waiver_policy: unknown
  documents: Array<{
    id: string
    document: unknown
    versions: unknown[]
    acceptances: unknown[]
    signers: unknown[]
    notices: unknown[]
  }>
}

export interface TeamConsentLedger {
  teamId: string
  counts: { documents: number; versions: number; acceptances: number; signers: number }
  /** The serializable archive, or NULL when the team never signed anything — the
   *  ordinary sandbox case, where writing an empty artefact would train whoever
   *  reads the output to ignore it. A null archive means "safe to delete, there
   *  was nothing to preserve", NOT "the read failed" (a failed read throws). */
  archive: TeamConsentLedgerArchive | null
}

/**
 * Read every waiver-shaped artefact belonging to one team into a serializable
 * object. Deliberately raw rather than rendered: an archive is read by whoever
 * asks in three years, and the fewest assumptions about what they will want is
 * the safest shape. Throws on any read failure — a teardown that proceeds past a
 * failed export is the exact outcome the gate exists to prevent.
 */
export async function readTeamConsentLedger(
  db: Firestore,
  teamId: string,
  exportedAtIso: string
): Promise<TeamConsentLedger> {
  const documentsSnap = await db.collection('documents').where('teamId', '==', teamId).get()
  const counts = { documents: documentsSnap.size, versions: 0, acceptances: 0, signers: 0 }
  if (documentsSnap.empty) return { teamId, counts, archive: null }

  const policySnap = await db
    .collection('teams')
    .doc(teamId)
    .collection('waiver_policy')
    .doc('current')
    .get()

  const documents: TeamConsentLedgerArchive['documents'] = []
  for (const doc of documentsSnap.docs) {
    const [versions, acceptances, signers, notices] = await Promise.all([
      doc.ref.collection('versions').get(),
      doc.ref.collection('acceptances').get(),
      doc.ref.collection('signers').get(),
      doc.ref.collection('notices').get(),
    ])
    counts.versions += versions.size
    counts.acceptances += acceptances.size
    counts.signers += signers.size
    documents.push({
      id: doc.id,
      document: doc.data(),
      versions: versions.docs.map((d) => ({ id: d.id, ...d.data() })),
      acceptances: acceptances.docs.map((d) => ({ id: d.id, ...d.data() })),
      signers: signers.docs.map((d) => ({ id: d.id, ...d.data() })),
      notices: notices.docs.map((d) => ({ id: d.id, ...d.data() })),
    })
  }

  // Nothing was ever signed here. Say so and archive nothing — see above.
  if (counts.acceptances === 0 && counts.versions === 0) return { teamId, counts, archive: null }

  return {
    teamId,
    counts,
    archive: { exported_at: exportedAtIso, teamId, waiver_policy: policySnap.data() ?? null, documents },
  }
}

export interface GcsConsentExportResult {
  teamId: string
  counts: TeamConsentLedger['counts']
  /** gs:// URI of the object written, or null when the team held no signatures. */
  uri: string | null
}

/**
 * THE GATE for the scheduled Cloud Function teardown: export the team's ledger
 * to GCS, and THROW if the read or the upload fails so the caller leaves the
 * team scheduled and retries tomorrow rather than deleting unexported.
 *
 * The object lands under the top-level `consent-ledgers/{teamId}/` prefix, NOT
 * under `teams/{teamId}/` — `purgeTeam` erases the team's Storage prefix, and
 * the whole point is an artefact that OUTLIVES the team. A team that never
 * signed anything writes nothing and is cleared to delete.
 */
export async function requireTeamConsentExportToGcs(
  db: Firestore,
  teamId: string
): Promise<GcsConsentExportResult> {
  const nowIso = new Date().toISOString()
  const ledger = await readTeamConsentLedger(db, teamId, nowIso)
  if (!ledger.archive) return { teamId, counts: ledger.counts, uri: null }

  const stamp = nowIso.replace(/[:.]/g, '-')
  const objectPath = `consent-ledgers/${teamId}/consent-ledger-${teamId}-${stamp}.json`
  const bucket = admin.storage().bucket()
  await bucket.file(objectPath).save(JSON.stringify(ledger.archive, null, 2) + '\n', {
    contentType: 'application/json',
    resumable: false,
  })
  return { teamId, counts: ledger.counts, uri: `gs://${bucket.name}/${objectPath}` }
}
