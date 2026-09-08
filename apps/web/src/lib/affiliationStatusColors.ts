/**
 * THE ONE PLACE A STATUS COLOUR BECOMES CLASSES.
 *
 * `OrgAffiliationStatusDef.color` is a NAME (`green`, `red`, …) chosen by the
 * organisation, not a class — the status vocabulary is tenant-configurable, so
 * the mapping has to live in the app. It was written out twice, identically, in
 * the team and org Affiliations pages; the org dashboard's status strip needed a
 * third form of it, which is the moment to stop copying.
 *
 * TWO SHAPES, because a badge and a bar are not the same thing: a badge is tinted
 * background + readable text, a bar is a solid fill with nothing on it. Deriving
 * one from the other would mean parsing class strings.
 *
 * Tailwind scans source for literal class names, so every class here is written
 * out in full — never assembled from a template (`bg-${color}-100` compiles and
 * then renders unstyled, which is the failure mode this comment exists to
 * prevent).
 */

import type { AffiliationStatusColor } from '@linyup/shared'

/** Tinted background + readable text — the status chip in a list or a table. */
export const AFFILIATION_STATUS_BADGE: Record<AffiliationStatusColor, string> = {
  gray:   'bg-gray-100   text-gray-700   dark:bg-gray-800   dark:text-gray-300',
  yellow: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  blue:   'bg-blue-100   text-blue-700   dark:bg-blue-900   dark:text-blue-300',
  purple: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  green:  'bg-green-100  text-green-700  dark:bg-green-900  dark:text-green-300',
  red:    'bg-red-100    text-red-700    dark:bg-red-900    dark:text-red-300',
  orange: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
}

/**
 * Solid fill — a segment of a distribution bar, or the dot beside its legend.
 *
 * A step darker than the badge in light mode and a step lighter in dark, because
 * these sit ON the page background rather than behind text: the badge's `-100`
 * is nearly invisible as a 6px bar, and its dark `-900` disappears entirely.
 */
export const AFFILIATION_STATUS_FILL: Record<AffiliationStatusColor, string> = {
  gray:   'bg-gray-400   dark:bg-gray-500',
  yellow: 'bg-yellow-400 dark:bg-yellow-500',
  blue:   'bg-blue-500   dark:bg-blue-400',
  purple: 'bg-purple-500 dark:bg-purple-400',
  green:  'bg-green-500  dark:bg-green-400',
  red:    'bg-red-500    dark:bg-red-400',
  orange: 'bg-orange-500 dark:bg-orange-400',
}

/** The colour name is tenant data and may be anything; fall back rather than blank. */
export function statusBadgeClass(color: string | undefined): string {
  return AFFILIATION_STATUS_BADGE[color as AffiliationStatusColor] ?? AFFILIATION_STATUS_BADGE.gray
}

export function statusFillClass(color: string | undefined): string {
  return AFFILIATION_STATUS_FILL[color as AffiliationStatusColor] ?? AFFILIATION_STATUS_FILL.gray
}
