import type { Metadata } from 'next'
import { cache } from 'react'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  SITE_PUBLISHED_COLLECTION,
  findSitePageByPath,
  siteI18nDocId,
  sitePageSegments,
  translationSourceHash,
  localizedPublicUrl,
  localizedPublicSubUrl,
} from '@linyup/shared'
import type { SiteI18nManifest, UiLanguage } from '@linyup/shared'
import { restString as str, restMap as map, restArray, fetchDocumentFields } from '@/lib/publicMetaRest'
import type { RestValue } from '@/lib/publicMetaRest'
import PublicSite from '../PublicSite'

// Public website route — the home page at /site and every other page of the
// site at /site/{path}. Full-bleed (no app/bio-link chrome) and reads only the
// fully-public site_published collection — structured to later lift onto a
// dedicated subdomain / custom domain with no data-model change.
export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ locale: string; slug: string; path?: string[] }>
}

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
const USE_EMULATORS = process.env.NEXT_PUBLIC_USE_EMULATORS === 'true'

function parseManifest(v?: RestValue): SiteI18nManifest | undefined {
  const fields = map(v)
  const srcLang = str(fields.srcLang)
  if (!srcLang) return undefined
  const locales = restArray(fields.locales)
    .map((x) => x.stringValue)
    .filter((x): x is string => !!x)
  return { srcLang: srcLang as UiLanguage, locales: locales as UiLanguage[] }
}

/** The page index, only as far as metadata and the 404 need it. */
function parsePages(v?: RestValue) {
  return restArray(v).flatMap((entry) => {
    const fields = map(entry)
    const id = str(fields.id)
    const path = str(fields.path)
    const title = str(fields.title)
    if (!id || !path || !title) return []
    const seo = map(fields.seo)
    return [
      {
        id,
        path,
        title,
        hidden: fields.hidden?.booleanValue === true,
        seoTitle: str(seo.title),
        seoDescription: str(seo.description),
        isPost: str(fields.kind) === 'post',
        publishedOn: str(fields.publishedOn),
        coverImageUrl: str(fields.coverImageUrl),
        excerpt: str(fields.excerpt),
      },
    ]
  })
}

// Resolve the published site's public SEO fields by slug via the Firestore REST
// API. Deliberately NOT the web SDK: inside the Next server runtime the SDK's
// streamed query responses come back empty (fetch-stream buffering), which made
// every page title fall back to "Site not found". A single unauthenticated REST
// read (rules: public) is dependency-free and works in any server runtime.
// `cache`d: metadata and the page's 404 check share one read per request.
const fetchSiteMeta = cache(async (slug: string) => {
  try {
    const base = USE_EMULATORS
      ? `http://${process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080'}/v1`
      : 'https://firestore.googleapis.com/v1'
    const key = process.env.NEXT_PUBLIC_FIREBASE_API_KEY
    const url =
      `${base}/projects/${PROJECT_ID}/databases/(default)/documents:runQuery` +
      (!USE_EMULATORS && key ? `?key=${key}` : '')
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: SITE_PUBLISHED_COLLECTION }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'slug' },
              op: 'EQUAL',
              value: { stringValue: slug },
            },
          },
          limit: 1,
        },
      }),
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`runQuery HTTP ${res.status}`)
    const rows = (await res.json()) as {
      document?: { name?: string; fields?: Record<string, RestValue> }
    }[]
    const document = rows.find((r) => r.document)?.document
    const fields = document?.fields
    if (!fields) return null
    // The doc id IS the teamId — pulled off the resource name (…/documents/
    // site_published/{teamId}) rather than stored redundantly in a field.
    const teamId = document?.name?.split('/').pop()
    const meta = map(fields.meta)
    const seo = map(meta.seo)
    return {
      teamId,
      name: str(fields.name),
      title: str(meta.title),
      seoTitle: str(seo.title),
      description: str(seo.description),
      ogImageUrl: str(seo.ogImageUrl),
      i18n: parseManifest(fields.i18n),
      pages: parsePages(fields.pages),
    }
  } catch (e) {
    // Metadata falls back to the generic title, but never silently — a broken
    // server-side read otherwise masquerades as a missing site.
    console.error('[public-site] metadata fetch failed:', e)
    return null
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

  // No configured base URL — derive the absolute origin from the request so the
  // canonical / og:url survive the future move to a custom domain.
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const origin = host ? `${proto}://${host}` : undefined
  const urlFor = (l: string) =>
    !origin
      ? undefined
      : page
        ? localizedPublicSubUrl(origin, l, slug, 'site', sitePageSegments(page.path))
        : localizedPublicUrl(origin, l, slug, 'site')
  const url = urlFor(locale)

  // The base text a stored translation unit was made from — substituted only
  // while its srcHash still matches, exactly like the render-path resolver
  // (applySiteTranslations). A stale or missing unit degrades to the base
  // (authoring-language) text, never to blank metadata. A page's title and SEO
  // live in the page index on the site doc, so they share the site's sidecar.
  let translated = (_key: string, base: string | undefined) => base
  const manifest = site.i18n
  if (manifest && site.teamId && locale !== manifest.srcLang && (manifest.locales as string[]).includes(locale)) {
    const sidecarFields = await fetchDocumentFields(
      `${SITE_PUBLISHED_COLLECTION}/${siteI18nDocId(site.teamId, locale)}`
    )
    const units = map(sidecarFields?.units)
    translated = (key, base) => {
      if (typeof base !== 'string' || base.trim() === '') return base
      const unit = map(units[key])
      const text = str(unit.text)
      return text && str(unit.srcHash) === translationSourceHash(base) ? text : base
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
    manifest && origin
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

export default async function SiteRoutePage({ params }: Props) {
  const { slug, path } = await params
  const segments = path ?? []
  if (segments.length > 0) {
    // A path the site does not have is a real 404 — status code included, so a
    // crawler drops a deleted page. Only when the site itself was read: a failed
    // read leaves the call to the client, which shows its own not-found.
    const site = await fetchSiteMeta(slug)
    if (site && !findSitePageByPath(site.pages, segments)) notFound()
  }
  return <PublicSite slug={slug} path={segments} />
}
