import { resolveAffiliationTerm, resolveHeldPlanSummary, formatAddress } from './profileUtils';

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

describe('resolveHeldPlanSummary', () => {
  const NOW = Date.parse('2026-09-25T12:00:00Z');
  const DAY = 86_400_000;
  const plan = (over: Record<string, unknown>) =>
    ({
      subscription_type_id: 't',
      subscription_type_name: null,
      source: 'grant',
      status: 'active',
      starts_at_ms: NOW - 30 * DAY,
      ends_at_ms: null,
      price_id: null,
      amount: null,
      recurrence: null,
      ref: 'r',
      ...over,
    }) as any;

  it('names the one plan held, with its recurrence', () => {
    const s = resolveHeldPlanSummary(
      { held_plans: [plan({ subscription_type_name: 'Gold', source: 'stripe', recurrence: 'monthly' })] },
      NOW,
    );
    expect(s).toEqual({ name: 'Gold', recurrence: 'monthly' });
  });

  it('counts a second plan instead of hiding it', () => {
    const s = resolveHeldPlanSummary(
      {
        held_plans: [
          plan({ subscription_type_name: 'Gold', recurrence: 'monthly' }),
          plan({ subscription_type_name: 'Kids', ref: 'r2' }),
        ],
      },
      NOW,
    );
    expect(s).toEqual({ name: 'Gold +1', recurrence: null });
  });

  // The list is stored ahead of the clock: nothing rewrites it when a grant
  // lapses, so the reader compares the dates itself.
  it('drops a lapsed grant, a plan not yet begun and credit packs', () => {
    const s = resolveHeldPlanSummary(
      {
        held_plans: [
          plan({ subscription_type_name: 'Lapsed', ends_at_ms: NOW - DAY }),
          plan({ subscription_type_name: 'Future', starts_at_ms: NOW + DAY }),
          plan({ subscription_type_name: '10er', source: 'credits', credits_remaining: 4 }),
        ],
      },
      NOW,
    );
    expect(s).toEqual({ name: null, recurrence: null });
  });

  it('ignores the legacy single-plan slot', () => {
    expect(
      resolveHeldPlanSummary({ subscription_type_name: 'Legacy Plan' } as any, NOW),
    ).toEqual({ name: null, recurrence: null });
  });

  it('falls back to the type id when a plan has no name', () => {
    expect(resolveHeldPlanSummary({ held_plans: [plan({ subscription_type_id: 'type-9' })] }, NOW).name).toBe(
      'type-9',
    );
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
