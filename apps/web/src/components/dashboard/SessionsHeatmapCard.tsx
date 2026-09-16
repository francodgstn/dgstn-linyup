'use client'

import { useMemo, useState, Fragment } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChevronsUpDown } from 'lucide-react'
import { getDay, getHours } from 'date-fns'
import { useTranslations, useLocale } from 'next-intl'
import type { SessionDoc, BookingDoc } from '@/hooks/useDashboardData'
import { Tip } from '@/components/ui/tip'

/**
 * Weekday initials from the VIEWER'S LOCALE, not from the message files.
 *
 * A translated list would have to be maintained in four places and would still
 * be wrong for anyone whose browser is set to a fifth. `Intl` already knows
 * them, and the rest of the app formats dates the same way (see the i18n note
 * in CLAUDE.md). Anchored to a known Monday so the order is fixed regardless of
 * where the locale starts its week.
 */
function weekdayLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' })
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 1 + i))))
}
// JS getDay: 0=Sun,1=Mon,...,6=Sat → col 0=Mon...6=Sun
const JS_DAY_TO_COL = [6, 0, 1, 2, 3, 4, 5]
const HOUR_START = 0
const HOUR_END = 23
const CELL_SIZE = 18 // px — row height

const COMPARISON_COLOR = '#F59E0B'
const PRIMARY_COLOR = '#6366F1'

/** The metric values, in order. Their LABELS are translated in the component —
 *  a module-level constant cannot call a hook. */
const SOURCE_VALUES = ['participants', 'new_bookings_session', 'new_bookings_booked'] as const

type Grid = number[][]

function buildGrid(source: string, sessions: SessionDoc[], bookings: BookingDoc[]): Grid {
  const numHours = HOUR_END - HOUR_START + 1
  const g: Grid = Array.from({ length: numHours }, () => new Array(7).fill(0))

  const add = (date: Date, val: number) => {
    const hour = getHours(date)
    if (hour < HOUR_START || hour > HOUR_END) return
    const col = JS_DAY_TO_COL[getDay(date)]
    g[hour - HOUR_START][col] += val
  }

  if (source === 'participants') {
    for (const s of sessions) {
      const d = s.start?.toDate?.()
      if (d) add(d, s.participants_count ?? 0)
    }
  } else if (source === 'new_bookings_session') {
    for (const s of sessions) {
      const d = s.start?.toDate?.()
      if (d) add(d, s.bio_link_new_contact_bookings_count ?? 0)
    }
  } else {
    for (const b of bookings) {
      const d = b.joinedAt?.toDate?.()
      if (d) add(d, 1)
    }
  }
  return g
}

