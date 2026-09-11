'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { MapPin, ArrowRight } from 'lucide-react'
import type { ClubsSection, LocationsSection, CoachesSection, TeamPublicProfile } from '@linyup/shared'
import type { SitePalette } from './theme'
import { publicHrefLocalized } from '@/lib/publicRoutes'
// Type-only — avoids a real runtime circular import (sections.tsx imports the
// blocks below as values).
import type { RenderCtx } from './sections'
import { nameInitials, PUBLIC_PROFILE_SUBCOLLECTION, TEAMS_COLLECTION } from '@linyup/shared'

// ─────────────────────────────────────────────────────────────────────────────
// Organization site — aggregate blocks (clubs / locations / coaches).
//
// Each block enriches `ctx.orgTeams` (the published site's embedded member-team
// snapshot: teamId/slug/name only) with a live read of that team's world-readable
// `teams/{teamId}/public_profile/{teamId}` doc, so branding/address/roster stay
// fresh without republishing the org site. A team that fails to resolve (or was
// removed) falls back to its embedded name, or is dropped for locations/coaches.
// ─────────────────────────────────────────────────────────────────────────────

// Small local duplicates of sections.tsx's Heading/linkProps helpers — kept
// in this file (rather than imported) so orgSections.tsx has no runtime
// dependency on sections.tsx (only the type-only RenderCtx import above).

function Heading({ text, palette }: { text?: string; palette: SitePalette }) {
  if (!text) return null
  return (
    <h2 className="text-center text-3xl font-bold tracking-tight" style={{ color: palette.text }}>
      {text}
    </h2>
  )
}

function linkProps(href: string | undefined, preview: boolean, external = false) {
  if (!href) return { href: undefined }
  if (preview)
    return {
      href: undefined,
      onClick: (e: React.MouseEvent) => e.preventDefault(),
      style: { cursor: 'default' },
    }
  return external ? { href, target: '_blank' as const, rel: 'noopener noreferrer' } : { href }
}

function colsClass(columns: 2 | 3 | 4): string {
  return columns === 2
    ? '@2xl:grid-cols-2'
    : columns === 4
      ? '@2xl:grid-cols-2 @5xl:grid-cols-4'
      : '@2xl:grid-cols-2 @5xl:grid-cols-3'
}

// ─── Clubs (card per member team, linking to its bio-link) ───────────────────

interface ClubEntry {
  teamId: string
  slug: string
  name: string
  imageUrl?: string
  accentColor?: string
  address?: string
}

