// Tarif 595 — BULK issuing: "issue the receipts for every member" at year end.
//
// One receipt per subscription-history row of a MAPPED plan that overlaps the
// window, for every live contact of the team, each issued through the very
// same `issueReceipt` the detail page runs (issue.ts) — so a bulk receipt is
// byte-for-byte the one the manager would have produced by hand, and a member
// who already got theirs is simply found (`already_issued`), not numbered
// twice. Attendance and course receipts stay manual: one needs a price the
// records do not carry, the other is one purchase, issued when it happens.
//
// A studio of a few hundred members is a few hundred PDF renders and uploads,
// which does not fit in a callable. So a run is a JOB — `tarif595_jobs/{jobId}`
// — drained by Cloud Task rounds of TARIF595_BULK_BATCH contacts, exactly the
// shape of the series teardown (sessions/teardown.ts + teardownWorker.ts):
//
//   • the callable measures the scope, mints the job and enqueues round 1;
//   • each round walks one page of contacts (ordered by document id, cursor on
//     the job), issues, writes progress as ABSOLUTE values (no
//     FieldValue.increment — noJournal.test.ts), and re-enqueues itself;
//   • the round's task id is `${jobId}-r${round}` — job id first, because Cloud
//     Tasks degrades on sequential id prefixes, and deterministic so a
//     redelivered round cannot start a second chain (`task-already-exists` is
//     read as the success it is);
//   • a business outcome RETURNS, an infrastructure error THROWS (Cloud Tasks
//     retries the round; `rounds >= round` on the job makes the retry a no-op
//     once the round's write landed).
//
// On a developer's machine with no Cloud Tasks emulator the callable runs the
// rounds INLINE instead (`runsInlineForLocalDev`, the same switch the
// scheduled fan-out uses) — the same `runBulkRound`, so there is no second
// implementation to drift.
//
// Every non-issue is RECORDED with its reason (the preview's own blocking
// codes), because the point of a bulk run is finding out which members are
// missing an AHV number or an address before the insurer does.

import * as admin from 'firebase-admin'
import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION,
  TARIF595_BULK_BATCH,
  TARIF595_BULK_MAX_FAILURES,
  TARIF595_BULK_MAX_ROUNDS,
  TARIF595_BULK_SKIPS_MAX,
  TARIF595_BULK_STALE_MS,
  TARIF595_JOBS_SUBCOLLECTION,
  TARIF595_PLUGIN_ID,
  TEAMS_COLLECTION,
  isLiveContact,
  tarif595OfferingKey,
  type SubscriptionHistoryEntry,
  type Tarif595BulkJob,
  type Tarif595BulkRequest,
  type Tarif595BulkResult,
  type Tarif595BulkSkip,
  type Tarif595BulkStatus,
  type Tarif595OfferingMapping,
  type Tarif595WarningCode,
} from '@linyup/shared'
import { assertManager } from '../connect/access'
import { assertPluginInstalled } from '../utils/plugins'
import { runsInlineForLocalDev } from '../utils/tenantFanOut'
import { loadSetup, requireCompleteSetup } from './config'
import { issueReceipt } from './issue'
import { zurichDay } from './sources'

/**
 * The queue is created by Firebase with the same name as the handler, in the
 * handler's region; a bare name would default to us-central1 (see
 * TEARDOWN_FUNCTION in sessions/teardown.ts for the full note).
 */
const BULK_FUNCTION = 'locations/europe-west6/functions/runTarif595BulkIssue'

export interface Tarif595BulkPayload {
  teamId: string
  jobId: string
  round: number
}

/** A bulk run never attests a period another issued receipt already covers —
 *  the manager on the detail page sees the warning and decides; a job cannot. */
const BULK_REFUSED_WARNINGS: ReadonlySet<Tarif595WarningCode> = new Set<Tarif595WarningCode>(['overlapping_receipt'])

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

export function bulkJobRef(teamId: string, jobId: string): FirebaseFirestore.DocumentReference {
  return admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(TARIF595_JOBS_SUBCOLLECTION).doc(jobId)
}

// ─── Row selection (pure) ─────────────────────────────────────────────────────

