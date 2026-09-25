'use client'

import type { RegionalFormatter } from '@linyup/shared'
import { MiniCalendar, dayKeyAtNoon } from '@/components/booking/MiniCalendar'

// WHEN, for a class: a list of documents that already exist.
//
// The other half of the one step the merged front door forks (plan section 4).
// An appointment's `when` computes candidates on the fly and has a length to
// choose first; a class's `when` picks from sessions the studio scheduled, and
// those carry states a candidate cannot have: FULL, with or without a queue
// behind it, and booking-required. That is the whole reason these are siblings
// rather than one component with two branches.
//
// A full slot is still RENDERED. It is either the queue's front door or, with
// no queue, an honest "no seats" row. What it must never be again is a
// clickable row that dead-ends on a server throw.
//
// It takes rows rather than session documents on purpose: which sessions are
// bookable, which are full and which offer a queue are the funnel's questions,
// answered against its own gate before anything reaches a screen. This renders
// the answer.

export interface ClassWhenRow {
  id: string
  /** Epoch ms, both ends. The funnel resolves the studio's clock. */
  startMs: number
  endMs: number
  /** Shown only when the visitor has not pinned an activity (date-first). */
  activityName?: string | null
  activityColor?: string | null
  providerName?: string | null
  location?: string | null
  /** The studio's one-line note on this session. */
  headline?: string | null
  bookingMandatory?: boolean
  /** No seats left. */
  full: boolean
  /** Full AND the activity runs a queue: the row leads to the waiting list
   *  instead of being a dead end. */
  waitlistable: boolean
}

export interface ClassWhenProps {
  /** Days with at least one session the visitor may act on. */
  availableDates: string[]
  selectedDate: string | null
  onSelectDate: (dateKey: string | null) => void
  maxDateKey: string
  /** The rows for the selected day, in the order they should read. */
  rows: ClassWhenRow[]
  /** True while the visitor is browsing several activities at once, which is
   *  what makes each row name its own. */
  showActivityNames: boolean
  fmt: RegionalFormatter
  onPick: (rowId: string) => void
  /** Bound to `PublicBooking`. */
  t: (key: string, values?: Record<string, string | number>) => string
  /** "1h 30m" in the studio's visitors' words. */
  formatDuration: (startMs: number, endMs: number) => string
}

export function ClassWhen({
  availableDates,
  selectedDate,
  onSelectDate,
  maxDateKey,
  rows,
  showActivityNames,
  fmt,
  onPick,
  t,
  formatDuration,
}: ClassWhenProps) {
  if (availableDates.length === 0) {
    return (
      <div className="rounded-xl border bg-muted/30 p-8 text-center">
        <p className="text-muted-foreground text-sm">{t('noSessionsAvailable')}</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-8 items-start">
      {/* Calendar */}
      <div className="bg-card border rounded-xl p-4">
        <MiniCalendar
          availableDates={availableDates}
          selectedDate={selectedDate}
          onSelect={onSelectDate}
          maxDateKey={maxDateKey}
        />
      </div>

      {/* Time slots */}
      <div>
        {selectedDate && (
          <p className="text-sm font-medium mb-3 text-muted-foreground">
            {fmt.custom(dayKeyAtNoon(selectedDate), {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>
        )}

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">{t('noSessionsOnDate')}</p>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <button
                key={row.id}
                disabled={row.full && !row.waitlistable}
                onClick={() => onPick(row.id)}
                className="w-full text-left rounded-xl border bg-card p-3.5 hover:border-primary hover:bg-primary/5 transition-colors flex items-stretch gap-3 group disabled:pointer-events-none disabled:opacity-60"
              >
                <div
                  className="w-1 rounded-full shrink-0"
                  style={{ background: row.activityColor || 'var(--primary)' }}
                />
                <div className="flex-1 min-w-0">
                  {showActivityNames && row.activityName && (
                    <p className="text-xs font-medium text-muted-foreground mb-0.5">
                      {row.activityName}
                    </p>
                  )}
                  <p className="font-semibold text-sm">
                    {fmt.time(row.startMs)} – {fmt.time(row.endMs)}
                  </p>
                  {row.headline && <p className="text-xs text-amber-700 mt-0.5">{row.headline}</p>}
                  <div className="flex flex-wrap gap-x-3 mt-0.5">
                    {row.providerName && (
                      <p className="text-xs text-muted-foreground">{row.providerName}</p>
                    )}
                    {row.location && <p className="text-xs text-muted-foreground">{row.location}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {row.full && (
                    <span className="text-xs rounded-full px-2 py-0.5 bg-muted text-muted-foreground font-medium">
                      {t('waitlistBadgeFull')}
                    </span>
                  )}
                  {row.waitlistable && (
                    <span className="text-xs rounded-full px-2 py-0.5 bg-amber-100 text-amber-800 font-medium">
                      {t('waitlistJoinCta')}
                    </span>
                  )}
                  {row.bookingMandatory && !row.full && (
                    <span className="text-xs rounded-full px-2 py-0.5 bg-primary/10 text-primary font-medium">
                      {t('bookingRequired')}
                    </span>
                  )}
                  <span className="text-xs bg-muted rounded-full px-2 py-0.5 text-muted-foreground">
                    {formatDuration(row.startMs, row.endMs)}
                  </span>
                  <svg
                    className="h-4 w-4 text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