function alpha(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${opacity})`
}

interface Props {
  sessions?: SessionDoc[]
  newContactBookings?: BookingDoc[]
  compareWith?: string
  comparisonSessions?: SessionDoc[]
  comparisonNewContactBookings?: BookingDoc[]
  title?: string
}

export function SessionsHeatmapCard({
  sessions = [],
  newContactBookings = [],
  compareWith = 'none',
  comparisonSessions = [],
  comparisonNewContactBookings = [],
  title,
}: Props) {
  const t = useTranslations('Heatmap')
  const locale = useLocale()
  const DAYS = useMemo(() => weekdayLabels(locale), [locale])
  // Four literal keys per group rather than `t(`source_${v}`)`: `i18n:check`
  // counts computed keys and never fails them.
  const sourceOptions = [
    { value: 'participants', label: t('sourceCheckins'), sublabel: t('bySessionTime') },
    { value: 'new_bookings_session', label: t('sourceNewBookings'), sublabel: t('bySessionTime') },
    { value: 'new_bookings_booked', label: t('sourceNewBookings'), sublabel: t('byBookingTime') },
  ]
  const [source, setSource] = useState<string>(SOURCE_VALUES[0])
  // Adapt to data by default — show only the hours with activity; the heading
  // toggle expands to the full 24-hour grid.
  const [autoHours, setAutoHours] = useState(true)

  const grid = useMemo(
    () => buildGrid(source, sessions, newContactBookings),
    [source, sessions, newContactBookings]
  )
  const compGrid = useMemo(
    () =>
      compareWith !== 'none'
        ? buildGrid(source, comparisonSessions, comparisonNewContactBookings)
        : null,
    [compareWith, source, comparisonSessions, comparisonNewContactBookings]
  )

  const maxVal = useMemo(() => {
    const all = [...grid.flat(), ...(compGrid ? compGrid.flat() : [])]
    return Math.max(1, ...all)
  }, [grid, compGrid])

  const numHours = HOUR_END - HOUR_START + 1
  const isComparing = compareWith !== 'none' && compGrid !== null

  const displayRows = useMemo(() => {
    const all = Array.from({ length: numHours }, (_, i) => i)
    if (!autoHours) return all
    const grids = compGrid ? [grid, compGrid] : [grid]
    let minRow: number | null = null
    let maxRow: number | null = null
    for (let row = 0; row < numHours; row++) {
      if (grids.some((g) => g[row].some((v) => v > 0))) {
        if (minRow === null) minRow = row
        maxRow = row
      }
    }
    if (minRow === null) return all
    return Array.from({ length: maxRow! - minRow + 1 }, (_, i) => minRow! + i)
  }, [autoHours, grid, compGrid, numHours])

  const comparePeriodLabel =
    compareWith === 'last_year' ? t('comparePrevYear') : t('comparePrevPeriod')
  /**
   * ICU PLURALS, not `+ 's'`.
   *
   * The count was pluralised by appending an English "s", which is a grammar
   * rule this card had no business knowing — German and Italian do not form a
   * plural that way at all, and French agrees differently. The message file
   * owns it now, one key per metric so each language can decline its own noun.
   */
  const countLabel = (n: number) =>
    source === 'participants' ? t('nParticipants', { n }) : t('nNewBookings', { n })

  const getDotDiameter = (val: number, compVal: number) => {
    const dominant = isComparing ? Math.max(val, compVal) : val
    return dominant > 0 ? Math.max(0.3, dominant / maxVal) * CELL_SIZE : 0
  }

  const getCellBg = (val: number, compVal: number) => {
    const empty = alpha(PRIMARY_COLOR, 0.07)
    if (!isComparing) {
      return val === 0 ? empty : alpha(PRIMARY_COLOR, 0.15 + (val / maxVal) * 0.85)
    }
    const currentColor = val > 0 ? alpha(PRIMARY_COLOR, 0.15 + (val / maxVal) * 0.85) : empty
    const compColor =
      compVal > 0 ? alpha(COMPARISON_COLOR, 0.15 + (compVal / maxVal) * 0.85) : empty
    return `linear-gradient(135deg, ${compColor} 50%, ${currentColor} 50%)`
  }

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="flex-1">{title || t('title')}</CardTitle>
          <Tip label={
              autoHours ? t('hoursShowAll') : t('hoursAdapt')
            }>
            <button
              onClick={() => setAutoHours((v) => !v)}
              aria-label={
                autoHours ? t('hoursShowAll') : t('hoursAdapt')
              }
              className={`p-1 rounded transition-colors ${autoHours ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <ChevronsUpDown className="h-4 w-4" />
            </button>
          </Tip>
          <Select
            value={source}
            onValueChange={(v) => {
              if (v) setSource(v)
            }}
          >
            <SelectTrigger size="sm" className="w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sourceOptions.map((o) => (
                <SelectItem key={o.value} value={o.value} label={o.label}>
                  {o.sublabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col pb-4 pt-3 overflow-x-auto">
        <div
          className="flex-1"
          style={{
            display: 'grid',
            gridTemplateColumns: `38px repeat(7, 1fr)`,
            gridTemplateRows: `16px repeat(${displayRows.length}, ${CELL_SIZE}px)`,
            columnGap: '2px',
            rowGap: '3px',
            minWidth: 280,
          }}
        >
          {/* header row */}
          <div />
          {DAYS.map((d) => (
            <span key={d} className="text-center text-[0.625rem] font-bold text-muted-foreground">
              {d}
            </span>
          ))}

          {/* data rows */}
          {displayRows.map((i) => {
            const hour = HOUR_START + i
            return (
              <Fragment key={`row-${hour}`}>
                <span
                  className="text-[0.625rem] text-muted-foreground text-right pr-1 whitespace-nowrap"
                  style={{ lineHeight: `${CELL_SIZE}px`, height: CELL_SIZE }}
                >
                  {hour}:00
                </span>
                {Array.from({ length: 7 }, (_, col) => {
                  const val = grid[i]?.[col] ?? 0
                  const compVal = compGrid ? (compGrid[i]?.[col] ?? 0) : 0
                  const hasData = val > 0 || compVal > 0
                  const dotSize = getDotDiameter(val, compVal)

                  const tooltipContent =
                    isComparing && hasData
                      ? `${t('current')}: ${countLabel(val)} · ${comparePeriodLabel}: ${countLabel(compVal)}`
                      : val > 0
                        ? countLabel(val)
                        : ''

                  return (
                    <div key={`${hour}-${col}`} title={tooltipContent || undefined}>
                      {isComparing ? (
                        <div
                          style={{
                            height: CELL_SIZE,
                            borderRadius: 3,
                            background: getCellBg(val, compVal),
                            transition: 'opacity 0.15s',
                          }}
                          className="hover:opacity-75"
                        />
                      ) : (
                        <div
                          className="hover:opacity-75 transition-opacity"
                          style={{
                            height: CELL_SIZE,
                            position: 'relative',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {/* ghost dot */}
                          <div
                            style={{
                              position: 'absolute',
                              width: CELL_SIZE,
                              height: CELL_SIZE,
                              borderRadius: '50%',
                              background: alpha(PRIMARY_COLOR, 0.07),
                            }}
                          />
                          {/* value dot */}
                          {dotSize > 0 && (
                            <div
                              style={{
                                position: 'relative',
                                width: dotSize,
                                height: dotSize,
                                borderRadius: '50%',
                                background: getCellBg(val, compVal),
                                overflow: 'hidden',
                              }}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </Fragment>
            )
          })}
        </div>
        {isComparing && (
          <div className="flex items-center gap-6 justify-end mt-3">
            <div className="flex items-center gap-1">
              <div
                className="w-3.5 h-3.5 rounded-[3px] overflow-hidden"
                style={{
                  background: `linear-gradient(135deg, ${alpha(COMPARISON_COLOR, 0.7)} 50%, transparent 50%)`,
                }}
              />
              <span className="text-xs text-muted-foreground">{comparePeriodLabel}</span>
            </div>
            <div className="flex items-center gap-1">
              <div
                className="w-3.5 h-3.5 rounded-[3px] overflow-hidden"
                style={{
                  background: `linear-gradient(135deg, transparent 50%, ${alpha(PRIMARY_COLOR, 0.7)} 50%)`,
                }}
              />
              <span className="text-xs text-muted-foreground">current</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
