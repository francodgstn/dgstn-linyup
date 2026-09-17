'use client'

/**
 * FIGURES — the dashboard's numbers, and the ONE place their shell is defined.
 *
 * A CARD on the dashboard means a bounded thing you can scroll, page or click
 * INTO: the agenda is a `max-h` scroll region, the discover panel owns tabs and
 * their state, the roster and demographics each own a view `Select`, and a chart
 * needs a plotting surface. A bare number has none of that. Eight of them used
 * to be eight accent-bordered boxes — four "stats" on the page plus four in the
 * finance block — which framed nothing and made a five-row payments list
 * indistinguishable from a headline figure. They sit on the background now.
 *
 * This module exists because the shell was written TWICE (once in the dashboard
 * page, once in `DashboardFinanceSection`) and the two drifted: the money figure
 * rendered at `text-3xl` while every other figure rendered at `text-4xl`, so
 * takings were the smallest number on a dashboard opened to look at takings. One
 * owner, so that cannot recur.
 */

import type React from 'react'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * One figure: a caption with its icon, and whatever number goes under it.
 *
 * The caption is deliberately WEAKER than `SectionHeading`. Both used to be
 * `font-semibold uppercase tracking-wider text-muted-foreground` at 12px and
 * 11px, so the page's highest-level label was typeset as its smallest.
 */
export function Figure({
  title,
  icon: Icon,
  href,
  children,
}: {
  title: string
  icon: React.ElementType
  href?: string
  children: React.ReactNode
}) {
  const inner = (
    <div className="h-full">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-primary/60" />
        <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
      </div>
      {children}
    </div>
  )
  return href ? (
    <Link href={href as Route} className="group/figure block h-full">
      {inner}
    </Link>
  ) : (
    inner
  )
}

/**
 * The number itself, its caption, and an optional second line.
 *
 * `text-4xl` is the ONE size a figure is rendered at — money included.
 */
export function FigureNumber({
  value,
  subtitle,
  loading,
  note,
}: {
  value: React.ReactNode
  subtitle: React.ReactNode
  loading?: boolean
  note?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      {loading ? (
        <Skeleton className="h-9 w-24" />
      ) : (
        <p className="text-4xl font-black leading-none tracking-tight tabular-nums transition-colors group-hover/figure:text-primary">
          {value ?? '—'}
        </p>
      )}
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{subtitle}</p>
        {note}
      </div>
    </div>
  )
}

/** The dim second line under a figure's caption. */
export function FigureNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground/60">{children}</p>
}

/**
 * The figures of one section, as a RAIL rather than a row of boxes.
 *
 * TWO COLUMNS, ALWAYS. The rail used to take a `cols: 2 | 4`. Every figure
 * section is half the page wide now — they stack in the first screen's right
 * column, beside the agenda — and at half of 1035px two figures land at ~228px
 * each, which is what the four-up rail gave them across the full width. Same
 * figure width; a quarter of the eye travel, because Highlights now reads as a
 * 2×2 block rather than a 1035px sweep.
 *
 * At `lg` the gutter becomes padding either side of a hairline, so the numbers
 * read as one instrument panel. Below `lg` the grid gap does the separating — a
 * vertical rule between wrapped rows would be a rule to nowhere.
 *
 * THE SELECTOR IS ROW-AWARE, and that is not cosmetic: it was `[&>*+*]`, i.e.
 * "every child but the first", which is only correct for a SINGLE row. Give
 * that rail four children in two columns and child 3 opens row 2 wearing a left
 * border — exactly the rule to nowhere the paragraph above forbids. In a
 * two-column grid, odd children are always column 1 and even always column 2,
 * so `nth-child(odd|even)` states the geometry rather than the sequence.
 *
 * `lg` and NOT `md`: the finance block used to go three-up at `md` while every
 * other block waited for `lg`, so the page reflowed twice on the way down. One
 * breakpoint, and one gutter (`gap-6`, where the page previously mixed
 * `gap-3`/`gap-4`/`gap-6`).
 */
export function FigureRail({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-6 lg:gap-x-0',
        'lg:[&>*:nth-child(odd)]:pr-6',
        'lg:[&>*:nth-child(even)]:border-l lg:[&>*:nth-child(even)]:border-border',
        'lg:[&>*:nth-child(even)]:pl-6',
        className
      )}
    >
      {children}
    </div>
  )
}
