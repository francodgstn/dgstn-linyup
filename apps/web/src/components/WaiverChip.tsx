'use client'

// The roster / manifest waiver chip.
//
// ── IT HAS TO SURVIVE A PRINTER, AND THAT CONSTRAINS ITS FORM ──────────────
// `globals.css` forces `.manifest-session` backgrounds transparent for the day
// sheet, and most browsers drop background graphics by default anyway — so a
// coloured PILL prints as invisible text. The meaning therefore rides on a
// STROKE (the lucide glyph, an SVG path) and on the word beside it, never on a
// fill. The tick box on the same sheet already solves the identical problem the
// same way (`bg-foreground print:bg-transparent`, so the border carries it).
//
// ── UNKNOWN RENDERS NOTHING ─────────────────────────────────────────────────
// Absent state is a real third value: a booking taken before waivers existed, a
// contact the reader cannot see, a lookup that failed. The subscription badge on
// the same page tests `=== false` for exactly this reason. A chip that appears
// because a read failed is an accusation about somebody standing at a door.

import { useTranslations } from 'next-intl'
import { AlertTriangle, UserCheck } from 'lucide-react'
import type { WaiverAcceptanceState, WaiverDoorCheck } from '@linyup/shared'

/** Which states are worth a chip. `valid` and unknown are not. */
export function waiverChipState(
  state: WaiverAcceptanceState | undefined
): Exclude<WaiverAcceptanceState, 'valid'> | null {
  if (!state || state === 'valid') return null
  return state
}

export function WaiverChip({
  state,
  /** The day sheet's row style: text only, `shrink-0`, no pill — the template is
   *  the `unpaid` chip immediately beside it. */
  print,
}: {
  state: WaiverAcceptanceState | undefined
  print?: boolean
}) {
  const t = useTranslations('SessionDetail')
  const shown = waiverChipState(state)
  if (!shown) return null

  const label = t('waiverBadge')
  const detail = t(`waiverBadge_${shown}` as Parameters<typeof t>[0])

  if (print) {
    return (
      <span className="shrink-0 text-xs text-amber-700" title={detail}>
        <AlertTriangle className="mr-0.5 inline h-3 w-3" aria-hidden />
        {label}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-semibold ${
        shown === 'revoked'
          ? 'border-destructive/40 text-destructive'
          : 'border-amber-300 text-amber-700'
      }`}
      title={detail}
    >
      <AlertTriangle className="h-3 w-3" aria-hidden />
      {label}
    </span>
  )
}

/**
 * THE DOOR CHECK, beside the state chip and never instead of it.
 *
 * Two different questions: `WaiverChip` answers "does this person's signature
 * count", and this answers "who did the studio actually agree to admit". A
 * minors-flagged waiver produces one of these on every booking it covers — that
 * is the whole point of the flag, which is a PROMPT and not an enforcement: the
 * studio sees the participant at the door and we do not.
 *
 * Same print constraints as its sibling — a stroke and a word, never a fill.
 */
export function WaiverDoorCheckChip({
  check,
  print,
}: {
  /** null is an ordinary answer, not a missing one — it is what every booking a
   *  studio never flagged produces, and it renders nothing. */
  check: WaiverDoorCheck | null | undefined
  print?: boolean
}) {
  const t = useTranslations('SessionDetail')
  if (!check) return null

  const label = check === 'guardian' ? t('waiverGuardianBadge') : t('waiverCheckBadge')
  const detail =
    check === 'guardian' ? t('waiverGuardianBadgeTitle') : t('waiverCheckBadgeTitle')

  if (print) {
    return (
      <span className="shrink-0 text-xs text-sky-700" title={detail}>
        <UserCheck className="mr-0.5 inline h-3 w-3" aria-hidden />
        {label}
      </span>
    )
  }

  return (
    <span
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-sky-300 px-1.5 py-0.5 text-xs font-semibold text-sky-700"
      title={detail}
    >
      <UserCheck className="h-3 w-3" aria-hidden />
      {label}
    </span>
  )
}
