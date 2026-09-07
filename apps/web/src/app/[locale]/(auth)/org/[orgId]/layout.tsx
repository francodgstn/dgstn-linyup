'use client'

/**
 * THE ORGANISATION IS A SCOPE, NOT A SECTION — so this layout is thin.
 *
 * It used to render eleven destinations in one horizontal tab strip with no
 * wrap and no scroll: about 1100–1400px of tabs in the ~1000px a 1280 viewport
 * leaves beside the sidebar, and unusable on a phone. The overflow was the
 * visible failure; the structural one was that eleven flat tabs are an entire
 * application's navigation, not a feature area's.
 *
 * Both halves of that now live where a studio's equivalents live: the working
 * destinations are SIDEBAR ROWS (the shell renders them when the URL is in org
 * scope), and everything configurational is behind the RAIL below. The
 * strip and the "← Back to dashboard" link are gone — the second because it
 * framed the organisation as a modal detour rather than a place you work, which
 * is exactly the framing this design rejects.
 *
 * Full reasoning: docs/org-navigation.md. The catalogue: lib/org-nav.ts.
 */

import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Link, usePathname } from '@/i18n/navigation'
import { OrgProvider, useOrg } from '@/contexts/OrgContext'
import { OrgRail } from '@/components/org/OrgRail'
import { ChevronLeft } from 'lucide-react'
import type { Route } from 'next'
import { ORG_MANAGE_PATH, isOrgManageRoot, orgHref, orgRailSegment } from '@/lib/org-nav'

/*
 * ── THE LAYOUT NO LONGER TITLES THE PAGE, AND MUST NOT AGAIN ────────────────
 *
 * It used to, via an `OrgPageHeading` that read the catalogue and printed the
 * destination's label unless the entry carried `ownsHeader: true`. The flag was
 * the bug: it had to be REMEMBERED for every page that titled itself, it was set
 * on five entries, and thirteen of the fourteen org pages title themselves. So
 * eight pages rendered their name twice — a large heading from here and the
 * page's own smaller one directly beneath it (Franco, 2026-08-28: "some pages
 * still show some duplicated header").
 *
 * The default was simply the wrong way round, and a flag whose absence is
 * invisible will keep being forgotten. Every page now owns its heading through
 * the shared `PageHeader`, exactly as a studio's pages do — one `<h1>`, at one
 * size, with the subtitle and the primary action the layout could never carry.
 */

function OrgShell({ orgId, children }: { orgId: string; children: React.ReactNode }) {
  const t = useTranslations('Org')
  const pathname = usePathname()
  const { userRole, loading: roleLoading } = useOrg()

  // A MEMBER STUDIO HAS NO RAIL.
  //
  // Whether to render the management shell was decided from the PATHNAME alone,
  // so somebody with no seat in the organisation — arriving at `/org/{id}/ranking`
  // from Settings → Team, which is a legitimate link — was handed the rail and
  // with it every destination `ORG_STUDIO_NAV_ITEMS` deliberately withholds
  // (Franco, 2026-08-28). `OrgRail` filters `adminOnly`, which separates an
  // org_admin from an org_viewer; it cannot separate either from a person who is
  // not a member at all, and that is a different question — so it is answered
  // here, beside the decision to render the shell in the first place.
  //
  // The page itself still renders, full width with its own heading: those links
  // promise the ranking scale, and the scale is genuinely readable by a member
  // studio (`firestore.rules` admits `currentTeamInOrg` to the org document).
  const onRailRoute = orgRailSegment(pathname) !== null && userRole != null

  // WAIT rather than guess. On a rail route the shell would otherwise render
  // for a beat and then vanish once the role arrives, which reads as the app
  // taking something away.
  if (roleLoading && orgRailSegment(pathname) !== null) return null

  // A sidebar row renders full-width, exactly as a studio's own pages do. Only
  // the rail destinations get the master-detail shell.
  if (!onRailRoute) {
    return <>{children}</>
  }

  // `/manage` is the rail's own index, exactly as `/settings` is the studio's:
  // on a phone the rail IS that page and the detail is hidden; on a section the
  // detail is the page and the rail is hidden. Desktop always shows both.
  //
  // This replaced a mobile DISCLOSURE that existed only because the org had no
  // index route to be the index of. It does now, so the org rail behaves like
  // the studio one instead of like a special case.
  const isRailRoot = isOrgManageRoot(pathname)

  return (
    <div className="md:flex md:gap-8">
      <aside className={`md:w-60 md:shrink-0 ${isRailRoot ? 'block' : 'hidden md:block'}`}>
        <div className="md:sticky md:top-6">
          <OrgRail orgId={orgId} />
        </div>
      </aside>

      <div className={`min-w-0 flex-1 ${isRailRoot ? 'hidden md:block' : 'block'}`}>
        {!isRailRoot && (
          <Link
            href={orgHref(orgId, ORG_MANAGE_PATH) as Route}
            className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:hidden"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('manageTitle')}
          </Link>
        )}
        {children}
      </div>
    </div>
  )
}

export default function OrgLayout({ children }: { children: React.ReactNode }) {
  const { orgId } = useParams<{ orgId: string }>()
  return (
    <OrgProvider orgId={orgId}>
      <OrgShell orgId={orgId}>{children}</OrgShell>
    </OrgProvider>
  )
}
