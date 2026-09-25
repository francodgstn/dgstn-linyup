'use client'

import { useEffect, useMemo, useState } from 'react'
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
  /** A BASKET (the offer's `maxDatesPerBooking` above one): times are added
   *  to a list instead of chosen, and Continue hands the whole list over. When
   *  absent, a time is chosen with one click, as always. */
  onPickMany?: (starts: number[], duration: AvailDuration) => void
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
  onPickMany,
  t,
  tPublic,
  formatDuration,
}: AppointmentWhenProps) {
  const setDuration = onDurationChange
  const setSelectedDateKey = onDateChange

  // ── THE BASKET ────────────────────────────────────────────────────────────
  // Only for an offer that sells several dates at once. Every date shares one
  // length (the server's rule too), so changing the length empties it.
  const maxDates = Math.max(1, activity.maxDatesPerBooking ?? 1)
  const basketMode = maxDates > 1 && !!onPickMany
  const [picked, setPicked] = useState<number[]>([])
  useEffect(() => {
    setPicked([])
  }, [duration, activity.activityId])
  const durationMs = duration * 60_000
  const togglePicked = (startMs: number) =>
    setPicked((prev) =>
      prev.includes(startMs)
        ? prev.filter((p) => p !== startMs)
        : prev.length < maxDates
          ? [...prev, startMs].sort((a, b) => a - b)
          : prev
    )
  /** A time that would overlap a date already in the basket: the provider
   *  cannot be in two places, and the server would refuse it by name. */
  const clashesWithPicked = (startMs: number) =>
    picked.some((p) => p !== startMs && Math.abs(p - startMs) < durationMs)

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
                        ` · ${
                          d.party
                            ? t('durationPricePerPerson', {
                                price: formatCurrency(d.priceAmount, currency, locale),
                              })
                            : formatCurrency(d.priceAmount, currency, locale)
                        }`}
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
              {times.map((startMs) => {
                const inBasket = picked.includes(startMs)
                const unavailable =
                  basketMode && !inBasket && (picked.length >= maxDates || clashesWithPicked(startMs))
                return (
                  <button
                    key={startMs}
                    type="button"
                    disabled={unavailable}
                    aria-pressed={basketMode ? inBasket : undefined}
                    onClick={() =>
                      basketMode ? togglePicked(startMs) : onPick(startMs, chosenDuration)
                    }
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40 ${
                      inBasket
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'hover:border-primary hover:bg-primary/5'
                    }`}
                  >
                    {fmt.time(startMs)}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* THE BASKET: every date chosen so far, across days, each removable,
          with the total and one Continue. */}
      {basketMode && (
        <div className="rounded-xl border bg-card p-4 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">
              {t('basketTitle', { count: picked.length, max: maxDates })}
            </p>
            {picked.length > 0 &&
              typeof chosenDuration.priceAmount === 'number' &&
              chosenDuration.benefitOnly !== true && (
                <p className="text-sm font-semibold tabular-nums">
                  {chosenDuration.party
                    ? t('basketTotalPerPerson', {
                        total: formatCurrency(chosenDuration.priceAmount * picked.length, currency, locale),
                      })
                    : t('basketTotal', {
                        total: formatCurrency(chosenDuration.priceAmount * picked.length, currency, locale),
                      })}
                </p>
              )}
          </div>
          {picked.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('basketHint', { max: maxDates })}</p>
          ) : (
            <ul className="divide-y text-sm">
              {picked.map((startMs) => {
                const label = `${fmt.custom(startMs, { weekday: 'short', day: 'numeric', month: 'short' })} · ${fmt.time(startMs)}–${fmt.time(startMs + durationMs)}`
                return (
                  <li key={startMs} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="tabular-nums">{label}</span>
                    <button
                      type="button"
                      onClick={() => togglePicked(startMs)}
                      aria-label={t('basketRemove', { date: label })}
                      className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {t('basketRemoveShort')}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <button
            type="button"
            disabled={picked.length === 0}
            onClick={() => onPickMany?.(picked, chosenDuration)}
            className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {t('basketContinue', { count: picked.length })}
          </button>
        </div>
      )}
    </>
  )
}
