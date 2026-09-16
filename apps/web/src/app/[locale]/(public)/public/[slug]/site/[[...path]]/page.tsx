import type { Metadata } from 'next'
import { cache } from 'react'
import { notFound, permanentRedirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  SITE_PUBLISHED_COLLECTION,
  SITE_PAGES_SUBCOLLECTION,
  customDomainSiteUrl,
  findSiteRedirect,
  findSitePageByPath,
  publicLocalePrefix,
  publicPath,
  publicSubPath,
  siteI18nDocId,
  sitePageSegments,
  translationSourceHash,
  localizedPublicUrl,
  localizedPublicSubUrl,
} from '@linyup/shared'
import type {
  PublishedSite,
  SiteRedirect,
  SiteI18nManifest,
  SitePageDoc,
  SitePageRef,
  SiteTranslationDoc,
  SiteTranslationUnits,
  UiLanguage,
  WebsiteSection,
} from '@linyup/shared'
import { restGetDocument, restRunQuery } from '@/lib/firestoreRest'
import { resolveRequestHost } from '@/lib/tenantHostContext'
import PublicSite, { type PublicSiteInitial } from '../PublicSite'

// Public website route — the home page at /site and every other page of the
// site at /site/{path}. Full-bleed (no app/bio-link chrome) and reads only the
// fully-public site_published collection — structured to later lift onto a
// dedicated subdomain / custom domain with no data-model change.
export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ locale: string; slug: string; path?: string[] }>
}

/**
 * The FULL published site doc for `slug`, decoded from Firestore REST — the
 * one server-side read this route needs (see CLAUDE.md "Next.js Firebase
 * server reads": the web SDK's streamed query responses come back EMPTY
 * inside the Next server runtime). `cache()`d per request+slug so
 * `generateMetadata` (via `fetchSiteMeta` below) and the page component share
 * this ONE read rather than each running their own query.
 */
const fetchFullSite = cache(async (slug: string): Promise<{ teamId: string; site: PublishedSite } | null> => {
  const doc = await restRunQuery({
    from: [{ collectionId: SITE_PUBLISHED_COLLECTION }],
    where: {
      fieldFilter: { field: { fieldPath: 'slug' }, op: 'EQUAL', value: { stringValue: slug } },
    },
    limit: 1,
  })
  if (!doc) return null
  // site_published/{teamId} is a TOP-LEVEL collection — the doc's own id IS
  // the teamId (no parent document to derive it from, unlike public_profile).
  return { teamId: doc.id, site: doc.fields as unknown as PublishedSite }
})

/** The address of a page of `slug`'s site (`segments` [] ⇒ home) for this request. */
async function siteAddress(slug: string, locale: string, segments: readonly string[]): Promise<string | undefined> {
  const { visitorHost, tenant, origin } = await resolveRequestHost()
  if (tenant && tenant.scope === 'team' && tenant.slug === slug) {
    return customDomainSiteUrl({
      host: visitorHost,
      slug,
      locale,
      tenantLanguage: tenant.language,
      siteAtRoot: tenant.siteAtRoot,
      segments,
    })
  }
  if (!origin) return undefined
  return segments.length
    ? localizedPublicSubUrl(origin, locale, slug, 'site', [...segments])
    : localizedPublicUrl(origin, locale, slug, 'site')
}

/** Where an old-site redirect sends a visitor, or null when its page is gone. */
async function redirectTarget(
  to: SiteRedirect['to'],
  site: PublishedSite,
  slug: string,
  locale: string
): Promise<string | null> {
  if (to.kind === 'url') return to.url
  const ref = to.kind === 'page' ? (site.pages ?? []).find((p) => p.id === to.pageId && !p.hidden) : null
  if (to.kind === 'page' && !ref) return null
  const segments = ref ? sitePageSegments(ref.path) : []
  const { tenant } = await resolveRequestHost()
  if (tenant && tenant.slug === slug) return (await siteAddress(slug, locale, segments)) ?? null
  // Relative on the app's own hosts: the visitor stays on whichever one they used.
  return `${publicLocalePrefix(locale)}${segments.length ? publicSubPath(slug, 'site', segments) : publicPath(slug, 'site')}`
}

