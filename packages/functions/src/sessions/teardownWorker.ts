/* eslint-disable no-console */
// ─── The background drain for a large series teardown ─────────────────────────
//
// One invocation = one batch. The handler re-enqueues itself until the scope is
// empty, so no single run approaches the timeout however long the series is, and
// Cloud Tasks' retry/backoff covers a transient Firestore or mail failure for
// free.
//
// The design and its concurrency rules belong to `SeriesTeardownJob`
// (packages/shared/src/types/sessionSeriesJob.ts) and the engine in ./teardown.
// What is decided HERE, and nowhere else, is when a job STOPS:
//
//   • drained            → completed (or completed_with_errors, if any session
//                          could not be torn down)
//   • too many failures  → failed, series left frozen
//   • round cap reached  → failed, series left frozen
//
// A business-level problem RETURNS rather than throws: throwing hands the task
// back to Cloud Tasks, which would retry a job that has already decided it is
// finished. Only genuinely retryable infrastructure errors are allowed to
// propagate.

import { onTaskDispatched } from 'firebase-functions/v2/tasks'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import {
  SERIES_TEARDOWN_MAX_FAILURES,
  SERIES_TEARDOWN_MAX_ROUNDS,
  type SeriesTeardownJob,
} from '@linyup/shared'
import { to } from '../utils/async'
import {
  enqueueTeardownRound,
  finalizeTeardownJob,
  getTeamData,
  jobRef,
  runSeriesTeardownBatch,
  type SeriesTeardownPayload,
} from './teardown'

export const runSeriesTeardown = onTaskDispatched<SeriesTeardownPayload>(
  {
    // A batch is bounded work, but each session in it can send mail to a full
    // roster. Nine minutes leaves generous headroom for SERIES_TEARDOWN_BATCH
    // sessions; the chain, not the timeout, is what makes the job unbounded.
    timeoutSeconds: 540,
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30 },
    // One worker per job is the intent; the cap is a platform-wide safety net
    // for many studios tearing down at once.
    rateLimits: { maxConcurrentDispatches: 6 },
  },
  async (req) => {
    const { jobId, round } = req.data ?? {}
    if (!jobId || typeof round !== 'number') {
      console.error('[teardown] invalid payload:', req.data)
      return // never throw — Cloud Tasks would retry a payload that can't improve
    }

    const db = admin.firestore()
    const ref = jobRef(db, jobId)
    const [jobErr, jobSnap] = await to(ref.get())
    if (jobErr) throw jobErr // transient: let Cloud Tasks retry
    if (!jobSnap || !jobSnap.exists) {
      console.error(`[teardown] job ${jobId} not found`)
      return
    }

    const job = jobSnap.data() as SeriesTeardownJob
    if (job.status !== 'running') {
      console.log(`[teardown] job ${jobId} already ${job.status}, round ${round} ignored`)
      return
    }
    // A redelivery of a round this job has already completed. Progress is
    // delete-driven so re-running would be survivable, but it would also mail a
    // second batch of members in parallel with the live chain — the one cost the
    // claim exists to avoid, avoided here more cheaply.
    if ((job.rounds ?? 0) >= round) {
      console.log(`[teardown] job ${jobId} round ${round} already done (at ${job.rounds})`)
      return
    }

    const teamData = await getTeamData(db, job.teamId)
    const batch = await runSeriesTeardownBatch({
      db,
      jobId,
      seriesId: job.seriesId,
      cutoff: job.cutoff as unknown as Timestamp,
      teamData,
      failedIds: job.failed_ids ?? [],
      // Pinned at enqueue, read here: whether the news is this job's to deliver.
      // Absent on every job written before the field existed, and those are all
      // "delete this and all following", which notifies.
      notify: job.notify ?? true,
    })

    const failedIds = [...(job.failed_ids ?? []), ...batch.newFailedIds]

    await ref.update({
      processed: FieldValue.increment(batch.processed),
      notified: FieldValue.increment(batch.sent),
      notify_failed: FieldValue.increment(batch.failed),
      ...(batch.newFailedIds.length ? { failed_ids: failedIds } : {}),
      rounds: round,
      updated_at: FieldValue.serverTimestamp(),
    })

    if (batch.drained) {
      await finalizeTeardownJob(
        db,
        jobId,
        job.seriesId,
        failedIds.length > 0 ? 'completed_with_errors' : 'completed'
      )
      return
    }

    if (failedIds.length >= SERIES_TEARDOWN_MAX_FAILURES) {
      await finalizeTeardownJob(
        db,
        jobId,
        job.seriesId,
        'failed',
        `${failedIds.length} sessions could not be deleted`
      )
      return
    }

    if (round >= SERIES_TEARDOWN_MAX_ROUNDS) {
      await finalizeTeardownJob(
        db,
        jobId,
        job.seriesId,
        'failed',
        `round cap ${SERIES_TEARDOWN_MAX_ROUNDS} reached`
      )
      return
    }

    // A batch that claimed nothing (every candidate held by a live claim) is not
    // progress, but it is not an error either — the next round finds them freed.
    await enqueueTeardownRound(jobId, round + 1)
  }
)
