/**
 * Stamp `teams/{teamId}/counters/contacts` for a seeded team.
 *
 * ── WHY A SEEDER HAS TO DO THIS ─────────────────────────────────────────────
 * The operator console reads the live-contact count off that document rather
 * than running a `count()` per tenant on every page view. Two writers keep it
 * (packages/shared/src/utils/contactCounter.ts owns the reasoning): the
 * `trackContacts` trigger applies DELTAS, and the nightly platform-metrics job
 * reconciles with an authoritative count. A seeder writes contacts straight to
 * Firestore, so neither has run for them.
 *
 * On a deployed project that self-heals by morning. In the EMULATOR it never
 * does — no scheduler runs there — and the failure is worse than a blank:
 * `trackContacts` DOES run locally, and its delta is
 * `set({ live: increment(1) }, { merge: true })`, which on a missing document
 * CREATES it at 1. So a seeded studio of two hundred shows `live: 1` the moment
 * somebody adds one contact — a confident wrong number in place of the honest
 * "—" the console renders for a counter that was never written.
 *
 * ── IT MUST AGREE WITH THE RECONCILER, NOT MERELY BE CORRECT ────────────────
 * This runs the SAME query `countActiveContacts` runs in
 * packages/functions/src/analytics/platformMetrics.ts — same filters, same
 * `count()`. The point is not to be independently accurate: it is that the
 * value a seed writes and the value the nightly job would later write can never
 * disagree. Counting some other way (reading the docs and filtering in memory,
 * say) would be a SECOND definition of "live", and the one thing worse than a
 * missing counter is two writers that each believe a different number.
 *
 * That also means it inherits the `== null` rule: a Firestore `== null` filter
 * matches an explicit null and NOT a missing field (CLAUDE.md). Every seeder
 * writes `deleted_at: null` and `archived_at: null` on its contacts, which is
 * what makes this safe — and if one ever stopped, this would undercount in
 * exactly the way the live system already does, which is the behavior to want
 * here.
 */
import type { Firestore } from 'firebase-admin/firestore'
import admin from 'firebase-admin'
import {
  CONTACTS_COLLECTION,
  TEAMS_COLLECTION,
  TEAM_COUNTERS_SUBCOLLECTION,
  TEAM_CONTACT_COUNTER_DOC,
} from '@linyup/shared'

/**
 * Count this team's live contacts and write the counter as an ABSOLUTE value —
 * never an increment, the same rule both real writers follow.
 *
 * Call it AFTER the team's contacts are written. Returns the value stored, so a
 * seeder can log it.
 */
export async function writeTeamContactCounter(db: Firestore, teamId: string): Promise<number> {
  const snap = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .where('deleted_at', '==', null)
    .where('archived_at', '==', null)
    .count()
    .get()
  const live = snap.data().count

  await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(TEAM_COUNTERS_SUBCOLLECTION)
    .doc(TEAM_CONTACT_COUNTER_DOC)
    .set(
      {
        live,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
        // NOT `reconciled_at`: that field means the nightly job replaced this
        // with an authoritative count, and a seeder is not that job. Leaving it
        // unset keeps "has this ever been reconciled?" answerable.
        reconciled_at: null,
      },
      { merge: true },
    )
  return live
}
