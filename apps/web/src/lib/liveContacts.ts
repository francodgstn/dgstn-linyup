/**
 * A CONTACT WHO STILL COUNTS — one definition, in one place.
 *
 * "Live" means **not deleted and not archived**, and both halves matter:
 *
 *   `deleted_at`  the contact is in the bin, awaiting anonymisation.
 *   `archived_at` the person left. The record is kept deliberately — history,
 *                 an old subscription, a competition result — and it must not
 *                 be counted as somebody the studio looks after today.
 *
 * ── WHY THIS IS A MODULE AND NOT TWO `where` CLAUSES AT EACH CALL SITE ──────
 *
 * Because the second half kept being forgotten, and forgetting it fails
 * SILENTLY and UPWARDS: the query succeeds, the page renders, and the number is
 * simply too big. Nothing errors, no test goes red, and the only symptom is a
 * studio or a federation reading a headcount that flatters it — which is the
 * one direction a wrong number is least likely to be questioned.
 *
 * `useActiveContacts` had both clauses and was right; every org-side count
 * written against it later had only `deleted_at`, so an organisation's
 * dashboard and its studios list both counted people who had left (Franco,
 * 2026-09-08: "in the org dashboard, I see too high counts"). Naming the pair
 * is what stops the next reader writing one of them.
 *
 * ── THE FIELDS ARE ALWAYS PRESENT, WHICH IS WHAT MAKES `== null` SAFE ───────
 *
 * A Firestore `== null` filter matches an explicit null and NOT a missing
 * field, so this would quietly UNDER-count if any writer omitted them. Every
 * one sets them: the contacts page and the booking / signup / login callables
 * write `archived_at: null` on create, and the HMD migration coalesces
 * (`transforms/contacts.ts`). Add a new contact writer without them and it
 * becomes invisible to every count in the product — that, not the filter, is
 * the thing to be careful about.
 */

import { where, type QueryFieldFilterConstraint } from 'firebase/firestore'

/**
 * The clauses to spread into any `contacts` query that means "people, now".
 *
 * A function rather than a shared constant array: a `QueryFieldFilterConstraint`
 * is a descriptor and reusing one is harmless today, but a module-level array
 * built at import time is a Firestore object living for the life of the tab for
 * no reason. Spread it: `query(col, where('teamId','==',id), ...liveContactConstraints())`.
 */
export function liveContactConstraints(): QueryFieldFilterConstraint[] {
  return [where('deleted_at', '==', null), where('archived_at', '==', null)]
}

/**
 * The same question asked of a contact already in memory — and its sibling,
 * `isRosterContact`, which additionally drops EXTERNALS (people who train here
 * without being looked after — see `contactLifecycle` in shared). The roster
 * cannot be a query: `external` is present only when true, so a headcount
 * spreads `liveContactConstraints()` and then narrows with `isRosterContact`.
 * Both re-exported from the one owner so this module stays the place a reader
 * looks for "who counts".
 */
export { isLiveContact, isRosterContact } from '@linyup/shared'
