// ONE studio look → the app's whole theme.
//
// The app is "Linyup" (one store listing, one bundle id — mobile roadmap §2),
// but a member spends their time inside ONE studio, and that studio already
// chose a look for its public surfaces: `Team.bioLinkThemePreset` +
// `bioLinkAccentColor` (packages/shared/src/types/themePreset.ts), mirrored
// onto the world-readable `public_profile` the app reads anyway. So the app
// re-themes at runtime from the mirror — the SAME preset registry and the
// SAME "which half in dark mode" rule the web uses (`resolveSurfacePalette`),
// with the accent driving every MD3 primary role. No new studio setting, no
// new field, nothing to backfill: a studio that never chose a look gets
// Linyup's own.
//
// Everything below is pure (hex in, hex out) and tested; the only React in
// this feature is `contexts/TenantThemeContext.tsx`, which stores the brand
// and hands it to `buildTheme` (`theme.ts`).
//
// What this is NOT: an org-branded white-label app. That needs a second store
// listing, bundle id, icon and developer accounts per organisation (roadmap
// §5) — `app.config.js`'s `APP_VARIANT` is the seam for it, deliberately left
// with one entry.
import { resolveSurfacePalette, surfaceThemePreset, type SurfacePalette } from '@linyup/shared';
import { contrastText, isHexColor, mix, parseHex, toHex } from '@linyup/shared';

/** What the app keeps about the signed-in member's studio, persisted so a
 *  cold start opens in the studio's look rather than flashing Linyup purple. */
export interface TenantBrand {
  presetId?: string | null;
  accent?: string | null;
  logoUrl?: string | null;
  name?: string | null;
}

/** The subset of a `public_profile` mirror the brand is read from. */
export interface BrandSource {
  name?: string;
  bioLinkThemePreset?: string | null;
  bioLinkAccentColor?: string | null;
  profileImage?: string | null;
}

export function brandFromProfile(profile: BrandSource): TenantBrand {
  return {
    presetId: profile.bioLinkThemePreset ?? null,
    accent: isHexColor(profile.bioLinkAccentColor) ? profile.bioLinkAccentColor : null,
    logoUrl: profile.profileImage ?? null,
    name: profile.name ?? null,
  };
}

/** The MD3 colour roles a tenant overrides. Everything absent keeps Linyup's. */
export interface TenantColorOverrides {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  inversePrimary: string;
  background?: string;
  surface?: string;
  onBackground?: string;
  onSurface?: string;
  elevation?: { level1: string; level2: string; level3: string; level4: string; level5: string };
}

export interface ResolvedTenantTheme {
  /** Whether the app renders DARK — a non-adaptive preset (`ink`) decides this
   *  itself, exactly as it does on the web; otherwise the system scheme. */
  isDark: boolean;
  colors: TenantColorOverrides;
  /** Three stops for GradientBackground: the page background tinted towards
   *  the accent. */
  gradient: readonly [string, string, string];
}

const LINYUP_BG = { light: '#FAFAFF', dark: '#121015' };
const LINYUP_SURFACE = { light: '#FFFFFF', dark: '#1A1720' };

/**
 * Null means "no studio look" — render Linyup's own theme untouched. That is
 * the answer for no brand, for a brand with neither a known preset nor a
 * valid accent, and for anything malformed: a studio's typo must never
 * produce an unreadable app.
 */
export function resolveTenantTheme(
  brand: TenantBrand | null | undefined,
  systemDark: boolean,
): ResolvedTenantTheme | null {
  if (!brand) return null;
  const preset = surfaceThemePreset(brand.presetId);
  const rawAccent = isHexColor(brand.accent) ? brand.accent : (preset?.defaultAccent ?? null);
  if (!preset && !rawAccent) return null;
  if (!rawAccent || !isHexColor(rawAccent)) return null; // a preset always carries a defaultAccent; belt and braces
  // Normalised (#RRGGBB, upper-case) so equality checks and the mixes below
  // never see two spellings of one colour.
  const norm = (hex: string) => toHex(parseHex(hex)!);
  const accent = norm(rawAccent);

  let palette: SurfacePalette | null = preset ? resolveSurfacePalette(preset, systemDark) : null;
  // The registry holds plain hex backgrounds; a CSS gradient (allowed by the
  // type for the web) cannot be a native background, so fall back to Linyup's.
  if (palette && !isHexColor(palette.background)) palette = null;

  // `scheme` is the TEXT scheme: light text ⇒ a dark page.
  const isDark = palette ? palette.scheme === 'light' : systemDark;
  const background = palette ? norm(palette.background) : LINYUP_BG[isDark ? 'dark' : 'light'];
  const surface =
    palette && isHexColor(palette.surface) ? norm(palette.surface) : LINYUP_SURFACE[isDark ? 'dark' : 'light'];

  // Dark mode lifts the accent so it still reads on a dark surface — the same
  // move MD3 makes for its own primary (Linyup's #7C3AED becomes #CFBCFF).
  const primary = isDark ? mix(accent, '#FFFFFF', 0.3) : accent;
  const onPrimary = contrastText(primary);
  const primaryContainer = mix(surface, accent, isDark ? 0.35 : 0.14);
  const onPrimaryContainer = isDark ? mix(accent, '#FFFFFF', 0.75) : mix(accent, '#000000', 0.55);
  const inversePrimary = isDark ? accent : mix(accent, '#FFFFFF', 0.55);
  const onSurface = isDark ? '#E6E1E5' : '#1C1B1F';

  return {
    isDark,
    colors: {
      primary,
      onPrimary,
      primaryContainer,
      onPrimaryContainer,
      inversePrimary,
      background,
      surface,
      onBackground: onSurface,
      onSurface,
      // MD3 tinted surfaces: each elevation level is the surface pulled a
      // little further towards the primary.
      elevation: {
        level1: mix(surface, primary, 0.05),
        level2: mix(surface, primary, 0.08),
        level3: mix(surface, primary, 0.11),
        level4: mix(surface, primary, 0.12),
        level5: mix(surface, primary, 0.14),
      },
    },
    gradient: [background, mix(background, accent, 0.06), mix(background, accent, 0.12)],
  };
}
