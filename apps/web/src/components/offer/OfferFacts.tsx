'use client'

/**
 * THE FACTS BLOCK in the catalog's detail pane — what the list pages show on
 * a row, shown for the one thing that is selected.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * The pane used to open with a name, a one-line count of edges ("2 plans open
 * this") and the edge editor. Everything ELSE a studio knows about the thing —
 * what it costs, whether it is public, whether it is even active, what the
 * description says — was on the list page it came from, so checking "is this
 * the right Premium?" meant leaving the page that had just answered a question
 * about Premium (Franco, 2026-08-31).
 *
 * ── IT IS A RENDERER, NOT A RESOLVER ────────────────────────────────────────
 * Deliberately dumb: chips, a description, an optional note. The per-kind
 * derivation stays with the page that already holds the documents, and the one
 * genuinely non-trivial part of it — an activity's money chips — is the SHARED
 * `activityMoneyChipLabels` the activities list itself reads. A component that
 * knew about four entity types would be a second place for pricing rules to
 * live, which is the failure the catalog exists to prevent.
 *
 * ── CHIPS CARRY A TONE ──────────────────────────────────────────────────────
 * `muted` is the default: a fact. `warn` is for a fact that changes whether the
 * thing WORKS — inactive, hidden, unpublished. A studio scanning the pane
 * should not have to read a chip to know it is bad news, and "Inactive"
 * rendered identically to "Monthly" was doing exactly that.
 */

import { Badge } from '@/components/ui/badge'

export interface OfferChip {
  label: string
  tone?: 'muted' | 'warn' | 'accent'
}

export interface OfferFactsProps {
  chips: OfferChip[]
  description?: string | null
  /** A sentence under the chips — used where the pane must say what it CANNOT
   *  do (a product has no plan edge), not for ordinary detail. */
  note?: string | null
}

const TONE_CLASS: Record<NonNullable<OfferChip['tone']>, string> = {
  muted: '',
  accent: 'border-primary/40 text-primary',
  warn: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400',
}

export function OfferFacts({ chips, description, note }: OfferFactsProps) {
  if (chips.length === 0 && !description && !note) return null

  return (
    <div className="space-y-2">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip, i) => (
            <Badge
              key={`${chip.label}-${i}`}
              variant="outline"
              className={`text-xs font-normal ${TONE_CLASS[chip.tone ?? 'muted']}`}
            >
              {chip.label}
            </Badge>
          ))}
        </div>
      )}

      {/* Clamped, not truncated to one line: a description is often the thing
          that tells two similarly-named plans apart, and one line is rarely
          enough to. Three is where a pane header stops being a header. */}
      {description && (
        <p className="line-clamp-3 text-xs text-muted-foreground">{description}</p>
      )}

      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}
