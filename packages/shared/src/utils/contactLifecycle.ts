/**
 * WHERE A CONTACT STANDS WITH THE STUDIO — one predicate, in one place.
 *
 * Four independent things are tracked about a person: how far they got on the
 * journey (`acquisition_stage`), whether the club counts them (affiliation),
 * what they pay for (subscription), and THIS — whether the studio looks after
 * them today. The first three are read through their own resolvers; this file
 * owns the fourth.
 *
 * ── THE VALUES, IN THE ORDER THEY ARE DECIDED ────────────────────────────────
 *
 *   deleted      in the bin, or already anonymised. Nothing reads them.
 *   archived     the person left; the record is kept for history.
 *   provisional  a lead that has not materialised yet (shop registration
 *                awaiting payment, unattended trial booking) — the Leads tab,
 *                exempt from the contact cap, shop ones purged unpaid.
 *   external     trains here without being on the roster — a partner-app
 *                drop-in, a former member who still comes now and then. LIVE
 *                (bookable, checked in, in the class stats) but not looked after
 *                (no reminders, invitations, automations, attention, headline).
 *   active       on the roster: everyone else.
 *
 * The order is fixed and the first match wins, so a document carrying two
 * markers (an archived external, a provisional external) answers deterministically
 * and every surface agrees. `archived_at` and `deleted_at` are ALWAYS present
 * (`null` when clear) — see apps/web/src/lib/liveContacts.ts for why that is
 * what makes the Firestore `== null` query safe; `provisional` and `external`
 * are PRESENT ONLY WHEN TRUE, like every other opt-in marker, which is what
 * lets a query for them (`where('external', '==', true)`) work without a
 * backfill and a query for their absence be answered in memory.
 *
 * ── TWO QUESTIONS, TWO PREDICATES ────────────────────────────────────────────
 *
 * `isLiveContact`   — may this person book, attend, sign in, be found by email?
 *                     Not deleted, not archived. Externals and leads are live.
 * `isRosterContact` — does the studio LOOK AFTER this person? `active` and
 *                     `provisional` — a lead is somebody the studio is working
 *                     to convert, the top of its own funnel, the target of its
 *                     trial follow-ups. This is the headcount, who gets invited,
 *                     who an automation sweeps, who can need attention. The
 *                     Active TAB is the roster minus leads, split on the client
 *                     as it always was.
 *
 * So the only difference between the two is the external, and that is the
 * whole reason the bucket exists: before it, a ClassPass visitor was either on
 * the roster (nagged, counted, invited) or archived (unbookable). Every count
 * that flatters a studio by including people it does not look after reads the
 * wrong one of these two.
 */

export type ContactLifecycle = 'deleted' | 'archived' | 'provisional' | 'external' | 'active'

/** The order surfaces list the buckets in — the same order they are decided. */
export const CONTACT_LIFECYCLES: readonly ContactLifecycle[] = [
  'active',
  'external',
  'provisional',
  'archived',
  'deleted',
]

/** The fields the answer is read from. Every one optional: a partial document
 *  (a query with `select`, a mirror, a test fixture) still answers. */
export interface ContactLifecycleFacts {
  deleted_at?: unknown
  anonymized_at?: unknown
  archived_at?: unknown
  provisional?: boolean
  external?: boolean
}

export function contactLifecycle(c: ContactLifecycleFacts): ContactLifecycle {
  if (c.deleted_at != null || c.anonymized_at != null) return 'deleted'
  if (c.archived_at != null) return 'archived'
  if (c.provisional === true) return 'provisional'
  if (c.external === true) return 'external'
  return 'active'
}

/** Not deleted, not archived — may book, attend, sign in, be matched by email. */
export function isLiveContact(c: ContactLifecycleFacts): boolean {
  const l = contactLifecycle(c)
  return l !== 'deleted' && l !== 'archived'
}

/** Somebody the studio looks after today — active or a lead. The headcount,
 *  the invitation list, the automation sweep, the attention queue all read THIS. */
export function isRosterContact(c: ContactLifecycleFacts): boolean {
  const l = contactLifecycle(c)
  return l === 'active' || l === 'provisional'
}
