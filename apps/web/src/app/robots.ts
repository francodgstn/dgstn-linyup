import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'
import { isLinyupOwnHost } from '@linyup/shared'
import { resolveCustomDomainTenant } from '@/lib/customDomainTenant'

// Crawler policy, the counterpart to the `robots` metadata in layout.tsx. The
// meta tag only takes effect once a crawler has fetched the page; this stops it
// fetching non-production hosts at all.
//
// Same production test as the layout, and for the same reason — derived from the
// Firebase project so it cannot disagree with which backend the app serves.
//
// Production stays permissive but still hides the authenticated app and the
// per-tenant token URLs: none of it is useful in search, and the invitation and
// contact-update links are effectively capability URLs.
//
// A studio's OWN domain answers too (`/robots.txt` passes the custom-domain
// mapping untouched; the Worker's `X-Linyup-Host` names the studio): there the
// whole site is theirs and public, so it points crawlers at that domain's
// sitemap (sitemap.ts) and keeps only the machinery out.
export const dynamic = 'force-dynamic'

export default async function robots(): Promise<MetadataRoute.Robots> {
  const isProduction = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID === 'linyup-prod'

  if (!isProduction) {
    return { rules: [{ userAgent: '*', disallow: '/' }] }
  }

  const h = await headers()
  const host = (h.get('x-linyup-host') || h.get('host') || '').split(':')[0].toLowerCase()
  if (host && !isLinyupOwnHost(host) && (await resolveCustomDomainTenant(host))) {
    return {
      rules: [
        {
          userAgent: '*',
          allow: '/',
          disallow: ['/api/', '/pay/', '/embed/', '/manage-booking', '/contact-update'],
        },
      ],
      sitemap: `https://${host}/sitemap.xml`,
    }
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/dashboard',
          '/settings',
          '/contacts',
          '/schedule',
          '/bookings',
          '/payments',
          '/public/event-invitation',
          '/public/team-invitation',
        ],
      },
    ],
  }
}
