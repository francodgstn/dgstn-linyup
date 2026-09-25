import { MD3DarkTheme, MD3LightTheme, configureFonts, useTheme, type MD3Theme } from 'react-native-paper'
import merge from 'deepmerge'
import type { ResolvedTenantTheme } from './utils/tenantTheme'

// Linyup brand — purple accent (hue ~292, matching the web app's oklch primary).
// All MD3 color roles derived from this base. This is the look the app has
// with NO studio signed in; once a member is in, `buildTheme` overlays their
// studio's preset + accent (utils/tenantTheme.ts) on top of it.

const fontConfig = {
  displayLarge: { fontFamily: 'System', fontWeight: '700' as const, letterSpacing: 0, lineHeight: 44, fontSize: 32 },
  headlineMedium: { fontFamily: 'System', fontWeight: '600' as const, letterSpacing: 0.15, lineHeight: 32, fontSize: 24 },
  titleLarge: { fontFamily: 'System', fontWeight: '600' as const, letterSpacing: 0, lineHeight: 28, fontSize: 22 },
  bodyLarge: { fontFamily: 'System', fontWeight: '400' as const, letterSpacing: 0.5, lineHeight: 24, fontSize: 16 },
  bodyMedium: { fontFamily: 'System', fontWeight: '400' as const, letterSpacing: 0.25, lineHeight: 20, fontSize: 14 },
  labelLarge: { fontFamily: 'System', fontWeight: '600' as const, letterSpacing: 0.1, lineHeight: 20, fontSize: 14 },
}

const lightColors = {
  primary: '#7C3AED',
  onPrimary: '#FFFFFF',
  primaryContainer: '#EDE5FF',
  onPrimaryContainer: '#250066',
  secondary: '#625B71',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#E8DEF8',
  onSecondaryContainer: '#1D192B',
  tertiary: '#7D5260',
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#FFD8E4',
  onTertiaryContainer: '#31111D',
  background: '#FAFAFF',
  onBackground: '#1C1B1F',
  surface: '#FFFFFF',
  onSurface: '#1C1B1F',
  surfaceVariant: '#E7E0EC',
  onSurfaceVariant: '#49454F',
  outline: '#79747E',
  outlineVariant: '#CAC4D0',
  inverseSurface: '#313033',
  inverseOnSurface: '#F4EFF4',
  inversePrimary: '#CFBCFF',
  elevation: {
    level0: 'transparent',
    level1: '#FFFFFF',
    level2: '#FFFFFF',
    level3: '#F7F2FA',
    level4: '#F3EDF7',
    level5: '#EFE9F4',
  },
  error: '#BA1A1A',
  onError: '#FFFFFF',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002',
}

const darkColors = {
  primary: '#CFBCFF',
  onPrimary: '#381E72',
  primaryContainer: '#4F378B',
  onPrimaryContainer: '#EADDFF',
  secondary: '#CCC2DC',
  onSecondary: '#332D41',
  secondaryContainer: '#4A4458',
  onSecondaryContainer: '#E8DEF8',
  tertiary: '#EFB8C8',
  onTertiary: '#492532',
  tertiaryContainer: '#633B48',
  onTertiaryContainer: '#FFD8E4',
  background: '#121015',
  onBackground: '#E6E1E5',
  surface: '#1A1720',
  onSurface: '#E6E1E5',
  surfaceVariant: '#252030',
  onSurfaceVariant: '#CAC4D0',
  outline: '#938F99',
  outlineVariant: '#49454F',
  inverseSurface: '#E6E1E5',
  inverseOnSurface: '#313033',
  inversePrimary: '#6750A4',
  elevation: {
    level0: 'transparent',
    level1: '#252030',
    level2: '#2B2535',
    level3: '#322B3C',
    level4: '#383144',
    level5: '#3E374B',
  },
  error: '#FFB4AB',
  onError: '#690005',
  errorContainer: '#93000A',
  onErrorContainer: '#FFDAD6',
}

// Gradient stops used by GradientBackground and any future branded surfaces.
export const gradientColors = {
  light: ['#FAFAFF', '#F0E8FF', '#E8DCFF'] as const,
  dark: ['#121015', '#1A1028', '#221838'] as const,
}

// ── Semantic colors ─────────────────────────────────────────────────────────
// The colors that mean something regardless of the studio's brand: a status,
// a category, a third-party mark. Components read these through `useAppTheme`
// instead of carrying their own hex, so a tenant accent never collides with a
// "success" green — and so the literals live in ONE place per scheme.
//
// NOT here, on purpose: the categorical palettes for charts, badge gradients
// and the attendance calendar (BadgesCard, PerformanceProfileSection,
// GamificationCard, AttendanceCalendar). Those are data colors, many per
// file, and re-mapping them blind is a visual regression waiting to happen —
// a device-verified pass (roadmap §6).
export const semanticColors = {
  light: {
    info: '#3B82F6',
    success: '#22C55E',
    warning: '#F59E0B',
    danger: '#EF4444',
    teal: '#14B8A6',
    instagram: '#E1306C',
  },
  dark: {
    info: '#60A5FA',
    success: '#4ADE80',
    warning: '#FBBF24',
    danger: '#F87171',
    teal: '#2DD4BF',
    instagram: '#F06292',
  },
} as const

export type SemanticColors = (typeof semanticColors)['light']

/** Paper's MD3 theme plus what this app hangs on it. */
export type AppTheme = MD3Theme & {
  semantic: SemanticColors
  /** GradientBackground's stops — Linyup's, or the studio's (tenantTheme). */
  gradient: readonly [string, string, string]
}

export const useAppTheme = () => useTheme<AppTheme>()

/**
 * The theme for one render: the system scheme, overlaid with the signed-in
 * member's studio look when there is one. A non-adaptive studio preset decides
 * dark/light itself (`tenant.isDark`), exactly as it does on the web.
 */
export function buildTheme(systemDark: boolean, tenant?: ResolvedTenantTheme | null): AppTheme {
  const isDark = tenant?.isDark ?? systemDark
  const base = isDark ? MD3DarkTheme : MD3LightTheme
  const colors = merge(isDark ? darkColors : lightColors, tenant?.colors ?? {})
  return merge(base, {
    colors,
    fonts: configureFonts({ config: fontConfig }),
    semantic: semanticColors[isDark ? 'dark' : 'light'],
    gradient: tenant?.gradient ?? gradientColors[isDark ? 'dark' : 'light'],
  }) as AppTheme
}
