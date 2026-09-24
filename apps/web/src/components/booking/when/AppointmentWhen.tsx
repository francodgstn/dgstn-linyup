'use client'

import { useEffect, useMemo } from 'react'
import type { RegionalFormatter } from '@linyup/shared'
import { MiniCalendar, dayKeyAtNoon, toDateKey } from '@/components/booking/MiniCalendar'
import { formatCurrency } from '@/lib/format'
import type { AvailActivity, AvailCoach, AvailDuration } from './availability'

// WHEN, for an appointment: candidates computed on the fly, with a length
// dimension in front of them.
//
// This is one half of the ONE step the merged front door forks (plan section
// 4). The other half, `ClassWhen`, picks from documents that already exist and
// carry states a candidate cannot have: full, queued, booking closed. Fusing
// the two yields a component with two disjoint branches and no shared line, so
// they stay siblings with the same shell around them.
//
// A window may offer several lengths, so a start time is indeterminate until
// the visitor has chosen one. That is why availability can never be
// pre-generated, and it is why the length chips sit ABOVE the times rather
// than after them.
//
// Formatting comes in as props rather than from a hook: this component sits in
// `components/`, and the regional formatter belongs to the public routes.

export interface AppointmentWhenProps {
  coach: AvailCoach
  activity: AvailActivity
  currency: string
  locale: string
  fmt: RegionalFormatter
  duration: number
  onDurationChange: (minutes: number) => void
  selectedDateKey: string | null
  onDateChange: (dateKey: string | null) => void
  onPick: (startMs: number, duration: AvailDuration) => void
  /** Bound to `AppointmentBooking`. */
  t: (key: string, values?: Record<string, string | number>) => string
  /** Bound to `PublicBooking`, for the one line both funnels say. */
  tPublic: (key: string, values?: Record<string, string | number>) => string
  /** Minutes as the studio's visitors read them ("1h 30m"). */
  formatDuration: (minutes: number) => string
}

export function AppointmentWhen({
  coach,
  activity,
  currency,
  locale,
  fmt,
  duration,
  onDurationChange,
  selectedDateKey,
  onDateChange,
  onPick,
  t,
  tPublic,
  formatDuration,
}: AppointmentWhenProps) {
  const setDuration = onDurationChange
  const setSelectedDateKey = onDateChange

  // Only days with a free start for the CHOSEN duration are selectable: a
  // window may offer several lengths and not every day has room for all of them.
  const availableDates = useMemo(
    () =>
      activity.days
        .filter((d) => (d.slotsByDuration[String(duration)] ?? []).length > 0)
        .map((d) => toDateKey(new Date(d.dayMs))),
    [activity, duration]
  )
  const maxDateKey = useMemo(() => {
    const last = activity.days[activity.days.length - 1]
    return last ? toDateKey(new Date(last.dayMs)) : toDateKey(new Date())
  }, [activity])

  // Re-validate the selected day whenever the duration (or activity) changes:
  // the previously-selected day may not offer the new duration. It lives WITH
  // the state, because without it a restored duration whose day has no slots
  // silently renders an empty grid.
  useEffect(() => {
    if (selectedDateKey && availableDates.includes(selectedDateKey)) return
    setSelectedDateKey(availableDates[0] ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, activity.activityId, availableDates.join(',')])

  const day = activity.days.find((d) => toDateKey(new Date(d.dayMs)) === selectedDateKey)
  const times = day?.slotsByDuration[String(duration)] ?? []
  const chosenDuration =
    activity.durations.find((d) => d.minutes === duration) ??
    activity.durations[0] ?? { minutes: duration, priceAmount: null, benefitOnly: false }

  return (
    <>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{activity.activityName}</h1>
        {coach.providerName && (
          <p className="text-sm text-muted-foreground mt-1">
            {tPublic('withInstructor', { name: coach.providerName })}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-8 items-start">
        {/* Calendar */}
        <div className="bg-card border rounded-xl p-4">
          <MiniCalendar
            availableDates={availableDates}
            selectedDate={selectedDateKey}
            onSelect={setSelectedDateKey}
            maxDateKey={maxDateKey}
          />
        </div>

        {/* Duration chips (above the time list) + times */}
        <div>
          {activity.durations.length > 1 && (
            <div className="space-y-1.5 mb-4">
              <p className="text-xs font-medium text-muted-foreground">{t('pickDuration')}</p>
              <div className="flex gap-2 flex-wrap">
                {activity.durations.map((d) => (
                  <button
                    key={d.minutes}
                    type="button"
                    onClick={() => setDuration(d.minutes)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      d.minutes === duration
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {formatDuration(d.minutes)}
                    {d.benefitOnly === true
                      ? ` · ${t('durationBenefitOnly')}`
                      : typeof d.priceAmount === 'number' &&
                        ` · ${formatCurrency(d.priceAmount, currency, locale)}`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {selectedDateKey && (
            <p className="text-sm font-medium mb-3 text-muted-foreground">
              {fmt.custom(dayKeyAtNoon(selectedDateKey), {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </p>
          )}

          {times.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">{t('noTimesThisDay')}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {times.map((startMs) => (
                <button
                  key={startMs}
                  type="button"
                  onClick={() => onPick(startMs, chosenDuration)}
                  className="rounded-lg border px-3 py-2 text-sm font-medium transition-colors hover:border-primary hover:bg-primary/5"
                >
                  {fmt.time(startMs)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
