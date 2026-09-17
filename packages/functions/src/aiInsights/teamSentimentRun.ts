// ─── A team sentiment run — refresh the active members, then read them ───────
//
// One press of the dashboard button (`generateTeamSentiment`) starts a RUN:
//
//   1. pick the team's ACTIVE members — on the roster AND in the `active`
//      engagement band (seen within the studio's `active_within_days`), most
//      recently seen first, capped at TEAM_SENTIMENT_MAX_SUMMARIES;
//   2. refresh each member's briefing that has something new since it was
//      written (`summaryNeedsRefresh` — a session, a booking, a note, or older
//      than SUMMARY_REUSE_MAX_AGE_DAYS), reusing the rest, in Cloud Task rounds
//      of TEAM_SENTIMENT_REFRESH_BATCH;
//   3. read THOSE members' briefings in one prompt and store the reading, which
//      says it covers active members within that threshold only.
//
// Rounds follow `tarif595/bulkWorker.ts`: one task per round, re-enqueuing the
// next. State lives on the dashboard's own document (`TeamSentimentDoc.run`), so
// the card shows progress with the listener it already has. Every write to the
// run is a transaction that re-reads it and checks the run id, status and
// `rounds_done`, and writes ABSOLUTE counts from that read — a redelivered round
// finds `rounds_done` moved on and does nothing. A member a crashed round already
// refreshed looks fresh to the retry and is reused, not charged twice.
//
// A briefing here is the SAME briefing the contact page's button writes
// (`generateSummaryForContact`), stamped `generated_by: 'team_sentiment'`.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { Type } from '@google/genai'
import {
  AI_REPORTS_SUBCOLLECTION,
  CONTACTS_COLLECTION,
  CONTACT_NOTES_SUBCOLLECTION,
  DEFAULT_ENGAGEMENT_THRESHOLDS,
  SESSION_BOOKINGS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  TEAM_SENTIMENT_MAX_AGE_DAYS,
  TEAM_SENTIMENT_MAX_SUMMARIES,
  TEAM_SENTIMENT_MIN_SUMMARIES,
  TEAM_SENTIMENT_MOODS,
  TEAM_SENTIMENT_REPORT_ID,
  computeEngagementBand,
  isRosterContact,
  summaryNeedsRefresh,
  teamSentimentRoundCount,
  teamSentimentRoundSlice,
  type Contact,
  type EngagementThresholds,
  type TeamSentimentDoc,
} from '@linyup/shared'
import { mapWithConcurrency } from '../outreach/recipients'
import { ASSISTANT_MODEL, getGenAI, replyWasStopped } from '../utils/vertexClient'
import { LANGUAGE_NAMES, toDate } from '../contacts/aiSummaryDossier'
import { generateSummaryForContact } from '../contacts/aiSummaryGenerate'
import { buildTeamDossier, readTeamSentimentReply, teamSentimentSystemPrompt, type SentimentEntry } from './teamSentimentPrompt'

/** The worker's queue, addressed in europe-west6 (see teamSentimentWorker.ts). */
const ROUND_FUNCTION = 'locations/europe-west6/functions/refreshTeamSentimentRound'
/** How a run's briefings are stamped on the contact. */
export const TEAM_SENTIMENT_GENERATED_BY = 'team_sentiment'
/** Contacts read to find the active members: a field-masked scan, bounded. */
export const TEAM_SENTIMENT_SCAN_LIMIT = 5000
/** Briefings generated at once inside a round. */
const REFRESH_CONCURRENCY = 5
/** A chain never needs more rounds than a full run of capped members. */
const MAX_ROUNDS = teamSentimentRoundCount(TEAM_SENTIMENT_MAX_SUMMARIES)

export interface TeamSentimentPayload {
  teamId: string
  runId: string
  round: number
}

export type TeamSentimentRunError = 'not_enough_summaries' | 'unavailable' | 'empty' | 'enqueue_failed'

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