/** The page index, only as far as metadata and the 404 need it — derived from
 *  the same decoded read `fetchFullSite` already did. */
const fetchSiteMeta = cache(async (slug: string) => {
  const resolved = await fetchFullSite(slug)
  if (!resolved) return null
  const { teamId, site } = resolved
  return {
    teamId,
    name: site.name,
    title: site.meta?.title,
    seoTitle: site.meta?.seo?.title,
    description: site.meta?.seo?.description,
    ogImageUrl: site.meta?.seo?.ogImageUrl,
    i18n: site.i18n,
    pages: (site.pages ?? []).map((p) => ({
      id: p.id,
      path: p.path,
      title: p.title,
      hidden: p.hidden === true,
      seoTitle: p.seo?.title,
      seoDescription: p.seo?.description,
      isPost: p.kind === 'post',
      publishedOn: p.publishedOn,
      coverImageUrl: p.coverImageUrl,
      excerpt: p.excerpt,
    })),
  }
})

// Emit real SEO / OpenGraph tags into <head> from the published site's stored
// meta.seo, or the page's own seo (the client renderer never touches the head).
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug, path } = await params
  const site = await fetchSiteMeta(slug)
  const segments = path ?? []
  const page = site && segments.length ? findSitePageByPath(site.pages, segments) : null

  if (!site || (segments.length > 0 && !page)) {
    const t = await getTranslations({ locale, namespace: 'Site' })
    return { title: t('notFoundTitle') }
  }

  // No configured base URL — the address comes from the request: the short one on
  // a studio's own domain, the public path on ours (see `siteAddress`). Resolved
  // for every locale up front, since hreflang needs them all.
  const pageSegments = page ? sitePageSegments(page.path) : []
  const addressLocales = [locale, ...(site.i18n ? [site.i18n.srcLang, ...site.i18n.locales] : [])]
  const addresses = new Map(
    await Promise.all(addressLocales.map(async (l) => [l, await siteAddress(slug, l, pageSegments)] as const))
  )
  const urlFor = (l: string) => addresses.get(l)
  const url = urlFor(locale)

  // The base text a stored translation unit was made from — substituted only
  // while its srcHash still matches, exactly like the render-path resolver
  // (applySiteTranslations). A stale or missing unit degrades to the base
  // (authoring-language) text, never to blank metadata. A page's title and SEO
  // live in the page index on the site doc, so they share the site's sidecar.
  let translated = (_key: string, base: string | undefined) => base
  const manifest = site.i18n
  if (manifest && site.teamId && locale !== manifest.srcLang && (manifest.locales as string[]).includes(locale)) {
    const sidecar = await restGetDocument(`${SITE_PUBLISHED_COLLECTION}/${siteI18nDocId(site.teamId, locale)}`)
    const units = (sidecar?.fields.units as SiteTranslationUnits | undefined) ?? {}
    translated = (key, base) => {
      if (typeof base !== 'string' || base.trim() === '') return base
      const unit = units[key]
      return unit?.text && unit.srcHash === translationSourceHash(base) ? unit.text : base
    }
  }

  const siteTitle = site.title || site.name || slug
  let title: string
  let description: string | undefined
  if (page) {
    const pageTitle = translated(`page.${page.id}.title`, page.title) ?? page.title
    title = translated(`page.${page.id}.seo.title`, page.seoTitle) || `${pageTitle} | ${siteTitle}`
    // A post's own teaser is a better description than the whole site's.
    description = page.seoDescription
      ? translated(`page.${page.id}.seo.description`, page.seoDescription)
      : page.isPost && page.excerpt
        ? translated(`page.${page.id}.excerpt`, page.excerpt)
        : translated('seo.description', site.description)
  } else {
    title = translated('seo.title', site.seoTitle) || siteTitle
    description = translated('seo.description', site.description)
  }
  // A post shares its own cover, and says it is an article with a date.
  const ogImageUrl = (page?.isPost && page.coverImageUrl) || site.ogImageUrl
  const article = page?.isPost
    ? { type: 'article' as const, ...(page.publishedOn ? { publishedTime: page.publishedOn } : {}) }
    : {}

  // hreflang alternates — only for a site with a translation manifest, and only
  // for the locales it actually carries; x-default points at the authoring
  // language, the one that's never gated on a translation existing.
  const languages: Record<string, string> | undefined =
    manifest && url
      ? Object.fromEntries([
          ...[manifest.srcLang, ...manifest.locales].map((l) => [l, urlFor(l) as string]),
          ['x-default', urlFor(manifest.srcLang) as string],
        ])
      : undefined

  return {
    title,
    description,
    alternates: url ? { canonical: url, ...(languages ? { languages } : {}) } : undefined,
    openGraph: {
      title,
      description,
      url,
      images: ogImageUrl ? [ogImageUrl] : undefined,
      ...article,
    },
  }
}

