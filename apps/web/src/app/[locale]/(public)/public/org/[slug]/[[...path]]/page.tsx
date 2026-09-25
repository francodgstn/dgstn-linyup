import type { Metadata, Route } from 'next'
import { cache } from 'react'
import { notFound, permanentRedirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  ORG_SITE_PUBLISHED_COLLECTION,
  customDomainSiteUrl,
  SITE_PAGES_SUBCOLLECTION,
  findSitePageByPath,
  findSiteRedirect,
  publicLocalePrefix,
  publicOrgPath,
  siteI18nDocId,
  sitePageSegments,
  translationSourceHash,
} from '@linyup/shared'
import type {
  OrgPublishedSite,
  OrgSiteSection,
  SiteI18nManifest,
  SitePageDoc,
  SitePageRef,
  SiteRedirect,
  SiteTranslationDoc,
  SiteTranslationUnits,
  UiLanguage,
} from '@linyup/shared'
import { restGetDocument, restRunQuery } from '@/lib/firestoreRest'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { resolveRequestHost, tenantDomainContext } from '@/lib/tenantHostContext'
import PublicOrgSite, { type PublicOrgSiteInitial } from '../PublicOrgSite'

// An organization's public website — its home at /public/org/{slug} and every
// other page directly under it (/public/org/{slug}/{path}). The static `events`
// segment beside this catch-all still wins for /public/org/{slug}/events, and a
// site page may never take that name (TENANT_ROUTE_SEGMENTS).
//
// The team site's twin is (public)/public/[slug]/site/[[...path]]/page.tsx: the
// same REST read, shared by the metadata and the page; the same real 404 and
// permanent redirects; the same server-seeded first render.
export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ locale: string; slug: string; path?: string[] }>
}

/**
 * The published org site for `slug`, over Firestore REST — the web SDK's queries
 * come back EMPTY inside the Next server (CLAUDE.md "Next.js Firebase server
 * reads"). `cache()`d per request, so the metadata and the page share one read.
 */
const fetchOrgSite = cache(async (slug: string): Promise<OrgPublishedSite | null> => {
  try {
    const found = await restRunQuery({
      from: [{ collectionId: ORG_SITE_PUBLISHED_COLLECTION }],
      where: {
        fieldFilter: { field: { fieldPath: 'slug' }, op: 'EQUAL', value: { stringValue: slug } },
      },
      limit: 1,
    })
    return found ? (found.fields as unknown as OrgPublishedSite) : null
  } catch (err: unknown) {
    // Metadata falls back to the generic title and the page to the client read,
    // but never silently — a broken read otherwise masquerades as a missing site.
    reportPublicLoadFailure('org-site/server-read', err)
    return null
  }
})

/**
 * The address of a page of `slug`'s site (`segments` [] ⇒ home) for this
 * request, or undefined when that language has no address here.
 *
 * On the organization's OWN domain it is the short one a visitor sees
 * (`https://verband.ch/ueber-uns`) — its site is always the domain's root —
 * and English on a non-English organization has none (the unprefixed path is
 * the organization's language). On our own hosts the unprefixed path answers
 * in the SITE's language too (proxy.ts), so English there needs its `/en`.
 */
async function orgSiteAddress(
  slug: string,
  locale: string,
  segments: readonly string[],
  siteLanguage: string | undefined
): Promise<string | undefined> {
  const { visitorHost, tenant, origin } = await resolveRequestHost()
  if (tenant && tenant.scope === 'org' && tenant.slug === slug) {
    return (
      customDomainSiteUrl({
        host: visitorHost,
        slug,
        locale,
        tenantLanguage: tenant.language,
        siteAtRoot: true,
        segments,
      }) ?? undefined
    )
  }
  if (!origin) return undefined
  const prefix = locale === 'en' && siteLanguage && siteLanguage !== 'en' ? '/en' : publicLocalePrefix(locale)
  return `${origin}${prefix}${publicOrgPath(slug, segments)}`
}

/** Where an old-site redirect sends a visitor, or null when its page is gone. */
async function redirectTarget(
  to: SiteRedirect['to'],
  site: OrgPublishedSite,
  slug: string,
  locale: string
): Promise<string | null> {
  if (to.kind === 'url') return to.url
  const ref = to.kind === 'page' ? (site.pages ?? []).find((p) => p.id === to.pageId && !p.hidden) : null
  if (to.kind === 'page' && !ref) return null
  const segments = ref ? sitePageSegments(ref.path) : []
  const { tenant } = await resolveRequestHost()
  if (tenant && tenant.scope === 'org' && tenant.slug === slug) {
    return (await orgSiteAddress(slug, locale, segments, site.meta?.language)) ?? null
  }
  // Relative on the app's own hosts: the visitor stays on whichever one they used.
  return `${publicLocalePrefix(locale)}${publicOrgPath(slug, segments)}`
}

/** Whether `locale` has a translation sidecar worth fetching for a manifest. */
function wantsLocale(manifest: SiteI18nManifest | undefined, locale: string): manifest is SiteI18nManifest {
  return !!manifest && locale !== manifest.srcLang && manifest.locales.includes(locale as UiLanguage)
}