function ClubsBlock({ section, ctx }: { section: ClubsSection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  const { palette, locale, preview, orgTeams } = ctx
  const [clubs, setClubs] = useState<ClubEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [term, setTerm] = useState('')

  useEffect(() => {
    let alive = true
    const teams = orgTeams ?? []
    if (teams.length === 0) {
      setClubs([])
      setLoading(false)
      return
    }
    Promise.all(
      teams.map(async (t): Promise<ClubEntry> => {
        try {
          const snap = await getDoc(doc(db, TEAMS_COLLECTION, t.teamId, PUBLIC_PROFILE_SUBCOLLECTION, t.teamId))
          const data = snap.data() as TeamPublicProfile | undefined
          return {
            teamId: t.teamId,
            slug: t.slug,
            name: data?.name || t.name,
            imageUrl: data?.heroImage || data?.profileImage || undefined,
            accentColor: data?.bioLinkAccentColor || undefined,
            address: data?.mainAddress?.address || undefined,
          }
        } catch (err: unknown) {
          // Per-club degradation: the org page still lists this club, just
          // without its profile. Logged so a rules change is not mistaken for
          // clubs that never filled their profile in.
          reportPublicLoadFailure('org-site/club-profile', err)
          return { teamId: t.teamId, slug: t.slug, name: t.name }
        }
      })
    )
      .then((list) => {
        if (alive) setClubs(list)
      })
      .catch((err: unknown) => {
        // Belt-and-braces: the per-club mapper above already catches, so nothing
        // should reach here. `catch {}` is still not how you say that — an outer
        // handler that fires unexpectedly and empties the section in silence is
        // the same defect one level up.
        reportPublicLoadFailure('org-site/clubs', err)
        if (alive) setClubs([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [orgTeams])

  const cols = colsClass(section.columns)
  const asList = section.layout === 'list'

  // Name AND address, because "the one in Basel" is how somebody looks for a
  // club they have not learned the name of yet.
  const needle = term.trim().toLowerCase()
  const visible = needle
    ? clubs.filter((c) =>
        `${c.name} ${c.address ?? ''}`.toLowerCase().includes(needle)
      )
    : clubs

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto max-w-5xl px-6">
        <Heading text={section.heading ?? t('headingClubs')} palette={palette} />
        {section.subheading && (
          <p className="mt-3 text-center" style={{ color: palette.muted }}>
            {section.subheading}
          </p>
        )}
        {/* SEARCH — a plain input, not the app's SearchInput: these blocks also
            render inside a cross-origin embed and on the builder canvas, where
            the app's components and their router context are not available. */}
        {section.searchable && !loading && clubs.length > 0 && (
          <div className="mt-8 flex justify-center">
            <input
              type="search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={t('searchClubs')}
              aria-label={t('searchClubs')}
              className="w-full max-w-sm rounded-xl border px-4 py-2.5 text-sm outline-none focus:ring-2"
              style={{
                borderColor: palette.border,
                background: palette.surface,
                color: palette.text,
              }}
            />
          </div>
        )}

        {/* A SEARCH THAT MATCHES NOTHING SAYS SO. Without this the section
            renders an empty box and reads as "this federation has no clubs". */}
        {!loading && clubs.length > 0 && visible.length === 0 && (
          <p className="mt-10 text-center text-sm" style={{ color: palette.muted }}>
            {t('noClubsMatch')}
          </p>
        )}

        <div
          className={
            asList
              ? 'mt-10 divide-y overflow-y-auto rounded-2xl border'
              : `mt-10 grid grid-cols-1 gap-5 ${cols}`
          }
          style={
            asList
              ? // FIXED HEIGHT, so a long directory scrolls inside itself
                // instead of pushing everything below it off the page.
                { borderColor: palette.border, background: palette.surface, maxHeight: '32rem' }
              : undefined
          }
        >
          {loading ? (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('loading')}
            </p>
          ) : clubs.length === 0 ? (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('emptyClubs')}
            </p>
          ) : (
            visible.map((c) =>
              // Cross-tenant: the org site links each member club to its own
              // tenant root. Locale-prefixed like every other raw <a> here.
              asList ? (
                <a
                  key={c.teamId}
                  {...linkProps(publicHrefLocalized(locale, c.slug), preview)}
                  className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:opacity-80"
                  style={{ borderColor: palette.border }}
                >
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg"
                    style={{ background: c.accentColor || palette.accent }}
                  >
                    {c.imageUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={c.imageUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-sm font-bold" style={{ color: '#ffffff', opacity: 0.92 }}>
                        {c.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" style={{ color: palette.text }}>
                      {c.name}
                    </span>
                    {section.showAddress && c.address && (
                      <span className="block truncate text-sm" style={{ color: palette.muted }}>
                        {c.address}
                      </span>
                    )}
                  </span>
                </a>
              ) : (
              <a
                key={c.teamId}
                {...linkProps(publicHrefLocalized(locale, c.slug), preview)}
                className="flex flex-col overflow-hidden rounded-2xl border transition-transform hover:scale-[1.01]"
                style={{ borderColor: palette.border, background: palette.surface }}
              >
                <div
                  className="relative aspect-[4/3] w-full"
                  style={{ background: c.accentColor || palette.accent }}
                >
                  {c.imageUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={c.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <span
                        className="text-4xl font-bold"
                        style={{ color: '#ffffff', opacity: 0.92 }}
                      >
                        {c.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <h3 className="text-lg font-semibold" style={{ color: palette.text }}>
                    {c.name}
                  </h3>
                  {section.showAddress && c.address && (
                    <p className="mt-2 text-sm" style={{ color: palette.muted }}>
                      {c.address}
                    </p>
                  )}
                </div>
              </a>
              )
            )
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Locations (every club's mainAddress, plus org-authored extra venues) ─────

interface LocationEntry {
  id: string
  name: string
  address?: string
  mapsLink?: string
}

function mapsHref(address?: string, mapsLink?: string): string | undefined {
  if (mapsLink) return mapsLink
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
  return undefined
}

function LocationsBlock({ section, ctx }: { section: LocationsSection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  const { palette, preview, orgTeams } = ctx
  const [locations, setLocations] = useState<LocationEntry[]>([])
  const [loading, setLoading] = useState(true)
  const extra = section.extra

  useEffect(() => {
    let alive = true
    const teams = orgTeams ?? []
    Promise.all(
      teams.map(async (t): Promise<LocationEntry | null> => {
        try {
          const snap = await getDoc(doc(db, TEAMS_COLLECTION, t.teamId, PUBLIC_PROFILE_SUBCOLLECTION, t.teamId))
          const data = snap.data() as TeamPublicProfile | undefined
          const main = data?.mainAddress
          if (!main) return null
          return {
            id: t.teamId,
            name: main.name || data?.name || t.name,
            address: main.address,
            mapsLink: main.mapsLink,
          }
        } catch (err: unknown) {
          reportPublicLoadFailure('org-site/club-location', err)
          return null
        }
      })
    )
      .then((clubLocations) => {
        if (!alive) return
        const extraLocations: LocationEntry[] = (extra ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          address: e.address,
          mapsLink: e.mapsLink,
        }))
        setLocations([
          ...clubLocations.filter((l): l is LocationEntry => !!l),
          ...extraLocations,
        ])
      })
      .catch((err: unknown) => {
        reportPublicLoadFailure('org-site/locations', err)
        if (alive) setLocations([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [orgTeams, extra])

  const cols = colsClass(section.columns)

  return (
    <section id={section.id} className="py-20" style={{ background: palette.surface }}>
      <div className="mx-auto max-w-5xl px-6">
        <Heading text={section.heading ?? t('headingPlaces')} palette={palette} />
        {section.subheading && (
          <p className="mt-3 text-center" style={{ color: palette.muted }}>
            {section.subheading}
          </p>
        )}
        <div className={`mt-10 grid grid-cols-1 gap-5 ${cols}`}>
          {loading ? (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('loading')}
            </p>
          ) : locations.length === 0 ? (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('emptyLocations')}
            </p>
          ) : (
            locations.map((l) => {
              const href = mapsHref(l.address, l.mapsLink)
              return (
                <div
                  key={l.id}
                  className="flex flex-col rounded-2xl border p-5"
                  style={{ borderColor: palette.border, background: palette.bg }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                      style={{ background: `${palette.accent}1a`, color: palette.accent }}
                    >
                      <MapPin className="h-4 w-4" />
                    </span>
                    <h3 className="text-lg font-semibold" style={{ color: palette.text }}>
                      {l.name}
                    </h3>
                  </div>
                  {l.address && (
                    <p className="mt-3 text-sm" style={{ color: palette.muted }}>
                      {l.address}
                    </p>
                  )}
                  {href && (
                    <a
                      {...linkProps(href, preview, true)}
                      className="mt-4 inline-flex items-center gap-1.5 self-start text-sm font-semibold transition-opacity hover:opacity-70"
                      style={{ color: palette.accent }}
                    >
                      {t('openInMaps')}
                      <ArrowRight className="h-4 w-4" />
                    </a>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Coaches (roster aggregated across opted-in member teams) ────────────────

interface CoachEntry {
  uid: string
  name: string
  photoUrl?: string
  clubName: string
}

function CoachesBlock({ section, ctx }: { section: CoachesSection; ctx: RenderCtx }) {
  const t = useTranslations('Site')
  const { palette, orgTeams } = ctx
  const [coaches, setCoaches] = useState<CoachEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const teams = orgTeams ?? []
    if (teams.length === 0) {
      setCoaches([])
      setLoading(false)
      return
    }
    Promise.all(
      teams.map(async (t): Promise<CoachEntry[]> => {
        try {
          const snap = await getDoc(doc(db, TEAMS_COLLECTION, t.teamId, PUBLIC_PROFILE_SUBCOLLECTION, t.teamId))
          const data = snap.data() as TeamPublicProfile | undefined
          const clubName = data?.name || t.name
          return (data?.coaches ?? []).map((c) => ({ ...c, clubName }))
        } catch (err: unknown) {
          reportPublicLoadFailure('org-site/club-coaches', err)
          return []
        }
      })
    )
      .then((lists) => {
        if (alive) setCoaches(lists.flat())
      })
      .catch((err: unknown) => {
        reportPublicLoadFailure('org-site/coaches', err)
        if (alive) setCoaches([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [orgTeams])

  const cols = colsClass(section.columns)

  return (
    <section id={section.id} className="py-20" style={{ background: palette.bg }}>
      <div className="mx-auto max-w-5xl px-6">
        <Heading text={section.heading ?? t('headingCoaches')} palette={palette} />
        {section.subheading && (
          <p className="mt-3 text-center" style={{ color: palette.muted }}>
            {section.subheading}
          </p>
        )}
        <div className={`mt-10 grid grid-cols-1 gap-5 ${cols}`}>
          {loading ? (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('loading')}
            </p>
          ) : coaches.length === 0 ? (
            <p className="col-span-full text-center text-sm" style={{ color: palette.muted }}>
              {t('emptyCoaches')}
            </p>
          ) : (
            coaches.map((c, i) => (
              <div
                key={`${c.uid}-${i}`}
                className="flex flex-col items-center rounded-2xl border p-6 text-center"
                style={{ borderColor: palette.border, background: palette.surface }}
              >
                <div
                  className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full"
                  style={{ background: palette.accent }}
                >
                  {c.photoUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={c.photoUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-xl font-bold" style={{ color: '#ffffff' }}>
                      {nameInitials(c.name)}
                    </span>
                  )}
                </div>
                <h3 className="mt-4 text-base font-semibold" style={{ color: palette.text }}>
                  {c.name}
                </h3>
                <p className="text-sm" style={{ color: palette.muted }}>
                  {c.clubName}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  )
}

export { ClubsBlock, LocationsBlock, CoachesBlock }
