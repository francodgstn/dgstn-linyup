import type {
  ActivityDurationBenefit,
  ActivityMemberBenefit,
  Benefit,
  BookingContactField,
  DurationParty,
} from '@linyup/shared'

// THE SHAPE `listAvailability` ANSWERS IN.
//
// Availability is the ONLY source of bookable times for an appointment:
// nothing is pre-generated, because a start time is indeterminate until the
// visitor picks a length, and an appointment Session exists only once booked.
// Duration, name and pricing come from the linked Activity rather than from the
// window.
//
// THE PRICE IS THE GATE for appointments. There is no access rule any more (see
// `ActivityMemberBenefit`'s history note): an unpriced duration is free for
// anyone, a priced one is payable by anyone, and `memberBenefit` only ever
// lowers a signed-in member's price.
//
// These live here, beside the step that renders them, because the merged front
// door needs them as much as the appointment funnel does.

export interface AvailDuration {
  minutes: number
  priceAmount: number | null
  /** NOT SOLD INDIVIDUALLY (UX-70): bookable only through `memberBenefit`.
   *  Distinct from `priceAmount: null`, which means free for anyone. The two
   *  used to be the same value and the coach could express only one of them. */
  benefitOnly?: boolean
  /** A GROUP books this length and `priceAmount` is per person. Present only
   *  for a party the server honors. */
  party?: DurationParty
}

export interface AvailActivity {
  activityId: string
  activityName: string
  durations: AvailDuration[]
  /** How many dates one booking may take; absent means one. */
  maxDatesPerBooking?: number
  /** The activity-wide rule, the LEGACY reading, correct only while
   *  `durationBenefits` is absent. Never read either directly: the pair goes
   *  through `resolveDurationBenefit`, which is what makes a tenant mirrored
   *  before per-length rules existed keep quoting the same price. */
  memberBenefit: ActivityMemberBenefit | Benefit | null
  durationBenefits: ActivityDurationBenefit[] | null
  /** Per-activity override of the team's cancellation terms. Display-only;
   *  falls back to the team default. */
  cancellationPolicy: string | null
  /** The activity's own CONTACT fields, which EXTEND the team-wide list.
   *  Unlike the policy above this is not display-only: the same resolver runs
   *  on the server, so the guest step asks for exactly what will be accepted. */
  contactFields: BookingContactField[] | null
  /** WHERE. `listAvailability` returns one entry per (provider, activity,
   *  PLACE), so a coach teaching the same thing at two places arrives as two
   *  entries sharing an `activityId`. The place is what tells them apart, on
   *  the card and in the URL. Null for a schedule naming no tracked place. */
  placeId: string | null
  placeName: string | null
  /** The free-text note the studio typed on top of the place, never its name. */
  location: string | null
  onlineUrl: string | null
  days: { dayMs: number; slotsByDuration: Record<string, number[]> }[]
}

export interface AvailCoach {
  providerId: string
  providerName: string | null
  activities: AvailActivity[]
}
