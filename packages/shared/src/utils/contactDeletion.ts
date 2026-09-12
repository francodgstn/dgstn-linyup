/**
 * SELF-SERVICE ACCOUNT DELETION for a contact, and the 30-day window before it.
 *
 * ── IT ANONYMISES, IT DOES NOT ERASE ─────────────────────────────────────────
 *
 * A contact is not a personal account in the usual sense — the studio holds
 * records about them that it is obliged to keep. Finance rows underpin
 * bookkeeping, and the waiver ledger is deliberately immutable (published
 * versions are `allow write: if false`; acceptances are append-only) because its
 * whole purpose is proving who consented to what.
 *
 * So "delete my account" resolves to: **sever the identity, keep the business
 * record.** Everything that names the person is cleared; the rows that reference
 * their id survive, now pointing at somebody unnamed. That satisfies an erasure
 * request without destroying a studio's ability to account for its own past.
 *
 * ── THE WINDOW ───────────────────────────────────────────────────────────────
 *
 * Nothing is destroyed when the request is made. The contact keeps working
 * normally for 30 days and can cancel by signing in — the convention Google,
 * Apple and most SaaS already use, so it needs no explaining. Apple accepts a
 * disclosed grace period provided the deletion is genuinely initiated in-app and
 * needs no further steps, which is why the copy must state the date and the way
 * back.
 *
 * The window is also what makes this safe to offer at all: the failure mode of
 * a mis-tap is a confusing week, not a lost history.
 */
import type { Timestamp } from '../types/common'

/** How long a contact has to change their mind. */
export const CONTACT_DELETION_GRACE_DAYS = 30

/** The fields on a contact that carry the deletion request. */
export interface ContactDeletionFields {
  deletion_requested_at?: Timestamp | null
  deletion_scheduled_for?: Timestamp | null
  anonymized_at?: Timestamp | null
}

export type ContactDeletionState =
  /** No request outstanding. */
  | 'none'
  /** Requested, inside the window — reversible, and everything still works. */
  | 'scheduled'
  /** Past its date and waiting for the sweep. */
  | 'due'
  /** Already anonymised. Terminal: there is nothing left to identify. */
  | 'anonymized'

/**
 * THE one reader of these fields. Fixed order, most-terminal first, for the same
 * reason `waiverAcceptanceState` has one: a state machine spelled out at each
 * call site is a state machine that disagrees with itself.
 */
export function contactDeletionState(
  contact: ContactDeletionFields | null | undefined,
  nowMs: number
): ContactDeletionState {
  if (!contact) return 'none'
  if (contact.anonymized_at) return 'anonymized'
  const dueMs = contact.deletion_scheduled_for?.toMillis?.()
  if (typeof dueMs !== 'number') return 'none'
  return dueMs <= nowMs ? 'due' : 'scheduled'
}

/**
 * EVERY field that identifies a person, and therefore everything the sweep must
 * clear. Enumerated here rather than at the sweep so the list can be read,
 * reviewed and tested in one place — the failure mode of missing one is silent
 * and permanent-feeling, because nobody re-reads a contact they believe is gone.
 *
 * `login_emails` is the one that bites. It is the per-contact allow-list that
 * lets a PARENT sign in as their child; leaving it behind means the account is
 * anonymised and still reachable, which is worse than not deleting it at all
 * because it looks done.
 *
 * `email` is set to null rather than to a placeholder: an anonymised contact
 * must not collide with, or be matched by, `resolveSingleContact`.
 */
export const CONTACT_IDENTIFYING_FIELDS = [
  // Name and the ways to reach them.
  'firstname',
  'lastname',
  'email',
  'phone',
  // THE ONE THAT BITES. `login_emails` is the per-contact allow-list that lets a
  // PARENT sign in as their child. Leaving it behind means the account is
  // anonymised and still reachable — worse than not deleting it, because it
  // looks done.
  'login_emails',
  // Who they are.
  'gender',
  'birthdate',
  'birthplace',
  'weight',
  'avatar_url',
  'address',
  'emergency_contacts',
  // Things a studio typed ABOUT them, which are as identifying as a name.
  'notes',
  'custom_fields',
  'tags',
  // …and what a model wrote about them from those notes. Prose about a person
  // is a description of the person; it goes with the name it uses.
  'ai_summary',
  // Consent and marketing state carry the address they were given for.
  'consent',
  'source_detail',
] as const

/**
 * The patch that anonymises a contact. Values are `null` (not `undefined`) so
 * the write is explicit — a merge that omits a key leaves it standing, which is
 * exactly the bug this list exists to prevent.
 */
export function anonymizedContactPatch(nowMs: number): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const field of CONTACT_IDENTIFYING_FIELDS) patch[field] = null
  // A name is required by too many readers to be null everywhere, so the
  // placeholder goes here rather than leaving each surface to invent one.
  patch.firstname = 'Deleted'
  patch.lastname = 'account'
  patch.anonymized_at = new Date(nowMs)
  // The request is spent. Clearing it stops the sweep re-selecting the row every
  // night for the rest of time.
  patch.deletion_requested_at = null
  patch.deletion_scheduled_for = null
  // Archived, so it leaves the active roster without pretending it never
  // existed — the studio's counts and history stay coherent.
  patch.archived_at = new Date(nowMs)
  return patch
}
