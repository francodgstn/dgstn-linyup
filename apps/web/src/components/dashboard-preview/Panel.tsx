'use client'

/**
 * A PANEL — the working surface of this dashboard, and the reason the page has
 * a shape at all.
 *
 * It is the shared `Card` in its **accent** variant: `border-2`, a 4px primary
 * left bar, `shadow-md`. That variant was criticised in the review that started
 * this redesign — for being the loudest treatment in the system wrapped around
 * the *least* information, seven bare figures. The critique was about the
 * pairing, not the frame: on the two blocks that carry the day's work it is the
 * loudest frame on the most important thing, which is hierarchy working rather
 * than fighting. Nothing else on this page is framed at all.
 *
 * WHICH MEANS THE FRAME NO LONGER RANKS THE TWO PANELS. Both wear it, so the
 * border says "primary work" and says it equally; the only thing left to say
 * "and this one first" is SIZE. That is why the working row went from 3:2 to
 * 2:1 in the same change — see the row's comment on the page. The page's rule
 * is unchanged and now load-bearing: **hierarchy comes from size, never from
 * decoration.** A future panel must not be given a third border treatment to
 * rank it; make it bigger or smaller.
 *
 * The header carries the title, an optional muted `meta` line-mate (the count
 * that stops a title from being a bare noun) and one right-hand `action`.
 */

import type React from 'react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function Panel({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  // `gap-0 py-0` strips the Card's own vertical rhythm: this card's interior is
  // a fixed header over a scroll region, not a stack of padded sections.
  return (
    <Card variant="accent" className={cn('flex h-full flex-col gap-0 py-0', className)}>
      {children}
    </Card>
  )
}

export function PanelHeader({
  title,
  meta,
  action,
  lead,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  action?: React.ReactNode
  /**
   * Controls that belong BEFORE the title — a day stepper, in practice. Kept
   * separate from `action` (which is the right-hand cluster) because the two
   * ends of this bar mean different things: `lead` changes WHAT the panel is
   * showing, `action` is where you go next.
   */
  lead?: React.ReactNode
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b px-3">
      {lead ? <div className="-mr-1.5 flex shrink-0 items-center gap-0.5">{lead}</div> : null}
      <h2 className="font-heading truncate text-sm font-bold tracking-tight text-heading">
        {title}
      </h2>
      {meta ? (
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{meta}</p>
      ) : (
        <div className="flex-1" />
      )}
      {action}
    </div>
  )
}

/**
 * The body. `lg:min-h-0 lg:flex-1` is what lets the ROW own the height and the
 * longer of the two lists absorb the difference — below `lg` the panel has no
 * height to divide, so it is an ordinary block under its own ceiling.
 *
 * ── `scroll={false}` IS A PROP AND NOT A CLASS, AND THAT IS THE POINT ────────
 *
 * A caller that wants an uncapped body cannot get one by passing `max-h-none`
 * through `className`. `cn` is `twMerge`, and twMerge does not reliably fold an
 * ARBITRARY value (`lg:max-h-[320px]`) against a named one (`lg:max-h-none`) —
 * it keeps both, CSS then resolves them by stylesheet order rather than by the
 * order they were written, and the caller's intent loses silently. The org
 * dashboard shipped exactly that: a roster asking to cap at 320px, rendering
 * with `max-height: none` and running to 700px, with both classes sitting in
 * the DOM looking correct.
 *
 * So the choice is made HERE, by not emitting the classes at all, which no
 * merge strategy can undo. Default `true` — every existing caller is unchanged.
 */
export function PanelBody({
  className,
  scroll = true,
  children,
}: {
  className?: string
  /** `false` for a list the PAGE should scroll rather than the panel. */
  scroll?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'p-2',
        scroll ? 'max-h-[320px] overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1' : 'lg:min-h-0',
        className
      )}
    >
      {children}
    </div>
  )
}
