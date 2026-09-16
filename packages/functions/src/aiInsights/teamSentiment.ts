// ─── Team sentiment ───────────────────────────────────────────────────────────
//
// The `ai-team-sentiment` module: one reading of the whole team, made from the
// contact summaries the studio has already generated, shown on the dashboard.
// The pure half — the dossier, the reply, the prompt — is `teamSentimentPrompt.ts`.
//
// ── FIVE A DAY, COUNTED BEFORE THE CALL ─────────────────────────────────────
// One run sends up to TEAM_SENTIMENT_MAX_SUMMARIES summaries in one prompt, the
// largest call in the AI container by far. So a team gets
// TEAM_SENTIMENT_DAILY_LIMIT runs per calendar day (Europe/Zurich), and the run
// is RESERVED in a transaction before the model is asked — an attempt spends a
// run whether or not the model answers, because an answer is what costs. The
// count is written as an absolute value from the transaction's own read, never
// with FieldValue.increment, and nothing gives a run back: a second writer of
// that number is how a cap stops being one.
//
// The refusals that cost nothing — module off, not enough summaries — come
// BEFORE the reservation, so they never spend a run.
//
// ── ALL-SCOPED ONLY ──────────────────────────────────────────────────────────
// A coach scoped to their own book cannot read the other contacts, so they do
// not get a reading of them either: not here, and not through the rules on the
// stored document.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { Type } from '@google/genai'
import {
  AI_MODULES,
  AI_REPORTS_SUBCOLLECTION,
  CONTACTS_COLLECTION,
  TEAMS_COLLECTION,
  TEAM_SENTIMENT_DAILY_LIMIT,
  TEAM_SENTIMENT_MAX_AGE_DAYS,
  TEAM_SENTIMENT_MAX_SUMMARIES,
  TEAM_SENTIMENT_MIN_SUMMARIES,
  TEAM_SENTIMENT_MOODS,
  TEAM_SENTIMENT_REPORT_ID,
  aiUsageCountToday,
  aiUsageDayKey,
  computeEngagementBand,
  isRosterContact,
  type Contact,
  type TeamSentimentDoc,
} from '@linyup/shared'
import { to } from '../utils/async'
import { callerIsAllScoped, isTeamMember } from '../utils/teams'
import { pluginIsActive } from '../utils/plugins'
import { ASSISTANT_MODEL, getGenAI, replyWasStopped } from '../utils/vertexClient'
import { LANGUAGE_NAMES, toDate } from '../contacts/aiSummaryDossier'
import {
  buildTeamDossier,
  readTeamSentimentReply,
  teamSentimentSystemPrompt,
  type SentimentEntry,
} from './teamSentimentPrompt'

/**
 * How many contacts the query reads to find TEAM_SENTIMENT_MAX_SUMMARIES live
 * ones: archived and deleted contacts keep their summaries and are dropped in
 * memory, so the read has some headroom. Bounded either way.
 */
const READ_LIMIT = 200

const SENTIMENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    mood: { type: Type.STRING, enum: [...TEAM_SENTIMENT_MOODS], description: 'the overall reading' },
    overview: { type: Type.STRING, description: 'the overall picture and its direction' },
    strengths: { type: Type.STRING, description: 'what is working, as shared patterns' },
    concerns: { type: Type.STRING, description: 'what to watch, as groups — never individuals' },
    focus: { type: Type.STRING, description: 'one or two team-level things to do next' },
  },
  required: ['mood', 'overview', 'strengths', 'concerns', 'focus'],
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

  const db = admin.firestore()
  const teamSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
  const team = teamSnap.data()
  const now = new Date()

  // Newest summaries first. A contact without a summary has no
  // `ai_summary.generated_at` and is not in this ordering at all, which is the
  // filter. Index: contacts (teamId ASC, ai_summary.generated_at DESC).
  const snap = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .orderBy('ai_summary.generated_at', 'desc')
    .limit(READ_LIMIT)
    .get()

  const maxAgeMs = TEAM_SENTIMENT_MAX_AGE_DAYS * 86_400_000
  const entries: SentimentEntry[] = []
  let oldest: Date | null = null
  for (const d of snap.docs) {
    if (entries.length >= TEAM_SENTIMENT_MAX_SUMMARIES) break
    const contact = { ...d.data(), id: d.id } as Contact
    if (!isRosterContact(contact)) continue
    const summary = contact.ai_summary
    const generated = toDate(summary?.generated_at)
    if (!summary || !generated) continue
    const ageMs = now.getTime() - generated.getTime()
    // Ordered newest first, so the first summary past the cut ends the list.
    if (ageMs > maxAgeMs) break
    const lastMs = toDate(contact.last_session_at)?.getTime() ?? null
    const refMs = lastMs ?? toDate(contact.created_at)?.getTime() ?? null
    entries.push({
      firstname: contact.firstname,
      band: computeEngagementBand(refMs, team?.engagement_thresholds, now.getTime()),
      ageDays: Math.max(0, Math.floor(ageMs / 86_400_000)),
      status: summary.sections?.status ?? null,
      outlook: summary.sections?.outlook ?? null,
      text: summary.text ?? null,
    })
    oldest = generated
  }

  if (entries.length < TEAM_SENTIMENT_MIN_SUMMARIES) {
    throw new HttpsError('failed-precondition', 'Not enough contact summaries yet.', {
      reason: 'not_enough_summaries',
      found: entries.length,
      needed: TEAM_SENTIMENT_MIN_SUMMARIES,
    })
  }

  // RESERVE THE RUN — see the header.
  const ref = db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(AI_REPORTS_SUBCOLLECTION)
    .doc(TEAM_SENTIMENT_REPORT_ID)
  const day = aiUsageDayKey(now)
  const used = await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() as TeamSentimentDoc | undefined
    const count = aiUsageCountToday(current?.usage, now)
    if (count >= TEAM_SENTIMENT_DAILY_LIMIT) {
      throw new HttpsError('resource-exhausted', 'The daily limit for team readings is reached.', {
        reason: 'daily_limit',
        limit: TEAM_SENTIMENT_DAILY_LIMIT,
      })
    }
    tx.set(ref, { usage: { day, count: count + 1 } }, { merge: true })
    return count + 1
  })

  const langRaw = String(team?.language ?? 'en')
  const lang = langRaw in LANGUAGE_NAMES ? langRaw : 'en'

  let raw = ''
  let cut = false
  try {
    const response = await getGenAI().models.generateContent({
      model: ASSISTANT_MODEL,
      contents: [{ role: 'user', parts: [{ text: buildTeamDossier(entries) }] }],
      config: {
        systemInstruction: teamSentimentSystemPrompt(LANGUAGE_NAMES[lang]),
        maxOutputTokens: 1024,
        // No thinking: it would spend the output cap (see utils/vertexClient.ts).
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0.4,
        responseMimeType: 'application/json',
        responseJsonSchema: SENTIMENT_SCHEMA,
      },
    })
    raw = response.text ?? ''
    cut = replyWasStopped(response)
    if (cut) console.warn(`[generateTeamSentiment] reply hit the output cap (team=${teamId})`)
  } catch (err) {
    console.error('[generateTeamSentiment] Vertex error:', (err as Error).message)
    throw new HttpsError('internal', 'The reading service is unavailable right now.')
  }

  // A stopped reply keeps the parts that closed; `readTeamSentimentReply` never
  // stores a half-written one, and refuses outright without an overview.
  const reading = readTeamSentimentReply(raw)
  if (!reading) throw new HttpsError('internal', 'The reading came back empty.')

  // `update` with the whole `report` map REPLACES it — a `set` with merge would
  // deep-merge and keep a previous reading's parts beside the new ones.
  await ref.update({
    report: {
      mood: reading.mood,
      sections: reading.sections,
      generated_at: FieldValue.serverTimestamp(),
      generated_by: uid,
      model: ASSISTANT_MODEL,
      language: lang,
      summaries_used: entries.length,
      summaries_oldest_at: oldest ? Timestamp.fromDate(oldest) : null,
    },
  })

  return {
    mood: reading.mood,
    sections: reading.sections,
    summariesUsed: entries.length,
    runsLeft: Math.max(0, TEAM_SENTIMENT_DAILY_LIMIT - used),
  }
})
