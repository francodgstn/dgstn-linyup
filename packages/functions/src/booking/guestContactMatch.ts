// THE guest-identity predicate: "which of this team's contacts is the person
// who just typed this name and this email?"
//
// It was written twice, identically, in `bookSession` and
// `createDropInCheckout`. Extracting it is not tidying — it is what makes W9
// (the public answer and the gate's answer agree, for the same person) a
// property of the code rather than a promise, because a THIRD caller now needs
// the same answer: `resolveWaiverRequirement`, which tells a visitor whether a
// waiver step is coming.
//
// ── WHY EMAIL ALONE IS THE WRONG QUESTION ───────────────────────────────────
// One email routinely addresses several contacts — a family sharing a mailbox
// is the ordinary configuration, and `utils/contactSession.ts` already
// describes a parent signing in to a child's profile. So an email-only lookup
// and this predicate resolve DIFFERENT PEOPLE:
//
//   Sabine and her son Nils share familie-meier@example.ch. Sabine signed the
//   release last year; Nils books. An email-only lookup matches Sabine, reads
//   her signature, and reports "nothing to sign" — no step, no age question. The
//   gate then matches email+name, resolves Nils, finds no signer row and
//   refuses. On the returning-member path that refusal arrives AFTER the
//   verification code was marked used. Worse: on a class Sabine's contact could
//   book, a 12-year-old would pass a gate on his mother's signature.
//
// So the requirement callable resolves the caller through THIS helper, and when
// it cannot narrow an email to one contact it returns the conservative answer
// rather than a candidate's. Asking someone to tick again costs a tick; not
// asking costs the gate.
//
// ── BEHAVIOR IS PRESERVED EXACTLY ──────────────────────────────────────────
// This is the two rails' code, moved. It deliberately does NOT filter archived
// or deleted contacts, because neither rail did: adding that filter here would
// change which contact a booking attaches to, which is a booking change wearing
// a refactor's clothes. `resolveSingleContact` (utils/contacts.ts) is the
// helper that DOES apply the active filter, and it answers a different question
// (one email → exactly one active contact, or nothing).

import * as admin from 'firebase-admin'
import { CONTACTS_COLLECTION } from '@linyup/shared'

export interface GuestContactIdentity {
  email: string
  firstname: string
  lastname: string
}

export interface GuestContactMatch {
  /** The one contact whose email AND (case-insensitive, trimmed) first and last
   *  name match. null when none does — which is when a rail mints a new one. */
  match: admin.firestore.QueryDocumentSnapshot | null
  /** EVERY contact stored under this email, match or not. The promo rails
   *  already need this to decide "is this a new customer"; the waiver rails need
   *  it to know when an email is ambiguous. */
  emailMatches: admin.firestore.QueryDocumentSnapshot[]
}

/** Pure, so the ambiguity rule can be asserted without Firestore. */
export function pickGuestNameMatch<T extends { firstname?: string; lastname?: string }>(
  candidates: Array<{ id: string; data: T }>,
  identity: Pick<GuestContactIdentity, 'firstname' | 'lastname'>
): { id: string; data: T } | null {
  const first = identity.firstname.toLowerCase().trim()
  const last = identity.lastname.toLowerCase().trim()
  if (!first || !last) return null
  return (
    candidates.find(
      (c) =>
        c.data.firstname?.toLowerCase().trim() === first &&
        c.data.lastname?.toLowerCase().trim() === last
    ) ?? null
  )
}

export async function matchGuestContact(
  teamId: string,
  identity: GuestContactIdentity,
  db: admin.firestore.Firestore = admin.firestore()
): Promise<GuestContactMatch> {
  const email = identity.email.toLowerCase().trim()
  if (!email) return { match: null, emailMatches: [] }
  const snap = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .where('email', '==', email)
    .get()
  const picked = pickGuestNameMatch(
    snap.docs.map((d) => ({ id: d.id, data: d.data() as { firstname?: string; lastname?: string } })),
    identity
  )
  return {
    match: picked ? (snap.docs.find((d) => d.id === picked.id) ?? null) : null,
    emailMatches: snap.docs,
  }
}
