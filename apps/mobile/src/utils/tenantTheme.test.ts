import { brandFromProfile, resolveTenantTheme } from './tenantTheme';
import { contrastRatio, contrastText, isHexColor, mix, parseHex, toHex, withAlpha } from '@linyup/shared';

describe('color helpers', () => {
  it('parses the hex shapes a studio can store', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#7C3AED')).toEqual({ r: 124, g: 58, b: 237 });
    expect(parseHex('#7C3AEDCC')).toEqual({ r: 124, g: 58, b: 237 });
    expect(parseHex('purple')).toBeNull();
    expect(parseHex('linear-gradient(#000, #fff)')).toBeNull();
    expect(isHexColor(null)).toBe(false);
  });

  it('round-trips and mixes', () => {
    expect(toHex({ r: 124, g: 58, b: 237 })).toBe('#7C3AED');
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mix('#000000', '#FFFFFF', 0)).toBe('#000000');
    expect(mix('#000000', '#FFFFFF', 1)).toBe('#FFFFFF');
    expect(mix('nope', '#FFFFFF', 0.5)).toBe('nope');
    expect(withAlpha('#7C3AED', 0.12)).toBe('rgba(124, 58, 237, 0.12)');
  });

  it('picks readable text', () => {
    expect(contrastText('#FFFFFF')).toBe('#000000');
    expect(contrastText('#000000')).toBe('#FFFFFF');
    expect(contrastText('#7C3AED')).toBe('#FFFFFF');
    expect(contrastText('#F59E0B')).toBe('#000000');
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
  });
});

describe('brandFromProfile — what the mirror hands the theme', () => {
  it('takes the preset, a VALID accent, the logo and the name', () => {
    expect(
      brandFromProfile({
        name: 'Iron Circle',
        bioLinkThemePreset: 'ink',
        bioLinkAccentColor: '#DC2626',
        profileImage: 'https://x/logo.png',
      }),
    ).toEqual({ presetId: 'ink', accent: '#DC2626', logoUrl: 'https://x/logo.png', name: 'Iron Circle' });
  });

  it('drops a malformed accent rather than passing it on', () => {
    expect(brandFromProfile({ name: 'S', bioLinkAccentColor: 'red' }).accent).toBeNull();
    expect(brandFromProfile({}).presetId).toBeNull();
  });
});

describe('resolveTenantTheme — one studio look → the theme', () => {
  it('no brand, or nothing usable in it, means Linyup’s own theme (null)', () => {
    expect(resolveTenantTheme(null, false)).toBeNull();
    expect(resolveTenantTheme({}, false)).toBeNull();
    expect(resolveTenantTheme({ presetId: 'not-a-preset', accent: 'red' }, false)).toBeNull();
  });

  it('an accent alone re-colours the primary roles and keeps Linyup’s surfaces', () => {
    const t = resolveTenantTheme({ accent: '#DC2626' }, false)!;
    expect(t.isDark).toBe(false);
    expect(t.colors.primary).toBe('#DC2626');
    expect(t.colors.onPrimary).toBe('#FFFFFF');
    expect(t.colors.background).toBe('#FAFAFF');
    expect(t.gradient[0]).toBe('#FAFAFF');
    expect(t.gradient[2]).not.toBe('#FAFAFF');
  });

  it('follows the system scheme for an adaptive preset', () => {
    const light = resolveTenantTheme({ presetId: 'ocean' }, false)!;
    const dark = resolveTenantTheme({ presetId: 'ocean' }, true)!;
    expect(light.isDark).toBe(false);
    expect(light.colors.background).toBe('#EEF6FC');
    expect(dark.isDark).toBe(true);
    expect(dark.colors.background).toBe('#08131D');
    // The preset's default accent applies when the studio chose none.
    expect(light.colors.primary).toBe('#0369A1');
  });

  it('a non-adaptive preset (ink) is dark in BOTH system schemes — a look, not a mode', () => {
    for (const systemDark of [false, true]) {
      const t = resolveTenantTheme({ presetId: 'ink', accent: '#F59E0B' }, systemDark)!;
      expect(t.isDark).toBe(true);
      expect(t.colors.background).toBe('#0F1115');
      expect(t.colors.onSurface).toBe('#E6E1E5');
    }
  });

  it('lifts the accent in dark mode so it reads on a dark surface', () => {
    const t = resolveTenantTheme({ presetId: 'paper', accent: '#7C3AED' }, true)!;
    expect(t.isDark).toBe(true);
    expect(t.colors.primary).not.toBe('#7C3AED');
    expect(contrastRatio(t.colors.primary, t.colors.background!)).toBeGreaterThan(
      contrastRatio('#7C3AED', t.colors.background!),
    );
  });

  it('every text role it sets reads against its surface (WCAG AA for large text)', () => {
    for (const [brand, dark] of [
      [{ presetId: 'paper', accent: '#6366F1' }, false],
      [{ presetId: 'sand', accent: '#B45309' }, true],
      [{ presetId: 'mono', accent: '#111111' }, false],
      [{ presetId: 'forest', accent: '#15803D' }, true],
    ] as const) {
      const t = resolveTenantTheme(brand, dark)!;
      expect(contrastRatio(t.colors.onPrimary, t.colors.primary)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(t.colors.onPrimaryContainer, t.colors.primaryContainer)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(t.colors.onSurface!, t.colors.surface!)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
