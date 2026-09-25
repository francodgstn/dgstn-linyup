import type {
  EventProgramConfig,
  EventProgramItem,
  ProgramDay,
  ProgramTemplate,
  ProgramTemplateItem,
  ProgramTrack,
} from '../types/event'

// Pure helpers for the event program. Client-safe (no Firestore, no admin SDK)
// so the web app, the public surfaces and the Cloud Functions all order and
// transform programs identically.
//
// Times are WALL-CLOCK at the venue ('HH:MM' + the day's calendar date) — see
// the long comment in types/event.ts. Nothing here converts timezones, by
// design; a program is a printed schedule, not a bookable slot.

/** Minutes since midnight, or null when the string is not a valid 'HH:MM'. */
export function parseHHMM(value: string | undefined | null): number | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** 'HH:MM' from minutes since midnight. Wraps past 24 h (crossing midnight). */
export function formatHHMM(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440
  const h = Math.floor(wrapped / 60)
  const m = wrapped % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Structural, not Pick<EventProgramItem>: the PUBLIC mirror uses `null` where
// the private document uses `undefined`, and both must sort through the same
// comparator rather than each growing its own.
type SortableItem = { startTime: string; order: number; allDay?: boolean }

/** The time fields these helpers need, tolerant of null or undefined ends. */
export interface TimedItem {
  startTime: string
  endTime?: string | null
}

/** The canonical item ordering WITHIN a day: all-day first, then by start
 *  time, then by `order` as a stable tie-break. Times drive the ordering —
 *  `order` only separates items that begin at the same minute. */
export function compareProgramItems(a: SortableItem, b: SortableItem): number {
  if (!!a.allDay !== !!b.allDay) return a.allDay ? -1 : 1
  const as = parseHHMM(a.startTime)
  const bs = parseHHMM(b.startTime)
  // An unparseable time sorts last rather than throwing — a bad row must never
  // take the whole agenda down.
  if (as !== bs) {
    if (as === null) return 1
    if (bs === null) return -1
    return as - bs
  }
  return (a.order ?? 0) - (b.order ?? 0)
}

/** Length in minutes, handling an item that runs past midnight (endTime
 *  earlier than startTime). Null when either end is missing or unparseable. */
export function itemDurationMinutes(item: TimedItem): number | null {
  const start = parseHHMM(item.startTime)
  const end = parseHHMM(item.endTime)
  if (start === null || end === null) return null
  return end >= start ? end - start : 1440 - start + end
}

/** True when the item finishes on the following calendar day. */
export function crossesMidnight(item: TimedItem): boolean {
  const start = parseHHMM(item.startTime)
  const end = parseHHMM(item.endTime)
  return start !== null && end !== null && end < start
}

/** Just the parts of a program config these helpers read. The PUBLIC mirror
 *  uses null where the private document uses undefined, so both flow through
 *  the same sorting/grouping code. */
export interface DaysAndTracks {
  days?: ProgramDay[]
  tracks?: ProgramTrack[]
}

export function compareProgramDays(a: ProgramDay, b: ProgramDay): number {
  if (a.order !== b.order) return (a.order ?? 0) - (b.order ?? 0)
  return a.date.localeCompare(b.date)
}

export function sortedDays(config: DaysAndTracks | undefined): ProgramDay[] {
  return [...(config?.days ?? [])].sort(compareProgramDays)
}

export function sortedTracks(config: DaysAndTracks | undefined): ProgramTrack[] {
  return [...(config?.tracks ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/** Items for one day, correctly ordered. */
export function itemsForDay<T extends SortableItem & { dayId: string }>(
  items: T[],
  dayId: string,
): T[] {
  return items.filter((i) => i.dayId === dayId).sort(compareProgramItems)
}

/** Items belonging to one track. Pass null for the plenary lane — items with no
 *  trackId span every track. */
export function itemsForTrack<T extends { trackId?: string | null }>(
  items: T[],
  trackId: string | null,
): T[] {
  return items.filter((i) => (i.trackId ?? null) === trackId)
}

/** True for an item that spans every track (no track assigned). */
export function isPlenary(item: { trackId?: string | null }): boolean {
  return (item.trackId ?? null) === null
}

/** Next free `order` within a day.
 *
 *  MAX + 1, deliberately NOT the item count: `order` only has to be unique and
 *  increasing (it is the tie-break between items sharing a start time), and
 *  counting reuses a value that is still in use as soon as anything has been
 *  deleted from the middle of the day. */
export function nextItemOrder(
  items: Array<{ dayId: string; order?: number }>,
  dayId: string,
): number {
  return items
    .filter((i) => i.dayId === dayId)
    .reduce((max, i) => Math.max(max, i.order ?? 0), -1) + 1
}

/** Day-by-day grouping in display order, including days with no items. */
export function groupItemsByDay<T extends SortableItem & { dayId: string }>(
  config: DaysAndTracks | undefined,
  items: T[],
): Array<{ day: ProgramDay; items: T[] }> {
  return sortedDays(config).map((day) => ({ day, items: itemsForDay(items, day.id) }))
}

// ─── calendar-date helpers ────────────────────────────────────────────────────
// 'YYYY-MM-DD' arithmetic done on the calendar itself, never via a local Date,
// so a program day never shifts because of a timezone or a DST boundary.

/** Parse 'YYYY-MM-DD'. Returns null when malformed. */
export function parseISODate(value: string | undefined | null): {
  year: number
  month: number
  day: number
} | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

/** Add whole days to a 'YYYY-MM-DD' string, returning 'YYYY-MM-DD'. Uses UTC so
 *  the result is a pure calendar operation with no DST involvement. */
export function addDaysISO(date: string, days: number): string {
  const parsed = parseISODate(date)
  if (!parsed) return date
  const d = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day))
  d.setUTCDate(d.getUTCDate() + days)
  return toISODate(d)
}

/** 'YYYY-MM-DD' from a Date, read in UTC. */
export function toISODate(d: Date): string {
  return [
    String(d.getUTCFullYear()).padStart(4, '0'),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

/** The calendar date AT A GIVEN TIMEZONE, as 'YYYY-MM-DD'.
 *
 *  Reading `getFullYear()/getMonth()/getDate()` off a Date gives the *runtime's*
 *  calendar, which on Cloud Functions is UTC — so an event starting 00:30 in
 *  Zurich reads as the PREVIOUS day, and anything derived from it (a program
 *  day shift, for one) lands twenty-four hours out. `en-CA` formats as
 *  YYYY-MM-DD, which is exactly the shape stored on a ProgramDay. */
export function isoDateInTimezone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetweenISO(from: string, to: string): number {
  const a = parseISODate(from)
  const b = parseISODate(to)
  if (!a || !b) return 0
  const ms =
    Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)
  return Math.round(ms / 86_400_000)
}

// ─── template transforms ──────────────────────────────────────────────────────

/** Item ready to write, minus the fields the caller stamps (id/eventId/tenant). */
export type MaterialisedItem = Omit<
  EventProgramItem,
  'id' | 'eventId' | 'teamId' | 'orgId' | 'scope' | 'created_at' | 'updated_at' | 'createdBy'
>

/** Turn a template into a concrete program anchored on `firstDayDate`.
 *
 *  `newId` mints the ids for the generated days and tracks — the caller passes
 *  its own generator (crypto.randomUUID in the browser, the Firestore doc-id
 *  generator on the server) so this stays pure and deterministic in tests.
 *  Track ids are ALWAYS regenerated, so two events never share track ids. */
export function materialiseTemplate(
  template: Pick<ProgramTemplate, 'days' | 'tracks' | 'items' | 'timezoneLabel' | 'note'>,
  firstDayDate: string,
  newId: () => string,
): { config: EventProgramConfig; items: MaterialisedItem[] } {
  // Old track id → freshly minted id.
  const trackIdMap = new Map<string, string>()
  const tracks: ProgramTrack[] = [...(template.tracks ?? [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((t, index) => {
      const id = newId()
      trackIdMap.set(t.id, id)
      return { id, name: t.name, ...(t.color ? { color: t.color } : {}), order: index }
    })

  // A template may carry day metadata for only some indexes; the item list is
  // the authority on how many days the program actually spans.
  const maxItemIndex = (template.items ?? []).reduce(
    (max, i) => Math.max(max, i.dayIndex ?? 0),
    -1,
  )
  const maxDayIndex = (template.days ?? []).reduce(
    (max, d) => Math.max(max, d.dayIndex ?? 0),
    maxItemIndex,
  )

  const dayIdByIndex = new Map<number, string>()
  const days: ProgramDay[] = []
  for (let index = 0; index <= maxDayIndex; index++) {
    const meta = (template.days ?? []).find((d) => d.dayIndex === index)
    const id = newId()
    dayIdByIndex.set(index, id)
    days.push({
      id,
      date: addDaysISO(firstDayDate, index),
      ...(meta?.title ? { title: meta.title } : {}),
      ...(meta?.subtitle ? { subtitle: meta.subtitle } : {}),
      order: index,
    })
  }

  const items: MaterialisedItem[] = (template.items ?? [])
    .filter((i) => dayIdByIndex.has(i.dayIndex))
    .map((i) => {
      const mappedTrack = i.trackId ? trackIdMap.get(i.trackId) ?? null : null
      return {
        dayId: dayIdByIndex.get(i.dayIndex)!,
        trackId: mappedTrack,
        startTime: i.startTime,
        ...(i.endTime ? { endTime: i.endTime } : {}),
        ...(i.allDay ? { allDay: true } : {}),
        title: i.title,
        ...(i.subtitle ? { subtitle: i.subtitle } : {}),
        ...(i.description ? { description: i.description } : {}),
        ...(i.locationText ? { locationText: i.locationText } : {}),
        ...(i.peopleText ? { peopleText: i.peopleText } : {}),
        ...(i.kind ? { kind: i.kind } : {}),
        ...(i.color ? { color: i.color } : {}),
        ...(i.isHighlight ? { isHighlight: true } : {}),
        ...(i.internalNote ? { internalNote: i.internalNote } : {}),
        order: i.order ?? 0,
      }
    })

  return {
    config: {
      days,
      tracks,
      ...(template.timezoneLabel ? { timezoneLabel: template.timezoneLabel } : {}),
      ...(template.note ? { note: template.note } : {}),
    },
    items,
  }
}

/** The inverse: turn a live program into a reusable template by replacing each
 *  dayId with its 0-based index. Track ids are kept as-is here — they are
 *  internal to the template and regenerated again on the next apply. */
export function extractTemplate(
  config: EventProgramConfig | undefined,
  items: Array<Pick<EventProgramItem,
    | 'dayId' | 'trackId' | 'startTime' | 'endTime' | 'allDay' | 'title' | 'subtitle'
    | 'description' | 'locationText' | 'peopleText' | 'kind' | 'color' | 'isHighlight'
    | 'internalNote' | 'order'>>,
): Pick<ProgramTemplate, 'days' | 'tracks' | 'items' | 'timezoneLabel' | 'note'> {
  const days = sortedDays(config)
  const indexByDayId = new Map(days.map((d, index) => [d.id, index]))
  const validTrackIds = new Set((config?.tracks ?? []).map((t) => t.id))

  const templateItems: ProgramTemplateItem[] = items
    .filter((i) => indexByDayId.has(i.dayId))
    .map((i) => {
      // Drop a dangling track reference rather than carrying a broken id into
      // the template — the item becomes plenary, which is the safe reading.
      const trackId = i.trackId && validTrackIds.has(i.trackId) ? i.trackId : null
      return {
        dayIndex: indexByDayId.get(i.dayId)!,
        trackId,
        startTime: i.startTime,
        ...(i.endTime ? { endTime: i.endTime } : {}),
        ...(i.allDay ? { allDay: true } : {}),
        title: i.title,
        ...(i.subtitle ? { subtitle: i.subtitle } : {}),
        ...(i.description ? { description: i.description } : {}),
        ...(i.locationText ? { locationText: i.locationText } : {}),
        ...(i.peopleText ? { peopleText: i.peopleText } : {}),
        ...(i.kind ? { kind: i.kind } : {}),
        ...(i.color ? { color: i.color } : {}),
        ...(i.isHighlight ? { isHighlight: true } : {}),
        ...(i.internalNote ? { internalNote: i.internalNote } : {}),
        order: i.order ?? 0,
      }
    })
    .sort((a, b) => a.dayIndex - b.dayIndex || compareProgramItems(a, b))

  return {
    days: days.map((d, index) => ({
      dayIndex: index,
      ...(d.title ? { title: d.title } : {}),
      ...(d.subtitle ? { subtitle: d.subtitle } : {}),
    })),
    tracks: sortedTracks(config),
    items: templateItems,
    ...(config?.timezoneLabel ? { timezoneLabel: config.timezoneLabel } : {}),
    ...(config?.note ? { note: config.note } : {}),
  }
}

/** Shift every day of a program by `days` calendar days — used when an event is
 *  duplicated to a new start date, so a five-day camp keeps its shape. */
export function shiftProgramDays(
  config: EventProgramConfig,
  days: number,
): EventProgramConfig {
  if (days === 0) return config
  return { ...config, days: config.days.map((d) => ({ ...d, date: addDaysISO(d.date, days) })) }
}
