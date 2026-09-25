// ─── Records about people — a session's roster, a contact's history ─────────
//
// Every name on a booking or a check-in comes from the CONTACT document through
// `loadPeople`, which is the one place that decides whether this principal may
// see a person: the contact must belong to the team, pass the coach's own-scope
// (`principalSeesContact`) and not be deleted or anonymized (`projectPerson`).
// A row whose person may not be shown is left out and COUNTED, so a coach sees
// "3 more booked" rather than a list that silently looks shorter.

import * as admin from 'firebase-admin'
import {
  CONTACTS_COLLECTION,
  PARTICIPANTS_SUBCOLLECTION,
  SESSIONS_COLLECTION,
  SESSION_BOOKINGS_SUBCOLLECTION,
  projectAttendance,
  projectBooking,
  projectPerson,
  projectSession,
  type ApiAttendance,
  type ApiBooking,
  type ApiContact,
  type ApiPerson,
  type ApiSession,
  type Booking,
  type Contact,
  type ParticipantRecord,
  type Session,
} from '@linyup/shared'
import { principalMay, principalSeesContact, principalSeesSession, type ApiPrincipal } from '../auth/principal'
import { requireScope } from '../access'
import { projectionContext, type TeamReadContext } from '../context'
import { getContact } from './contacts'
import { getSession } from './sessions'

/** One session's roster is read whole, under this ceiling. */
const ROSTER_CAP = 500
const GET_ALL_CHUNK = 300

/**
 * The people behind contact ids, as THIS principal may see them. Every id maps
 * to a person or to null — missing, another team's, out of scope, deleted.
 * Without `contacts:read` every id is null.
 */
export async function loadPeople(
  principal: ApiPrincipal,
  contactIds: string[],
  pii: boolean
): Promise<Map<string, ApiPerson | null>> {
  const ids = [...new Set(contactIds.filter((id) => typeof id === 'string' && id.length > 0))]
  const out = new Map<string, ApiPerson | null>(ids.map((id) => [id, null]))
  if (ids.length === 0 || !principalMay(principal, 'contacts:read')) return out

  const db = admin.firestore()
  for (let i = 0; i < ids.length; i += GET_ALL_CHUNK) {
    const refs = ids.slice(i, i + GET_ALL_CHUNK).map((id) => db.collection(CONTACTS_COLLECTION).doc(id))
    for (const snap of await db.getAll(...refs)) {
      if (!snap.exists) continue
      const contact = { ...(snap.data() as Contact), id: snap.id }
      if (contact.teamId !== principal.teamId || !principalSeesContact(principal, contact)) continue
      out.set(snap.id, projectPerson(contact, pii))
    }
  }
  return out
}

export interface ApiSessionRoster {
  object: 'session_roster'
  session: ApiSession
  bookings: ApiBooking[]
  attendance: ApiAttendance[]
  /** Rows about people this connection may not name. */
  hidden_bookings: number
  hidden_attendance: number
  truncated: boolean
}

export async function getSessionRoster(
  principal: ApiPrincipal,
  team: TeamReadContext,
  sessionId: string,
  nowMs: number
): Promise<ApiSessionRoster> {
  // schedule:read, the session's team and the coach's own-scope — or a 404.
  const session = await getSession(principal, sessionId, nowMs)
  const ref = admin.firestore().collection(SESSIONS_COLLECTION).doc(sessionId)
  const [bookingsSnap, participantsSnap] = await Promise.all([
    ref.collection(SESSION_BOOKINGS_SUBCOLLECTION).limit(ROSTER_CAP).get(),
    ref.collection(PARTICIPANTS_SUBCOLLECTION).limit(ROSTER_CAP).get(),
  ])
  const bookings = bookingsSnap.docs.map((d) => ({ ...(d.data() as Booking), id: d.id }))
  const participants = participantsSnap.docs.map((d) => ({ ...(d.data() as ParticipantRecord), id: d.id }))
  const contactOfBooking = (b: Booking) => b.contact || b.id
  const contactOfRow = (p: ParticipantRecord & { id: string }) => p.contactId || p.contact || p.id

  const pii = projectionContext(principal, team, nowMs).pii
  const people = await loadPeople(
    principal,
    [...bookings.map(contactOfBooking), ...participants.map(contactOfRow)],
    pii
  )

  const shownBookings: ApiBooking[] = []
  for (const b of bookings) {
    const person = people.get(contactOfBooking(b)) ?? null
    if (person) shownBookings.push(projectBooking(b, { sessionId, person }))
  }
  const shownAttendance: ApiAttendance[] = []
  for (const p of participants) {
    const person = people.get(contactOfRow(p)) ?? null
    if (person) shownAttendance.push(projectAttendance(p, { sessionId, person }))
  }
  shownBookings.sort((a, b) => (a.booked_at ?? '').localeCompare(b.booked_at ?? ''))
  shownAttendance.sort((a, b) => (a.checked_in_at ?? '').localeCompare(b.checked_in_at ?? ''))

  return {
    object: 'session_roster',
    session,
    bookings: shownBookings,
    attendance: shownAttendance,
    hidden_bookings: bookings.length - shownBookings.length,
    hidden_attendance: participants.length - shownAttendance.length,
    truncated: bookings.length >= ROSTER_CAP || participants.length >= ROSTER_CAP,
  }
}

