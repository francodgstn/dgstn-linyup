"use client"

/**
 * Hover card — a small PANEL that opens on hover, as opposed to a tooltip.
 *
 * ── WHEN TO USE THIS AND NOT `tooltip.tsx` ──────────────────────────────────
 * A tooltip is a LABEL: one short line, inverted colors, no structure, and it
 * exists to name the thing under the cursor. A hover card is a CARD: it uses
 * the surface colors the rest of the app uses, and it can hold rows, rules,
 * headings and figures — a small amount of real content.
 *
 * The distinction is not decorative. The payment rows' journal breakdown
 * (category, charged, each fee, what you receive, a caveat) is a five-row table
 * with a total; rendered in a tooltip it was legible but wrong — inverted
 * colors on tabular figures, and a "structured" block inside a component whose
 * own styling assumes one line of text (Franco, 2026-08-24).
 *
 * Built on base-ui's `preview-card`, which is its hover-card primitive: opens on
 * hover AND on keyboard focus, stays open while the pointer travels to it, and
 * closes on Escape. That last part is what a bare `group-hover` div cannot do
 * and why this is a primitive rather than a div.
 *
 * Keep the CONTENT small. Anything that needs scrolling, a form control, or a
 * click target the user must reach reliably belongs in a `popover` (click to
 * open, stays put) — a panel that vanishes when the pointer strays is a bad
 * home for anything actionable.
 */

import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card"

import { cn } from "@/lib/utils"

function HoverCard({ ...props }: PreviewCardPrimitive.Root.Props) {
  return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />
}

function HoverCardTrigger({ ...props }: PreviewCardPrimitive.Trigger.Props) {
  return (
    <PreviewCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  )
}

function HoverCardContent({
  className,
  side = "top",
  sideOffset = 6,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<
    PreviewCardPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            // SURFACE colors, not the tooltip's inverted ones — this is a card.
            "z-50 w-64 origin-(--transform-origin) rounded-lg border bg-popover p-3 text-popover-foreground shadow-md outline-none",
            "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
        </PreviewCardPrimitive.Popup>
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