export function sentimentRef(teamId: string): FirebaseFirestore.DocumentReference {
  return admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(AI_REPORTS_SUBCOLLECTION)
    .doc(TEAM_SENTIMENT_REPORT_ID)
}

// ─── who is in a run ──────────────────────────────────────────────────────────

/** The only fields the member scan reads. */
export const ACTIVE_MEMBER_FIELDS = [
  'archived_at',
  'deleted_at',
  'anonymized_at',
  'provisional',
  'external',
  'last_session_at',
  'created_at',
] as const

/**
 * Pure: the active members — roster contacts whose engagement band is `active`
 * against the studio's thresholds — most recently seen first, capped. The band
 * is measured exactly as the contact page's meter measures it: last session,
 * falling back to when the contact was created.
 */
export function selectActiveMembers(
  contacts: ReadonlyArray<{ id: string; data: Record<string, unknown> }>,
  thresholds: EngagementThresholds | undefined,
  nowMs: number,
  cap: number = TEAM_SENTIMENT_MAX_SUMMARIES
): string[] {
  const t = thresholds ?? DEFAULT_ENGAGEMENT_THRESHOLDS
  return contacts
    .map((c) => ({
      id: c.id,
      data: c.data,
      seenMs: toDate(c.data.last_session_at)?.getTime() ?? toDate(c.data.created_at)?.getTime() ?? null,
    }))
    .filter((c) => isRosterContact(c.data) && computeEngagementBand(c.seenMs, t, nowMs) === 'active')
    .sort((a, b) => (b.seenMs ?? 0) - (a.seenMs ?? 0))
    .slice(0, cap)
    .map((c) => c.id)
}

export async function loadActiveMemberIds(
  teamId: string,
  thresholds: EngagementThresholds | undefined,
  nowMs: number
): Promise<string[]> {
  const snap = await admin
    .firestore()
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .select(...ACTIVE_MEMBER_FIELDS)
    .limit(TEAM_SENTIMENT_SCAN_LIMIT)
    .get()
  return selectActiveMembers(
    snap.docs.map((d) => ({ id: d.id, data: d.data() })),
    thresholds,
    nowMs
  )
}

// ─── the chain ────────────────────────────────────────────────────────────────

export async function enqueueTeamSentimentRound(teamId: string, runId: string, round: number): Promise<void> {
  if (round > MAX_ROUNDS) throw new Error(`team sentiment run ${runId} exceeded ${MAX_ROUNDS} rounds`)
  const { getFunctions } = await import('firebase-admin/functions')
  const queue = getFunctions().taskQueue<TeamSentimentPayload>(ROUND_FUNCTION)
  try {
    // Tenant first in the id: a run id is not a sequential prefix, but the
    // doctrine is the doctrine (utils/tenantFanOut.ts).
    await queue.enqueue({ teamId, runId, round }, { id: `${teamId}-${runId}-r${round}` })
  } catch (err) {
    if ((err as { code?: string })?.code === 'functions/task-already-exists') {
      console.log(`[teamSentiment] round ${round} of ${runId} was already queued`)
      return
    }
    throw err
  }
}

/** End a run as failed — only if it is still THIS run and still going. */
export async function failTeamSentimentRun(teamId: string, runId: string, error: TeamSentimentRunError): Promise<void> {
  const db = admin.firestore()
  const ref = sentimentRef(teamId)
  await db.runTransaction(async (tx) => {
    const run = ((await tx.get(ref)).data() as TeamSentimentDoc | undefined)?.run
    if (!run || run.id !== runId || (run.status !== 'refreshing' && run.status !== 'reading')) return
    tx.update(ref, { 'run.status': 'failed', 'run.error': error, 'run.finished_at': FieldValue.serverTimestamp() })
  })
  console.warn(`[teamSentiment] run ${runId} (team ${teamId}) failed: ${error}`)
}

type MemberOutcome = 'refreshed' | 'reused' | 'failed' | 'gone'

