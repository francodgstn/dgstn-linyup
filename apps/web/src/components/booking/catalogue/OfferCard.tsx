'use client'

import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { activityGradient } from '@/components/booking/StickyBar'

// ONE CARD FOR ONE THING A VISITOR CAN BOOK.
//
// The class flow and the appointment picker each drew their own, and the two
// were not variations on a theme: the class card carried the studio's picture,
// its description, its tags, its prerequisites and its prices; the appointment
// card carried a name, a price and a line of grey text. Same studio, same
// visitor, two answers to "what is this?" — and the appointment was always the
// poorer of the two, for no reason anybody chose.
//
// So the CARD is here and the ANSWERS stay with the caller. Nothing in this
// file knows what an activity is, what a price means or which words to use: it
// takes strings that were already resolved and lays them out. That is what
// lets the two flows converge without this component growing a branch per
// flow, and it is what will let the merged front door list classes,
// appointments and courses in one column (plan section 4).
//
// Two ways to say money, and they are not the same question:
//   `priceChip`  — one short answer, worth reading at a glance ("from CHF 45")
//   `priceLines` — several, behind a quiet trigger. A class can carry four or
//                  five ("Included with X", "Y per class", a discount, a
//                  range), and stacked under every card they turned the
//                  selection screen into a price list.
// A caller passes whichever its offer actually has; passing both is allowed
// and means the glance answer plus the detail, which is exactly what a priced
// appointment with a member benefit is.

export interface OfferChip {
  label: string
  /** 'positive' is the ONE free/good signal (a free trial). Everything else is
   *  neutral on purpose: a row of coloured chips says nothing. */
  tone?: 'neutral' | 'positive'
}

export interface OfferCardProps {
  name: string
  /** The studio's picture. Falls back to its colour, then to a deterministic
   *  gradient from the name — an appointment has never had an image, so this
   *  fallback is what it will normally show. */
  image?: string | null
  color?: string | null
  chips?: OfferChip[]
  description?: string | null
  /** The amber line. `label` is the caller's word for it ("Prerequisites"). */
  note?: { label: string; text: string } | null
  /** The grey row under the text: length, place, online. Free-form because the
   *  icons and their order belong to the flow, not to the card. */
  meta?: ReactNode
  priceChip?: string | null
  priceLines?: { trigger: string; lines: string[] } | null
  /** Nothing to book. The card stays readable and stops being a button. */
  disabled?: boolean
  onSelect: () => void
}

export function OfferCard({
  name,
  image,
  color,
  chips,
  description,
  note,
  meta,
  priceChip,
  priceLines,
  disabled,
  onSelect,
}: OfferCardProps) {
  const bg = image
    ? `url("${image}")`
    : color
      ? `linear-gradient(135deg, ${color}cc, ${color}88)`
      : activityGradient(name)

  return (
    <button
      type="button"
      onClick={() => {
        if (!disabled) onSelect()
      }}
      disabled={disabled}
      className="w-full text-left rounded-xl border bg-card hover:border-primary hover:bg-primary/5 transition-colors flex items-stretch overflow-hidden min-h-24 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {/* Thumbnail — square (1:1) for typical items via w-24 + item min-h-24 */}
      <div
        className="w-24 shrink-0 bg-muted"
        style={{
          background: bg,
          backgroundSize: image ? 'cover' : '100% 100%',
          backgroundPosition: 'center',
        }}
      />
      <div className="flex-1 p-4 min-w-0">
        <div className="flex items-start gap-1.5 flex-wrap">
          <p className="font-semibold text-sm leading-tight">{name}</p>
          {priceChip && (
            <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
              {priceChip}
            </span>
          )}
          {chips?.map((chip, i) => (
            <span
              key={`${chip.label}-${i}`}
              className={
                chip.tone === 'positive'
                  ? 'rounded-full bg-green-100 text-green-700 text-xs px-2 py-0.5 font-medium'
                  : 'rounded-full bg-muted text-muted-foreground text-xs px-2 py-0.5'
              }
            >
              {chip.label}
            </span>
          ))}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{description}</p>
        )}
        {note && (
          <p className="text-xs text-amber-700 mt-1.5">
            <span className="font-medium">{note.label}</span> {note.text}
          </p>
        )}
        {meta && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-xs text-muted-foreground">
            {meta}
          </div>
        )}
        {/* Pricing last, and behind a trigger rather than printed. The trigger
            is a span (`render`) because this card is a <button> and a button
            may not nest one. Hover/focus only, by the tooltip's nature — on a
            phone the next step and the checkout still state the amount. */}
        {priceLines && priceLines.lines.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={<span />}
              className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground underline decoration-dotted underline-offset-2"
            >
              <Info aria-hidden className="h-3.5 w-3.5" />
              {priceLines.trigger}
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="max-w-xs px-3 py-2">
              <div className="divide-y divide-background/20">
                {priceLines.lines.map((line, i) => (
                  <p key={i} className="py-1 text-xs">
                    {line}
                  </p>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {!disabled && (
        <div className="flex items-center pr-4 text-muted-foreground">
          <svg
            aria-hidden
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </div>
      )}
    </button>
  )
}
