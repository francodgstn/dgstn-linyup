/**
 * THE COLOR OF AN EVENT TYPE — one map, for every surface that draws one.
 *
 * It was written out identically in `EventPeekSheet` and `SessionsCalendar`, and
 * the org events timeline wanted a third copy. Three copies of a color map is
 * how a competition ends up red on the calendar and orange on the timeline after
 * somebody adjusts one of them.
 *
 * HEX, not Tailwind classes, because these are used as inline `background` and
 * `borderColor` values on elements whose color is data-driven — a class name
 * cannot be assembled at runtime and survive Tailwind's static scan.
 *
 * The keys are the BUILT-IN type slugs. A plugin-contributed type
 * ('hmd_fighting_cup') is not here and falls back to the neutral, which is the
 * intended behavior: the type still renders, labeled by its own copy, just
 * without a color of its own until somebody chooses one.
 */

/** Neutral gray, for a type this map does not know. */
export const EVENT_TYPE_COLOR_FALLBACK = '#6B7280'

export const EVENT_TYPE_COLOR: Record<string, string> = {
  competition: '#EF4444',
  camp: '#F97316',
  exam: '#8B5CF6',
  seminar: '#3B82F6',
  workshop: '#10B981',
}

export function eventTypeColor(type: string | undefined | null): string {
  return (type && EVENT_TYPE_COLOR[type]) || EVENT_TYPE_COLOR_FALLBACK
}
