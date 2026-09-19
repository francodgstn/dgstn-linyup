import 'server-only'
import { cache } from 'react'
import { headers } from 'next/headers'
import { isLinyupOwnHost } from '@linyup/shared'
import { resolveCustomDomainTenant } from './customDomainTenant'
import type { PublicTeamDomain } from '@/app/[locale]/(public)/public/[slug]/PublicTeamProvider'

// ─── Which host a public request came through ─────────────────────────────────
//
// On a studio's OWN domain the addresses are the short ones a visitor sees
// (`/angebot/crossfit`); on the app's own hosts they are the `/public/{slug}/…`
// paths. Both the tenant layout (which puts the answer on the public-team
// context, so any client component can shorten a link) and the website route
// (canonical, hreflang, redirects) ask here, and `cache()` makes that ONE
// lookup per request — itself cached per instance in `customDomainTenant`.

export const resolveRequestHost = cache(async () => {
  const h = await headers()
  // The Worker preserves the visitor's host in `x-linyup-host`; forwarding to
  // App Hosting necessarily overwrites `Host` with the backend's own name.
  const visitorHost = (h.get('x-linyup-host') || h.get('x-forwarded-host') || h.get('host') || '')
    .split(':')[0]
    .toLowerCase()
  const rawHost = h.get('x-forwarded-host') ?? h.get('host')
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const tenant = visitorHost && !isLinyupOwnHost(visitorHost) ? await resolveCustomDomainTenant(visitorHost) : null
  return { visitorHost, tenant, origin: rawHost ? `${proto}://${rawHost}` : undefined }
})

/**
 * What a page needs to write short links — only when the request came through
 * THIS tenant's own domain. Undefined everywhere else, which is what keeps the
 * long path the address on our own hosts.
 */
export async function tenantDomainContext(
  slug: string,
  scope: 'team' | 'org' = 'team'
): Promise<PublicTeamDomain | undefined> {
  const { tenant } = await resolveRequestHost()
  return tenant && tenant.scope === scope && tenant.slug === slug
    ? { tenantLanguage: tenant.language, siteAtRoot: tenant.siteAtRoot }
    : undefined
}
