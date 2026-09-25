'use client'

import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

/**
 * A STYLED tooltip on an element that already exists.
 *
 * ── WHEN TO USE IT, AND WHEN `title=` IS FINE ───────────────────────────────
 * Use this on an ICON-ONLY control, where the label is the only thing that says
 * what the button does. There, the browser's own tooltip is not a lesser
 * version of this one — it is a missing label: it waits about a second, never
 * appears on touch at all, and a keyboard user tabbing through a toolbar of
 * fifteen icons is told nothing by any of them.
 *
 * Native `title=` stays correct on content that is ALREADY LABELED — a
 * truncated name, a date, a chip — where the tooltip repeats or extends
 * something visible. It is also the better tool for revealing clamped text: no
 * JS, no portal, and it works on any `truncate` without ceremony. And an
 * `<iframe title=>` is an accessible name, not a tooltip; never convert one.
 *
 * ── COMPOSE, DO NOT WRAP ────────────────────────────────────────────────────
 * `render` makes the trigger BE the element passed in, so there is no extra DOM
 * node and no interactive element nested inside another — which is what a
 * wrapping `<span onMouseEnter>` would produce, and what screen readers and
 * `focus-visible` both handle badly.
 *
 * ── THE PROVIDER IS GLOBAL ──────────────────────────────────────────────────
 * One `TooltipProvider` sits in `app/[locale]/layout.tsx`, so this needs none
 * of its own. That is not only tidiness: the provider owns the SHARED delay, so
 * moving between two controls opens the second instantly instead of waiting
 * again. A provider per tooltip is a provider per control, which defeats it.
 */
export function Tip({
  label,
  children,
  side = 'top',
}: {
  /**
   * ABSENT MEANS NO TOOLTIP, and the child renders untouched.
   *
   * That is not a convenience: it is how the collapsed-sidebar pattern works.
   * Those rows carried `title={collapsed ? label : undefined}` — a tooltip only
   * while the label is hidden, and silence once the row shows its own name,
   * which is exactly right. Modeling that here keeps the call sites a
   * one-for-one swap instead of a conditional wrapper each.
   */
  label?: string
  children: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  if (!label) return children
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} className="max-w-64">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
