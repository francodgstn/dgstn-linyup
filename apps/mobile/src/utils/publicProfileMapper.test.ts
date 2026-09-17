import { mapPublicProfileMirror } from './publicProfileMapper';

describe('mapPublicProfileMirror', () => {
  const raw = {
    name: 'Studio X',
    description: 'A great studio',
    slug: 'studio-x',
    org_id: 'org-1',
    language: 'en',
    links: [{ label: 'Book', target: 'booking', showInBioLink: true }],
    socialLinks: [{ platform: 'instagram', url: 'https://instagram.com/studiox' }],
    profileImage: 'https://example.com/logo.png',
    heroImage: 'https://example.com/hero.png',
    bioLinkThemePreset: 'sunrise',
    bioLinkAccentColor: '#7C3AED',
    bioLinkBackground: { type: 'solid', color: '#fff' },
    coaches: [{ uid: 'coach-1', name: 'Alex' }],
    payments_enabled: true,
    whatsapp_opt_in_offered: true,
    performance_indicators: [{ key: 'effort', label: 'Effort' }],
    goal_categories: [{ key: 'technique', label: 'Technique' }],
    gamificationEnabled: true,
    gamification_settings: { badge_thresholds: undefined, coach_badges: [] },
    ranking_systems: [{ id: 'default', name: 'Default', levels: [] }],
    affiliation_term: { en: 'Membership', de: 'Mitgliedschaft' },
    bookingSettings: { appointmentsEnabled: true },
    active_public_surfaces: { appointments: true },
    referralEnabled: true,
  };

  it('maps every field this app reads — no field is dropped', () => {
    const result = mapPublicProfileMirror('team-1', raw);

    expect(result).toMatchObject({
      id: 'team-1',
      name: 'Studio X',
      description: 'A great studio',
      slug: 'studio-x',
      org_id: 'org-1',
      language: 'en',
      links: raw.links,
      socialLinks: raw.socialLinks,
      profileImage: raw.profileImage,
      heroImage: raw.heroImage,
      bioLinkThemePreset: raw.bioLinkThemePreset,
      bioLinkAccentColor: raw.bioLinkAccentColor,
      bioLinkBackground: raw.bioLinkBackground,
      coaches: raw.coaches,
      payments_enabled: true,
      whatsapp_opt_in_offered: true,
      performance_indicators: raw.performance_indicators,
      goal_categories: raw.goal_categories,
      gamificationEnabled: true,
      gamification_settings: raw.gamification_settings,
      ranking_systems: raw.ranking_systems,
      affiliation_term: raw.affiliation_term,
      referralEnabled: true,
    });
  });

  it('composes appointmentsEnabled from BOTH halves (studio toggle AND server content flag)', () => {
    expect(
      mapPublicProfileMirror('t', {
        ...raw,
        bookingSettings: { appointmentsEnabled: true },
        active_public_surfaces: { appointments: true },
      }).appointmentsEnabled
    ).toBe(true);

    // Studio toggle off -> false even if the server thinks there's content.
    expect(
      mapPublicProfileMirror('t', {
        ...raw,
        bookingSettings: { appointmentsEnabled: false },
        active_public_surfaces: { appointments: true },
      }).appointmentsEnabled
    ).toBe(false);

    // No published availability -> false even with the toggle on.
    expect(
      mapPublicProfileMirror('t', {
        ...raw,
        bookingSettings: { appointmentsEnabled: true },
        active_public_surfaces: { appointments: false },
      }).appointmentsEnabled
    ).toBe(false);

    // ABSENT MEANS ON for the studio toggle (a studio that never opened
    // Settings → Booking) — only the content half then decides.
    expect(
      mapPublicProfileMirror('t', {
        ...raw,
        bookingSettings: {},
        active_public_surfaces: { appointments: true },
      }).appointmentsEnabled
    ).toBe(true);
  });

  it('defaults ranking_systems and links to empty arrays, never undefined', () => {
    const result = mapPublicProfileMirror('team-1', { name: 'Bare Studio', slug: 'bare' });
    expect(result.ranking_systems).toEqual([]);
    expect(result.links).toEqual([]);
    expect(result.socialLinks).toEqual([]);
    expect(result.referralEnabled).toBe(false);
    expect(result.appointmentsEnabled).toBe(false);
  });
});
