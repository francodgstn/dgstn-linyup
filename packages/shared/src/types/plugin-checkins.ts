/**
 * Per-event-type CHECK-IN COMPLETION rules contributed by plugins.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `isCheckinCompleted` is a switch on event type, and its `default` branch used
 * to read `Array.isArray(checkinData.categories)` — the `hmd-fighting-cup`
 * payload shape, written into core. Core therefore knew one tenant-specific
 * plugin's data model, and the second plugin needing custom completion logic had
 * nowhere to put it but that same branch, beside a rule that was not its own.
 *
 * ── WHY IT LIVES IN `shared` AND NOT IN THE PLUGIN FOLDER ───────────────────
 * `isCheckinCompleted` runs on the client (the check-in UI) AND on the server
 * (`addEventCheckin`'s validation), so the rule has to be reachable from both,
 * and the plugin registry lives in `apps/web`. `PLUGIN_BUNDLES` and
 * `PLUGIN_ADDONS` next door are here for exactly that reason — one owner, no
 * copy for a test to police. Same trade, same place.
 *
 * ── WHAT A RULE MAY AND MAY NOT DO ──────────────────────────────────────────
 * It is a PURE PREDICATE over the check-in payload. No Firestore, no fetch, no
 * clock — the same constraint the progression engine's plugin requirements
 * carry, and for the same reason: this is asked on every roster row of every
 * event, on both sides of the wire.
 *
 * An event type with no entry here is AUTO-CONFIRMED, which is what
 * `competition`, `seminar` and `workshop` already were. Adding a rule is
 * therefore a narrowing: it can only make a check-in stay pending, never make a
 * pending one complete.
 */

/** A pure predicate over `checkin_data`. */
export type CheckinCompletionRule = (checkinData?: Record<string, unknown>) => boolean

/**
 * A competitor is checked in once they are in at least one category. The
 * categories are defined per event by the plugin's CategoryManager and assigned
 * at the door.
 *
 * ── THE ABSENT KEY AUTO-CONFIRMS, AND THAT IS DELIBERATE ────────────────────
 * The array must be PRESENT to gate. A cup check-in that has not been through
 * the form yet carries no `categories` key at all, and the type collects nothing
 * else — so it confirms on admission. Only a form that ran and left the array
 * EMPTY means "nobody was assigned".
 *
 * This is long-standing behavior and it is pinned by
 * `events/checkinCompletion.test.ts`, whose own comment says it is there "so the
 * exam fix cannot be read as license to change it". Moving the rule out of core
 * is not that license either: the predicate below reproduces the old expression
 * exactly.
 */
const requiresACategory: CheckinCompletionRule = (d) =>
  Array.isArray(d?.categories) ? (d.categories as unknown[]).length > 0 : true

export const PLUGIN_CHECKIN_COMPLETION: Record<string, CheckinCompletionRule> = {
  hmd_fighting_cup: requiresACategory,

  /**
   * The PRE-MIGRATION spelling, kept deliberately.
   *
   * hmd-lineup stores `'fighting_cup'`; the migration maps it to
   * `'hmd_fighting_cup'` because plugin resolution is an exact match (see
   * `scripts/migration/config.ts`). A document that predates that map — or a
   * half-run migration — would otherwise fall to the auto-confirm default and
   * silently mark an emptied category list as checked in. Registering the old
   * key costs one line and keeps the failure in the safe direction; it is also
   * the key the existing tests use.
   */
  fighting_cup: requiresACategory,
}
