'use client'

import { useClock } from './useClock'
import { usePublicFormat } from '../usePublicFormat'

interface Props {
  title: string
  logoUrl?: string
}

// Top bar: kiosk.title (falls back to the team name), team logo, live clock.
export default function KioskHeader({ title, logoUrl }: Props) {
  const now = useClock()
  const fmt = usePublicFormat()
  const time = fmt.time(now)
  const date = fmt.custom(now, { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b bg-card px-6 py-4 sm:px-10">
      <div className="flex min-w-0 items-center gap-3">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt=""
            className="h-10 w-10 shrink-0 rounded-full object-cover sm:h-12 sm:w-12"
          />
        ) : null}
        <p className="truncate text-xl font-bold tracking-tight sm:text-2xl">{title}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="text-2xl font-bold tabular-nums sm:text-3xl">{time}</span>
        <span className="text-xs text-muted-foreground sm:text-sm">{date}</span>
      </div>
    </header>
  )
}
