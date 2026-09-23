// The ONE wire-contract type for the `listAvailability` callable
// (packages/functions/src/appointments/window.ts) — matching EXACTLY what it
// returns today. Both the web appointment picker
// (apps/web's AppointmentPicker.tsx, which hand-declared this shape locally as
// `AvailCoach`/`AvailActivity`/`AvailDuration` before this type existed — a
// future pass should import from here instead of re-declaring it) and the
// mobile app consume it; defining it once in `packages/shared` (client-safe,
// no admin-SDK imports) means both READ the same contract instead of two
// hand-mirrors silently drifting apart, the exact failure this lane exists to
// close for the rest of the member app's data.
//
// NO `accessRule` here — appointments dropped the access gate entirely; money
// (`durations` + `memberBenefit`) is the only gate. See the module header of
// `appointments/window.ts`.
import type { ActivityMemberBenefit, ActivityDurationBenefit } from './activity'
import type { Benefit } from './benefit'
import type { BookingContactField } from './team'

export interface ListAvailabilityDuration {
  minutes: number
  priceAmount: number | null
  /** NOT SOLD INDIVIDUALLY (UX-70) — bookable only through `memberBenefit`.
   *  Distinct from `priceAmount: null`, which means free for anyone. */
  benefitOnly?: boolean
}

export interface ListAvailabilityDay {
  dayMs: number
  /** Keyed by duration minutes as a string (Firestore/JSON object key). */
  slotsByDuration: Record<string, number[]>
}

export interface ListAvailabilityActivity {
  activityId: string
  activityName: string
  durations: ListAvailabilityDuration[]
  memberBenefit: ActivityMemberBenefit | Benefit | null
  /** Per-duration member benefits (the per-length pricing that landed on
   *  main while this type was being introduced) — verbatim from the activity,
   *  null when the activity has none; the picker mirrors the resolver for
   *  display and the server re-resolves at booking. */
  durationBenefits: ActivityDurationBenefit[] | null
  /** Per-activity override of the team's cancellation terms. Display-only;
   *  falls back to the team default (TeamPublicProfile.bookingCancellationPolicy). */
  cancellationPolicy: string | null
  /** The activity's own CONTACT fields, extending the team-wide list — the
   *  same resolver runs server-side at booking, so this is not display-only. */
  contactFields: BookingContactField[] | null
  /** WHERE. One entry per (provider, activity, PLACE) — see the grouping note
   *  in `appointments/window.ts`. Null for a schedule that names no tracked
   *  place (legacy docs carry only the free-text `location`). */
  placeId: string | null
  /** The place's own name, resolved server-side so every client labels the
   *  same calendar the same way. Null when `placeId` is. */
  placeName: string | null
  /** The free-text note the studio typed ON TOP of the place ("Meet at the 50m
   *  hall"), never the place's name. */
  location: string | null
  onlineUrl: string | null
  days: ListAvailabilityDay[]
}

export interface ListAvailabilityCoach {
  providerId: string
  providerName: string | null
  activities: ListAvailabilityActivity[]
}

export interface ListAvailabilityResult {
  coaches: ListAvailabilityCoach[]
  /**
   * The studio cannot be paid ONLINE, so a priced length is booked here and
   * settled at the door.
   *
   * A TEAM-level fact, not a per-duration one, and computed on the server
   * (`appointments/window.ts`) rather than in each client so the web picker and
   * the member app cannot disagree about which door a price opens.
   *
   * It exists because the fail-closed reading DROPPED a priced duration when the
   * studio had no chargeable Connect account, and a visitor who reached one
   * anyway was told "This slot is no longer available" — false, and it cost the
   * studio the appointment. The length stays on the menu; this says where the
   * money changes hands (Franco, 2026-08-28).
   */
  settleAtStudio: boolean
}
