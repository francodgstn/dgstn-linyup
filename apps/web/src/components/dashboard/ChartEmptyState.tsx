'use client'

/**
 * The empty state for a TREND CARD (UX-46).
 *
 * A chart with no rows is the one empty state that lies: recharts happily draws
 * the axes and a flat line along zero, which reads as "your studio is dead" or
 * "this card is broken" rather than "there is nothing here yet". Both trend
 * cards used to answer it with a bare centered sentence in hardcoded English,
 * which is barely better — it states the absence without saying what to do
 * about it.
 *
 * The copy deliberately blames the WINDOW and the SERIES, never the studio: the
 * dashboard already hides these cards entirely until a team has a contact or a
 * session, so anyone who reaches this has data — just not in the weeks shown,
 * or not on the breakdown they picked. "Add your first contact" would be wrong
 * for a studio with two hundred of them.
 */

import type { LucideIcon } from 'lucide-react'

export function ChartEmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon
  title: string
  hint: string
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Icon className="h-9 w-9 text-muted-foreground/30" aria-hidden />
      <p className="text-sm font-medium text-foreground/80">{title}</p>
      <p className="max-w-[16rem] text-xs leading-snug text-muted-foreground">{hint}</p>
    </div>
  )
}
