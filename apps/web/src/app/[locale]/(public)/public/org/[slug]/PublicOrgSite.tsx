'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { collection, doc, getDoc, query, where, limit, getDocs } from 'firebase/firestore'
import { useLocale, useTranslations } from 'next-intl'
import { db } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { reviveTimestamps } from '@/lib/restTimestamps'
import { publicOrgHrefLocalized } from '@/lib/publicRoutes'
import {
  ORG_SITE_PUBLISHED_COLLECTION,
  SITE_PAGES_SUBCOLLECTION,
  applySiteTranslations,
  findSitePageByPath,
  siteI18nDocId,
  toTenantPublicPath,
} from '@linyup/shared'
import type {
  OrgPublishedSite,
  OrgSiteSection,
  SiteI18nManifest,
  SitePageDoc,
  SitePageRef,
  SiteTranslationDoc,
  SiteTranslationUnits,
} from '@linyup/shared'
import WebsiteRenderer from '@/components/site/WebsiteRenderer'
import type { PublicTeamDomain } from '../../[slug]/PublicTeamProvider'

/** What the server component resolved, so the first render has real content.
 *  Mirrors the team site's `PublicSiteInitial`. */
export interface PublicOrgSiteInitial {
  site: OrgPublishedSite
  units: SiteTranslationUnits | null
  page: { ref: SitePageRef; sections: OrgSiteSection[] } | null
  pageUnits: SiteTranslationUnits | null
}

// An organisation's public site — its home at /public/org/{slug} and every
// other page directly under it. Reads only the fully-public
// org_site_published collection. The team site's twin is
// (public)/public/[slug]/site/PublicSite.tsx; this one has none of its booking,
// member and surface chrome, because an organisation has none of those.
export default function PublicOrgSite({
  slug,
  path = [],
  initial,
  domain,
}: {
  slug: string
  path?: string[]
  /** Present when the server read the site (SSR); absent ⇒ read it here. */
  initial?: PublicOrgSiteInitial
  /** The organisation's own domain, when the request came through it — the
   *  site's links are then the short ones a visitor sees there. */
  domain?: PublicTeamDomain
}) {
  const locale = useLocale()
  const t = useTranslations('Site')
  // Plain `<a href>`s, so each click is a full navigation the domain's rewrite
  // resolves server-side. Anything with no short form (English on a German
  // organisation) keeps its long path, which the domain still serves.
  const shortenHref = useMemo(
    () =>
      domain
        ? (href: string) =>
            toTenantPublicPath(href, { slug, scope: 'org', tenantLanguage: domain.tenantLanguage, siteAtRoot: false })
        : undefined,
    [domain, slug]
  )
  const pathKey = path.join('/')
  // Which slug+locale+path `initial` was computed for — a client-side locale or
  // path change re-runs the server component while this instance stays
  // mounted, so the effect compares keys rather than trusting the first mount.
  const initialKeyRef = useRef<string | null>(initial ? `${slug}:${locale}:${pathKey}` : null)
  const [site, setSite] = useState<OrgPublishedSite | null>(() => (initial ? reviveTimestamps(initial.site) : null))
  const [i18nUnits, setI18nUnits] = useState<SiteTranslationUnits | null>(() =>
    initial ? reviveTimestamps(initial.units) : null
  )
  const [page, setPage] = useState<PublicOrgSiteInitial['page']>(() => (initial ? reviveTimestamps(initial.page) : null))
  const [pageUnits, setPageUnits] = useState<SiteTranslationUnits | null>(() =>
    initial ? reviveTimestamps(initial.pageUnits) : null
  )
  const [loading, setLoading] = useState(!initial)

  useEffect(() => {
    const key = `${slug}:${locale}:${pathKey}`
    if (initial) {
      if (initialKeyRef.current === key) return
      initialKeyRef.current = key
      setSite(reviveTimestamps(initial.site))
      setI18nUnits(reviveTimestamps(initial.units))
      setPage(reviveTimestamps(initial.page))
      setPageUnits(reviveTimestamps(initial.pageUnits))
      setLoading(false)
      return
    }
    // The server read failed — read here instead, the way this page always did.
    let cancelled = false
    setLoading(true)
    async function run() {
      let base: OrgPublishedSite | null = null
      try {
        const snap = await getDocs(
          query(collection(db, ORG_SITE_PUBLISHED_COLLECTION), where('slug', '==', slug), limit(1))
        )
        if (!snap.empty) base = snap.docs[0].data() as OrgPublishedSite
      } catch (err: unknown) {
        reportPublicLoadFailure('org-site/published', err) // terminal not-found, but never silent
      }
      if (cancelled) return
      const wantsLocale = (manifest: SiteI18nManifest | undefined): manifest is SiteI18nManifest =>
        !!manifest && locale !== manifest.srcLang && manifest.locales.includes(locale as (typeof manifest.locales)[number])
      let units: SiteTranslationUnits | null = null
      if (base && wantsLocale(base.i18n)) {
        try {
          const sidecar = await getDoc(doc(db, ORG_SITE_PUBLISHED_COLLECTION, siteI18nDocId(base.orgId, locale)))
          if (sidecar.exists()) units = (sidecar.data() as SiteTranslationDoc).units
        } catch (err: unknown) {
          reportPublicLoadFailure('org-site/i18n-sidecar', err) // base-language text
        }
      }
      // A page other than home: its own doc under the site doc, with its own
      // translation sidecars. A path the site does not have renders not-found.
      const segments = pathKey ? pathKey.split('/') : []
      const ref = base && segments.length ? findSitePageByPath(base.pages, segments) : null
      let loadedPage: PublicOrgSiteInitial['page'] = null
      let loadedPageUnits: SiteTranslationUnits | null = null
      if (base && ref) {
        try {
          const pageSnap = await getDoc(doc(db, ORG_SITE_PUBLISHED_COLLECTION, base.orgId, SITE_PAGES_SUBCOLLECTION, ref.id))
          if (pageSnap.exists()) {
            const pageDoc = pageSnap.data() as SitePageDoc<OrgSiteSection>
            loadedPage = { ref, sections: pageDoc.sections ?? [] }
            if (wantsLocale(pageDoc.i18n)) {
              try {
                const pageSidecar = await getDoc(
                  doc(db, ORG_SITE_PUBLISHED_COLLECTION, base.orgId, SITE_PAGES_SUBCOLLECTION, siteI18nDocId(ref.id, locale))
                )
                if (pageSidecar.exists()) loadedPageUnits = (pageSidecar.data() as SiteTranslationDoc).units
              } catch (err: unknown) {
                reportPublicLoadFailure('org-site/page-i18n-sidecar', err) // base-language text
              }
            }
          }
        } catch (err: unknown) {
          reportPublicLoadFailure('org-site/page', err) // terminal not-found, but never silent
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
  }, [slug, locale, pathKey, initial])

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
        <p className="text-lg font-semibold">{t('notFoundTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('notFoundBody')}</p>
      </div>
    )
  }

  return (
    <WebsiteRenderer
      site={translatedSite}
      page={translatedPage}
      orgId={translatedSite.orgId}
      orgTeams={translatedSite.teams}
      // An org's pages sit directly under its slug — no /site level.
      siteHref={(segments) => publicOrgHrefLocalized(locale, slug, segments)}
      shortenHref={shortenHref}
    />
  )
}
