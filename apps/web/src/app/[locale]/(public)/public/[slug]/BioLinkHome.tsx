'use client'

import { useEffect, useState } from 'react'
import { collectionGroup, query, where, limit, getDocs } from 'firebase/firestore'
import { useLocale, useTranslations } from 'next-intl'
import { db } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import {
  Instagram,
  Facebook,
  Youtube,
  Twitter,
  Linkedin,
  Globe,
  MessageCircle,
  Star,
  Music2,
  ChevronRight,
  MapPin,
} from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { DynamicIcon } from '@/components/ui/icon-picker'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import { resolveBioLinkPalette } from '@/lib/bioLink'
import {
  SYSTEM_LINK_META,
  SYSTEM_LINK_ROUTE,
  surfaceThemePreset,
  systemLinkIsLive,
  PUBLIC_PROFILE_SUBCOLLECTION,
} from '@linyup/shared'
import { publicHrefLocalized } from '@/lib/publicRoutes'
import type {
  TeamLink,
  SocialLink,
  BioLinkTheme,
  BioLinkBackground,
  SurfaceThemePresetId,
  PublicMainAddress,
  ActivePublicSurfaces,
} from '@linyup/shared'
import { DEFAULT_ACCENT } from '@/lib/colors'

// ─── types ────────────────────────────────────────────────────────────────────

export interface BioLinkTeamData {
  name: string
  description?: string
  profileImage?: string
  heroImage?: string
  socialLinks?: SocialLink[]
  links?: TeamLink[]
  /** ONE choice carrying both a light and a dark palette. Wins over the two
   *  legacy fields below, which still answer for a page authored before
   *  presets — see packages/shared/src/types/themePreset.ts. */
  bioLinkThemePreset?: SurfaceThemePresetId
  bioLinkTheme?: BioLinkTheme
  bioLinkAccentColor?: string
  bioLinkBackground?: BioLinkBackground
  /** Denormalized by syncTeamPublicProfile — true on the Free plan; removing
   *  the badge is a paid perk. */
  showBranding?: boolean
  /** The team's primary place (Main Address), denormalized for the address + map. */
  mainAddress?: PublicMainAddress | null
  /** Which of this team's public surfaces are actually live, computed by
   *  syncTeamPublicProfile. Read here so a page link whose destination has been
   *  taken down is not offered — see `systemLinkIsLive` for why it fails open,
   *  and why the admin preview (which never sets this) is unaffected. */
  active_public_surfaces?: ActivePublicSurfaces
}

// ─── social icon map ──────────────────────────────────────────────────────────

const SOCIAL_ICONS: Record<string, React.FC<{ className?: string }>> = {
  instagram: Instagram,
  facebook: Facebook,
  youtube: Youtube,
  x: Twitter,
  linkedin: Linkedin,
  whatsapp: MessageCircle,
  website: Globe,
  review: Star,
  tiktok: Music2,
}

// ─── component ───────────────────────────────────────────────────────────────

interface Props {
  slug: string
  /** Pass for live preview (admin dashboard). Omit to fetch from Firestore (public bio-link). */
  team?: BioLinkTeamData
  /** When set, link clicks call this instead of navigating (preview mode). */
  onLinkClick?: (type: 'booking' | 'signup' | 'external', url?: string) => void
}

