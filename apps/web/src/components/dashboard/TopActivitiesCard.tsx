'use client'

import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Dumbbell } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { SessionDoc, BookingDoc, ActivityDoc } from '@/hooks/useDashboardData'

const MODES = [
  { value: 'checkins',  label: 'Check-ins',    sublabel: 'actual attendance, all contacts',   unit: 'check-in' },
  { value: 'all',       label: 'All bookings', sublabel: 'new + existing contacts',            unit: 'booking'  },
  { value: 'new',       label: 'New bookings', sublabel: 'first-time / trial contacts only',   unit: 'booking'  },
]

interface RankItem { key: string; name: string; count: number }

function buildRankingFromSessions(sessions: SessionDoc[], activityNames: Map<string, string>): RankItem[] {
  const counts: Record<string, RankItem> = {}
  for (const s of sessions) {
    const key = s.activityId ?? '__none__'
    const name = activityNames.get(s.activityId ?? '') ?? s.activityName ?? 'No activity'
    const n = s.participants_count ?? 0
    if (counts[key]) counts[key].count += n
    else counts[key] = { key, name, count: n }
  }
  return Object.values(counts).filter((r) => r.count > 0).sort((a, b) => b.count - a.count)
}

function buildRankingFromBookings(
  bookings: BookingDoc[], sessionActivityMap: Map<string, { activityId: string | null; name: string | null }>,
): RankItem[] {
  const counts: Record<string, RankItem> = {}
  for (const b of bookings) {
    const info = sessionActivityMap.get(b.session ?? '')
    if (!info) continue
    const key = info.activityId ?? '__none__'
    const name = info.name ?? 'No activity'
    if (counts[key]) counts[key].count += 1
    else counts[key] = { key, name, count: 1 }
  }
  return Object.values(counts).sort((a, b) => b.count - a.count)
}

function DeltaBadge({ current, comparison }: { current: number; comparison: number | null | undefined }) {
  if (comparison === undefined) return null
  if (comparison === null) {
    return <Badge className="h-4 text-[0.625rem] px-1.5 bg-blue-500 text-white hover:bg-blue-500 ml-1">NEW</Badge>
  }
  const delta = current - comparison
  if (delta === 0) return <span className="text-[0.6875rem] text-muted-foreground ml-1">—</span>
  return (
    <Badge className={`h-4 text-[0.625rem] px-1.5 ml-1 ${delta > 0 ? 'bg-green-500 hover:bg-green-500' : 'bg-red-500 hover:bg-red-500'} text-white`}>
      {delta > 0 ? `+${delta}` : delta}
    </Badge>
  )
}

interface Props {
  sessions?: SessionDoc[]; allBookings?: BookingDoc[]; newContactBookings?: BookingDoc[]
  activities?: ActivityDoc[]; compareWith?: string
  comparisonSessions?: SessionDoc[]; comparisonAllBookings?: BookingDoc[]
  comparisonNewContactBookings?: BookingDoc[]; title?: string
}

export function TopActivitiesCard({
  sessions = [], allBookings = [], newContactBookings = [],
  activities = [], compareWith = 'none',
  comparisonSessions = [], comparisonAllBookings = [], comparisonNewContactBookings = [],
  title,
}: Props) {
  const td = useTranslations('Dashboard')
  const [mode, setMode] = useState('checkins')

  const activityNames = useMemo(
    () => new Map((activities).map((a) => [a.id, a.name ?? a.activityName ?? a.id])),
    [activities],
  )

  const sessionActivityMap = useMemo(() => {
    const map = new Map<string, { activityId: string | null; name: string | null }>()
    for (const s of sessions) {
      map.set(s.id, { activityId: s.activityId ?? null, name: activityNames.get(s.activityId ?? '') ?? s.activityName ?? null })
    }
    return map
  }, [sessions, activityNames])

  const compSessionActivityMap = useMemo(() => {
    if (compareWith === 'none') return null
    const map = new Map<string, { activityId: string | null; name: string | null }>()
    for (const s of comparisonSessions) {
      map.set(s.id, { activityId: s.activityId ?? null, name: activityNames.get(s.activityId ?? '') ?? s.activityName ?? null })
    }
    return map
  }, [compareWith, comparisonSessions, activityNames])

  const ranked = useMemo(() => {
    if (mode === 'checkins') return buildRankingFromSessions(sessions, activityNames)
    const src = mode === 'all' ? allBookings : newContactBookings
    return buildRankingFromBookings(src, sessionActivityMap)
  }, [mode, sessions, allBookings, newContactBookings, sessionActivityMap, activityNames])

  const compRanked = useMemo(() => {
    if (compareWith === 'none') return null
    if (mode === 'checkins') return buildRankingFromSessions(comparisonSessions, activityNames)
    if (!compSessionActivityMap) return null
    const src = mode === 'all' ? comparisonAllBookings : comparisonNewContactBookings
    return buildRankingFromBookings(src, compSessionActivityMap)
  }, [compareWith, mode, comparisonSessions, comparisonAllBookings, comparisonNewContactBookings, compSessionActivityMap, activityNames])

  const compCountByKey = useMemo(() => {
    if (!compRanked) return null
    return Object.fromEntries(compRanked.map((r) => [r.key, r.count]))
  }, [compRanked])

  const selectedMode = MODES.find((m) => m.value === mode)!
  const max = ranked[0]?.count || 1

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <div className="flex items-center gap-2">

          <CardTitle className="flex-1">{title || td('chartTitleTopActivities')}</CardTitle>
          <Select value={mode} onValueChange={(v) => { if (v) setMode(v) }}>
            <SelectTrigger size="sm" className="w-[130px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value} label={m.label}>
                  {m.sublabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex-1 py-2 pb-4">
        {ranked.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <Dumbbell className="h-9 w-9 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No data for this period</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-2">
            {ranked.map((item, idx) => {
              const compCount = compCountByKey !== null ? (compCountByKey[item.key] ?? null) : undefined
              const isTop = idx === 0
              return (
                <div key={item.key}>
                  <div className="flex items-baseline justify-between mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-xs font-bold flex-shrink-0 min-w-[18px] ${isTop ? 'text-yellow-500' : 'text-muted-foreground'}`}>
                        #{idx + 1}
                      </span>
                      <span className={`text-sm truncate ${isTop ? 'font-bold' : 'font-medium'}`} title={item.name}>
                        {item.name}
                      </span>
                    </div>
                    <div className="flex items-center flex-shrink-0 ml-2">
                      <span className={`text-sm font-bold ${isTop ? 'text-yellow-500' : ''}`}>
                        {item.count}
                        <span className="text-xs font-normal text-muted-foreground ml-1">
                          {selectedMode.unit}{item.count !== 1 ? 's' : ''}
                        </span>
                      </span>
                      <DeltaBadge current={item.count} comparison={compCount} />
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${(item.count / max) * 100}%`,
                        background: isTop ? '#EAB308' : '#6366F1',
                        opacity: Math.max(0.3, 1 - idx * 0.12),
                      }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
