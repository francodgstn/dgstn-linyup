import type { Timestamp } from './common'

export type ActivityEventType =
  | 'contact_add'
  | 'contact_archive'
  | 'contact_unarchive'
  // Roster ↔ external (Contact.external). Written by trackContacts beside the
  // archive pair — a lifecycle move, so it sits in the same `profile` feed.
  | 'contact_mark_external'
  | 'contact_unmark_external'
  | 'contact_delete'
  | 'contact_type_change'
  | 'acquisition_stage_change'
  | 'acquisition_stage_correction'
  | 'rank_change'
  | 'subscription_change'
  | 'session_participant_add'
  | 'session_participant_delete'
  | 'booking_created'
  | 'booking_confirmed'
  | 'booking_cancelled'
  | 'booking_rebooked'
  // Written by trackBookings when a booking flips to 'no_show' — the nightly
  // markNoShowBookings job is the only thing that sets that status today. It is
  // a booking event like the four above and belongs in the same filter; leaving
  // it out of this union made the rows render with the fallback icon and vanish
  // from the Bookings tab of a contact's activity.
  | 'booking_no_show'
  | 'contact_login'
  | 'outreach_email_sent'
  | 'contact_anonymized'
  // Consent. Written by `trackWaiverAcceptances`, the trigger on the append-only
  // acceptance ledger — ONE writer for every rail (booking, drop-in, appointment,
  // waitlist claim, signup, Space) plus the manager's revocation, because every
  // one of them lands a row in that collection and none of them writes here.
  // A signature and its withdrawal are facts about a PERSON, which is what this
  // feed is; the evidence itself stays in the ledger.
  | 'waiver_accepted'
  | 'waiver_revoked'
  // Coaching. A goal reached or given up on, and a step ticked off, are facts
  // about a person's practice and belong in the same feed as their bookings and
  // signatures — the evaluations themselves stay under the goal. Written by
  // `trackGoals`, the ONE trigger that also maintains the contact's coaching
  // counters, so a row and a counter can never disagree about what happened.
  | 'goal_achieved'
  | 'goal_abandoned'
  | 'goal_step_completed'
  // A check-in is the member's own report, and the only coaching event they
  // originate. Written by `trackPerformanceCheckins`.
  | 'performance_checkin'

export interface ActivityLogEntry {
  id: string
  event: ActivityEventType
  created_at: Timestamp
  parameters: {
    description: string
    [key: string]: unknown
  }
  refs: {
    contact?: string
    session?: string
    user: string  // teamId
  }
}

// Future analytics stream — NOT stored in Firestore long-term.
// Ship to Mixpanel / PostHog / Amplitude when a platform is chosen.
export interface AnalyticsEvent {
  name: string
  properties: Record<string, string | number | boolean | null>
}
