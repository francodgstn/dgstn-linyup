'use client'

import type { ReactNode } from 'react'
import type { Route } from 'next'
import { ArrowLeft } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { QuickLinks, type QuickLink } from './QuickLinks'
import { Tip } from '@/components/ui/tip'

// Shared page header for list/config pages (Activities, Event types,
// Subscriptions, …). Keeps the title block + primary action consistent.
//
// Navigation back to a hub is intentionally NOT part of this header: the sidebar
// is the single, consistent way back (e.g. the "All public pages" nav item), so
// detail pages don't sprout their own inconsistent up-links.
//
// `quickLinks` is the one exception, and it is a FORWARD link, not an up-link:
// the page that confirms or completes what was just done here (UX-71). See
// QuickLinks for when it earns its place — it is not for every page.
export function PageHeader({
  title,
  back,
  subtitle,
  quickLinks,
  action,
}: {
  title: string
  /** An arrow to the left of the title. ONLY for a page the sidebar cannot
   *  return you from — see the note on the header row below. */
  back?: { href: Route; label: string }
  subtitle?: ReactNode
  quickLinks?: QuickLink[]
  action?: ReactNode
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* Icon only, and the label survives as the accessible name and the
                tooltip — the words beside it were repeating what an arrow next
                to a title already says.

                This is the ONE exception to "no up-links in a header" (see the
                note at the top): the rule assumes the destination has a sidebar
                row to come back from, and a page reached only from other pages
                has none. */}
            {back && (
              <Tip label={back.label}>
                <Link
                  href={back.href}
                  aria-label={back.label}
                  className="-ml-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ArrowLeft className="h-5 w-5" />
                </Link>
              </Tip>
            )}
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {quickLinks && <QuickLinks links={quickLinks} />}
          </div>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-3">{action}</div>}
      </div>
    </div>
  )
}