export interface BulkHistoryRow {
  id: string
  subscriptionTypeId: string | null
  /** YYYY-MM-DD or null. */
  start: string | null
  /** YYYY-MM-DD, or null while the subscription is still open. */
  end: string | null
}

export interface BulkRow {
  historyId: string
  from: string
  to: string
}

/**
 * Which history rows get a receipt, and for which period: rows of a mapped
 * plan that overlap the window, clipped to it — an open row ends at the run
 * day. Clipping is what Qualitop FAQ 3.5 allows ("one receipt per month, or
 * one line with the number of months"): a subscription running June to May
 * gets a January-to-May receipt from a calendar-year run, which is what the
 * member's insurer reimburses by. The start is never moved EARLIER than the
 * row's own (Helsana §4.1).
 */
export function selectBulkRows(
  rows: BulkHistoryRow[],
  window: { from: string; to: string },
  offerings: Record<string, Tarif595OfferingMapping>,
  today: string
): BulkRow[] {
  const out: BulkRow[] = []
  for (const row of rows) {
    if (!row.subscriptionTypeId || !row.start) continue
    if (!offerings[tarif595OfferingKey('subscription', row.subscriptionTypeId)]) continue
    const end = row.end ?? today
    const from = row.start > window.from ? row.start : window.from
    const to = end < window.to ? end : window.to
    if (from > to) continue
    out.push({ historyId: row.id, from, to })
  }
  return out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.historyId.localeCompare(b.historyId)))
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** One page of the team's contacts, in document-id order from the cursor —
 *  an equality filter plus the id order needs no composite index. Liveness is
 *  decided in memory by the ONE predicate (`isLiveContact`): `archived_at`
 *  and `deleted_at` are always present on a contact, but `external` and
 *  `provisional` are not, and the predicate knows which is which. */
async function listContactsPage(teamId: string, cursor: string | null, size: number) {
  let q = admin.firestore().collection(CONTACTS_COLLECTION).where('teamId', '==', teamId).orderBy(FieldPath.documentId()).limit(size)
  if (cursor) q = q.startAfter(cursor)
  return (await q.get()).docs
}

async function loadHistoryRows(contactId: string): Promise<BulkHistoryRow[]> {
  const snap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(contactId).collection(CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION).get()
  return snap.docs.map((d) => {
    const h = d.data() as SubscriptionHistoryEntry
    return { id: d.id, subscriptionTypeId: h.subscription_type_id ?? null, start: zurichDay(h.start_date), end: zurichDay(h.end_date) }
  })
}

// ─── Job lifecycle ────────────────────────────────────────────────────────────

/** Mint the progress document — the ONE writer of a job's initial shape. */
async function createBulkJob(params: { teamId: string; from: string; to: string; total: number; createdBy: string }): Promise<string> {
  const ref = admin.firestore().collection(TEAMS_COLLECTION).doc(params.teamId).collection(TARIF595_JOBS_SUBCOLLECTION).doc()
  const job: Omit<Tarif595BulkJob, 'id' | 'created_at' | 'updated_at'> & { created_at: FieldValue; updated_at: FieldValue } = {
    teamId: params.teamId,
    from: params.from,
    to: params.to,
    status: 'running',
    total: params.total,
    processed: 0,
    issued: 0,
    skipped: 0,
    failed: 0,
    failed_ids: [],
    skips: [],
    cursor: null,
    rounds: 0,
    createdBy: params.createdBy,
    error: null,
    finished_at: null,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  }
  await ref.set(job)
  return ref.id
}

async function finalizeBulkJob(ref: FirebaseFirestore.DocumentReference, status: Tarif595BulkStatus, error?: string): Promise<void> {
  await ref.update({ status, error: error ?? null, finished_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() })
  console.log(`[tarif595:bulk] job ${ref.id} → ${status}${error ? `: ${error}` : ''}`)
}