async function refreshMember(
  teamId: string,
  team: FirebaseFirestore.DocumentData | undefined,
  contactId: string,
  nowMs: number
): Promise<MemberOutcome> {
  const db = admin.firestore()
  const ref = db.collection(CONTACTS_COLLECTION).doc(contactId)
  const snap = await ref.get()
  const contact = snap.exists ? ({ ...snap.data(), id: snap.id } as Contact) : null
  // Archived, deleted or moved since the run started: nothing to refresh.
  if (!contact || contact.teamId !== teamId || !isRosterContact(contact)) return 'gone'

  const facts = {
    generatedAtMs: toDate(contact.ai_summary?.generated_at)?.getTime() ?? null,
    lastSessionMs: toDate(contact.last_session_at)?.getTime() ?? null,
    newestBookingMs: null,
    newestNoteMs: null,
  }
  let needs = summaryNeedsRefresh(facts, nowMs)
  if (!needs) {
    // Only a briefing that still looks fresh pays for these two reads.
    const [bookings, notes] = await Promise.all([
      db
        .collectionGroup(SESSION_BOOKINGS_SUBCOLLECTION)
        .where('teamId', '==', teamId)
        .where('contact', '==', contactId)
        .orderBy('joinedAt', 'desc')
        .limit(1)
        .get(),
      ref.collection(CONTACT_NOTES_SUBCOLLECTION).orderBy('created_at', 'desc').limit(1).get(),
    ])
    needs = summaryNeedsRefresh(
      {
        ...facts,
        newestBookingMs: toDate(bookings.docs[0]?.data().joinedAt)?.getTime() ?? null,
        newestNoteMs: toDate(notes.docs[0]?.data().created_at)?.getTime() ?? null,
      },
      nowMs
    )
  }
  if (!needs) return 'reused'

  try {
    await generateSummaryForContact({ teamId, team, contactRef: ref, contact, generatedBy: TEAM_SENTIMENT_GENERATED_BY })
    return 'refreshed'
  } catch (err) {
    // One member the model could not answer for does not end the run: the
    // reading uses the briefing they already had, if any.
    console.warn(`[teamSentiment] member ${contactId} not refreshed:`, (err as Error).message)
    return 'failed'
  }
}

/**
 * One round: a batch of members refreshed or reused. Returns `done` when this
 * chain has nothing left to do — the last round (which also builds the reading),
 * or a redelivery of a round that already landed.
 */
export async function runTeamSentimentRound(teamId: string, runId: string, round: number): Promise<{ done: boolean }> {
  const db = admin.firestore()
  const ref = sentimentRef(teamId)
  const run = ((await ref.get()).data() as TeamSentimentDoc | undefined)?.run
  if (!run || run.id !== runId || run.status !== 'refreshing' || run.rounds_done !== round) return { done: true }

  const team = (await db.collection(TEAMS_COLLECTION).doc(teamId).get()).data()
  const nowMs = Date.now()
  const tally = { refreshed: 0, reused: 0, failed: 0 }
  await mapWithConcurrency(teamSentimentRoundSlice(run.member_ids, round), REFRESH_CONCURRENCY, async (id) => {
    const outcome = await refreshMember(teamId, team, id, nowMs).catch((err): MemberOutcome => {
      console.warn(`[teamSentiment] member ${id} could not be checked:`, (err as Error).message)
      return 'failed'
    })
    if (outcome === 'refreshed') tally.refreshed++
    else if (outcome === 'reused') tally.reused++
    else if (outcome === 'failed') tally.failed++
  })

  const last = round + 1 >= teamSentimentRoundCount(run.member_ids.length)
  const advanced = await db.runTransaction(async (tx) => {
    const current = ((await tx.get(ref)).data() as TeamSentimentDoc | undefined)?.run
    if (!current || current.id !== runId || current.status !== 'refreshing' || current.rounds_done !== round) return false
    tx.update(ref, {
      'run.rounds_done': round + 1,
      'run.refreshed': current.refreshed + tally.refreshed,
      'run.reused': current.reused + tally.reused,
      'run.failed': current.failed + tally.failed,
      ...(last ? { 'run.status': 'reading' } : {}),
    })
    return true
  })
  if (!advanced) return { done: true }
  if (!last) return { done: false }

  await buildTeamReading(teamId, runId)
  return { done: true }
}

