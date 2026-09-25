import {
  resolveDurationBenefit,
  type ActivityMemberBenefit,
  type Benefit,
  type BookingContactField,
  type DurationParty,
} from '@linyup/shared'
import type { AvailActivity, AvailCoach } from '@/components/booking/when/availability'

// WHAT A PICKED TIME CARRIES into the booking step. Denormalised from the
// availability the visitor just chose from, so the screen that commits can
// price, name and locate what it is taking without going back for it.
//
// Pricing here is DISPLAY and ROUTING only: `bookAppointment` and
// `createAppointmentCheckout` re-resolve server side, always.
//
// It moved out of the appointment route when the funnels merged, because the
// merged funnel builds one too.

export interface WindowBooking {
  providerId: string
  providerName: string | null
  activityId: string
  activityName: string
  startMs: number
  /** Every date booked, soonest first; `[startMs]` for one date. A basket has
   *  one provider, one length and one party, so only the starts differ. */
  startMsList: number[]
  durationMinutes: number
  placeName: string | null
  location: string | null
  onlineUrl: string | null
  priceAmount: number | null
  benefitOnly: boolean
  /** The chosen length's group bounds; `priceAmount` is then per person. */
  party: DurationParty | null
  memberBenefit: ActivityMemberBenefit | Benefit | null
  /** Carried to the booking step so the terms are on the screen that commits. */
  cancellationPolicy: string | null
  contactFields: BookingContactField[] | null
}

/**
 * A booking is identified by exactly four fields — provider, activity, start,
 * duration (the same key `SlotBookingForm` uses). Everything else on
 * `WindowBooking` is denormalized from the loaded availability, so the object is
 * always rebuildable and never needs serializing into the URL.
 */
export function buildWindowBooking(
  coach: AvailCoach,
  activity: AvailActivity,
  startMs: number,
  durationMinutes: number,
  /** A basket's dates; one date when absent. */
  startMsList?: number[]
): WindowBooking {
  const dates = [...new Set(startMsList?.length ? startMsList : [startMs])].sort((a, b) => a - b)
  const chosen =
    activity.durations.find((d) => d.minutes === durationMinutes) ?? activity.durations[0] ?? null
  return {
    providerId: coach.providerId,
    providerName: coach.providerName,
    activityId: activity.activityId,
    activityName: activity.activityName,
    startMs: dates[0],
    startMsList: dates,
    durationMinutes: chosen?.minutes ?? durationMinutes,
    placeName: activity.placeName,
    location: activity.location,
    onlineUrl: activity.onlineUrl,
    priceAmount: chosen?.priceAmount ?? null,
    benefitOnly: chosen?.benefitOnly === true,
    party: chosen?.party ?? null,
    // THE ONE READER, resolved for the CHOSEN length. Everything downstream —
    // the quote, the "sign in for the member price" line, the checkout — reads
    // this single already-resolved value, so no surface below can pick a
    // different length's rule than the one being booked.
    memberBenefit: resolveDurationBenefit(
      activity,
      chosen?.minutes ?? durationMinutes
    ),
    cancellationPolicy: activity.cancellationPolicy,
    contactFields: activity.contactFields,
  }
}
