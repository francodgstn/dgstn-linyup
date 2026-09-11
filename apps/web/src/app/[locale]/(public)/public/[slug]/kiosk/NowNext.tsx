'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { CalendarClock, MapPin } from 'lucide-react'
import type { KioskSession } from './useKioskSessions'
import { useClock } from './useClock'
import { usePublicFormat } from '../usePublicFormat'

interface Props {
  sessions: KioskSession[]
}

// "Ongoing / next class" widget. Re-derived every 30s from the shared session
// feed (useKioskSessions) rather than its own query.
export default function NowNext({ sessions }: Props) {
  const t = useTranslations('Kiosk')
  const fmt = usePublicFormat()
  const now = useClock(30_000)

  const { current, next } = useMemo(() => {
    const nowMs = now.getTime()
    let ongoing: KioskSession | null = null
    let soonest: KioskSession | null = null
    for (const s of sessions) {
      const startMs = s.start.toDate().getTime()
      const endMs = s.end.toDate().getTime()
      if (startMs <= nowMs && nowMs <= endMs) {
        if (!ongoing || startMs < ongoing.start.toDate().getTime()) ongoing = s
      } else if (startMs > nowMs) {
        if (!soonest || startMs < soonest.start.toDate().getTime()) soonest = s
      }
    }
    return { current: ongoing, next: soonest }
  }, [sessions, now])

  const featured = current ?? next
  const label = current ? t('nowClass') : t('nextClass')

  if (!featured) {
    return (
      <div className="rounded-2xl border bg-card p-6 text-center">
        <CalendarClock className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
        <p className="text-muted-foreground">{t('noUpcoming')}</p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border bg-card p-6">
      <p className="text-sm font-bold uppercase tracking-wide text-primary">{label}</p>
      <p className="mt-2 text-2xl font-bold sm:text-3xl">{featured.activityName ?? 'Session'}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-muted-foreground">
        <span className="flex items-center gap-1.5 text-lg font-semibold tabular-nums">
          <CalendarClock className="h-5 w-5" />
          {fmt.time(featured.start)} – {fmt.time(featured.end)}
        </span>
        {featured.location && (
          <span className="flex items-center gap-1.5 text-lg">
            <MapPin className="h-5 w-5" />
            {featured.location}
          </span>
        )}
      </div>
    </div>
  )
}
