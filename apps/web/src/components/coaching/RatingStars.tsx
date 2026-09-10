'use client'

// A 1–5 star rating — read-only, or interactive through `onChange` — for every
// place a score is shown or asked: the evaluation and check-in forms, the
// `latest_score` chip on a goal card, each row of an evaluation history, on
// the admin's coaching tab AND in the member Space. The admin carried its own
// `StarDisplay` + `StarInput` pair that differed from this only in where the
// empty-star colour came from — the identical situation `GoalProgressBar` was
// in, resolved the same way:
//
//   no `emptyColor` → the app's muted token. Right on the neutral admin
//                     surface and inside the Dialogs, which are app-token
//                     everywhere (the Space's included).
//   `emptyColor`    → the host surface's own muted colour, for a
//                     tenant-themed card whose dark theme can render the app
//                     token invisible (the same split `QueryErrorState` makes).
//
// `value: 0` MEANS UNSET, and is only meaningful when interactive. A rating
// input that opens pre-filled at "3" lets a stray click submit a score
// indistinguishable, later, from a deliberate neutral one — every caller in
// `onChange` mode starts its own state at 0 and disables its Submit until a
// star has been touched. This component does not enforce that; it just never
// claims 0 is a rating.

import { useTranslations } from 'next-intl'
import { Star } from 'lucide-react'

/** amber-500 — the hex the member app fills its stars with too. */
const FILLED_COLOR = '#f59e0b'

interface Props {
  /** 1–5, or 0 for unset. */
  value: number
  onChange?: (value: number) => void
  size?: number
  readOnly?: boolean
  /** Colour for an unfilled star — see the module header. */
  emptyColor?: string
}

export function RatingStars({ value, onChange, size = 22, readOnly = false, emptyColor }: Props) {
  const t = useTranslations('Common')
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= value
        const style = { width: size, height: size, color: filled ? FILLED_COLOR : emptyColor }
        const starClassName = filled ? 'fill-current' : emptyColor ? undefined : 'text-muted-foreground/40'
        if (readOnly) {
          return <Star key={n} aria-hidden className={starClassName} style={style} />
        }
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange?.(n)}
            aria-label={t('ratingAriaLabel', { n })}
            aria-pressed={filled}
            className="rounded-full p-0.5 transition-transform hover:scale-110"
          >
            <Star className={starClassName} style={style} />
          </button>
        )
      })}
    </div>
  )
}