// Real SEO / OpenGraph tags from the site's stored meta, or the page's own
// (the client renderer never touches the document head).
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug, path } = await params
  const site = await fetchOrgSite(slug)
  const segments = path ?? []
  const page = site && segments.length ? findSitePageByPath(site.pages, segments) : null

  if (!site || (segments.length > 0 && !page)) {
    const t = await getTranslations({ locale, namespace: 'Site' })
    return { title: t('notFoundTitle') }
  }

  // The base text a translation unit was made from — substituted only while its
  // srcHash still matches, exactly like the render-path resolver. A page's title
  // and SEO live in the page index on the site doc, so they share its sidecar.
  let translated = (_key: string, base: string | undefined) => base
  const manifest = site.i18n
  if (wantsLocale(manifest, locale)) {
    const sidecar = await restGetDocument(`${ORG_SITE_PUBLISHED_COLLECTION}/${siteI18nDocId(site.orgId, locale)}`)
    const units = (sidecar?.fields.units as SiteTranslationUnits | undefined) ?? {}
    translated = (key, base) => {
      if (typeof base !== 'string' || base.trim() === '') return base
      const unit = units[key]
      return unit?.text && unit.srcHash === translationSourceHash(base) ? unit.text : base
    }
  }

  const siteTitle = site.meta?.title || site.name || slug
  const seo = site.meta?.seo
  let title: string
  let description: string | undefined
  if (page) {
    const pageTitle = translated(`page.${page.id}.title`, page.title) ?? page.title
    title = translated(`page.${page.id}.seo.title`, page.seo?.title) || `${pageTitle} | ${siteTitle}`
    // A post's own teaser is a better description than the whole site's.
    description = page.seo?.description
      ? translated(`page.${page.id}.seo.description`, page.seo.description)
      : page.kind === 'post' && page.excerpt
        ? translated(`page.${page.id}.excerpt`, page.excerpt)
        : translated('seo.description', seo?.description)
  } else {
    title = translated('seo.title', seo?.title) || siteTitle
    description = translated('seo.description', seo?.description)
  }
  const isPost = page?.kind === 'post'
  const ogImageUrl = (isPost && page?.coverImageUrl) || seo?.ogImageUrl
  const article = isPost ? { type: 'article' as const, ...(page?.publishedOn ? { publishedTime: page.publishedOn } : {}) } : {}

  const pageSegments = page ? sitePageSegments(page.path) : []
  const url = await orgSiteAddress(slug, locale, pageSegments, site.meta?.language)
  // hreflang — only the locales the site actually carries; x-default is the
  // authoring language, the one never gated on a translation existing.
  let languages: Record<string, string> | undefined
  if (manifest && url) {
    const entries: Record<string, string> = {}
    for (const l of [manifest.srcLang, ...manifest.locales]) {
      const href = await orgSiteAddress(slug, l, pageSegments, site.meta?.language)
      if (href) entries[l] = href
    }
    const xDefault = entries[manifest.srcLang]
    if (xDefault) entries['x-default'] = xDefault
    languages = Object.keys(entries).length ? entries : undefined
  }

  return {
    title,
    description,
    alternates: url ? { canonical: url, ...(languages ? { languages } : {}) } : undefined,
    openGraph: { title, description, url, images: ogImageUrl ? [ogImageUrl] : undefined, ...article },
  }
}

export default async function OrgSiteRoutePage({ params }: Props) {
  const { locale, slug, path } = await params
  const segments = path ?? []
  const site = await fetchOrgSite(slug)

  if (site && segments.length > 0 && !findSitePageByPath(site.pages, segments)) {
    // A path the site does not have: an old URL of the organization's previous
    // website goes to its new page, permanently; anything else is a real 404,
    // status code included, so a crawler drops a deleted page.
    const redirect = findSiteRedirect(site.redirects, `/${segments.join('/')}`)
    const target = redirect ? await redirectTarget(redirect.to, site, slug, locale) : null
    if (target) permanentRedirect(target as Route)
    notFound()
  }

  // The server read failed — the client reads the site itself and renders its
  // own not-found, as this page always did.
  // On the organization's own domain the site's links are the short ones.
  const domain = await tenantDomainContext(slug, 'org')

  if (!site) return <PublicOrgSite slug={slug} path={segments} domain={domain} />

  let units: SiteTranslationUnits | null = null
  if (wantsLocale(site.i18n, locale)) {
    const sidecar = await restGetDocument(`${ORG_SITE_PUBLISHED_COLLECTION}/${siteI18nDocId(site.orgId, locale)}`)
    units = (sidecar?.fields as unknown as SiteTranslationDoc | undefined)?.units ?? null
  }

  const ref = segments.length ? findSitePageByPath(site.pages, segments) : null
  let page: { ref: SitePageRef; sections: OrgSiteSection[] } | null = null
  let pageUnits: SiteTranslationUnits | null = null
  if (ref) {
    const pagesPath = `${ORG_SITE_PUBLISHED_COLLECTION}/${site.orgId}/${SITE_PAGES_SUBCOLLECTION}`
    const pageDoc = await restGetDocument(`${pagesPath}/${ref.id}`)
    if (pageDoc) {
      const decoded = pageDoc.fields as unknown as SitePageDoc<OrgSiteSection>
      page = { ref, sections: decoded.sections ?? [] }
      if (wantsLocale(decoded.i18n, locale)) {
        const pageSidecar = await restGetDocument(`${pagesPath}/${siteI18nDocId(ref.id, locale)}`)
        pageUnits = (pageSidecar?.fields as unknown as SiteTranslationDoc | undefined)?.units ?? null
      }
    }
  }

  const initial: PublicOrgSiteInitial = { site, units, page, pageUnits }
  return <PublicOrgSite slug={slug} path={segments} initial={initial} domain={domain} />
}
