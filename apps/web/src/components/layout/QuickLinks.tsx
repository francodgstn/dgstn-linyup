'use client'

/**
 * Related links — one line under a page's main heading, naming the other pages
 * that confirm or complete what this page just did (UX-71).
 *
 * IT USED TO BE A PROMPT, and the prompt was the feature: "Check what a member
 * actually pays" says WHY you would open Pricing right now, which a menu never
 * can. It was changed to the destination's NAME on 2026-08-25 because the
 * sentences were long enough to wrap under the title and crowd it — and a line
 * that crowds the heading is a line people stop reading, which costs more than
 * the "why" was buying. The trade is real and is written down here so it can be
 * reversed knowingly rather than rediscovered.
 *
 * The names come from the `Nav` namespace, NOT from copy of their own: a page's
 * name lives in one place, so this line and the sidebar cannot disagree about
 * what a destination is called.
 *
 * BEHIND AN ICON, BESIDE THE TITLE (Franco, 2026-09-25). It was a full line
 * under the heading — "Related: A · B · C" — and a line on every page that has
 * one is space spent on a shortcut that is used now and then, not every visit.
 * It is now a small link icon right after the page title; hover or click opens
 * the same names in a popover. So a call site puts it IN THE TITLE ROW, next to
 * the <h1> (PageHeader does), never on a line of its own.
 *
 * Rules of use, deliberately restrictive:
 *  - NOT on every page. Only where the destination genuinely verifies or
 *    completes the work just done. A line of links on every heading is chrome,
 *    and chrome stops being read.
 *  - Up to FOUR. Names are short, so four fit where three sentences did not.
 *  - Shown at every width now: an icon costs no line, so the reason it was
 *    hidden on a phone (pushing content below the fold) is gone.
 *  - Point at the CANONICAL route. `/offer/subscriptions` and
 *    `/offer/affiliations` are redirect stubs — link `/offer/plans?tab=…`, which
 *    `useTabParam`/the plans hub reads directly.
 */

import type { Route } from 'next'
import { useTranslations } from 'next-intl'
import { Link2 } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export type QuickLink = {
  href: Route
  /** The destination's NAME, from the `Nav` namespace — not a sentence. */
  label: string
}

export function QuickLinks({ links }: { links: QuickLink[] }) {
  const t = useTranslations('QuickLinks')
  if (links.length === 0) return null
  // Four is the cap the rules above state. Silently dropping the fifth would
  // hide a call site's mistake; the cap is enforced where it is declared.
  const shown = links.slice(0, 4)
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        aria-label={t('relatedPages')}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
      >
        <Link2 className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 gap-1 p-1.5">
        <p className="px-2 pb-0.5 pt-1 text-xs font-medium text-muted-foreground">{t('relatedPages')}</p>
        {shown.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            {link.label}
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  )
}
