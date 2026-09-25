import type { Timestamp } from './common'

export interface AvailabilityRecurrence {
  daysOfWeek: number[]  // 0 = Sun … 6 = Sat
  /** The window/times are live only within these dates. */
  startDate: Timestamp
  endDate?: Timestamp | null
}

/** Provider time-off that OVERRIDES the availability templates: the provider is
 *  unavailable in [start, end) even if a template would otherwise offer that
 *  time. Used for one-off exceptions — "this slot", "this day", "this week" —
 *  without editing the recurring schedule. `listAvailability` subtracts these
 *  (they act as extra busy intervals), and the public booking path refuses a
 *  start that falls inside one. Stored at `availability_exceptions/{id}`. */
export interface AvailabilityException {
  teamId: string
  /** UID of the provider who is unavailable. */
  providerId: string
  providerName?: string
  /** Unavailable window — inclusive start, exclusive end. */
  start: Timestamp
  end: Timestamp
  /** Optional reason shown in the manager (never public). */
  note?: string
  created_at: Timestamp
  createdBy: string
}

/** How a provider advertises free time. BOTH modes are lazy — no Session is ever
 *  pre-generated; one is created (overlap-safe) only when a client books.
 *  - 'range': a daily time range the client self-books within (Calendly-style),
 *    stepped by `granularityMinutes`.
 *  - 'times': an explicit list of start times per day.
 *  Which *durations* are offered (and at what price) is NOT stored here — it
 *  derives from the linked activities' `durations` (see `activityIds`). */
export type AvailabilityMode = 'range' | 'times'

/** Daily bookable time range ('range' mode), Europe/Zurich, 'HH:MM'. */
export interface AvailabilityWindow {
  start: string
  end: string
}

/** A provider's published free time — the *when*, and only the when.
 *
 *  The *what* lives on the linked activities (`activityIds`): they own the name,
 *  duration, capacity, price and access rule. A materialized appointment session
 *  inherits `activityId`/`activityName`/`accessRule`/`max_participants` from the
 *  activity the client picked, which is what makes appointments listable on the
 *  website and gateable by subscription — exactly like classes.
 *
 *  NOTE: because one availability may offer several activities of differing
 *  lengths, a start time is *indeterminate* until the client picks an activity —
 *  which is why availability can never be pre-materialized into slots. */
export interface Availability {
  teamId: string
  /** UID of the provider whose time this availability publishes. */
  providerId: string
  /** Denormalised provider display name. */
  providerName: string
  /** The SCHEDULE's admin-facing name — e.g. "Saturday mornings", "Weekday
   *  evenings". NOT the name of the offering (that's the activity's). */
  title: string
  description?: string
  /** The `type: 'appointment'` activities bookable within this availability.
   *  At least one; class activities are not linkable. */
  activityIds: string[]
  location?: string
  // Optional link to a Place + Room (team or org place) — same split as
  // Session: `location` is kept as a free-text fallback/note (online, ad-hoc,
  // or a detail on top of the place) and for display on legacy docs that only
  // ever carried it.
  placeId?: string
  roomId?: string
  onlineUrl?: string
  recurrence: AvailabilityRecurrence
  status: 'active' | 'paused' | 'archived'
  mode: AvailabilityMode
  /** 'range' mode: the daily bookable range clients pick a start within. */
  window?: AvailabilityWindow
  /** 'range' mode: step between selectable start times (minutes), provider-set. */
  granularityMinutes?: number
  /** 'times' mode: explicit start times ('HH:MM', Europe/Zurich). */
  times?: string[]
  /** Gap enforced before/after each appointment (minutes). Default 0. */
  bufferMinutes?: number
  created_at?: Timestamp
  updated_at?: Timestamp
  createdBy: string
}

// CoachSlot has been merged into Session (packages/shared/src/types/session.ts).
// Use Session with activityType === 'appointment' for appointment sessions.

export interface AppointmentBooking {
  slotId: string
  teamId: string
  firstname: string
  lastname: string
  fullname: string
  email: string
  phone?: string | null
  cancel_token: string
  status: 'confirmed' | 'cancelled'
  booked_at?: Timestamp
  cancelled_at?: Timestamp | null
  notes?: string
}
