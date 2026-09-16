// ─── Team sentiment ───────────────────────────────────────────────────────────
//
// The `ai-team-sentiment` module: one reading of the team's ACTIVE members,
// shown on the dashboard. This callable is the button, and it only STARTS a run:
// the run refreshes the active members' briefings and then reads them, in Cloud
// Task rounds (teamSentimentRun.ts, teamSentimentWorker.ts). The pure half — the
// dossier, the reply, the prompt — is `teamSentimentPrompt.ts`.
//
// ── FIVE A DAY, COUNTED BEFORE ANYTHING IS SPENT ────────────────────────────
// A run makes a model call for every active member with something new, and one
// more for the reading, so a team gets TEAM_SENTIMENT_DAILY_LIMIT runs per
// calendar day (Europe/Zurich). The run is RESERVED in the same transaction that
// creates it, before the first member is touched — a run spends its slot whether
// or not it finishes, because the calls are what cost. The count is written as an
// absolute value from the transaction's own read, never with
// FieldValue.increment, and nothing gives a run back: a second writer of that
// number is how a cap stops being one.
//
// The refusals that cost nothing — a module off, a run already going, too few
// active members — come BEFORE the reservation, so they never spend a run.
//
// ── ALL-SCOPED ONLY ──────────────────────────────────────────────────────────
// A coach scoped to their own book cannot read the other contacts, so they do
// not get a reading of them either: not here, and not through the rules on the
// stored document.
//
// ── IT NEEDS THE BRIEFINGS MODULE ────────────────────────────────────────────
// The run writes contact briefings, which belong to `ai-contact-summary`. With
// that module off, the studio has chosen not to have them, so the run refuses
// rather than write summaries nobody switched on.

import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import {
  AI_MODULES,
  DEFAULT_ENGAGEMENT_THRESHOLDS,
  TEAMS_COLLECTION,
  TEAM_SENTIMENT_DAILY_LIMIT,
  TEAM_SENTIMENT_MIN_SUMMARIES,
  aiUsageCountToday,
  aiUsageDayKey,
  teamSentimentRunInProgress,
  type EngagementThresholds,
  type TeamSentimentDoc,
  type TeamSentimentRun,
} from '@linyup/shared'
import { to } from '../utils/async'
import { callerIsAllScoped, isTeamMember } from '../utils/teams'
import { pluginIsActive } from '../utils/plugins'
import {
  enqueueTeamSentimentRound,
  failTeamSentimentRun,
  loadActiveMemberIds,
  sentimentRef,
} from './teamSentimentRun'

function runInProgress(): HttpsError {
  return new HttpsError('failed-precondition', 'A team reading is already being made.', { reason: 'run_in_progress' })
}

export const generateTeamSentiment = onCall({ timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.')
  const uid = request.auth.uid
  const { teamId } = (request.data ?? {}) as { teamId?: string }
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required.')

  const [memberErr, isMember] = await to(isTeamMember(uid, teamId))
  if (memberErr || !isMember) {
    throw new HttpsError('permission-denied', 'You are not a member of this team.')
  }
  if (!(await callerIsAllScoped(uid, teamId))) {
    throw new HttpsError('permission-denied', 'The team reading covers every contact.')
  }
  if (!(await pluginIsActive(teamId, AI_MODULES.teamSentiment))) {
    throw new HttpsError('failed-precondition', 'Team sentiment is not switched on for this team.')
  }
  if (!(await pluginIsActive(teamId, AI_MODULES.contactSummary))) {
    throw new HttpsError('failed-precondition', 'Contact briefings are not switched on for this team.', {
      reason: 'contact_summary_off',
    })
  }

  const db = admin.firestore()
  const ref = sentimentRef(teamId)
  const team = (await db.collection(TEAMS_COLLECTION).doc(teamId).get()).data()
  const thresholds: EngagementThresholds = team?.engagement_thresholds ?? DEFAULT_ENGAGEMENT_THRESHOLDS
  const now = new Date()

  const existing = (await ref.get()).data() as TeamSentimentDoc | undefined
  if (teamSentimentRunInProgress(existing?.run, now.getTime())) throw runInProgress()

  const memberIds = await loadActiveMemberIds(teamId, thresholds, now.getTime())
  if (memberIds.length < TEAM_SENTIMENT_MIN_SUMMARIES) {
    throw new HttpsError('failed-precondition', 'Not enough active members for a team reading.', {
      reason: 'not_enough_members',
      found: memberIds.length,
      needed: TEAM_SENTIMENT_MIN_SUMMARIES,
      active_within_days: thresholds.active_within_days,
    })
  }

  // RESERVE AND START THE RUN, in one transaction — see the header.
  const runId = db.collection('_').doc().id
  const day = aiUsageDayKey(now)
  const used = await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() as TeamSentimentDoc | undefined
    if (teamSentimentRunInProgress(current?.run, now.getTime())) throw runInProgress()
    const count = aiUsageCountToday(current?.usage, now)
    if (count >= TEAM_SENTIMENT_DAILY_LIMIT) {
      throw new HttpsError('resource-exhausted', 'The daily limit for team readings is reached.', {
        reason: 'daily_limit',
        limit: TEAM_SENTIMENT_DAILY_LIMIT,
      })
    }
    const run: TeamSentimentRun = {
      id: runId,
      status: 'refreshing',
      started_at: Timestamp.fromDate(now),
      started_by: uid,
      finished_at: null,
      active_within_days: thresholds.active_within_days,
      member_ids: memberIds,
      rounds_done: 0,
      refreshed: 0,
      reused: 0,
      failed: 0,
      error: null,
    }
    // `mergeFields` replaces `usage` and `run` WHOLE — a deep merge would keep the
    // previous run's fields — and leaves the last `report` on the card meanwhile.
    tx.set(ref, { usage: { day, count: count + 1 }, run }, { mergeFields: ['usage', 'run'] })
    return count + 1
  })

  try {
    await enqueueTeamSentimentRound(teamId, runId, 0)
  } catch (err) {
    console.error('[generateTeamSentiment] could not queue the run:', (err as Error).message)
    await failTeamSentimentRun(teamId, runId, 'enqueue_failed')
    throw new HttpsError('internal', 'The reading could not be started. Try again in a moment.')
  }

  return {
    runId,
    members: memberIds.length,
    activeWithinDays: thresholds.active_within_days,
    runsLeft: Math.max(0, TEAM_SENTIMENT_DAILY_LIMIT - used),
  }
})
