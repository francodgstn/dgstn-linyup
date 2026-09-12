// Pure mapping from a `teams/{teamId}/public_profile/{teamId}` document (the
// ONE world-readable mirror a contact session may read — see firestore.rules)
// to the app's `TeamPublicProfile` view. Kept pure and Firestore-free so it is
// unit-testable without an emulator; `FirestoreService.getTeamPublicProfile`
// is the only caller.
//
// Every field this app renders anywhere (AffiliationCard, TeamCard,
// GoalsSection, PerformanceProfileSection, BadgesCard, SocialActionsCard, the
// Team tab's coaches/links sections) must be mapped here — a field
// dropped here is a silent regression identical to the ones this lane exists
// to close (see docs/mobile-roadmap-2026-09.md §1.3).
import { withRankLevelIds } from '@linyup/shared';
import type { TeamPublicProfile } from '../types';

export function mapPublicProfileMirror(teamId: string, data: Record<string, unknown>): TeamPublicProfile {
  return {
    id: teamId,
    name: (data.name as string) || '',
    description: data.description as string | undefined,
    slug: data.slug as string,
    org_id: data.org_id as string | null | undefined,
    language: data.language as TeamPublicProfile['language'],
    links: (data.links as TeamPublicProfile['links']) || [],
    socialLinks: (data.socialLinks as TeamPublicProfile['socialLinks']) || [],
    profileImage: data.profileImage as string | undefined,
    heroImage: data.heroImage as string | undefined,
    bioLinkThemePreset: data.bioLinkThemePreset as TeamPublicProfile['bioLinkThemePreset'],
    bioLinkAccentColor: data.bioLinkAccentColor as string | undefined,
    bioLinkBackground: data.bioLinkBackground as TeamPublicProfile['bioLinkBackground'],
    coaches: data.coaches as TeamPublicProfile['coaches'],
    payments_enabled: data.payments_enabled as boolean | undefined,
    // The team's coaching / gamification / ranking configuration — mirrored
    // here specifically so a contact session (which cannot read `teams/{id}`
    // or `organizations/{id}`) still sees the studio's own customisation
    // instead of silently falling back to defaults everywhere.
    performance_indicators: data.performance_indicators as TeamPublicProfile['performance_indicators'],
    goal_categories: data.goal_categories as TeamPublicProfile['goal_categories'],
    gamificationEnabled: data.gamificationEnabled as boolean | undefined,
    gamification_settings: data.gamification_settings as TeamPublicProfile['gamification_settings'],
    // Every level with an id (docs/rank-scale-decoupling.md) — the same
    // deterministic slug the web resolver and the backfill mint, so a mirror
    // written before the ids existed still resolves a member's belt.
    ranking_systems: ((data.ranking_systems as TeamPublicProfile['ranking_systems']) || []).map((s) => ({
      ...s,
      levels: withRankLevelIds(s.levels ?? []),
    })),
    affiliation_term: data.affiliation_term as TeamPublicProfile['affiliation_term'],
    // BOTH HALVES, composed here once — this flag says the appointments UI is
    // worth PROMOTING, not that a toggle is on. It gates invitations to book
    // (the dashboard card, the "book new" entry point); a member's own booked
    // appointments are a record and are never hidden behind it.
    //
    // The studio's toggle lives in bookingSettings (written by the admin
    // Settings → Booking page) and ABSENT MEANS ON, so on its own it is true
    // for every studio that never opened that page. The content half is
    // `active_public_surfaces.appointments`, computed server-side from the
    // same inputs listAvailability reads, and it fails closed. Without it the
    // dashboard promo card — which does not fetch availability itself — would
    // invite every member of every studio to book a coach who has published
    // none. This is the composition `appointmentPickerLive` performs on the web.
    appointmentsEnabled:
      (data.bookingSettings as { appointmentsEnabled?: boolean } | undefined)?.appointmentsEnabled !== false &&
      (data.active_public_surfaces as { appointments?: boolean } | undefined)?.appointments === true,
    // Real field, written by syncTeamPublicProfile from
    // settings.referral.enabled — not yet declared on the shared type (see
    // types/index.ts's TeamPublicProfile extension for why this is here).
    referralEnabled: (data as { referralEnabled?: boolean }).referralEnabled ?? false,
  } as TeamPublicProfile;
}
