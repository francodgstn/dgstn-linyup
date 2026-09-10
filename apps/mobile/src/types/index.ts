// Types shared with the rest of the platform now come from @linyup/shared —
// the ONE owner of these shapes (see packages/shared/src/index.ts). Only
// genuinely mobile-local view/wire types are declared in this file. If a type
// drifts between here and @linyup/shared, fix it there; this file must never
// hand-mirror a shape @linyup/shared already owns.
import type { Contact as SharedContact, TeamPublicProfile as SharedTeamPublicProfile, TeamLeaderboard } from '@linyup/shared';

export type {
  // Contact + its sub-shapes
  ContactAddress,
  EmergencyContact,
  ActiveSubscriptionSummary,
  SubscriptionRollupStatus,
  MobileAppTelemetry,
  AffiliationSummary,
  // Contact alerts
  AlertScheduleType,
  ContactAlert,
  // Coaching contract (goals / evaluations / check-ins)
  GoalType,
  GoalStatus,
  GoalCreatedBy,
  Goal,
  GoalEvaluation,
  PerformanceIndicator,
  PerformanceContext,
  PerformanceCheckin,
  ProfileKey,
  ProfileResult,
  // Ranking systems (belts/ranks — tenant-configured, not sport-specific)
  RankLevel,
  RankingSystem,
  // Gamification
  GamificationSettings,
  GamificationBadgeThresholds,
  GamificationCoachBadge,
  LeaderboardEntry,
  // Bio-link / public profile building blocks
  TeamLink,
  SocialLink,
  SystemLinkTarget,
  // Appointment availability — the ONE owner of the listAvailability payload
  ListAvailabilityResult,
  ListAvailabilityCoach,
  ListAvailabilityActivity,
  ListAvailabilityDuration,
  ListAvailabilityDay,
  // The member's own bookings (getMyBookings)
  MyBooking,
  MyBookingKind,
  MyBookingsResult,
  BookingCancelEffect,
} from '@linyup/shared';

// ─── Contact ────────────────────────────────────────────────────────────────
// The shared shape directly — no mobile hand-mirror. The pre-migration
// mismatches (residence vs address, a single emergencyContact vs
// emergency_contacts[], taxnumber, membership_status, a scalar rank) are gone;
// the UI reads the shared field names now.
export type Contact = SharedContact;

// ─── Team public profile ─────────────────────────────────────────────────────
// The shared shape, extended with the two fields real `public_profile` docs
// carry that @linyup/shared has not caught up to declaring yet:
//  - `referralEnabled` — written by syncTeamPublicProfile from
//    `settings.referral.enabled` (packages/functions/src/sync/syncTeamPublicProfile.ts)
//  - `appointmentsEnabled` — composed CLIENT-SIDE by
//    FirestoreService.getTeamPublicProfile (bookingSettings.appointmentsEnabled
//    !== false && active_public_surfaces.appointments === true); never stored
//    under this name.
// Fix upstream in @linyup/shared when convenient — this is the honest shape
// until then, not a fork of it.
export interface TeamPublicProfile extends SharedTeamPublicProfile {
  /** The team id — the mirror document's OWN id is its parent's, never part
   *  of the document body; `FirestoreService` attaches it from the doc path
   *  (mapPublicProfileMirror) so callers can key off it without a second read. */
  id: string;
  referralEnabled?: boolean;
  appointmentsEnabled?: boolean;
}

// ─── Mobile-local wire/view types ────────────────────────────────────────────
// Genuinely mobile-only shapes with no shared owner.

export interface ReferralInfo {
  code: string;
  referralUrl: string;
}

export interface WeeklyReport {
  id: string;
  iso_week: string;
  sessions_count: number;
}

export type SessionParticipationStatus = 'attended' | 'not attended' | 'booked' | 'book';

/** One entry of the team's public session-mirror collection group
 *  (`teams|organizations/{id}/sessions/{id}/public_profile/{id}`), filtered on
 *  `type == 'session'` — see syncSessionPublicProfile.ts. `location` is the
 *  ONLY location field the mirror carries (no `locationAddress`/`locationMapsUrl`
 *  — nothing writes those).
 *
 *  DELIBERATELY NOT NAMED `SessionPublicProfile`. That name belongs to the WIRE
 *  shape in @linyup/shared (`start`/`end` as Timestamps, no `id`); this is what
 *  `mapSessionPublicProfile` produces from it — Dates, plus the doc id — and
 *  the two shared one name for long enough that it was recorded as a hazard in
 *  docs/scalability-2026-09.md. If you find yourself wanting the shared type
 *  here, you want the mapper's input, not its output. */
export interface HydratedSession {
  id: string;
  activityId?: string;
  activityName?: string;
  teamId: string;
  start: Date;
  end: Date;
  location?: string | null;
  providerName?: string;
  allowBooking?: boolean;
}

export interface SessionWithStatus extends HydratedSession {
  status: SessionParticipationStatus;
}

/** The shared `TeamLeaderboard` document as `FirestoreService.getTeamLeaderboard`
 *  hands it out — `updated_at` hydrated to a Date. Same relationship as
 *  `HydratedSession` to the session mirror: the rows are the wire shape
 *  (`LeaderboardEntry`, re-exported above), the envelope is not. */
export interface Leaderboard extends Omit<TeamLeaderboard, 'updated_at' | 'score_history'> {
  updated_at: Date;
}

// ── Appointments (member's own bookings + view model for the carousel) ──────
// Appointments are Sessions with activityType === 'appointment'. The member's
// own upcoming ones are read through `getMyBookings` (never a root `sessions`
// query — see FirestoreService.getUpcomingAppointments), so this view model is
// derived from a `MyBooking` (kind: 'appointment') rather than from a raw
// session document.

export type AppointmentBookingStatus = 'booked' | 'cancelled';

export interface AppointmentWithStatus {
  /** The session id — `MyBooking.sessionId`. */
  id: string;
  providerName: string | null;
  activityName: string | null;
  start: Date;
  end: Date;
  location: string | null;
  bookingStatus: AppointmentBookingStatus;
  /** `cancelBooking`'s token for this booking — present only when `cancellable`. */
  cancelToken: string | null;
  cancellable: boolean;
}
