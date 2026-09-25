'use client'

// A labelled disclosure for the OPTIONAL tail of a long form.
//
// ── THE DISCLOSURE RULE (read this before putting a field behind it) ─────────
//
// Only a field whose default is right for a studio that NEVER opens this may
// live here. Concretely: leaving it untouched must produce the behaviour that
// studio would have chosen, and an empty value must render nothing rather than
// something wrong. A default that is wrong is worse than a question.
//
// So these NEVER go behind it, however long the form gets:
//   • anything that decides what someone is CHARGED — a price, a discount, a
//     drop-in or trial fee, a member benefit;
//   • anything that decides WHO CAN GET IN — an access tier, a capacity, a
//     trial door, a subscription allow-list.
// They may be grouped and ordered, never tucked away. `WaiverSettings.tsx`
// carries the same rule for `mayIncludeMinors`, and `Course.accessRule`'s tiers
// are public copy for the same reason (UX-11: a members-tier class must still
// say so publicly).
//
// `defaultOpen` exists for ONE job: an EDIT form whose stored doc already has a
// value in here must open showing it. A field the studio filled in and then
// cannot find is a worse bug than the one this component fixes.

// ── WHY IT IS A LINE OF TEXT, NOT A BOX ─────────────────────────────────────
// It used to be a full-width dashed box, which stayed on screen whether it was
// open or closed. Closed, it read as an empty field to fill in. Open, it was a
// frame around nothing, sitting above the fields it had revealed. Either way it
// was the heaviest thing in the form, for the options least likely to be used.
//
// Now it is quiet in both states. Closed, it is one muted line (the label, then
// the hint saying what is inside), the weight of a link. Open, the hint goes
// (you can see what is inside now), and the revealed fields hang off a thin
// violet rule on the left, so they read as belonging to the line that opened
// them without a second frame. The same shape works at the foot of a dialog and
// nested inside a repeated price row, where a box inside a box was worst.

import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export function MoreOptions({
  label,
  hint,
  defaultOpen = false,
  children,
  className,
}: {
  /** Visible trigger text — always a translated string, never a bare "Advanced". */
  label: string
  /** One line saying what is inside, so the trigger is not a mystery box.
   *  Shown only while closed. */
  hint?: string
  defaultOpen?: boolean
  children: React.ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()

  return (
    <div className={cn('space-y-3', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          'group -mx-1 flex max-w-full items-baseline gap-1.5 rounded-md px-1 py-0.5 text-left text-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
        )}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 translate-y-0.5 transition-transform duration-200',
            open && 'rotate-90 text-primary'
          )}
        />
        <span className="font-medium">{label}</span>
        {hint && !open && (
          <span className="min-w-0 truncate text-xs text-muted-foreground/80">· {hint}</span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          className="ml-1.5 space-y-4 border-l-2 border-primary/25 pl-4 animate-in fade-in-0 slide-in-from-top-1 duration-200"
        >
          {children}
        </div>
      )}
    </div>
  )
}
