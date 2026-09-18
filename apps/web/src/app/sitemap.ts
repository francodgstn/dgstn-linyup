import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'
import { SITE_PUBLISHED_COLLECTION, customDomainSiteUrl, isLinyupOwnHost, sitePageSegments } from '@linyup/shared'
import { resolveCustomDomainTenant } from '@/lib/customDomainTenant'
import { fetchDocumentFields, restArray, restMap, restString, type RestValue } from '@/lib/publicMetaRest'

// A sitemap for a studio's OWN domain — its website's home, pages and posts, at
// the addresses a visitor sees (`customDomainSiteUrl`), with the other languages
// the site is translated into as alternates.
//
// `/sitemap.xml` passes the custom-domain mapping untouched, so this one route
// answers for every host; the Worker's `X-Linyup-Host` names the studio. The
// app's own hosts have no public sitemap of their own (the marketing site lives
// elsewhere), so they get an empty one — never a list of every studio.
export const dynamic = 'force-dynamic'

const isProduction = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID === 'linyup-prod'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const h = await headers()
  const host = (h.get('x-linyup-host') || h.get('host') || '').split(':')[0].toLowerCase()
  // Non-production hosts are closed to crawlers (robots.ts); an empty sitemap
  // keeps the two from ever disagreeing.
  if (!host || isLinyupOwnHost(host) || !isProduction) return []

  const tenant = await resolveCustomDomainTenant(host)
  if (!tenant || tenant.scope !== 'team') return []

  const fields = await fetchDocumentFields(`${SITE_PUBLISHED_COLLECTION}/${tenant.teamId}`)
  if (!fields) return []

  const manifest = restMap(fields.i18n)
  const srcLang = restString(manifest.srcLang) || tenant.language
  const locales = [
    srcLang,
    ...restArray(manifest.locales)
      .map((value) => value.stringValue)
      .filter((locale): locale is string => !!locale && locale !== srcLang),
  ]
  const updatedAt = (fields.updated_at as RestValue & { timestampValue?: string } | undefined)?.timestampValue

  const entry = (segments: string[], lastModified?: string): MetadataRoute.Sitemap[number] | null => {
    const url = (locale: string) =>
      customDomainSiteUrl({
        host,
        slug: tenant.slug,
        locale,
        tenantLanguage: tenant.language,
        siteAtRoot: tenant.siteAtRoot,
        segments,
      })
    // The domain always answers in the tenant's own language; a locale with no
    // address there (English on a German domain) is left out rather than listed
    // pointing at another language's page.
    const self = url(tenant.language)
    if (!self) return null
    const languages = Object.fromEntries(
      locales.map((locale) => [locale, url(locale)] as const).filter((e): e is readonly [string, string] => !!e[1])
    )
    return {
      url: self,
      ...(lastModified ? { lastModified } : {}),
      ...(Object.keys(languages).length > 1 ? { alternates: { languages } } : {}),
    }
  }

  const pages = restArray(fields.pages).flatMap((value) => {
    const page = restMap(value)
    const path = restString(page.path)
    if (!path || page.hidden?.booleanValue === true) return []
    // A post's own date is its last change as far as a crawler cares.
    const row = entry(sitePageSegments(path), restString(page.publishedOn) || updatedAt)
    return row ? [row] : []
  })

  const home = entry([], updatedAt)
  return home ? [home, ...pages] : pages
}
