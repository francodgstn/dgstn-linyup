// The background drain for a Tarif 595 bulk run — one invocation = one round
// of TARIF595_BULK_BATCH contacts, re-enqueuing itself until the team's
// contacts are walked. The engine and the stop conditions live in bulk.ts
// (`runBulkRound`); what is decided HERE is only the Cloud Tasks contract:
//
//   • an unusable payload RETURNS (a retry cannot improve it);
//   • a job that `runBulkRound` reports done ends the chain;
//   • anything that THROWS is an infrastructure error, handed back to Cloud
//     Tasks to retry — safe, because the round's progress write and the
//     `rounds >= round` guard make a redelivery a no-op.
//
// Exported from src/index.ts so Firebase creates the queue under this name in
// europe-west6; bulk.ts addresses it as
// locations/europe-west6/functions/runTarif595BulkIssue.

import { onTaskDispatched } from 'firebase-functions/v2/tasks'
import { enqueueBulkRound, runBulkRound, type Tarif595BulkPayload } from './bulk'

export const runTarif595BulkIssue = onTaskDispatched<Tarif595BulkPayload>(
  {
    // A round renders up to a few dozen PDFs and uploads twice as many files;
    // nine minutes is generous for TARIF595_BULK_BATCH contacts. The chain, not
    // the timeout, is what makes a run unbounded.
    timeoutSeconds: 540,
    memory: '1GiB',
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30 },
    // One worker per job is the intent; the cap is a platform-wide safety net
    // for several studios running their year-end at once.
    rateLimits: { maxConcurrentDispatches: 4 },
  },
  async (req) => {
    const { teamId, jobId, round } = req.data ?? {}
    if (!teamId || !jobId || typeof round !== 'number') {
      console.error('[tarif595:bulk] invalid payload:', req.data)
      return
    }
    const { done } = await runBulkRound(teamId, jobId, round)
    if (!done) await enqueueBulkRound(teamId, jobId, round + 1)
  }
)
