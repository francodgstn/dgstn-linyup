'use client'

// Read-only schedule board — the simple stacked List view plus the shared
// WeeklyCalendar (time-grid planner). Tapping any session opens a detail modal.
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Clock, MapPin, User, X } from 'lucide-react'
import { WeeklyCalendar, type PlannerSession } from '@/components/schedule/WeeklyCalendar'
import { useKioskAvailability } from './useKioskAvailability'
import type { KioskSession } from './useKioskSessions'
import { usePublicFormat } from '../usePublicFormat'

interface DayGroup {
  key: string
  date: Date
  sessions: KioskSession[]
}

function groupByDay(sessions: KioskSession[]): DayGroup[] {
  const groups = new Map<string, DayGroup>()
  for (const s of sessions) {
    const d = s.start.toDate()
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    let g = groups.get(key)
    if (!g) {
      g = { key, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), sessions: [] }
      groups.set(key, g)
    }
    g.sessions.push(s)
  }
  return [...groups.values()].sort((a, b) => a.date.getTime() - b.date.getTime())
}

interface Props {
  sessions: KioskSession[]
  loading: boolean
  view: 'calendar' | 'list'
  /** Team id — enables the optional appointment-availability overlay. */
  teamId?: string
  /** Set when the session feed failed — see the empty state below. */
  error?: unknown
  /** True once the feed has successfully loaded at least once — which is what
   *  makes an empty board a fact rather than a failure. See the empty state. */
  loaded?: boolean
}

/**
 * How long the availability overlay stays on before switching itself back off.
 *
 * The kiosk is a SHARED tablet: whatever the last person left it showing is what
 * the next person sees. A filter that HIDES classes would be dangerous here, so
 * availability is additive (classes never disappear) and it still reverts, so the
 * display always settles back to the plain schedule.
 */
const AVAILABILITY_AUTO_OFF_MS = 60_000

export default function KioskSchedule({ sessions, loading, view, teamId, error, loaded }: Props) {
  const t = useTranslations('Kiosk')
  const [selected, setSelected] = useState<PlannerSession | null>(null)
  const [showAvailability, setShowAvailability] = useState(false)
  const availability = useKioskAvailability(teamId ?? '', showAvailability)

  // Timed reset — see AVAILABILITY_AUTO_OFF_MS. Re-armed on every toggle-on.
  useEffect(() => {
    if (!showAvailability) return
    const id = setTimeout(() => setShowAvailability(false), AVAILABILITY_AUTO_OFF_MS)
    return () => clearTimeout(id)
  }, [showAvailability])

  // ADDITIVE, never exclusive: availability is layered ON TOP of the real
  // schedule so the classes are always there behind it.
  const entries: (KioskSession & { variant?: 'availability' })[] = showAvailability
    ? [...sessions, ...availability]
        .sort((a, b) => a.start.toMillis() - b.start.toMillis())
        // The calendar draws 'availability' as a dashed outline rather than a
        // solid block, so a window never looks like a scheduled class.
        .map((s) => (s.type === 'availability' ? { ...s, variant: 'availability' as const } : s))
    : sessions

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/40" />
        ))}
      </div>
    )
  }

  if (sessions.length === 0) {
    // Two different facts, two different sentences. "No classes today" closes the
    // desk; "we couldn't load the schedule" tells the front desk to check, and is
    // the only one we can honestly say when the feed failed and left us nothing.
    //
    // "LEFT US NOTHING" IS THE WHOLE TEST, and `error != null` is not it. The feed
    // keeps its last good result across a failed refresh, and on a genuinely quiet
    // day that result is an empty list — so a board correctly reading "no classes"
    // flipped to "couldn't load the schedule" the first time a five-minute refresh
    // blipped, and stayed there, unattended, asserting a fault over a day that
    // simply had nothing on it. A feed that has loaded ONCE has an answer; only
    // one that never has is unavailable.
    const neverLoaded = error != null && loaded !== true
    return (
      <div className="flex h-full items-center justify-center py-10 text-center">
        <p className="text-muted-foreground">
          {neverLoaded ? t('sessionsUnavailable') : t('noSessions')}
        </p>
      </div>
    )
  }

  return (
    <>
      {teamId && (
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={() => setShowAvailability((v) => !v)}
            aria-pressed={showAvailability}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
              showAvailability
                ? 'border-primary bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('showAvailability')}
          </button>
        </div>
      )}
      {view === 'list' ? (
        <DayList sessions={entries} onSelect={setSelected} />
      ) : (
        <WeeklyCalendar sessions={entries} onSelect={setSelected} />
      )}
      {selected && (
        <SessionModal s={selected} onClose={() => setSelected(null)} closeLabel={t('close')} />
      )}
    </>
  )
}

function DayDivider({ date }: { date: Date }) {
  const fmt = usePublicFormat()
  return (
    <div className="flex items-center gap-3 pt-4 first:pt-0">
      <span className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
        {fmt.custom(date, { weekday: 'long', day: 'numeric', month: 'short' })}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

function SessionRow({ s, onSelect }: { s: KioskSession; onSelect: (s: KioskSession) => void }) {
  const fmt = usePublicFormat()
  return (
    <button
      type="button"
      onClick={() => onSelect(s)}
      className="flex w-full items-center gap-4 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:border-primary hover:bg-primary/5"
    >
      <div
        className="h-10 w-1.5 shrink-0 rounded-full"
        style={{ background: s.activityColor || 'var(--primary)' }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold">
          {s.activityName ?? 'Session'}
          {s.providerName ? ` · ${s.providerName}` : ''}
        </p>
        {s.location && <p className="truncate text-sm text-muted-foreground">{s.location}</p>}
      </div>
      <p className="shrink-0 text-base font-semibold tabular-nums">{fmt.time(s.start)}</p>
    </button>
  )
}

function DayList({ sessions, onSelect }: { sessions: KioskSession[]; onSelect: (s: KioskSession) => void }) {
  const days = groupByDay(sessions)
  return (
    <div className="space-y-2.5">
      {days.map((g) => (
        <div key={g.key} className="space-y-2.5">
          <DayDivider date={g.date} />
          {g.sessions.map((s) => (
            <SessionRow key={s.id} s={s} onSelect={onSelect} />
          ))}
        </div>
      ))}
    </div>
  )
}

function SessionModal({
  s,
  onClose,
  closeLabel,
}: {
  s: PlannerSession
  onClose: () => void
  closeLabel: string
}) {
  const fmt = usePublicFormat()
  const start = s.start.toDate()
  const end = s.end?.toDate()
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className="mt-1 h-12 w-1.5 shrink-0 rounded-full"
            style={{ background: s.activityColor || 'var(--primary)' }}
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-xl font-bold">{s.activityName ?? 'Session'}</h3>
            <p className="mt-1 text-sm capitalize text-muted-foreground">
              {fmt.custom(start, { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-4 space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="font-medium tabular-nums">
              {fmt.time(start)}
              {end ? ` – ${fmt.time(end)}` : ''}
            </span>
          </div>
          {s.providerName && (
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{s.providerName}</span>
            </div>
          )}
          {s.location && (
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{s.location}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
