import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// ─── THE SUB-HEADING ─────────────────────────────────────────────────────────
//
// Everything below a page's <h1>. Before this there was no canon and ~20 hand-
// rolled variants were in use, several differing only in ways nobody chose:
// `tracking-wide` vs `tracking-wider`, `text-sm font-semibold` vs
// `font-semibold text-sm`, `text-xs` vs `text-xs`. They cluster into three
// real levels, which are the three below — the drift was noise on top of a
// structure that already existed.
//
// ── IT MATCHES CardTitle ON PURPOSE ─────────────────────────────────────────
// `CardTitle` already renders with the `font-heading` / `text-heading` tokens,
// and the hand-rolled headings did not — so a heading inside a Card and one
// directly above it were set in different faces and different colors. The two
// non-muted levels here use the same tokens, so the page reads as one document
// whether or not a given block happens to be wrapped in a Card.
//
// ── LEVELS ──────────────────────────────────────────────────────────────────
//   section  a major block on a page          ("Health", "Preview")
//   sub      a group inside a block           ("Plans", "Includes")
//   eyebrow  a label ABOVE a list, not a      ("PLANS", "CLASSES")
//            heading you would read aloud
//
// `eyebrow` is deliberately the only muted, uppercased one: it labels a column
// or a rail group, where the words are navigation furniture rather than prose.
// Reach for `sub` when the words are a heading someone reads.

const LEVELS = {
  section: 'font-heading text-lg leading-snug font-semibold text-heading',
  sub: 'font-heading text-sm leading-snug font-semibold text-heading',
  eyebrow: 'text-xs font-semibold uppercase tracking-wider text-muted-foreground',
} as const

export type SectionHeadingLevel = keyof typeof LEVELS

export function SectionHeading({
  level = 'section',
  title,
  description,
  action,
  icon: Icon,
  className,
}: {
  level?: SectionHeadingLevel
  title: ReactNode
  /** The muted line under the heading. Paired here rather than left to each
   *  call site, because the gap between the two was its own source of drift
   *  (mt-0.5 / mt-1 / nothing). */
  description?: ReactNode
  /** Trailing control on the heading's own row — a button, a count, a switch. */
  action?: ReactNode
  icon?: React.ElementType
  className?: string
}) {
  const heading = (
    <div className={cn('flex items-center gap-1.5', LEVELS[level])}>
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
      {title}
    </div>
  )

  // No wrapper row when there is nothing to sit beside — an extra flex container
  // around a lone heading changes how it collapses inside a grid cell.
  if (!action) {
    return (
      <div className={cn('min-w-0', className)}>
        {heading}
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
    )
  }

  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        {heading}
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{action}</div>
    </div>
  )
}
