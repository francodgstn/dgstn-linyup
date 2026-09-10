import { resolveAffiliationTerm, resolveSubscriptionTypeName, resolvePrimaryRank, formatAddress } from './profileUtils';

describe('resolveAffiliationTerm', () => {
  const term = { en: 'Membership', de: 'Mitgliedschaft', fr: 'Adhésion' };

  it('picks the term for the device locale', () => {
    expect(resolveAffiliationTerm(term, 'de-CH')).toBe('Mitgliedschaft');
    expect(resolveAffiliationTerm(term, 'fr-FR')).toBe('Adhésion');
  });

  it('falls back to English when the locale has no translation', () => {
    expect(resolveAffiliationTerm(term, 'it-IT')).toBe('Membership');
  });

  it('falls back to the generic "Affiliation" when no term is configured at all', () => {
    expect(resolveAffiliationTerm(null, 'de-CH')).toBe('Affiliation');
    expect(resolveAffiliationTerm(undefined, 'de-CH')).toBe('Affiliation');
    expect(resolveAffiliationTerm({}, 'de-CH')).toBe('Affiliation');
  });
});

describe('resolveSubscriptionTypeName', () => {
  it('prefers the active_subscriptions entry matching subscription_type_id', () => {
    const name = resolveSubscriptionTypeName({
      subscription_type_id: 'type-2',
      subscription_type_name: 'stale single-field snapshot',
      active_subscriptions: [
        { subscription_type_id: 'type-1', subscription_type_name: 'Type One' } as any,
        { subscription_type_id: 'type-2', subscription_type_name: 'Type Two' } as any,
      ],
    });
    expect(name).toBe('Type Two');
  });

  it('falls back to the first active subscription when subscription_type_id does not match', () => {
    const name = resolveSubscriptionTypeName({
      active_subscriptions: [{ subscription_type_id: 'type-1', subscription_type_name: 'Type One' } as any],
    });
    expect(name).toBe('Type One');
  });

  it('falls back to the single-field snapshot when there is no active_subscriptions array', () => {
    const name = resolveSubscriptionTypeName({ subscription_type_name: 'Legacy Plan' });
    expect(name).toBe('Legacy Plan');
  });

  // The flat grant carries an expiry; a live subscription does not. The
  // date check must therefore bite ONLY on the fallback arm — this is the
  // asymmetry the admin and the Space already honour and the app did not.
  it('does NOT show a flat grant whose expiry has passed', () => {
    const name = resolveSubscriptionTypeName({
      subscription_type_name: '2 months included',
      subscription_expires_at: { toMillis: () => Date.now() - 1000 } as any,
    });
    expect(name).toBeNull();
  });

  it('still shows a flat grant that has not yet expired', () => {
    const name = resolveSubscriptionTypeName({
      subscription_type_name: '2 months included',
      subscription_expires_at: { toMillis: () => Date.now() + 86_400_000 } as any,
    });
    expect(name).toBe('2 months included');
  });

  it('never gates a LIVE subscription on the grant expiry', () => {
    const name = resolveSubscriptionTypeName({
      subscription_expires_at: { toMillis: () => Date.now() - 1000 } as any,
      active_subscriptions: [{ subscription_type_id: 'type-1', subscription_type_name: 'Type One' } as any],
    });
    expect(name).toBe('Type One');
  });

  it('returns null when the contact has no subscription anywhere', () => {
    expect(resolveSubscriptionTypeName({})).toBeNull();
  });
});

describe('resolvePrimaryRank', () => {
  const systems = [
    {
      id: 'default',
      name: 'Default',
      is_primary: true,
      levels: [
        { value: 1, label: 'Beginner', color: '#fff' },
        { value: 2, label: 'Advanced', color: '#000' },
      ],
    },
  ];

  it('resolves the level matching the contact\'s stored rank for the primary system', () => {
    const resolved = resolvePrimaryRank({ ranks: { default: 2 } }, systems as any);
    expect(resolved?.label).toBe('Advanced');
  });

  it('returns null when no ranking systems are configured — no sport-specific fallback', () => {
    expect(resolvePrimaryRank({ ranks: { default: 2 } }, [])).toBeNull();
    expect(resolvePrimaryRank({ ranks: { default: 2 } }, null)).toBeNull();
  });

  it('returns null when the contact has no recorded level for the system', () => {
    expect(resolvePrimaryRank({ ranks: {} }, systems as any)).toBeNull();
  });
});

describe('formatAddress', () => {
  it('joins the route/street_number and postal_code/locality lines', () => {
    expect(
      formatAddress({ route: 'Main St', street_number: '12', postal_code: '8000', locality: 'Zurich' })
    ).toBe('Main St 12, 8000 Zurich');
  });

  it('returns null when there is no address', () => {
    expect(formatAddress(null)).toBeNull();
    expect(formatAddress(undefined)).toBeNull();
  });
});
