'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { collection, doc, getDoc, query, where, limit, getDocs } from 'firebase/firestore'
import { useLocale, useTranslations } from 'next-intl'
import { db } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import {
  SITE_PAGES_SUBCOLLECTION,
  SITE_PUBLISHED_COLLECTION,
  applySiteTranslations,
  findSitePageByPath,
  siteI18nDocId,
  parseDocId,
  parseDateKey,
  parseSlug,
  resolveSiteSurfaceLinks,
  routableSurfaces,
} from '@linyup/shared'
import type {
  PublishedSite,
  PublicSurface,
  SiteI18nManifest,
  SitePageDoc,
  SitePageRef,
  SiteTranslationDoc,
  SiteTranslationUnits,
  WebsiteSection,
} from '@linyup/shared'
import { useRouter } from '@/i18n/navigation'
import { publicHref, publicHrefLocalized } from '@/lib/publicRoutes'
import { usePublicTeam } from '../PublicTeamProvider'
import { usePublicContactAuth } from '../PublicContactAuthProvider'
import WebsiteRenderer from '@/components/site/WebsiteRenderer'
import { BookingOverlay, type BookIntent } from '@/components/booking/BookingOverlay'
import { takeBookingConfirmed } from '@/lib/bookingReturn'

// Resolves a published site by slug from the fully-public site_published
// collection — no auth, no restricted data. This is the single read a future
// headless website app (subdomain / custom domain) would perform.
//
// It is also the ONLY place in the website render chain that sits inside
// `PublicTeamProvider` (via the /public/[slug] layout) and outside the embed, so
// it is where the booking overlay is hosted. The builder canvas and the embed
// render the same blocks without a provider and must never receive `onBook`.
//
// `path` names a page of the site other than home ([] ⇒ home). Every page is its
// own route, so moving between pages remounts this component — see the note on
// full-page navigation in WebsiteRenderer.
export default function PublicSite({ slug, path = [] }: { slug: string; path?: string[] }) {
  const { team } = usePublicTeam()
  const { isAuthenticated, contact, openSignIn } = usePublicContactAuth()
  const locale = useLocale()
  const router = useRouter()
  // Standalone nav labels, NOT PublicSurfaceLinks — those are sentence fragments
  // fused with a preposition ("zum Shop") for the "To {name}" back links.
  const tSurfaces = useTranslations('PublicSurfaceNav')
  const tSpace = useTranslations('Space')
  const tSite = useTranslations('Site')
  const [site, setSite] = useState<PublishedSite | null>(null)
  const [i18nUnits, setI18nUnits] = useState<SiteTranslationUnits | null>(null)
  const [page, setPage] = useState<{ ref: SitePageRef; sections: WebsiteSection[] } | null>(null)
  const [pageUnits, setPageUnits] = useState<SiteTranslationUnits | null>(null)
  const [loading, setLoading] = useState(true)
  // A stable dependency for the load effect — the array itself is new each render.
  const pathKey = path.join('/')
  const [bookIntent, setBookIntent] = useState<BookIntent | null>(null)
  // The session a real, verified payment confirmed — NOT a boolean: pinning it to
  // the id stops the confirmation leaking onto a LATER, different booking if the
  // visitor opens another class while this page is still mounted.
  // Set only when /pay/result vouched for the payment, never from the `?booked=1`
  // query, which anyone can put in a link. See bookingReturn.ts.
  const [paidSessionId, setPaidSessionId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      let base: PublishedSite | null = null
      try {
        const snap = await getDocs(
          query(collection(db, SITE_PUBLISHED_COLLECTION), where('slug', '==', slug), limit(1))
        )
        if (!snap.empty) base = snap.docs[0].data() as PublishedSite
      } catch (err: unknown) {
        reportPublicLoadFailure('site/published', err) // terminal not-found, but never silent
      }
      if (cancelled) return
      // Fetch the sidecar (if any) BEFORE first paint, in the same loading
      // state as the base fetch — a base-then-translated flash reads as a
      // flicker, not localization. Units are resolved locally and committed in
      // ONE batch with the site: a per-run reset, so a locale switch (this
      // component is NOT remounted when only the [locale] param changes) can
      // never leave the PREVIOUS locale's units applied — srcLang or a locale
      // with no sidecar degrades to base text, not to the last language viewed.
      const wantsLocale = (manifest: SiteI18nManifest | undefined): manifest is SiteI18nManifest =>
        !!manifest && locale !== manifest.srcLang && manifest.locales.includes(locale as (typeof manifest.locales)[number])
      let units: SiteTranslationUnits | null = null
      if (base && wantsLocale(base.i18n)) {
        try {
          const sidecarSnap = await getDoc(doc(db, SITE_PUBLISHED_COLLECTION, siteI18nDocId(base.teamId, locale)))
          if (sidecarSnap.exists()) {
            units = (sidecarSnap.data() as SiteTranslationDoc).units
          }
        } catch (err: unknown) {
          reportPublicLoadFailure('site/i18n-sidecar', err) // falls back to base-language text
        }
      }

      // A page other than home: its sections are a doc of their own under the
      // site doc, with translation sidecars beside it. A path the site does not
      // have renders not-found, exactly like a slug with no site.
      const segments = pathKey ? pathKey.split('/') : []
      const ref = base && segments.length ? findSitePageByPath(base.pages, segments) : null
      let loadedPage: { ref: SitePageRef; sections: WebsiteSection[] } | null = null
      let loadedPageUnits: SiteTranslationUnits | null = null
      if (base && ref) {
        try {
          const pageSnap = await getDoc(doc(db, SITE_PUBLISHED_COLLECTION, base.teamId, SITE_PAGES_SUBCOLLECTION, ref.id))
          if (pageSnap.exists()) {
            const pageDoc = pageSnap.data() as SitePageDoc
            loadedPage = { ref, sections: pageDoc.sections ?? [] }
            if (wantsLocale(pageDoc.i18n)) {
              try {
                const pageSidecar = await getDoc(
                  doc(db, SITE_PUBLISHED_COLLECTION, base.teamId, SITE_PAGES_SUBCOLLECTION, siteI18nDocId(ref.id, locale))
                )
                if (pageSidecar.exists()) loadedPageUnits = (pageSidecar.data() as SiteTranslationDoc).units
              } catch (err: unknown) {
                reportPublicLoadFailure('site/page-i18n-sidecar', err) // base-language text
              }
            }
          }
        } catch (err: unknown) {
          reportPublicLoadFailure('site/page', err) // terminal not-found, but never silent
        }
      }
      if (cancelled) return
      setSite(segments.length && !loadedPage ? null : base)
      setI18nUnits(units)
      setPage(loadedPage)
      setPageUnits(loadedPageUnits)
      setLoading(false)
    }
    run()
    return () => {
      cancelled = true
    }
  }, [slug, locale, pathKey])

  // The ONE resolver (packages/shared) — never re-derive translated fields here.
  const translatedSite = useMemo(() => (site ? applySiteTranslations(site, i18nUnits) : null), [site, i18nUnits])
  const translatedPage = useMemo(() => {
    if (!page) return undefined
    return {
      // The page's title lives in the site's index, translated with the site.
      ref: translatedSite?.pages?.find((p) => p.id === page.ref.id) ?? page.ref,
      sections: applySiteTranslations({ sections: page.sections }, pageUnits).sections,
    }
  }, [page, pageUnits, translatedSite])

  // Reopen the overlay from the URL, so a refresh or a shared link lands the
  // visitor back where they were instead of on a bare website. Same param names
  // as the canonical /booking route — one contract, two hosts.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const apply = () => {
      const params = new URLSearchParams(window.location.search)
      if (!params.has('book')) {
        setBookIntent(null)
        return
      }
      // Attacker-supplied like any inbound param — a crafted link must not put
      // an arbitrary id into a Firestore path.
      const sessionId = parseDocId(params.get('session'))
      const appointmentId = parseDocId(params.get('appointment'))
      const activitySlug = parseSlug(params.get('activity'))
      setBookIntent(
        sessionId
          ? { kind: 'session', sessionId }
          : appointmentId
            ? {
                kind: 'appointment',
                activityId: appointmentId,
                providerId: parseDocId(params.get('provider')),
                date: parseDateKey(params.get('date')),
              }
            : activitySlug
              ? { kind: 'activity', activitySlug }
              : { kind: 'root' }
      )
    }
    apply()
    // Read-and-clear once on mount: a reload must not replay the confirmation.
    const onMount = new URLSearchParams(window.location.search)
    if (onMount.has('booked') && takeBookingConfirmed()) {
      setPaidSessionId(parseDocId(onMount.get('session')) ?? null)
    }
    window.addEventListener('popstate', apply)
    return () => window.removeEventListener('popstate', apply)
  }, [])

  /** Mirror the open panel into the URL, so reload/share reopen the same thing. */
  const writeBookUrl = (intent: BookIntent, mode: 'push' | 'replace') => {
    const params = new URLSearchParams(window.location.search)
    params.set('book', '1')
    params.delete('session')
    params.delete('activity')
    params.delete('appointment')
    params.delete('provider')
    params.delete('date')
    if (intent.kind === 'session') params.set('session', intent.sessionId)
    if (intent.kind === 'activity') params.set('activity', intent.activitySlug)
    if (intent.kind === 'appointment') {
      params.set('appointment', intent.activityId)
      if (intent.providerId) params.set('provider', intent.providerId)
      if (intent.date) params.set('date', intent.date)
    }
    const url = `${window.location.pathname}?${params.toString()}`
    // Spread the existing state — the App Router keeps its route tree there.
    const state = { ...(window.history.state ?? {}) }
    if (mode === 'push') window.history.pushState(state, '', url)
    else window.history.replaceState(state, '', url)
  }

  // Opening pushes a history entry so Back closes the panel; closing pops it, so
  // the two stay symmetric and the stack never drifts.
  const openBooking = useCallback(
    (intent: BookIntent) => {
      setBookIntent(intent)
      writeBookUrl(intent, 'push')
    },
    []
  )

  /**
   * Swap the panel from the class funnel to the appointment picker in place.
   *
   * `replace`, not `push`: the visitor is refining the SAME booking intent, not
   * taking a step they should be able to Back out of into a half-state — Back
   * should still close the overlay in one press.
   */
  const switchToAppointments = useCallback((activityId: string) => {
    const intent: BookIntent = { kind: 'appointment', activityId }
    setBookIntent(intent)
    writeBookUrl(intent, 'replace')
  }, [])

  const closeBooking = useCallback(() => {
    setBookIntent(null)
    const params = new URLSearchParams(window.location.search)
    if (params.has('book')) {
      // Pop the entry `openBooking` pushed, so Back doesn't have to be pressed
      // twice and the site's own scroll position is restored.
      window.history.back()
    }
  }, [])

  // Cross-surface reachability, derived from what's actually live — no studio
  // configuration, no new data model. The website deliberately keeps its own
  // chrome (PublicContactBar opts out of /site), so these render as the site's
  // own palette-styled nav entries rather than the floating pill.
  const surfaceLinks = useMemo(() => {
    // `routableSurfaces`, not the raw mirror: the shop route renders a
    // read-only price list when the studio has no till, so its nav entry is
    // still a destination.
    const live = routableSurfaces(team.active_public_surfaces)
    const candidates: PublicSurface[] = ['shop', 'space', 'documents']
    const liveSurfaces = candidates.filter((s) => live?.[s as keyof typeof live])
    // Studio overrides (hide / relabel / reorder) applied over what's live.
    return resolveSiteSurfaceLinks(translatedSite?.meta.header, liveSurfaces, (s) => tSurfaces(s)).map(
      ({ surface, label }) => ({
        // `surface` is carried so a stored menu item can resolve its own href —
        // the renderer looks links up by it rather than re-deriving URLs.
        surface,
        href: publicHrefLocalized(locale, slug, surface, { from: 'site' }),
        label,
      })
    )
  }, [team.active_public_surfaces, translatedSite?.meta.header, locale, slug, tSurfaces])

  const memberControl = useMemo(
    () =>
      // Absent ⇒ shown; only an explicit `false` hides it.
      translatedSite?.meta.header.showSignIn === false
        ? undefined
        : isAuthenticated && contact
          ? {
              label: tSpace('openSpace'),
              // `from: 'site'` — the same stamp every other cross-surface link
              // from this page carries. Without it PublicReturnBar falls back to
              // the team's DEFAULT surface, so a member who opened her portal
              // from the website was returned to the bio-link instead.
              onClick: () => router.push(publicHref(slug, 'space', { from: 'site' })),
            }
          : { label: tSpace('signIn'), onClick: () => openSignIn() },
    [translatedSite?.meta.header.showSignIn, isAuthenticated, contact, tSpace, router, slug, openSignIn]
  )

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!translatedSite) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 px-4 text-center">
        <p className="text-lg font-semibold">{tSite('notFoundTitle')}</p>
        <p className="text-sm text-muted-foreground">{tSite('notFoundBody')}</p>
      </div>
    )
  }

  return (
    <>
      <WebsiteRenderer
        site={translatedSite}
        page={translatedPage}
        onBook={openBooking}
        surfaceLinks={surfaceLinks}
        memberControl={memberControl}
        paymentsEnabled={team.payments_enabled === true}
      />
      <BookingOverlay
        slug={slug}
        intent={bookIntent}
        paidSessionId={paidSessionId}
        onSwitchToAppointments={switchToAppointments}
        onClose={closeBooking}
      />
    </>
  )
}
