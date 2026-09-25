'use client'

/**
 * SCHEDULE CALENDARS — a VIEW PREFERENCE, and deliberately nothing else.
 *
 * WHAT IT IS: which of the four things the Schedule can draw are currently
 * DRAWN — Classes, Appointments, Bookable hours, Events. The mental model is
 * the one every calendar app already taught the user: each is a CALENDAR you
 * tick on or off, not a filter that narrows the list down to one. Unticking one
 * is the same gesture as unticking a calendar in the sidebar of Google or Apple
 * Calendar.
 *
 * THE WORD IS "CALENDARS", not "layers". Layers is a drawing-tool word that no
 * studio arrives with; every app that ships this exact control calls the things
 * calendars. This shipped as "layers" for a few commits (994af302) and was
 * renamed through — code, copy and storage key — while the vocabulary was days
 * old. Do not reintroduce the old word.
 *
 * "CALENDARS" (the things shown) vs "CALENDAR" (the view, opposite of List).
 * The page has both, a few pixels apart. The plural is always used for these
 * four, and no label for them is ever the bare singular — see
 * `components/schedule/VisibleCalendarsMenu.tsx`.
 *
 * WHAT IT IS NOT: nav memory. It is **not** a member of the census owned by
 * `contexts/NavPinsContext.tsx` and must never be added there. That census
 * answers WHERE YOU GO (shortcuts, open tabs, recently viewed contacts) and
 * every entry in it is a destination or a record. This answers WHAT IS DRAWN on
 * one page. Folding a view preference into it would undo exactly the distinction
 * UX-23 drew, and the next reader would have to re-derive it.
 *
 * SCOPE. One page, one key, per browser — no team scoping, because a shown
 * calendar is not a fact about a tenant (unlike recently-viewed contacts, which
 * are people belonging to one team). A studio that hides one finds it hidden
 * tomorrow, on that browser, in every team it opens.
 *
 * THE STORAGE KEY WAS RENAMED WITH THE VOCABULARY, and no migration was
 * written. That is a decision, not an oversight: a browser holding the old
 * `linyup_schedule_layers` value simply falls back to the default set, which is
 * the DELIBERATE default (below) rather than an empty screen — and the value
 * being reset is a per-browser view preference that has existed for a few days,
 * pre-launch. A read-the-old-key shim would be machinery for a hypothesis.
 *
 * TWO SECTIONS, AND THE LINE BETWEEN THEM IS "DOES IT HAPPEN?".
 *
 *   Sessions & events — Classes, Appointments, Events: OCCURRENCES. Each is a
 *     thing that happens, at a time, on a date, that somebody could attend.
 *   Other — Bookable hours: AVAILABILITY. A `availability/{id}` doc is a
 *     WINDOW, and nothing exists inside it until somebody books; that is the
 *     whole appointments design (see CLAUDE.md, "Appointments (1:1) vs
 *     classes"). It is the answer to "when am I sellable", not to "what is on".
 *
 * The tempting split is the DOCUMENT TYPE — classes and appointments are both
 * `sessions/{id}` docs (`Activity.type` picks the scheduling mechanism,
 * `Session.activityType` carries it), events are their own primitive, bookable
 * hours are `availability/{id}`. That split puts Events in "Other" purely
 * because it is not a session doc, which is a fact about our storage and not
 * about the studio's week. Occurrence-vs-availability is the line a studio
 * would draw itself, and it is the one that decides where a FIFTH calendar
 * goes: ask whether the thing happens, not which collection it lives in.
 *
 * THE DEFAULT IS SECTION ONE, EXACTLY — and that is why it has a name ("Only
 * sessions & events") instead of a generic "reset". Classes, Appointments and
 * Events are on; **Bookable hours is off**, because published hours are a
 * MANAGEMENT view — not what a studio wants behind its week every morning, and
 * on a busy week several coaches' windows are the thing most likely to make the
 * grid unreadable. It is one click away and it is remembered, so a studio that
 * does want it every day pays that click exactly once.
 *
 * `DEFAULT_VISIBLE_CALENDARS` is therefore DERIVED from the section rather than
 * re-listed. Re-listing it would let the two drift, and the day they drift the
 * menu offers a named state that is no longer the state you land on.
 *
 * A CALENDAR IS NEVER A COUNT. Nothing here may feed a header figure: the "N
 * upcoming" in the Schedule header comes from `useUpcomingCount`, its own
 * server-side count over its own window, precisely so it cannot move when the
 * view moves (UX-20). Hiding one changes what is drawn and nothing else.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

/** OCCURRENCES — things that happen, at a time, that somebody could attend. */
const OCCURRENCE_CALENDARS = ['classes', 'appointments', 'events'] as const
/** AVAILABILITY — windows in which something COULD be booked. See the header. */
const AVAILABILITY_CALENDARS = ['bookableHours'] as const

