/**
 * Shared contact query helpers.
 * Extracted from analytics/index.ts to be reusable across functions.
 */
import * as admin from 'firebase-admin'
import { CONTACTS_COLLECTION, isRosterContact, normalizeEmail } from '@linyup/shared'
import { to } from './async'

export interface SingleContactMatch {
  /** Matched contact id, or null when zero or more-than-one active contacts matched. */
  contactId: string | null
  /** Number of ACTIVE (non-archived, non-deleted) contacts that matched the email. */
  count: number
}

/**
 * Resolve a team contact by payer email, returning a contactId ONLY when exactly
 * one ACTIVE (non-archived, non-deleted) contact matches:
 *   • 0 matches → { contactId: null, count: 0 }   (none)
 *   • 1 match   → { contactId, count: 1 }          (safe to auto-link)
 *   • >1 match  → { contactId: null, count }       (ambiguous — never guess)
 *
 * Email is NOT a unique key in Linyup — a parent's address routinely controls
 * several child contacts — so taking the first `.limit(1)` match silently
 * mis-assigns a family's payment. Mirrors loginContactWithCode's active filter.
 * Callers decide what to do with none vs ambiguous (record unassigned, create, …).
 */
export async function resolveSingleContact(
  teamId: string,
  email: string | null | undefined,
  db: admin.firestore.Firestore = admin.firestore(),
): Promise<SingleContactMatch> {
  const normalized = email ? normalizeEmail(email) : ''
  if (!normalized) return { contactId: null, count: 0 }

  const [err, snap] = await to(
    db
      .collection(CONTACTS_COLLECTION)
      .where('teamId', '==', teamId)
      .where('email', '==', normalized)
      .get(),
  )
  if (err || !snap) return { contactId: null, count: 0 }

  // Exclude archived / deleted (same active filter as loginContactWithCode).
  const active = snap.docs.filter((d) => {
    const c = d.data()
    return c.archived_at == null && c.deleted_at == null
  })

  if (active.length === 1) return { contactId: active[0].id, count: 1 }
  return { contactId: null, count: active.length }
}

/**
 * Fetches the ROSTER — every contact the studio looks after today. Live (not
 * deleted, not archived) by query, then narrowed in memory by `isRosterContact`
 * so an external (a partner-app drop-in, a former member who still comes now
 * and then) is not counted: `external` is present only when true, so its
 * absence cannot be queried and is decided here instead. Leads stay: they are
 * the top of the studio's own funnel.
 */
export async function getActiveContacts(
  db: admin.firestore.Firestore,
  teamId: string,
): Promise<admin.firestore.DocumentData[]> {
  const [err, snap] = await to(
    db.collection('contacts')
      .where('teamId', '==', teamId)
      .where('deleted_at', '==', null)
      .where('archived_at', '==', null)
      .get(),
  )
  if (err || !snap) return []
  return snap.docs.map((d) => d.data()).filter(isRosterContact)
}

/**
 * Counts contacts by a given field value.
 * Returns a map of { fieldValue → count }.
 */
export function countByField(
  contacts: admin.firestore.DocumentData[],
  field: string,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const c of contacts) {
    const val = c[field] as string | undefined
    if (!val) continue
    counts[val] = (counts[val] ?? 0) + 1
  }
  return counts
}

/**
 * Count active contacts by acquisition stage
 * ('trial_booked' | 'trial_attended' | 'joined').
 */
export async function countContactsByStage(
  db: admin.firestore.Firestore,
  teamId: string,
): Promise<Record<string, number>> {
  const contacts = await getActiveContacts(db, teamId)
  return countByField(contacts, 'acquisition_stage')
}

/**
 * Count active contacts by subscription_type_id.
 */
export async function countContactsBySubscriptionType(
  db: admin.firestore.Firestore,
  teamId: string,
): Promise<Record<string, number>> {
  const contacts = await getActiveContacts(db, teamId)
  return countByField(contacts, 'subscription_type_id')
}

/**
 * Count active contacts (with a subscription) by subscription_recurrence.
 */
export async function countContactsByRecurrence(
  db: admin.firestore.Firestore,
  teamId: string,
): Promise<Record<string, number>> {
  const contacts = await getActiveContacts(db, teamId)
  return countByField(
    contacts.filter((c) => c.subscription_type_id),
    'subscription_recurrence',
  )
}

/**
 * Counts contacts by a set of keys derived from each contact via `getKeys`.
 * Each key returned by `getKeys` is deduplicated per contact (using a Set)
 * before incrementing, so a contact that maps to the same key twice counts once.
 * Returns a map of { key → count }.
 */
export function countByDistinctKeys(
  contacts: admin.firestore.DocumentData[],
  getKeys: (c: admin.firestore.DocumentData) => string[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const c of contacts) {
    const seen = new Set(getKeys(c))
    for (const key of seen) {
      if (!key) continue
      counts[key] = (counts[key] ?? 0) + 1
    }
  }
  return counts
}
