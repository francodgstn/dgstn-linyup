/**
 * THE ONE PERMUTATION behind every drag-to-reorder list that stores `order`.
 *
 * Three surfaces order the same two collections — the activities list, the
 * subscription-types manager, and now the catalog's rail — and all three write
 * `order = index` over the whole list. What they must agree about is not the
 * write but the ARITHMETIC: which positions a move actually changes.
 *
 * ── THE SECTION RULE ────────────────────────────────────────────────────────
 * Activities are shown in two groups (classes, appointments) but stored in ONE
 * ordered list. Dragging inside a group must therefore permute that group among
 * the GLOBAL positions it already occupies, leaving the other group's ordering —
 * and any interleaving that public surfaces produce by sorting the full list —
 * untouched. Reindexing the group alone would silently renumber it over the top
 * of the other one.
 *
 * A list with no groups is the same operation with `section === full`, which is
 * why plans use it too rather than a second, simpler copy.
 */

/**
 * Move `section[from]` to `section[to]`, then splice the permuted section back
 * into the slots it already held in `full`.
 *
 * Returns a new array in the order to persist; the caller writes
 * `order = index` for the entries whose index changed. Both inputs are treated
 * as read-only.
 */
export function reorderWithinSection<T extends { id: string }>(
  full: readonly T[],
  section: readonly T[],
  from: number,
  to: number
): T[] {
  const nextSection = [...section]
  const [moved] = nextSection.splice(from, 1)
  // A `from` outside the section yields `undefined` here, which would then be
  // spliced in as a hole and written as an order for nothing. Refusing is the
  // only safe answer: the caller's indices did not describe this list.
  if (moved === undefined) return [...full]
  nextSection.splice(to, 0, moved)

  const inSection = new Set(section.map((item) => item.id))
  let cursor = 0
  return full.map((item) => (inSection.has(item.id) ? nextSection[cursor++] : item))
}