export async function enqueueBulkRound(teamId: string, jobId: string, round: number): Promise<void> {
  if (round > TARIF595_BULK_MAX_ROUNDS) throw new Error(`tarif595 bulk ${jobId} exceeded ${TARIF595_BULK_MAX_ROUNDS} rounds`)
  const { getFunctions } = await import('firebase-admin/functions')
  const queue = getFunctions().taskQueue<Tarif595BulkPayload>(BULK_FUNCTION)
  try {
    await queue.enqueue({ teamId, jobId, round }, { id: `${jobId}-r${round}` })
  } catch (err) {
    if ((err as { code?: string })?.code === 'functions/task-already-exists') {
      console.log(`[tarif595:bulk] round ${round} of ${jobId} was already queued`)
      return
    }
    throw err
  }
}

/**
 * One round: a page of contacts, issued. Returns `done` when nothing is left
 * for THIS chain to do — drained, stopped, or a redelivery of a round that
 * already landed. Progress is written once, at the end, as absolute values
 * from the row read at the start; the deterministic task id and the `rounds`
 * guard are what make that safe.
 */
export async function runBulkRound(teamId: string, jobId: string, round: number): Promise<{ done: boolean }> {
  const ref = bulkJobRef(teamId, jobId)
  const snap = await ref.get()
  if (!snap.exists) {
    console.error(`[tarif595:bulk] job ${jobId} not found`)
    return { done: true }
  }
  const job = snap.data() as Tarif595BulkJob
  if (job.status !== 'running') {
    console.log(`[tarif595:bulk] job ${jobId} already ${job.status}, round ${round} ignored`)
    return { done: true }
  }
  if ((job.rounds ?? 0) >= round) {
    console.log(`[tarif595:bulk] job ${jobId} round ${round} already done (at ${job.rounds})`)
    return { done: true }
  }

  const { setup, issues } = await loadSetup(teamId)
  if (!setup) {
    await finalizeBulkJob(ref, 'failed', `setup incomplete: ${issues.map((i) => i.detail).join(', ')}`)
    return { done: true }
  }
  const today = zurichDay(new Date()) ?? new Date().toISOString().slice(0, 10)

  const page = await listContactsPage(teamId, job.cursor, TARIF595_BULK_BATCH)
  const skips: Tarif595BulkSkip[] = [...(job.skips ?? [])]
  const failedIds = [...(job.failed_ids ?? [])]
  let issued = job.issued ?? 0
  let skipped = job.skipped ?? 0
  let failed = job.failed ?? 0
  const recordSkip = (s: Tarif595BulkSkip) => {
    skipped++
    if (skips.length < TARIF595_BULK_SKIPS_MAX) skips.push(s)
  }

  for (const doc of page) {
    if (!isLiveContact(doc.data())) continue
    const rows = selectBulkRows(await loadHistoryRows(doc.id), { from: job.from, to: job.to }, setup.config.offerings, today)
    for (const row of rows) {
      try {
        const outcome = await issueReceipt(
          { teamId, contactId: doc.id, source: { kind: 'subscription', historyId: row.historyId }, from: row.from, to: row.to, unitPriceMinor: null },
          job.createdBy,
          { refuseOnWarnings: BULK_REFUSED_WARNINGS }
        )
        if (outcome.kind === 'issued') issued++
        else if (outcome.kind === 'existing') recordSkip({ contactId: doc.id, historyId: row.historyId, code: 'already_issued' })
        else recordSkip({ contactId: doc.id, historyId: row.historyId, code: outcome.blocking[0]?.code ?? outcome.warnings[0]?.code ?? 'no_lines' })
      } catch (err) {
        failed++
        if (!failedIds.includes(doc.id)) failedIds.push(doc.id)
        console.error(`[tarif595:bulk] job ${jobId} contact ${doc.id} row ${row.historyId} failed:`, err)
      }
    }
  }

  const drained = page.length < TARIF595_BULK_BATCH
  await ref.update({
    processed: (job.processed ?? 0) + page.length,
    issued,
    skipped,
    failed,
    failed_ids: failedIds,
    skips,
    cursor: page.length ? page[page.length - 1].id : job.cursor ?? null,
    rounds: round,
    updated_at: FieldValue.serverTimestamp(),
  })

  if (drained) {
    await finalizeBulkJob(ref, failedIds.length > 0 ? 'completed_with_errors' : 'completed')
    return { done: true }
  }
  if (failedIds.length >= TARIF595_BULK_MAX_FAILURES) {
    await finalizeBulkJob(ref, 'failed', `${failedIds.length} contacts could not be issued`)
    return { done: true }
  }
  if (round >= TARIF595_BULK_MAX_ROUNDS) {
    await finalizeBulkJob(ref, 'failed', `round cap (${TARIF595_BULK_MAX_ROUNDS}) reached`)
    return { done: true }
  }
  return { done: false }
}

