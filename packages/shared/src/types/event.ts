import type { Timestamp } from './common'
import type { RankRef } from './team'

// Built-in event types — hardcoded, always available.
//
// `other` IS THE CATCH-ALL, and it exists because there was nowhere else to
// put a thing. Custom event types are TEAM-scoped
// (`teams/{teamId}/event_types`, and nothing reads an org-level one), so an
// organisation running an AGM, an open day or a demo night could not name it:
// the only honest-looking slot was `seminar`, which asserts that training
// happened.
//
// It counts toward NOTHING, and that is the point. A catch-all that satisfied
// a grading requirement would hand one out every time somebody reached for it
// because none of the other words fit — silently, and to everyone who
// attended. `seminar` and `workshop` count toward nothing for the same reason;
// `other` differs only in making no claim at all about the event.
export type BuiltinEventType =
  | 'competition'
  | 'camp'
  | 'exam'
  | 'seminar'
  | 'workshop'
  | 'other'
export const BUILTIN_EVENT_TYPES: BuiltinEventType[] = [
  'competition',
  'camp',
  'exam',
  'seminar',
  'workshop',
  'other',
]

// EventType is open: built-in slug OR a custom event_type_id (e.g. 'fighting_cup' from plugin)
export type EventType = BuiltinEventType | string
export type EventStatus = 'open' | 'restricted' | 'closed' | 'cancelled'

export interface Event {
  id: string
  teamId?: string              // null for org-wide events
  orgId?: string               // set for org-wide events
  scope?: 'team' | 'org'      // defaults to 'team' when absent
  title: string
  type: EventType              // built-in slug or custom/plugin type ID
  start: Timestamp
  end: Timestamp
  location?: string
  // Optional link to a Place + Room (team or org place); `location` kept as fallback.
  placeId?: string
  roomId?: string
  description?: string
  fee?: number
  status?: EventStatus
  participants_count?: number
  completed_checkins_count?: number
  attendees_count?: number
  invitations_sent_count?: number
  last_invitation_sent_at?: Timestamp
  coachId?: string | null
  coachName?: string | null
  // The event's agenda — see "event program" below. Absent until the studio
  // builds one; an event without a program behaves exactly as it does today.
  program?: EventProgramConfig
  // Events are PRIVATE by default. An event only becomes world-readable when the
  // studio explicitly publishes it — this gates syncEventPublicProfile.
  publicVisibility?: 'hidden' | 'public'
  created_at?: Timestamp
  createdBy?: string
  deleted_at?: Timestamp | null
}

// ─── event program (the agenda) ───────────────────────────────────────────────
// The program is what distinguishes an event from a session: a multi-day,
// multi-track schedule of what happens, where, and with whom.
//
// TIMES ARE WALL-CLOCK AT THE VENUE ('HH:MM' plus the day's calendar date),
// never absolute Timestamps. A program is a printed schedule — "09:00
// breakfast" is 09:00 wherever the camp is. This sidesteps DST entirely and
// lets an event run abroad without the whole agenda shifting. Same convention
// as `availability.ts`. `timezoneLabel` is DISPLAY ONLY — nothing converts.
//
// Days and tracks are few, so they live in an embedded object on the event doc
// (the `Place.rooms` / `Form.fields` precedent). Items can run to hundreds, so
// they get their own subcollection: events/{eventId}/program_items/{itemId}.

/** A parallel stream within the program — "Kids", "Adults", "Mat A", "Room 1". */
export interface ProgramTrack {
  id: string
  name: string
  color?: string
  order: number
}

/** One calendar day of the program. */
export interface ProgramDay {
  id: string
  date: string // 'YYYY-MM-DD' — the venue's calendar date
  title?: string // "Day 1 — Arrival"
  subtitle?: string
  order: number
}

export interface EventProgramConfig {
  days: ProgramDay[]
  tracks: ProgramTrack[]
  /** Display-only label, e.g. 'Europe/Madrid'. Nothing converts times. */
  timezoneLabel?: string
  /** Free note rendered above the agenda. */
  note?: string
}

export type ProgramItemKind =
  | 'activity'
  | 'meal'
  | 'break'
  | 'transfer'
  | 'ceremony'
  | 'briefing'
  | 'free'
  | 'other'

export const PROGRAM_ITEM_KINDS: ProgramItemKind[] = [
  'activity', 'meal', 'break', 'transfer', 'ceremony', 'briefing', 'free', 'other',
]

/** events/{eventId}/program_items/{itemId} */
export interface EventProgramItem {
  id: string
  eventId: string
  // Tenant fields are DENORMALISED onto every item so security rules never need
  // get(parent) and so org-scoped events work (their parent's teamId is null).
  teamId?: string
  orgId?: string
  scope?: 'team' | 'org'

  dayId: string // → EventProgramConfig.days[].id
  /** null/absent = plenary: the item spans every track. */
  trackId?: string | null

  startTime: string // 'HH:MM' wall clock
  endTime?: string // 'HH:MM'; earlier than startTime means it crosses midnight
  allDay?: boolean // sorts before timed items

  title: string
  subtitle?: string
  description?: string
  /** Free text — an event is often off-site ("Beach", "Hotel Aurora"). */
  locationText?: string
  /** Free text — guests and externals are not team_members ("Coach Marta"). */
  peopleText?: string
  kind?: ProgramItemKind
  color?: string
  isHighlight?: boolean
  /** Staff-only. NEVER mirrored to the public profile. */
  internalNote?: string

