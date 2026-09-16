// ─── Generate one contact's AI summary — THE body ───────────────────────────
//
// Reads what a briefing is made from, asks the model once, and writes
// `Contact.ai_summary` WHOLE. It has no caller checks: every door in runs its
// own before it gets here, and there are two —
//
//   contacts/aiSummary.ts          the button on the contact page (member,
//                                  module, own-scope, hourly limit)
//   aiInsights/teamSentimentRun.ts a team sentiment run refreshing the active
//                                  members (module, all-scoped starter, daily cap)
//
// so a briefing reads the same whichever of them asked for it. `generatedBy` is
// the member's uid for the button and `'team_sentiment'` for a run, which is
// how a stored summary says where it came from.
//
// What the model sees and never sees is `buildContactDossier`
// (aiSummaryDossier.ts) — pure, with a test that pins the exclusions.

import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import * as admin from 'firebase-admin'
import { Type } from '@google/genai'
import {
  CONTACT_NOTES_SUBCOLLECTION,
  CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION,
  CONTACT_WEEKLY_REPORTS_SUBCOLLECTION,
  SESSIONS_COLLECTION,
  SESSION_BOOKINGS_SUBCOLLECTION,
  computeEngagementBand,
  densifyWeeklyCounts,
  isoWeekKeysBack,
  type Contact,
  type ContactAiMemberRecap,
  type ContactAiSummarySections,
} from '@linyup/shared'
import { ASSISTANT_MODEL, getGenAI, replyWasStopped } from '../utils/vertexClient'
import {
  LANGUAGE_NAMES,
  STUDIO_TIME_ZONE,
  buildContactDossier,
  noteText,
  readSummaryReply,
  systemPrompt,
  toDate,
  type DossierBooking,
  type DossierNote,
  type DossierPeriod,
} from './aiSummaryDossier'

/** Half a year of weeks: enough for a trend to mean something (see deriveSignals). */
const WEEKS = 26
/** Firestore's `in` takes at most thirty ids, and the session lookup is one such query. */
const RECENT_BOOKINGS = 30
const RECENT_NOTES = 3
const RECENT_PERIODS = 12

/**
 * THE REPLY'S SHAPE — the three parts the card labels (`readSummaryReply`). The
 * schema bounds the model; the reader still copes with a reply that ignores it.
 */
const SUMMARY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    status: { type: Type.STRING, description: 'engagement now, against their own history' },
    outlook: { type: Type.STRING, description: 'what to expect next, and how confident' },
    nextSession: { type: Type.STRING, description: 'one concrete thing for the next session' },
    // The member recap — written TO the person. No outlook, by design: see
    // ContactAiMemberRecap in @linyup/shared.
    memberStatus: { type: Type.STRING, description: 'to the person: where they stand, as encouragement' },
    memberNextSession: { type: Type.STRING, description: 'to the person: one thing to focus on next session' },
  },
  required: ['status', 'outlook', 'nextSession', 'memberStatus', 'memberNextSession'],
}

/** Why a summary could not be made — each door words it for its own caller. */
export class SummaryGenerationError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'empty',
    message: string
  ) {
    super(message)
  }
}

export interface GeneratedSummary {
  text: string
  sections: ContactAiSummarySections | null
  member: ContactAiMemberRecap | null
  language: string
  model: string
}