export default function BioLinkHome({ slug, team: teamProp, onLinkClick }: Props) {
  const locale = useLocale()
  const t = useTranslations('BioLink')
  const tSite = useTranslations('Site')
  const [team, setTeam] = useState<BioLinkTeamData | null>(teamProp ?? null)
  const [loading, setLoading] = useState(!teamProp)
  const [systemDark, setSystemDark] = useState(false)

  // Fetch team from public_profile subcollection — no auth required
  useEffect(() => {
    if (teamProp) return // skip fetch when data is provided (admin preview)
    const q = query(
      collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
      where('slug', '==', slug),
      where('type', '==', 'team'),
      limit(1)
    )
    getDocs(q)
      .then((snap) => {
        if (!snap.empty) setTeam(snap.docs[0].data() as BioLinkTeamData)
      })
      .catch((err: unknown) => {
        // Terminal not-found is right for the visitor; silence is not right for
        // us — this is the same lookup every public surface depends on.
        reportPublicLoadFailure('bio-link/resolve-slug', err)
      })
      .finally(() => setLoading(false))
  }, [slug, teamProp])

  // Keep preview in sync when admin edits the form
  useEffect(() => {
    if (teamProp) setTeam(teamProp)
  }, [teamProp])

  // SUBSCRIBE WHENEVER THE ANSWER COULD MATTER — any adaptive preset, not just
  // the legacy `bioLinkTheme: 'auto'`. Guarding on the old field alone would
  // freeze a preset-themed page at "light" for a viewer in dark mode, because
  // nothing would ever set `systemDark`.
  const bioPreset = surfaceThemePreset(team?.bioLinkThemePreset)
  const followsSystem = bioPreset ? bioPreset.adaptive : team?.bioLinkTheme === 'auto'
  useEffect(() => {
    if (!followsSystem) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(mq.matches)
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [followsSystem])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!team) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center px-4">
        <p className="text-lg font-semibold">{t('notFoundTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('notFoundBody')}</p>
      </div>
    )
  }

  // ONE resolver — preset first, the legacy theme + background pair second.
  // See packages/shared/src/types/themePreset.ts for the crossings it removed.
  const { background: bgStyle, onDark, accent } = resolveBioLinkPalette(
    team,
    systemDark,
    DEFAULT_ACCENT
  )

  const textMain = onDark ? '#f9fafb' : '#111827'
  const textMuted = onDark ? 'rgba(249,250,251,0.65)' : '#6b7280'
  const cardBg = onDark ? 'rgba(255,255,255,0.08)' : '#ffffff'
  const cardBorder = onDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)'
  const iconBg = onDark ? 'rgba(255,255,255,0.12)' : `${accent}18`

  // Two filters, and the second one is not a preference: `showInBioLink` is what
  // the STUDIO chose to show, `systemLinkIsLive` is whether there is anything at
  // the other end. A page link to a surface that has been taken down (website
  // unpublished, website plugin removed, Connect account no longer chargeable)
  // is dropped rather than rendered into a dead page — the same rule the website
  // header already applies via `resolveSiteSurfaceLinks`. Custom links carry no
  // target and are never touched.
  const visibleLinks = (team.links ?? []).filter(
    (l) => l.showInBioLink && (!l.target || systemLinkIsLive(l.target, team.active_public_surfaces))
  )
  const socialLinks = (team.socialLinks ?? []).filter((s) => s.url)

  return (
    <div
      className="min-h-screen w-full"
      style={{ background: bgStyle, color: textMain, fontFamily: 'inherit' }}
    >
      {/* Hero image */}
      {team.heroImage && (
        <div className="w-full h-48 sm:h-60 overflow-hidden relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={team.heroImage} alt="" className="w-full h-full object-cover" />
          <div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(to bottom, transparent 50%, rgba(0,0,0,0.2) 100%)',
            }}
          />
        </div>
      )}

      <div className="max-w-[640px] mx-auto px-5 pb-16">
        {/* Avatar — relative z-10 so it stacks ABOVE the (position:relative) hero
            image it overlaps via -mt-12; without it the positioned hero paints on top. */}
        <div className={`relative z-10 flex justify-center ${team.heroImage ? '-mt-12' : 'pt-10'}`}>
          <div
            className="h-24 w-24 rounded-full overflow-hidden ring-4 shadow-lg flex-shrink-0"
            style={{ boxShadow: `0 0 0 4px ${cardBg}` }}
          >
            {team.profileImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={team.profileImage} alt={team.name} className="h-full w-full object-cover" />
            ) : (
              <div
                className="h-full w-full flex items-center justify-center text-3xl font-bold text-white"
                style={{ background: accent }}
              >
                {team.name[0]?.toUpperCase()}
              </div>
            )}
          </div>
        </div>

        {/* Name + description */}
        <div className="mt-4 text-center space-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: textMain }}>
            {team.name}
          </h1>
          {team.description && (
            <p className="text-sm leading-relaxed max-w-sm mx-auto" style={{ color: textMuted }}>
              {team.description}
            </p>
          )}
        </div>

        {/* Social icons */}
        {socialLinks.length > 0 && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {socialLinks.map((s) => {
              const Icon = SOCIAL_ICONS[s.platform] ?? Globe
              return (
                <a
                  key={s.platform}
                  href={onLinkClick ? undefined : s.url}
                  target={onLinkClick ? undefined : '_blank'}
                  rel={onLinkClick ? undefined : 'noopener noreferrer'}
                  onClick={
                    onLinkClick
                      ? (e) => {
                          e.preventDefault()
                          onLinkClick('external', s.url)
                        }
                      : undefined
                  }
                  className="h-9 w-9 rounded-full flex items-center justify-center transition-opacity hover:opacity-70"
                  style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textMain }}
                  aria-label={s.platform}
                >
                  <Icon className="h-4 w-4" />
                </a>
              )
            })}
          </div>
        )}

        {/* Links */}
        {visibleLinks.length > 0 && (
          <div className="mt-7 space-y-3">
            {visibleLinks.map((link, i) => {
              // A "page link" carries a target → routes to one of our public surfaces;
              // otherwise it's a custom external URL. Booking keeps the accent CTA style.
              const target = link.target
              const isBooking = target === 'booking'
              // `from: 'bio-link'` so the surface's back link returns here — the
              // bio-link IS this team's root, so that is also the default, but
              // being explicit survives the studio changing its default surface.
              const href = target
                ? publicHrefLocalized(locale, slug, SYSTEM_LINK_ROUTE[target].route, {
                    ...SYSTEM_LINK_ROUTE[target].params,
                    from: 'bio-link',
                  })
                : link.url

              const isInternal = !!target
              const cardStyle = isBooking
                ? { background: accent, border: 'none' }
                : { background: cardBg, border: `1px solid ${cardBorder}` }

              const labelColor = isBooking ? '#fff' : textMain
              const descColor = isBooking ? 'rgba(255,255,255,0.75)' : textMuted
              const iconColor = isBooking ? 'rgba(255,255,255,0.9)' : accent

              return (
                <a
                  key={i}
                  href={onLinkClick ? undefined : href || undefined}
                  target={isInternal || onLinkClick ? undefined : '_blank'}
                  rel={isInternal || onLinkClick ? undefined : 'noopener noreferrer'}
                  onClick={
                    onLinkClick
                      ? (e) => {
                          e.preventDefault()
                          onLinkClick(
                            target === 'booking' ? 'booking' : target === 'signup' ? 'signup' : 'external',
                            href || undefined
                          )
                        }
                      : undefined
                  }
                  className="flex items-center gap-4 rounded-2xl px-5 py-4 transition-all hover:scale-[1.015] hover:shadow-lg cursor-pointer"
                  style={{ ...cardStyle, textDecoration: 'none', display: 'flex' }}
                >
                  <div
                    className="h-9 w-9 rounded-lg flex-shrink-0 flex items-center justify-center"
                    style={{
                      background: isBooking ? 'rgba(255,255,255,0.2)' : iconBg,
                      color: iconColor,
                    }}
                  >
                    <DynamicIcon
                      name={link.iconName ?? (target ? SYSTEM_LINK_META[target].defaultIcon : 'Link2')}
                      className="h-4 w-4"
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p
                      className="font-semibold text-sm leading-tight"
                      style={{ color: labelColor }}
                    >
                      {link.label}
                    </p>
                    {link.description && (
                      <p className="text-xs mt-0.5 leading-snug" style={{ color: descColor }}>
                        {link.description}
                      </p>
                    )}
                  </div>

                  <ChevronRight
                    className="h-4 w-4 flex-shrink-0"
                    style={{ color: isBooking ? 'rgba(255,255,255,0.6)' : textMuted }}
                  />
                </a>
              )
            })}
          </div>
        )}

        {/* Main address + map (the team's primary place) */}
        {team.mainAddress?.address && (
          <div className="mt-7">
            <div
              className="overflow-hidden rounded-2xl border"
              style={{ borderColor: cardBorder, background: cardBg }}
            >
              <iframe
                title="map"
                className="w-full"
                style={{ minHeight: 180, border: 0 }}
                loading="lazy"
                src={`https://www.google.com/maps?q=${encodeURIComponent(team.mainAddress.address)}&output=embed`}
              />
              <div className="flex items-start gap-2.5 p-4">
                <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: accent }} />
                <div className="min-w-0">
                  {team.mainAddress.name && (
                    <p className="text-sm font-semibold" style={{ color: textMain }}>
                      {team.mainAddress.name}
                    </p>
                  )}
                  <p className="text-xs" style={{ color: textMuted }}>
                    {team.mainAddress.address}
                  </p>
                  {team.mainAddress.mapsLink && (
                    <a
                      href={team.mainAddress.mapsLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-xs font-medium hover:underline"
                      style={{ color: accent }}
                    >
                      {tSite('openInMaps')} →
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Language choice — hidden in the admin bio-link editor preview
            (detected the same way the link clicks are: `onLinkClick` is only
            passed there). A visitor-only control the studio never needs while
            editing its own page. */}
        {!onLinkClick && (
          <div className="mt-8 flex justify-center">
            <LocaleSwitcher triggerStyle={{ background: cardBg, borderColor: cardBorder, color: textMain }} />
          </div>
        )}

        {/* Footer — Free-plan badge (denormalized flag; removing it is a paid
            perk). undefined = hidden: existing docs get the flag via backfill. */}
        {team.showBranding === true && (
          <p className="mt-12 text-center text-[11px]" style={{ color: textMuted }}>
            {tSite('poweredBy')}{' '}
            <Link href="/" className="hover:underline font-medium" style={{ color: textMuted }}>
              Linyup
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}
