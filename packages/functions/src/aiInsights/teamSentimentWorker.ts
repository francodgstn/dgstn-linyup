// The background drain for a team sentiment run — one invocation = one round of
// TEAM_SENTIMENT_REFRESH_BATCH members, re-enqueuing itself until the run's
// members are walked and the reading is written. The engine and its guards live
// in teamSentimentRun.ts (`runTeamSentimentRound`); what is decided HERE is only
// the Cloud Tasks contract, as in tarif595/bulkWorker.ts:
//
//   • an unusable payload RETURNS (a retry cannot improve it);
//   • a round `runTeamSentimentRound` reports done ends the chain;
//   • anything that THROWS is an infrastructure error, handed back to Cloud
//     Tasks to retry — safe, because the round's progress write and the
//     `rounds_done` guard make a redelivery a no-op, and a member a crashed
//     round already refreshed looks fresh to the retry.
//
// Exported from src/index.ts so Firebase creates the queue under this name in
// europe-west6; teamSentimentRun.ts addresses it as
// locations/europe-west6/functions/refreshTeamSentimentRound.

import { onTaskDispatched } from 'firebase-functions/v2/tasks'
import { enqueueTeamSentimentRound, runTeamSentimentRound, type TeamSentimentPayload } from './teamSentimentRun'

export const refreshTeamSentimentRound = onTaskDispatched<TeamSentimentPayload>(
  {
    // A round is up to TEAM_SENTIMENT_REFRESH_BATCH briefings, a few at a time,
    // plus — on the last round — the team reading. Nine minutes is generous.
    timeoutSeconds: 540,
    memory: '512MiB',
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 },
    // A platform-wide safety net for several studios pressing at once; each
    // run is one chain, so this bounds model calls in flight across tenants.
    rateLimits: { maxConcurrentDispatches: 6 },
  },
  async (req) => {
    const { teamId, runId, round } = req.data ?? ({} as Partial<TeamSentimentPayload>)
    if (!teamId || !runId || typeof round !== 'number') {
      console.error('[teamSentiment] invalid payload:', req.data)
      return
    }
    const { done } = await runTeamSentimentRound(teamId, runId, round)
    if (!done) await enqueueTeamSentimentRound(teamId, runId, round + 1)
  }
)
