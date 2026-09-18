import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { getTranslations } from 'next-intl/server'
import { restGetDocument, restRunQuery } from '@/lib/firestoreRest'
import {
  ORG_SITE_PUBLISHED_COLLECTION,
  publicLocalePrefix,
  siteI18nDocId,
  translationSourceHash,
} from '@linyup/shared'
import type { OrgPublishedSite, SiteTranslationDoc } from '@linyup/shared'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import PublicOrgSite from './PublicOrgSite'

// Public organization website route. Sibling to the team site's static `org`
// segment sitting alongside the dynamic team `/[slug]` root — Next resolves the
// static `org` segment first, so there's no collision. Full-bleed (no app/
// bio-link chrome) and reads only the fully-public org_site_published
// collection. Mirrors (public)/public/[slug]/site/page.tsx.
export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ locale: string; slug: string }>
}

// Resolve a published org site by slug from the fully-public
// org_site_published collection — over Firestore REST. The web SDK's query
// comes back EMPTY inside the Next server runtime (CLAUDE.md "Next.js Firebase
// server reads"), so this read, written with the SDK, found no site at all and
// every org site's <head> said "not found". The team site's route has read the
// same way since it was written.
async function fetchPublishedOrgSite(slug: string): Promise<OrgPublishedSite | null> {
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
    // Metadata falls back to the generic title, but never silently — a broken
    // server-side read otherwise masquerades as a missing site. (The team-site
    // twin, (public)/public/[slug]/site/page.tsx, has said so since it was
    // written; this sibling was the copy that never got the line.)
    reportPublicLoadFailure('org-site/metadata', err)
    return null
  }
}

// Emit real SEO / OpenGraph tags into <head> from the published site's stored
// meta.seo (the client renderer never touches the document head).
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params
  const site = await fetchPublishedOrgSite(slug)

  if (!site) {
    const t = await getTranslations({ locale, namespace: 'Site' })
    return { title: t('notFoundTitle') }
  }

  // No configured base URL — derive the absolute origin from the request so the
  // canonical / og:url survive the future move to a custom domain.
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const path = `/public/org/${slug}`
  const origin = host ? `${proto}://${host}` : undefined
  const localizedUrl = (o: string, l: string) => `${o}${publicLocalePrefix(l)}${path}`
  const url = origin ? localizedUrl(origin, locale) : undefined

  const { seo } = site.meta
  // The base text a stored translation unit was made from — substituted only
  // while its srcHash still matches, exactly like the render-path resolver
  // (applySiteTranslations). A stale or missing unit degrades to the base
  // (authoring-language) SEO text, never to blank metadata.
  let seoTitle = seo?.title
  let description = seo?.description

  const manifest = site.i18n
  if (manifest && locale !== manifest.srcLang && (manifest.locales as string[]).includes(locale)) {
    try {
      const sidecar = await restGetDocument(`${ORG_SITE_PUBLISHED_COLLECTION}/${siteI18nDocId(site.orgId, locale)}`)
      if (sidecar) {
        const units = (sidecar.fields as unknown as SiteTranslationDoc).units
        const titleUnit = units['seo.title']
        const descUnit = units['seo.description']
        if (
          typeof seo?.title === 'string' &&
          seo.title.trim() !== '' &&
          titleUnit?.srcHash === translationSourceHash(seo.title)
        ) {
          seoTitle = titleUnit.text
        }
        if (
          typeof seo?.description === 'string' &&
          seo.description.trim() !== '' &&
          descUnit?.srcHash === translationSourceHash(seo.description)
        ) {
          description = descUnit.text
        }
      }
    } catch (err: unknown) {
      reportPublicLoadFailure('org-site/metadata-i18n', err) // falls back to base-language text
    }
  }

  const title = seoTitle || site.meta.title || site.name
  const ogImageUrl = seo?.ogImageUrl

  // hreflang alternates — only for a site with a translation manifest, and only
  // for the locales it actually carries; x-default points at the authoring
  // language, the one that's never gated on a translation existing.
  const languages: Record<string, string> | undefined =
    manifest && origin
      ? Object.fromEntries([
          ...[manifest.srcLang, ...manifest.locales].map((l) => [l, localizedUrl(origin, l)]),
          ['x-default', localizedUrl(origin, manifest.srcLang)],
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
    },
  }
}

export default async function OrgSiteRoutePage({ params }: Props) {
  const { slug } = await params
  return <PublicOrgSite slug={slug} />
}
