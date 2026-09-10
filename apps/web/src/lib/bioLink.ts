import { resolveSurfacePalette, surfaceThemePreset, isLightColor } from '@linyup/shared'
import type { SocialPlatform, SurfaceThemePresetId } from '@linyup/shared'

export const BIO_LINK_GRADIENTS: Record<string, { label: string; css: string; dark: boolean }> = {
  'blue-violet': {
    label: 'Blue Violet',
    css: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)',
    dark: true,
  },
  sunset: { label: 'Sunset', css: 'linear-gradient(135deg,#f093fb 0%,#f5576c 100%)', dark: true },
  ocean: { label: 'Ocean', css: 'linear-gradient(135deg,#4facfe 0%,#00f2fe 100%)', dark: false },
  forest: { label: 'Forest', css: 'linear-gradient(135deg,#43e97b 0%,#38f9d7 100%)', dark: false },
  fire: { label: 'Fire', css: 'linear-gradient(135deg,#fa709a 0%,#fee140 100%)', dark: false },
  night: {
    label: 'Night',
    css: 'linear-gradient(135deg,#0f0c29 0%,#302b63 50%,#24243e 100%)',
    dark: true,
  },
  royal: {
    label: 'Royal Blue',
    css: 'linear-gradient(135deg,#1e3c72 0%,#2a5298 100%)',
    dark: true,
  },
  warm: { label: 'Warm Flame', css: 'linear-gradient(135deg,#f77062 0%,#fe5196 100%)', dark: true },
}

export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  'instagram',
  'facebook',
  'youtube',
  'tiktok',
  'x',
  'linkedin',
  'whatsapp',
  'website',
  'review',
]

export const SOCIAL_LABELS: Record<SocialPlatform, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  x: 'X (Twitter)',
  linkedin: 'LinkedIn',
  whatsapp: 'WhatsApp',
  website: 'Website',
  review: 'Reviews',
}

export const ICON_CATEGORIES: { label: string; icons: string[] }[] = [
  {
    label: 'Calendar',
    icons: ['CalendarDays', 'CalendarCheck', 'CalendarPlus', 'Clock', 'Timer', 'BookOpen'],
  },
  {
    label: 'Sports',
    icons: ['Dumbbell', 'Zap', 'Activity', 'Heart', 'Flame', 'Target', 'Trophy', 'Award'],
  },
  { label: 'Contact', icons: ['Phone', 'Mail', 'MapPin', 'MessageCircle', 'Info', 'Bell'] },
  {
    label: 'Business',
    icons: ['ShoppingBag', 'CreditCard', 'Gift', 'Tag', 'Users', 'UserCheck', 'Star'],
  },
  {
    label: 'Web',
    icons: ['Globe', 'Link2', 'ExternalLink', 'Youtube', 'Instagram', 'Facebook', 'FileText'],
  },
  {
    label: 'General',
    icons: ['Sparkles', 'Bookmark', 'Share2', 'Check', 'ArrowRight', 'Lightbulb'],
  },
]

/**
 * THE bio-link palette — preset first, legacy theme+background second.
 *
 * Mirrors `buildPalette` in components/site/theme.ts on purpose: the two public
 * surfaces are themed by the same registry and must not drift. See
 * types/themePreset.ts for why a preset carries both schemes.
 *
 * `resolveBackground` / `getTextColor` below are the LEGACY half, and are only
 * reached from here — a bio-link with no preset chosen yet.
 */
export function resolveBioLinkPalette(
  team: {
    bioLinkThemePreset?: SurfaceThemePresetId | null
    bioLinkTheme?: 'light' | 'dark' | 'auto'
    bioLinkAccentColor?: string | null
    bioLinkBackground?: { type: 'solid' | 'gradient'; color: string } | null
  },
  systemDark: boolean,
  defaultAccent: string
): { background: string; onDark: boolean; accent: string } {
  const preset = surfaceThemePreset(team.bioLinkThemePreset)
  if (preset) {
    const palette = resolveSurfacePalette(preset, systemDark)
    return {
      background: palette.background,
      onDark: palette.scheme === 'light',
      accent: team.bioLinkAccentColor || preset.defaultAccent,
    }
  }
  const isDark = team.bioLinkTheme === 'dark' || (team.bioLinkTheme === 'auto' && systemDark)
  const bg = team.bioLinkBackground ?? undefined
  return {
    background: resolveBackground(bg, isDark),
    onDark: getTextColor(bg, isDark) === 'light',
    accent: team.bioLinkAccentColor || defaultAccent,
  }
}

export function resolveBackground(
  bg: { type: 'solid' | 'gradient'; color: string } | undefined,
  isDark: boolean
): string {
  if (!bg) return isDark ? '#111827' : '#f3f4f6'
  if (bg.type === 'solid') return bg.color
  return BIO_LINK_GRADIENTS[bg.color]?.css ?? bg.color
}

export function getTextColor(
  bg: { type: 'solid' | 'gradient'; color: string } | undefined,
  isDark: boolean
): 'light' | 'dark' {
  if (!bg) return isDark ? 'light' : 'dark'
  if (bg.type === 'gradient') {
    return BIO_LINK_GRADIENTS[bg.color]?.dark ? 'light' : isDark ? 'light' : 'dark'
  }
  // THE shared contrast rule (WCAG, `isLightColor`) — this used to be a YIQ
  // copy with its own threshold. Unparseable → light text, as before.
  return isLightColor(bg.color) ? 'dark' : 'light'
}
