'use client'

// ─── THE ONE SAVE CONTROL FOR SETTINGS ───────────────────────────────────────
//
// Before this, a studio met four different save buttons while crossing three
// settings screens, and no two agreed:
//
//   settings/booking      default size, in the PAGE HEADER, top-right, no
//                         confirmation at all
//   settings/roles        default size, bottom-LEFT, "Saved" in muted gray
//   settings/team         size="sm",    bottom-LEFT, "Saved" in GREEN
//   NoShowPolicyCard      size="sm",    bottom-RIGHT, a spinner, no "Saved"
//
// None of that was decided; it accumulated. The cost is not ugliness — it is
// that the same act looks like four different acts, so nothing about one screen
// teaches you the next one, and "did that save?" is answered differently (or
// not at all) each time.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// A save sits at the TRAILING EDGE of the thing it saves, right-aligned, small,
// and says what happened. Right-aligned because it is the terminal action of a
// form and reads last; small because a settings pane is a stack of sections and
// a full-size button in each one competes with the page's own primary action.
//
// ── THE CONFIRMATION IS PART OF THE CONTROL, NOT AN EXTRA ───────────────────
// `saved` renders a muted "Saved" beside the button — muted, NOT green. Green
// is a status color in this app (a paid invoice, an active subscription); a
// form doing what it was asked is not a status, and spending a semantic color
// on it makes the genuine ones quieter.
//
// Callers that already toast on success can leave `saved` undefined; the label
// still tells the story while the write is in flight.

import { Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function SettingsSaveBar({
  onSave,
  type = 'button',
  saving = false,
  saved = false,
  disabled = false,
  className,
}: {
  /** Omit when `type="submit"` — the form's own onSubmit runs instead. */
  onSave?: () => void
  /**
   * `submit` for a section that IS a `<form>`. It exists because the team page
   * had hand-rolled a near-copy of this bar for exactly that case, and the copy
   * then drifted — it lost `justify-end` and sat bottom-LEFT, which is the
   * inconsistency this component was written to end. A prop is cheaper than a
   * second implementation that looks right on the day it is written.
   */
  type?: 'button' | 'submit'
  /** In flight — swaps the label and shows the spinner. */
  saving?: boolean
  /** Show the "Saved" confirmation. Omit if the caller toasts instead. */
  saved?: boolean
  /** Usually `!dirty`, `!valid` or `!canEdit` — the button is disabled, never hidden. */
  disabled?: boolean
  className?: string
}) {
  const t = useTranslations('Common')

  return (
    // `pt-2` is part of the control, not the caller's problem. Settings sections
    // stack with a `border-t` at the top of each, so a save bar with only the
    // list's own gap beneath it reads as glued to the NEXT section's divider —
    // which is what it looked like on Settings → General before this.
    <div className={cn('flex items-center justify-end gap-3 pt-2', className)}>
      {/* Placed BEFORE the button so it reads "Saved · [Save]" in LTR and never
          pushes the button off the trailing edge as it appears and disappears. */}
      {saved && !saving && (
        <span className="text-xs text-muted-foreground">{t('saved')}</span>
      )}
      <Button size="sm" type={type} onClick={onSave} disabled={disabled || saving}>
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        {saving ? t('saving') : t('save')}
      </Button>
    </div>
  )
}
