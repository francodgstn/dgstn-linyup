// ─── AI summary of a contact ─────────────────────────────────────────────────
//
// Two or three sentences a coach can read before the person walks in: how
// often they come, what they hold, what has changed, what the notes say. It is
// written ONTO the contact (`Contact.ai_summary`) by this callable and by
// nothing else — the rules deny the field to every client write, so the label
// "written by AI" on the page is true by construction.
//
// WHAT THE MODEL SEES, AND WHAT IT NEVER SEES. `buildContactDossier`
// (aiSummaryDossier.ts) is the one place the prompt's facts are assembled, and
// it is pure, with a test that pins the exclusions: no email, no phone, no
// address, no birthdate, no emergency contacts, no surname. A summary of a
// training relationship needs none of them, and nobody handed the studio a
// phone number to have it sent to a model. Notes DO go in (the newest few,
// tags stripped and truncated) because they are the most useful thing a coach
// has written, and a summary that ignores them is a worse summary. That is the
// trade this file makes; a studio that disagrees leaves the switch off.
//
// AN EXPERIMENT (`contact-summary` in EXPERIMENTAL_FEATURES), checked here as
// well as on the card: the flag is on the team doc, which only an owner may
// write, so a client cannot spend model calls on a switch that is off.
//
// MANUAL FOR NOW. The button on the insights card is the only trigger. When a
// scheduled refresh comes it runs the body below minus the caller checks, per
// tenant through `dispatchTenantJob` (utils/tenantFanOut.ts), skips what is
// fresh by `ai_summary.generated_at`, and writes the same record with
// `generated_by: 'schedule'`. Nothing here needs to change shape for that; it
// is deliberately not built until the button has shown whether a summary is
// worth the model calls (Franco, 2026-09-11).

import * as admin from 'firebase-admin'
import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  CONTACT_NOTES_SUBCOLLECTION,
  CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION,
  CONTACT_WEEKLY_REPORTS_SUBCOLLECTION,
  SESSIONS_COLLECTION,
  SESSION_BOOKINGS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  computeEngagementBand,
  densifyWeeklyCounts,
  isExperimentalFeatureEnabled,
  isoWeekKeysBack,
  type Contact,
} from '@linyup/shared'
import { to } from '../utils/async'
import { callerIsAllScoped, isTeamMember } from '../utils/teams'
import { bucketRateLimit } from '../utils/rateLimit'
import { ASSISTANT_MODEL, getGenAI } from '../utils/vertexClient'
import {
  LANGUAGE_NAMES,
  STUDIO_TIME_ZONE,
  buildContactDossier,
  coachOwnsContact,
  normaliseSummary,
  noteText,
  systemPrompt,
  toDate,
  type DossierBooking,
  type DossierNote,
  type DossierPeriod,
} from './aiSummaryDossier'

const EXPERIMENT_ID = 'contact-summary'
const RATE_LIMIT_MAX = 30 // summaries per user + team per hour
/** Half a year of weeks: enough for a trend to mean something (see deriveSignals). */
const WEEKS = 26
/** Firestore's `in` takes at most thirty ids, and the session lookup is one such query. */
const RECENT_BOOKINGS = 30
const RECENT_NOTES = 3
const RECENT_PERIODS = 12

type Request = { teamId?: string; contactId?: string }

export const generateContactSummary = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.')
  const uid = request.auth.uid
  const { teamId, contactId } = (request.data ?? {}) as Request
  if (!teamId || !contactId) {
    throw new HttpsError('invalid-argument', 'teamId and contactId are required.')
  }

  const db = admin.firestore()
  const [memberErr, isMember] = await to(isTeamMember(uid, teamId))
  if (memberErr || !isMember) {
    throw new HttpsError('permission-denied', 'You are not a member of this team.')
  }

  const teamSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
  const team = teamSnap.data()
  if (!isExperimentalFeatureEnabled(team, EXPERIMENT_ID)) {
    throw new HttpsError('failed-precondition', 'AI summaries are not switched on for this team.')
  }

  const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)
  const contactSnap = await contactRef.get()
  const contact = contactSnap.exists
    ? ({ ...contactSnap.data(), id: contactSnap.id } as Contact)
    : null
  if (!contact || contact.teamId !== teamId) throw new HttpsError('not-found', 'Contact not found.')
  // The rules' own-scope narrowing, repeated here because this write goes
  // through a callable and not through them: a coach summarises their own
  // book only.
  if (!(await callerIsAllScoped(uid, teamId)) && !coachOwnsContact(contact, uid)) {
    throw new HttpsError('permission-denied', 'This contact is not in your book.')
  }

  await bucketRateLimit({
    collection: 'contact_summary_attempts',
    key: `${uid}:${teamId}`,
    limit: RATE_LIMIT_MAX,
    windowMs: 3_600_000,
    message: 'You have reached the hourly limit. Try again later.',
  })

  const now = new Date()
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
    contactRef
      .collection(CONTACT_NOTES_SUBCOLLECTION)
      .orderBy('created_at', 'desc')
      .limit(RECENT_NOTES)
      .get(),
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
    ...new Set(
      bookingsSnap.docs
        .map((d) => d.data().session as string | undefined)
        .filter((s): s is string => !!s)
    ),
  ]
  const sessions = new Map<string, { activityName?: string; start?: unknown }>()
  if (sessionIds.length) {
    const sSnap = await db
      .collection(SESSIONS_COLLECTION)
      .where(FieldPath.documentId(), 'in', sessionIds)
      .get()
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
  try {
    const response = await getGenAI().models.generateContent({
      model: ASSISTANT_MODEL,
      contents: [{ role: 'user', parts: [{ text: dossier }] }],
      config: {
        systemInstruction: systemPrompt(LANGUAGE_NAMES[lang]),
        // Six sentences in German run past 256 tokens; the cap on the way back
        // is `normaliseSummary`, not this.
        maxOutputTokens: 512,
        // An analysis, not a brainstorm — warm enough to interpret, not so
        // warm it invents.
        temperature: 0.4,
      },
    })
    // `response.text`, not a walk down candidates[0].content.parts — see
    // vertexClient for why.
    raw = response.text ?? ''
  } catch (err) {
    console.error('[generateContactSummary] Vertex error:', (err as Error).message)
    throw new HttpsError('internal', 'The summary service is unavailable right now.')
  }

  const text = normaliseSummary(raw)
  if (!text) throw new HttpsError('internal', 'The summary came back empty.')

  await contactRef.update({
    ai_summary: {
      text,
      generated_at: FieldValue.serverTimestamp(),
      generated_by: uid,
      model: ASSISTANT_MODEL,
      language: lang,
    },
  })
  return { text, language: lang, model: ASSISTANT_MODEL }
})