export interface ApiSessionRef {
  id: string
  activity: string | null
  start: string | null
  status: string
}

export interface ApiContactHistory {
  object: 'contact_history'
  contact: ApiContact
  bookings: Array<ApiBooking & { session: ApiSessionRef }>
  attendance: Array<ApiAttendance & { session: ApiSessionRef }>
}

/** The id of the session a bookings/participants row lives under, or null when it lives elsewhere. */
function parentSessionId(doc: FirebaseFirestore.QueryDocumentSnapshot): string | null {
  const parent = doc.ref.parent.parent
  return parent && parent.parent.id === SESSIONS_COLLECTION ? parent.id : null
}

/** A contact's recent bookings and check-ins, newest first. */
export async function getContactHistory(
  principal: ApiPrincipal,
  team: TeamReadContext,
  contactId: string,
  limit: number,
  nowMs: number
): Promise<ApiContactHistory> {
  requireScope(principal, 'schedule:read')
  // contacts:read, the contact's team and the coach's own-scope — or a 404.
  const contact = await getContact(principal, team, contactId, nowMs)
  const db = admin.firestore()
  const [bookingsSnap, participantsSnap] = await Promise.all([
    db
      .collectionGroup(SESSION_BOOKINGS_SUBCOLLECTION)
      .where('teamId', '==', principal.teamId)
      .where('contact', '==', contactId)
      .orderBy('joinedAt', 'desc')
      .limit(limit)
      .get(),
    db.collectionGroup(PARTICIPANTS_SUBCOLLECTION).where('contactId', '==', contactId).orderBy('checkedInAt', 'desc').limit(limit).get(),
  ])

  // Both group names are shared with other parents; only rows under a session
  // of this team, visible to this principal, count.
  const sessionIds = [
    ...new Set([...bookingsSnap.docs, ...participantsSnap.docs].map(parentSessionId).filter((id): id is string => !!id)),
  ]
  const sessions = new Map<string, ApiSessionRef>()
  if (sessionIds.length > 0) {
    const snaps = await db.getAll(...sessionIds.map((id) => db.collection(SESSIONS_COLLECTION).doc(id)))
    for (const snap of snaps) {
      if (!snap.exists) continue
      const s = { ...(snap.data() as Session), id: snap.id }
      if (s.teamId !== principal.teamId || !principalSeesSession(principal, s)) continue
      const projected = projectSession(s, { nowMs })
      if (projected) {
        sessions.set(s.id, { id: s.id, activity: projected.activity.name, start: projected.start, status: projected.status })
      }
    }
  }

  const person: ApiPerson = {
    contact_id: contact.id,
    first_name: contact.first_name,
    last_name: contact.last_name,
    ...('email' in contact ? { email: contact.email ?? null, phone: contact.phone ?? null } : {}),
  }

  const bookings: ApiContactHistory['bookings'] = []
  for (const d of bookingsSnap.docs) {
    const session = sessions.get(parentSessionId(d) ?? '')
    if (session) bookings.push({ ...projectBooking({ ...(d.data() as Booking), id: d.id }, { sessionId: session.id, person }), session })
  }
  const attendance: ApiContactHistory['attendance'] = []
  for (const d of participantsSnap.docs) {
    const session = sessions.get(parentSessionId(d) ?? '')
    if (session) {
      attendance.push({
        ...projectAttendance({ ...(d.data() as ParticipantRecord), id: d.id }, { sessionId: session.id, person }),
        session,
      })
    }
  }
  return { object: 'contact_history', contact, bookings, attendance }
}
