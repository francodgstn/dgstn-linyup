import type { Contact } from '../types/contact'
import type { Session } from '../types/session'

// ─── Data scope — the server mirrors of the rules' ownership predicates ──────
//
// A coach is OWN-scoped: their capabilities reach only the records they own.
// `firestore.rules` answers that for client reads; a server seam that reads with
// the Admin SDK has to answer it itself, and must answer it the SAME way — a
// server read that is wider than the rules is a leak with no rule to catch it.
// So every server-side ownership question is one of these, and each names the
// rule function it mirrors.

/**
 * The rules' `callerOwnsContact`: on the contact's coach list, or its creator.
 */
export function coachOwnsContact(
  contact: Pick<Contact, 'assigned_coach_ids' | 'createdBy'>,
  uid: string
): boolean {
  return (contact.assigned_coach_ids ?? []).includes(uid) || contact.createdBy === uid
}

/**
 * The rules' `callerOwnsSession`: its provider, or its creator.
 */
export function coachOwnsSession(
  session: Pick<Session, 'providerId' | 'createdBy'>,
  uid: string
): boolean {
  return session.providerId === uid || session.createdBy === uid
}