/** Advance the job from `round`: a Cloud Task in production, the rounds run
 *  to the end inline on an emulator without Cloud Tasks. */
export async function continueBulkJob(teamId: string, jobId: string, round: number): Promise<'background' | 'inline'> {
  if (runsInlineForLocalDev()) {
    console.log(`[tarif595:bulk] no Cloud Tasks emulator — running job ${jobId} inline`)
    for (let r = round; ; r++) {
      const { done } = await runBulkRound(teamId, jobId, r)
      if (done) break
    }
    return 'inline'
  }
  await enqueueBulkRound(teamId, jobId, round)
  return 'background'
}

// ─── The callable ─────────────────────────────────────────────────────────────

/**
 * CREATION, so plugin-gated (gate.test.ts). Refuses when the setup is
 * incomplete (the same validators the preview runs) and when a run is still
 * beating — a second chain over the same members would race the first on
 * every `pending` row. A `running` job with no heartbeat for
 * TARIF595_BULK_STALE_MS is presumed dead and a fresh run may start; that is
 * safe because a receipt is found by its deterministic id, never numbered
 * twice.
 */
export const startTarif595BulkIssue = onCall(
  // The production path returns as soon as round 1 is queued; the timeout is
  // for the emulator's inline path, where the whole run happens in the call.
  { timeoutSeconds: 300 },
  async (request): Promise<Tarif595BulkResult> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
    const data = (request.data ?? {}) as Partial<Tarif595BulkRequest>
    const teamId = typeof data.teamId === 'string' ? data.teamId.trim() : ''
    if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')
    if (typeof data.from !== 'string' || typeof data.to !== 'string' || !ISO_RE.test(data.from) || !ISO_RE.test(data.to) || data.to < data.from) {
      throw new HttpsError('invalid-argument', 'from and to must be YYYY-MM-DD, from ≤ to')
    }
    const uid = request.auth.uid
    await assertManager(uid, teamId)
    await assertPluginInstalled(teamId, TARIF595_PLUGIN_ID)
    await requireCompleteSetup(teamId)

    const db = admin.firestore()
    const jobs = db.collection(TEAMS_COLLECTION).doc(teamId).collection(TARIF595_JOBS_SUBCOLLECTION)
    const running = await jobs.where('status', '==', 'running').limit(1).get()
    if (!running.empty) {
      const prior = running.docs[0]
      const beat = (prior.data().updated_at as Timestamp | undefined)?.toMillis?.() ?? 0
      if (Date.now() - beat < TARIF595_BULK_STALE_MS) {
        throw new HttpsError('failed-precondition', 'A bulk run is already in progress', { reason: 'job_already_running', jobId: prior.id })
      }
      // Dead chain: close it so the list does not show two runs in flight.
      await finalizeBulkJob(prior.ref, 'failed', 'no heartbeat — presumed dead')
    }

    const total = (await db.collection(CONTACTS_COLLECTION).where('teamId', '==', teamId).count().get()).data().count
    const jobId = await createBulkJob({ teamId, from: data.from, to: data.to, total, createdBy: uid })
    console.log(`[tarif595:bulk] job ${jobId} started team=${teamId} window=${data.from}..${data.to} total=${total} by=${uid}`)

    let mode: 'background' | 'inline'
    try {
      mode = await continueBulkJob(teamId, jobId, 1)
    } catch (err) {
      console.error(`[tarif595:bulk] job ${jobId} could not be started:`, err)
      await finalizeBulkJob(bulkJobRef(teamId, jobId), 'failed', 'could not be queued')
      throw new HttpsError('internal', 'Could not start the bulk run')
    }
    return { jobId, mode, total }
  }
)