export async function generateSummaryForContact(params: {
  teamId: string
  /** The team document's data — thresholds and language. */
  team: FirebaseFirestore.DocumentData | undefined
  contactRef: FirebaseFirestore.DocumentReference
  contact: Contact
  /** The pressing member's uid, or `'team_sentiment'` for a team run. */
  generatedBy: string
  now?: Date
}): Promise<GeneratedSummary> {
  const { teamId, team, contactRef, contact, generatedBy } = params
  const contactId = contact.id
  const db = admin.firestore()
  const now = params.now ?? new Date()
  const window = isoWeekKeysBack(WEEKS, now)
  const [weeklySnap, bookingsSnap, notesSnap, periodsSnap] = await Promise.all([
    contactRef
      .collection(CONTACT_WEEKLY_REPORTS_SUBCOLLECTION)
      .where('iso_week', '>=', window[0])
      .orderBy('iso_week', 'asc')
      .get(),
    // The contact detail page's own bookings query, with a tighter limit.
    db
      .collectionGroup(SESSION_BOOKINGS_SUBCOLLECTION)
      .where('teamId', '==', teamId)
      .where('contact', '==', contactId)
      .orderBy('joinedAt', 'desc')
      .limit(RECENT_BOOKINGS)
      .get(),
    contactRef.collection(CONTACT_NOTES_SUBCOLLECTION).orderBy('created_at', 'desc').limit(RECENT_NOTES).get(),
    // The plan PERIODS — renewals, gaps and how the last one ended — which
    // the live summary on the contact cannot say.
    contactRef
      .collection(CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION)
      .orderBy('start_date', 'desc')
      .limit(RECENT_PERIODS)
      .get(),
  ])

  const weekly = densifyWeeklyCounts(
    weeklySnap.docs.map((d) => d.data() as { iso_week: string; sessions_count?: number }),
    WEEKS,
    now
  )

  // WHAT and WHEN come from the session, not the booking — one `in` read for
  // at most RECENT_BOOKINGS ids.
  const sessionIds = [
    ...new Set(bookingsSnap.docs.map((d) => d.data().session as string | undefined).filter((s): s is string => !!s)),
  ]
  const sessions = new Map<string, { activityName?: string; start?: unknown }>()
  if (sessionIds.length) {
    const sSnap = await db.collection(SESSIONS_COLLECTION).where(FieldPath.documentId(), 'in', sessionIds).get()
    for (const s of sSnap.docs) {
      sessions.set(s.id, s.data() as { activityName?: string; start?: unknown })
    }
  }
  const bookings: DossierBooking[] = bookingsSnap.docs.map((d) => {
    const b = d.data()
    const s = b.session ? sessions.get(b.session as string) : undefined
    return {
      when: toDate(s?.start) ?? toDate(b.joinedAt),
      activity: s?.activityName ?? null,
      status: (b.status as string | undefined) ?? null,
    }
  })
  const notes: DossierNote[] = notesSnap.docs
    .map((d) => ({
      when: toDate(d.data().created_at),
      text: noteText(String(d.data().content ?? '')),
    }))
    .filter((n) => n.text)

  const periods: DossierPeriod[] = periodsSnap.docs.map((d) => {
    const p = d.data()
    return {
      plan: (p.subscription_type_name as string | undefined) ?? null,
      start: toDate(p.start_date),
      end: toDate(p.end_date),
      reason: (p.termination_reason as string | undefined) ?? null,
    }
  })

  // The same band the page's meter shows, from the same thresholds — so the
  // model and the coach are looking at one reading, not two.
  const lastMs = toDate(contact.last_session_at)?.getTime() ?? null
  const refMs = lastMs ?? toDate(contact.created_at)?.getTime() ?? null
  const engagementBand = computeEngagementBand(refMs, team?.engagement_thresholds, now.getTime())

  const langRaw = String(team?.language ?? 'en')
  const lang = langRaw in LANGUAGE_NAMES ? langRaw : 'en'
  const dossier = buildContactDossier({
    contact,
    weekly,
    bookings,
    notes,
    periods,
    engagementBand,
    timeZone: STUDIO_TIME_ZONE,
    now,
  })

  let raw = ''
  let cut = false
  try {
    const response = await getGenAI().models.generateContent({
      model: ASSISTANT_MODEL,
      contents: [{ role: 'user', parts: [{ text: dossier }] }],
      config: {
        systemInstruction: systemPrompt(LANGUAGE_NAMES[lang]),
        // Six sentences in German run past 256 tokens; the cap on the way back
        // is `normaliseSummary`, not this.
        // (640 since the reply became JSON — its keys and quotes cost a little;
        // 960 since it also carries the two-part member recap.)
        maxOutputTokens: 960,
        // NO THINKING. On this model thinking is on by default and its tokens
        // count against `maxOutputTokens`, so a reply the model had reasoned
        // about for a few hundred tokens was stopped mid-sentence — and stored
        // ending in a fragment ("…with her last session almost two weeks").
        // Two to six sentences from a prepared dossier need no reasoning budget.
        thinkingConfig: { thinkingBudget: 0 },
        // An analysis, not a brainstorm — warm enough to interpret, not so
        // warm it invents.
        temperature: 0.4,
        // THREE PARTS, GIVEN — see SUMMARY_SCHEMA.
        responseMimeType: 'application/json',
        responseJsonSchema: SUMMARY_SCHEMA,
      },
    })
    // `response.text`, not a walk down candidates[0].content.parts — see
    // vertexClient for why.
    raw = response.text ?? ''
    // Still possible without thinking (a very long reply), so the reply says
    // whether it was stopped, and `normaliseSummary` never stores the fragment.
    cut = replyWasStopped(response)
    if (cut) console.warn(`[aiSummary] reply hit the output cap (contact=${contactId})`)
  } catch (err) {
    console.error(`[aiSummary] Vertex error (contact=${contactId}):`, (err as Error).message)
    throw new SummaryGenerationError('unavailable', 'The summary service is unavailable right now.')
  }

  const { text, sections, member } = readSummaryReply(raw, { cut })
  if (!text) throw new SummaryGenerationError('empty', 'The summary came back empty.')

  await contactRef.update({
    // WHOLE, never merged key-by-key: a regenerated summary without parts must
    // not keep the previous one's parts beside its new paragraph — and a new
    // recap must not inherit the previous recap's `member_sent_at`.
    ai_summary: {
      text,
      ...(sections ? { sections } : {}),
      ...(member ? { member } : {}),
      generated_at: FieldValue.serverTimestamp(),
      generated_by: generatedBy,
      model: ASSISTANT_MODEL,
      language: lang,
    },
  })
  return { text, sections: sections ?? null, member: member ?? null, language: lang, model: ASSISTANT_MODEL }
}