// Composed from the sections, never listed twice: a calendar that is not in a
// section does not exist, so "which section does the new one go in" is not a
// question anybody can forget to answer. Declaration order is section order, so
// the menu, the trigger's list and the hidden-calendars notice all read in the
// same order without any of them sorting.
export const SCHEDULE_CALENDARS = [...OCCURRENCE_CALENDARS, ...AVAILABILITY_CALENDARS] as const
export type ScheduleCalendar = (typeof SCHEDULE_CALENDARS)[number]

export type CalendarSectionKey = 'sessionsAndEvents' | 'other'
export const CALENDAR_SECTIONS: readonly {
  key: CalendarSectionKey
  calendars: readonly ScheduleCalendar[]
}[] = [
  { key: 'sessionsAndEvents', calendars: OCCURRENCE_CALENDARS },
  { key: 'other', calendars: AVAILABILITY_CALENDARS },
]

/** See the header: the default IS section one, derived rather than re-listed. */
export const DEFAULT_VISIBLE_CALENDARS: readonly ScheduleCalendar[] = OCCURRENCE_CALENDARS

const STORAGE_KEY = 'linyup_schedule_calendars'

function isCalendar(v: unknown): v is ScheduleCalendar {
  return typeof v === 'string' && (SCHEDULE_CALENDARS as readonly string[]).includes(v)
}

/** `null` = never stored. An empty array is a real answer ("I hid everything"). */
function readStored(): ScheduleCalendar[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.filter(isCalendar)
  } catch {
    return null
  }
}

function persist(calendars: ScheduleCalendar[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(calendars))
  } catch {
    /* ignore (private mode, quota) */
  }
}

const sameSet = (a: readonly ScheduleCalendar[], b: readonly ScheduleCalendar[]) =>
  a.length === b.length && a.every((c) => b.includes(c))

export interface VisibleCalendarsValue {
  /** The calendars currently drawn. */
  visible: ReadonlySet<ScheduleCalendar>
  isVisible: (calendar: ScheduleCalendar) => boolean
  /** Show/hide one calendar. */
  toggle: (calendar: ScheduleCalendar) => void
  /** Named state: draw everything ("All calendars"). */
  showAll: () => void
  /** Named state: DEFAULT_VISIBLE_CALENDARS ("Only sessions & events"). */
  showOnlyDefault: () => void
  /** In declaration order, so a message listing them reads the same every time. */
  hidden: ScheduleCalendar[]
  allVisible: boolean
  isDefault: boolean
}

export function useVisibleCalendars(): VisibleCalendarsValue {
  // Starts at the default and hydrates after mount — localStorage does not exist
  // during SSR, and reading it in the initializer would hydrate-mismatch.
  const [calendars, setCalendars] = useState<ScheduleCalendar[]>(() => [
    ...DEFAULT_VISIBLE_CALENDARS,
  ])

  useEffect(() => {
    const stored = readStored()
    if (stored) setCalendars(stored)
  }, [])

  const write = useCallback((next: ScheduleCalendar[]) => {
    setCalendars(next)
    persist(next)
  }, [])

  const toggle = useCallback(
    (calendar: ScheduleCalendar) =>
      setCalendars((prev) => {
        const next = prev.includes(calendar)
          ? prev.filter((c) => c !== calendar)
          : SCHEDULE_CALENDARS.filter((c) => c === calendar || prev.includes(c))
        persist(next)
        return next
      }),
    []
  )

  const showAll = useCallback(() => write([...SCHEDULE_CALENDARS]), [write])
  const showOnlyDefault = useCallback(() => write([...DEFAULT_VISIBLE_CALENDARS]), [write])

  const visible = useMemo(() => new Set(calendars), [calendars])
  const isVisible = useCallback((calendar: ScheduleCalendar) => visible.has(calendar), [visible])
  const hidden = useMemo(
    () => SCHEDULE_CALENDARS.filter((c) => !visible.has(c)),
    [visible]
  )

  return {
    visible,
    isVisible,
    toggle,
    showAll,
    showOnlyDefault,
    hidden,
    allVisible: hidden.length === 0,
    isDefault: sameSet(calendars, DEFAULT_VISIBLE_CALENDARS),
  }
}
