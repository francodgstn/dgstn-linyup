'use client'

/**
 * THE OFFERING FORMS' LAYOUT, in two primitives — and what they replaced.
 *
 * Until 2026-09-12 every group of settings on an activity's panes sat in its
 * own `rounded-lg border` box, with `divide-y` between the rows inside it and
 * a hint under every control. Thirteen such boxes across the activity forms,
 * beside choice cards that are ALSO bordered, so a border no longer said
 * anything: "selected", "a group", "a row", "an editor" all drew the same
 * line, and a studio met a pane of nested rectangles before it met a single
 * field (Franco, 2026-09-11: "the page itself carries a lot of cognitive
 * load … declutter a bit").
 *
 * The rule now: **a border carries state or it is not drawn.** The audience
 * and "Offer as" choice cards keep theirs, because there the border IS the
 * selected state. Everything else is laid out by spacing and hairlines:
 *
 *   FormSections / FormSection   the pane's groups, one hairline between
 *                                them, generous vertical rhythm, no heading —
 *                                a heading over four rows names what the tab
 *                                already names (Franco, 2026-09-02).
 *   SettingRows / SettingRow     one on/off setting per row: label + hint on
 *                                the left, the control on the right, and what
 *                                the control reveals underneath. The shape
 *                                Settings → Booking already uses.
 *
 * Neither draws a box. `PlanPricingForm` never had any, and it was the one
 * pane that read calmly — that was the evidence.
 */

import { Children, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** The pane's groups, separated by a hairline. Put every `FormSection` of a
 *  pane inside ONE of these so the first and last lose their outer padding. */
export function FormSections({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('divide-y', className)}>{children}</div>
}

/** A group of related fields. No border, no heading by default — the tab
 *  names the subject; a `label` is for the rare group that is about something
 *  ELSE than the tab (and then it is a field label, not a section title). */
export function FormSection({
  label,
  hint,
  children,
  className,
}: {
  label?: ReactNode
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('space-y-4 py-5 first:pt-0 last:pb-0', className)}>
      {(label || hint) && (
        <div className="space-y-0.5">
          {label && <p className="text-sm font-medium">{label}</p>}
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      )}
      {children}
    </section>
  )
}

/** The on/off settings of a pane, one hairline between rows, no box. */
export function SettingRows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('divide-y', className)}>{children}</div>
}

/**
 * ONE SETTING. Label and hint on the left, its control on the right — a
 * `Switch`, a checkbox, a colour swatch, a short input — and, when the
 * control reveals more (a price once the trial is on), that goes UNDER the
 * row as `children`, so the row keeps its shape whether it is on or off.
 *
 * `htmlFor` makes the label click the control: a `Switch` is a button, and a
 * button is labelable, so no wrapping `<label>` is needed — which matters
 * because a wrapping label also fires for any OTHER button inside the row
 * (the pencil on the studio default), flipping the setting under the click.
 */
export function SettingRow({
  label,
  hint,
  control,
  htmlFor,
  disabled,
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  control: ReactNode
  htmlFor?: string
  disabled?: boolean
  children?: ReactNode
  className?: string
}) {
  // `{on && <Price />}` hands over `false`, and two of those hand over an
  // array of falses — truthy, so a bare check would draw the gap under an
  // off row. toArray drops them.
  const revealed = Children.toArray(children)
  return (
    <div className={cn('py-3 first:pt-0 last:pb-0', disabled && 'opacity-60', className)}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          {htmlFor ? (
            <label htmlFor={htmlFor} className={cn('text-sm font-medium', !disabled && 'cursor-pointer')}>
              {label}
            </label>
          ) : (
            <p className="text-sm font-medium">{label}</p>
          )}
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        <div className="shrink-0">{control}</div>
      </div>
      {revealed.length > 0 && <div className="mt-3 space-y-2">{revealed}</div>}
    </div>
  )
}
