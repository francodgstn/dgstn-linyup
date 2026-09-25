'use client'

// ─── SETTINGS AS ROWS, NOT CARDS ─────────────────────────────────────────────
//
// A settings page used to be a stack of Cards, each with a header, a
// description, a form with a hint under every field, and its own Save. Every
// border is an edge the eye has to cross, and every grey line is one more thing
// to read before finding the field you came for.
//
// The shape here: a SECTION is a small heading and a list of ROWS divided by
// hairlines. A row puts the label on the left and the control on the right
// (stacked on a phone). There is no box around anything, because a settings
// page is one list to read down, not a set of objects.
//
// ── HINTS: THREE WAYS TO SAY A SENTENCE, PICKED PER FIELD ───────────────────
// Most helper lines existed "just in case" and were read once, if ever. So a
// hint is hidden unless it earns its place:
//
//   'tip'     (default) an ⓘ beside the label, opened by hover OR tap. For
//             background: why the setting exists, what it affects.
//   'focus'   shown under the control only while the row is being edited.
//             For a FORMAT rule ("lowercase letters and hyphens"), which is
//             useful exactly while typing and noise the rest of the time.
//   'inline'  always visible. ONLY for a sentence that stops a likely wrong
//             reading, i.e. one that changes what the studio would choose.
//
// Errors are never hints: they go in `error` and are always shown.

import type { ReactNode } from 'react'
import { Info } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: ReactNode
  /** Rare. One short line when the heading alone would mislead. */
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('space-y-1', className)}>
      <div className="flex items-end justify-between gap-3 pb-1">
        <div className="min-w-0">
          <h2 className="font-heading text-base font-semibold tracking-tight">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="divide-y border-y">{children}</div>
    </section>
  )
}

export function SettingsRow({
  label,
  htmlFor,
  hint,
  hintMode = 'tip',
  error,
  stacked = false,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  hintMode?: 'tip' | 'focus' | 'inline'
  error?: ReactNode
  /** Put the control under the label at every width, for a control that needs
   *  the full row (a textarea, a group of inputs). */
  stacked?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'group/row grid gap-x-8 gap-y-2 py-4',
        !stacked && 'md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-start'
      )}
    >
      <div className={cn('min-w-0', !stacked && 'md:pt-2')}>
        <div className="flex items-center gap-1.5">
          <Label htmlFor={htmlFor} className="font-medium">
            {label}
          </Label>
          {hint && hintMode === 'tip' && <HintTip>{hint}</HintTip>}
        </div>
      </div>
      <div className="min-w-0 space-y-1.5">
        {children}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {/* Under the CONTROL, not the label: the right column is the wide one,
            so a sentence there takes two lines instead of five. */}
        {hint && hintMode === 'inline' && (
          <p className="text-xs text-muted-foreground">{hint}</p>
        )}
        {hint && hintMode === 'focus' && (
          <p className="hidden text-xs text-muted-foreground group-focus-within/row:block">
            {hint}
          </p>
        )}
      </div>
    </div>
  )
}

/** The ⓘ. A popover rather than a tooltip so a tap opens it too. A tooltip never
 *  shows on touch, and a studio owner on a phone would never see the sentence. */
export function HintTip({ children }: { children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={typeof children === 'string' ? children : undefined}
      >
        <Info className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent side="top" className="w-72 text-xs leading-relaxed text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  )
}