// ─── the reading ──────────────────────────────────────────────────────────────

/** Read the run's members' briefings in one prompt and store the team reading. */
export async function buildTeamReading(teamId: string, runId: string): Promise<void> {
  const db = admin.firestore()
  const ref = sentimentRef(teamId)
  const run = ((await ref.get()).data() as TeamSentimentDoc | undefined)?.run
  if (!run || run.id !== runId || run.status !== 'reading') return

  const team = (await db.collection(TEAMS_COLLECTION).doc(teamId).get()).data()
  const now = new Date()
  const snaps = run.member_ids.length
    ? await db.getAll(...run.member_ids.map((id) => db.collection(CONTACTS_COLLECTION).doc(id)))
    : []

  const maxAgeMs = TEAM_SENTIMENT_MAX_AGE_DAYS * 86_400_000
  const entries: SentimentEntry[] = []
  let oldest: Date | null = null
  for (const snap of snaps) {
    if (!snap.exists) continue
    const contact = { ...snap.data(), id: snap.id } as Contact
    if (contact.teamId !== teamId || !isRosterContact(contact)) continue
    const summary = contact.ai_summary
    const generated = toDate(summary?.generated_at)
    if (!summary || !generated) continue
    const ageMs = now.getTime() - generated.getTime()
    if (ageMs > maxAgeMs) continue
    const refMs = toDate(contact.last_session_at)?.getTime() ?? toDate(contact.created_at)?.getTime() ?? null
    entries.push({
      firstname: contact.firstname,
      band: computeEngagementBand(refMs, team?.engagement_thresholds, now.getTime()),
      ageDays: Math.max(0, Math.floor(ageMs / 86_400_000)),
      status: summary.sections?.status ?? null,
      outlook: summary.sections?.outlook ?? null,
      text: summary.text ?? null,
    })
    if (!oldest || generated < oldest) oldest = generated
  }

  if (entries.length < TEAM_SENTIMENT_MIN_SUMMARIES) {
    await failTeamSentimentRun(teamId, runId, 'not_enough_summaries')
    return
  }

  const langRaw = String(team?.language ?? 'en')
  const lang = langRaw in LANGUAGE_NAMES ? langRaw : 'en'

  let raw = ''
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
    if (replyWasStopped(response)) console.warn(`[teamSentiment] reply hit the output cap (team=${teamId})`)
  } catch (err) {
    console.error('[teamSentiment] Vertex error:', (err as Error).message)
    await failTeamSentimentRun(teamId, runId, 'unavailable')
    return
  }

  // A stopped reply keeps the parts that closed; `readTeamSentimentReply` never
  // stores a half-written one, and refuses outright without an overview.
  const reading = readTeamSentimentReply(raw)
  if (!reading) {
    await failTeamSentimentRun(teamId, runId, 'empty')
    return
  }

  await db.runTransaction(async (tx) => {
    const current = ((await tx.get(ref)).data() as TeamSentimentDoc | undefined)?.run
    if (!current || current.id !== runId || current.status !== 'reading') return
    // `report` in an update REPLACES the map — a merge would keep a previous
    // reading's parts beside the new ones.
    tx.update(ref, {
      report: {
        mood: reading.mood,
        sections: reading.sections,
        generated_at: FieldValue.serverTimestamp(),
        generated_by: run.started_by,
        model: ASSISTANT_MODEL,
        language: lang,
        summaries_used: entries.length,
        summaries_oldest_at: oldest ? Timestamp.fromDate(oldest) : null,
        active_within_days: run.active_within_days,
      },
      'run.status': 'done',
      'run.finished_at': FieldValue.serverTimestamp(),
    })
  })
}