  /** Tie-break for items sharing a startTime. Times drive the ordering. */
  order: number
  created_at?: Timestamp
  updated_at?: Timestamp
  createdBy?: string
}

// Keeps the public mirror doc (which embeds the whole program) safely under
// Firestore's 1 MB limit — ~300 items ≈ 120 KB.
export const MAX_PROGRAM_ITEMS = 300

// ─── program templates ────────────────────────────────────────────────────────
// A reusable program, stored WHOLE in one document (always read and written as a
// unit, like Form.fields). Template items are keyed by a relative `dayIndex`,
// never a dayId or a calendar date — that is what makes a template portable to
// any future event.
//
// Storage:
//   • team templates → teams/{teamId}/program_templates/{id}          (scope: 'team')
//   • org templates  → organizations/{orgId}/org_program_templates/{id} (scope: 'org')
// Org templates are a read-only shared resource every member studio can apply —
// the same model as org places (see place.ts).

export interface ProgramTemplateDay {
  dayIndex: number // 0-based offset from the event's first program day
  title?: string
  subtitle?: string
}

export interface ProgramTemplateItem {
  dayIndex: number
  trackId?: string | null // → ProgramTemplate.tracks[].id, or null for plenary
  startTime: string
  endTime?: string
  allDay?: boolean
  title: string
  subtitle?: string
  description?: string
  locationText?: string
  peopleText?: string
  kind?: ProgramItemKind
  color?: string
  isHighlight?: boolean
  internalNote?: string // kept — templates are never public
  order: number
}

export interface ProgramTemplate {
  id: string
  scope: 'team' | 'org'
  teamId?: string // set for team templates
  orgId?: string // set for org templates
  name: string
  description?: string
  timezoneLabel?: string
  note?: string
  tracks: ProgramTrack[]
  days: ProgramTemplateDay[]
  items: ProgramTemplateItem[]
  itemCount?: number
  created_at?: Timestamp
  updated_at?: Timestamp
  createdBy?: string
}

/** Flat safeguard cap — same for every plan (applies per team and per org). */
export const MAX_PROGRAM_TEMPLATES = 25

// ─── public mirror ────────────────────────────────────────────────────────────
// events/{eventId}/public_profile/{eventId}, written by syncEventPublicProfile.
// World-readable, so it carries ONLY what a public page may show — note the
// absence of `internalNote` on the items.

export interface PublicProgramItem {
  id: string
  dayId: string
  trackId: string | null
  startTime: string
  endTime: string | null
  allDay: boolean
  title: string
  subtitle: string | null
  description: string | null
  locationText: string | null
  peopleText: string | null
  kind: ProgramItemKind | null
  color: string | null
  isHighlight: boolean
  order: number
}

export interface EventPublicProfile {
  type: 'event'
  /** Null for an org-scoped event. */
  teamId: string | null
  /** Null for a team-scoped event. */
  orgId: string | null
  scope: 'team' | 'org'
  title: string
  eventType: string | null
  start: Timestamp | null
  end: Timestamp | null
  status: EventStatus
  location: string | null
  description: string | null
  coachName: string | null
  program: {
    days: ProgramDay[]
    tracks: ProgramTrack[]
    timezoneLabel: string | null
    note: string | null
  } | null
  programItems: PublicProgramItem[]
  programItemCount: number
}

// ─── configurable event type (teams/{teamId}/event_types/{typeId}) ─────────────

export type EventTypeFieldType = 'text' | 'number' | 'select' | 'multiselect' | 'boolean'

export interface EventTypeField {
  key: string
  label: string
  type: EventTypeFieldType
  options?: string[]    // for select / multiselect
  required?: boolean
  placeholder?: string
}

export interface EventTypeConfig {
  id: string
  name: string
  icon?: string                // lucide icon name
  color?: string
  source: 'team' | 'org' | 'plugin'
  plugin_id?: string           // set when source === 'plugin'
  checkin_fields?: EventTypeField[]
  created_at?: Timestamp
  created_by?: string
}

// ─── check-in document (/checkins/{checkinId}) ─────────────────────────────────

export interface EventCheckin {
  id: string
  teamId: string
  event: { id: string; title?: string; type?: string }
  contact: { id: string; firstname: string; lastname: string }
  is_completed: boolean
  checkin_data?: Record<string, unknown>   // type-specific payload (see below)
  checked_in_by?: string                   // uid of manager
  created_at?: Timestamp
  updated_at?: Timestamp
}

// checkin_data shapes per built-in type:
//   camp:         { join_as: 'participant' | 'staff' | 'coach' | 'volunteer' }
//   exam:         { disciplines: { [rankingSystemId: string]: number } }
//   fighting_cup: { categories: string[]; weight?: number }
//   others:       {}

// ─── per-event category (events/{eventId}/categories/{catId}) ─────────────────
// Used by the fighting_cup plugin and any plugin/type that declares hasCategories

export interface EventCategory {
  id: string
  name: string
  color?: string
  gender?: 'M' | 'F' | 'both'
  min_age?: number
  max_age?: number
  min_weight?: number
  max_weight?: number
  ranking_system_id?: string   // link to team ranking system for rank-based filtering
  /** Bounds on that ladder, inclusive, as `RankRef`s — a level id, or a legacy
   *  number on a category `backfill:rank-refs` has not reached. Compared by
   *  ladder POSITION, never as numbers (see the cup check-in form). */
  min_rank?: RankRef
  max_rank?: RankRef
  sort_order?: number
}
