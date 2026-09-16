'use client'

// THE rank badge.
//
// A level identifies itself visually, and clubs do not all do it the same way:
// a belt colour, a split belt's two colours, a swim school's animal, or a club's
// own uploaded artwork. Which one wins is decided ONCE, by `rankLevelBadge` in
// @linyup/shared, so this component and the member app cannot disagree — and so
// adding a fifth way later is one change rather than five.

import Image from 'next/image'
import { rankLevelBadge, type RankLevel } from '@linyup/shared'
import { cn } from '@/lib/utils'

const SIZES = {
  sm: { box: 'h-4 w-4', text: 'text-[0.625rem]', px: 16 },
  md: { box: 'h-6 w-6', text: 'text-sm', px: 24 },
  lg: { box: 'h-10 w-10', text: 'text-xl', px: 40 },
} as const

export function RankBadge({
  level,
  size = 'md',
  className,
}: {
  level: RankLevel
  size?: keyof typeof SIZES
  className?: string
}) {
  const badge = rankLevelBadge(level)
  const s = SIZES[size]
  // The label is the accessible name in every arm — a colour alone tells a
  // screen reader nothing, and two adjacent belts differ only by it.
  const shell = cn('inline-block shrink-0 rounded-full overflow-hidden align-middle', s.box, className)

  if (badge.kind === 'image') {
    return (
      <Image
        src={badge.imageUrl}
        alt={badge.label}
        width={s.px}
        height={s.px}
        className={cn(shell, 'object-cover')}
      />
    )
  }

  if (badge.kind === 'emoji') {
    return (
      <span
        role="img"
        aria-label={badge.label}
        title={badge.label}
        className={cn(shell, 'inline-flex items-center justify-center leading-none', s.text)}
        style={badge.color ? { backgroundColor: badge.color } : undefined}
      >
        {badge.emoji}
      </span>
    )
  }

  if (badge.kind === 'split') {
    // Two halves, because that is what a split belt looks like. A single colour
    // would render two adjacent grades identically.
    return (
      <span
        role="img"
        aria-label={badge.label}
        title={badge.label}
        className={shell}
        style={{
          background: `linear-gradient(90deg, ${badge.color} 0 50%, ${badge.secondColor} 50% 100%)`,
        }}
      />
    )
  }

  return (
    <span
      role="img"
      aria-label={badge.label}
      title={badge.label}
      className={shell}
      style={{ backgroundColor: badge.color }}
    />
  )
}
