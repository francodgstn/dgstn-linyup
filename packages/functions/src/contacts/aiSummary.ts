// ─── AI summary of a contact ─────────────────────────────────────────────────
//
// Two or three sentences a coach can read before the person walks in: how
// often they come, what they hold, what has changed, what the notes say. It is
// written ONTO the contact (`Contact.ai_summary`) by the functions and by
// nothing else — the rules deny the field to every client write, so the label
// "written by AI" on the page is true by construction.
//
// THIS FILE IS THE BUTTON. The body — reads, dossier, model call, the write — is
// `generateSummaryForContact` (aiSummaryGenerate.ts), shared with the team
// sentiment run that refreshes the active members' briefings. What stays here
// is the caller checks only the button needs.
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
// A PLUGIN MODULE (`ai-contact-summary`, in the `ai` container — see
// types/aiInsights.ts), checked here as well as on the card. It was the
// `contact-summary` experiment until 2026-09-16. The install document is
// owner-written, so a client cannot spend model calls on a module that is off;
// `pluginIsActive` also sees an install made at the ORGANISATION.
//
// ONE CALL, TWO AUDIENCES. The same reply carries the member RECAP
// (`ai_summary.member`): two parts written to the person, which the
// `ai-member-recap` module lets the studio email them. Asking in the same call
// sends the dossier once; the recap is stored whether or not that module is on,
// so switching it on later works on the summaries a studio already has.
//
// NO SCHEDULE. Briefings are generated when somebody presses this button, or
// when a team sentiment run refreshes the ACTIVE members (only those with
// something new since their last briefing). A scheduled refresh for everybody
// stays deliberately unbuilt — docs/ai-insights.md.

import * as admin from 'firebase-admin'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { CONTACTS_COLLECTION, TEAMS_COLLECTION, AI_MODULES, type Contact } from '@linyup/shared'
import { to } from '../utils/async'
import { callerIsAllScoped, isTeamMember } from '../utils/teams'
import { pluginIsActive } from '../utils/plugins'
import { bucketRateLimit } from '../utils/rateLimit'
import { coachOwnsContact } from './aiSummaryDossier'
import { SummaryGenerationError, generateSummaryForContact } from './aiSummaryGenerate'

const RATE_LIMIT_MAX = 30 // summaries per user + team per hour

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
  if (!(await pluginIsActive(teamId, AI_MODULES.contactSummary))) {
    throw new HttpsError('failed-precondition', 'AI summaries are not switched on for this team.')
  }

  const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)
  const contactSnap = await contactRef.get()
  const contact = contactSnap.exists ? ({ ...contactSnap.data(), id: contactSnap.id } as Contact) : null
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

  try {
    const summary = await generateSummaryForContact({ teamId, team, contactRef, contact, generatedBy: uid })
    return {
      text: summary.text,
      sections: summary.sections,
      member: summary.member,
      language: summary.language,
      model: summary.model,
    }
  } catch (err) {
    if (err instanceof SummaryGenerationError) throw new HttpsError('internal', err.message)
    throw err
  }
})