/** Whether `locale` has a translation sidecar worth fetching for a manifest —
 *  the same test `PublicSite`'s client effect runs. */
function wantsLocale(manifest: SiteI18nManifest | undefined, locale: string): manifest is SiteI18nManifest {
  return !!manifest && locale !== manifest.srcLang && manifest.locales.includes(locale as UiLanguage)
}

export default async function SiteRoutePage({ params }: Props) {
  const { locale, slug, path } = await params
  const segments = path ?? []
  const resolved = await fetchFullSite(slug)

  if (segments.length > 0) {
    // A path the site does not have is a real 404 — status code included, so a
    // crawler drops a deleted page. Only when the site itself was read: a failed
    // read leaves the call to the client, which shows its own not-found.
    if (resolved && !findSitePageByPath(resolved.site.pages, segments)) {
      // An old URL of the website the studio moved here → its new page,
      // permanently, so search results and bookmarks follow. A real page always
      // wins: this runs only where the answer would otherwise be "not found".
      const redirect = findSiteRedirect(resolved.site.redirects, `/${segments.join('/')}`)
      const target = redirect ? await redirectTarget(redirect.to, resolved.site, slug, locale) : null
      if (target) permanentRedirect(target)
      notFound()
    }
  }

  if (!resolved) {
    // REST failed (or the site truly doesn't exist) — let the client component
    // run its own query and render its own not-found, exactly as before this
    // change.
    return <PublicSite slug={slug} path={segments} />
  }

  const { teamId, site } = resolved

  let units: SiteTranslationUnits | null = null
  if (wantsLocale(site.i18n, locale)) {
    const sidecar = await restGetDocument(`${SITE_PUBLISHED_COLLECTION}/${siteI18nDocId(teamId, locale)}`)
    units = (sidecar?.fields as unknown as SiteTranslationDoc | undefined)?.units ?? null
  }

  const ref = segments.length ? findSitePageByPath(site.pages, segments) : null
  let page: { ref: SitePageRef; sections: WebsiteSection[] } | null = null
  let pageUnits: SiteTranslationUnits | null = null
  if (ref) {
    const pageDoc = await restGetDocument(`${SITE_PUBLISHED_COLLECTION}/${teamId}/${SITE_PAGES_SUBCOLLECTION}/${ref.id}`)
    if (pageDoc) {
      const decoded = pageDoc.fields as unknown as SitePageDoc
      page = { ref, sections: decoded.sections ?? [] }
      if (wantsLocale(decoded.i18n, locale)) {
        const pageSidecar = await restGetDocument(
          `${SITE_PUBLISHED_COLLECTION}/${teamId}/${SITE_PAGES_SUBCOLLECTION}/${siteI18nDocId(ref.id, locale)}`
        )
        pageUnits = (pageSidecar?.fields as unknown as SiteTranslationDoc | undefined)?.units ?? null
      }
    }
  }

  const initial: PublicSiteInitial = { site, units, page, pageUnits }
  return <PublicSite slug={slug} path={segments} initial={initial} />
}
