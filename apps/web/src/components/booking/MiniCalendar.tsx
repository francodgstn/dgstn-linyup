'use client'

// Shared date-picker used by every public booking flow (class BookingForm and
// the appointment picker) — moved out of BookingForm.tsx verbatim so both
// surfaces render the exact same calendar. Framework-agnostic: takes plain
// YYYY-MM-DD date keys, no Firestore Timestamp dependency.

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  addMonths,
  subMonths,
  isToday,
  isAfter,
  isSameMonth,
  startOfDay,
  format,
} from 'date-fns'

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function dateKeyToDate(key: string): Date {
  return new Date(key + 'T00:00:00')
}

/** The same day key as an instant for DISPLAY, and NOON is the whole point: the
 *  formatter renders in the studio's zone, so a device far east or west of it
 *  reads a midnight instant as the neighboring day. Its midnight sibling above
 *  is for calendar arithmetic, where the date parts are what matter and the
 *  instant is never formatted. */
export function dayKeyAtNoon(key: string): Date {
  return new Date(key + 'T12:00:00')
}

export interface MiniCalendarProps {
  availableDates: string[] // YYYY-MM-DD keys
  selectedDate: string | null
  onSelect: (dateKey: string) => void
  maxDateKey: string // YYYY-MM-DD, last bookable date
}

export function MiniCalendar({ availableDates, selectedDate, onSelect, maxDateKey }: MiniCalendarProps) {
  const t = useTranslations('PublicBooking')
  // The selected day wins over the first available one: a deep link
  // (`?session=` / `?date=`) can select a day weeks out, and opening on the
  // current month would show the visitor a calendar with nothing selected on it.
  const initialMonth = useMemo(() => {
    if (selectedDate) return dateKeyToDate(selectedDate)
    if (availableDates.length > 0) return dateKeyToDate(availableDates[0])
    return new Date()
    // Seed only — `currentMonth` is the visitor's own paging state from here on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableDates])

  const [currentMonth, setCurrentMonth] = useState(initialMonth)

  // …and follow the selection when it jumps out of the displayed month (the
  // activity changed, or a restored step selected a different day).
  //
  // IT DEPENDS ON `selectedDate` ALONE, AND THAT IS THE WHOLE POINT. With
  // `currentMonth` in the dependency array this effect also ran on the
  // visitor's OWN paging, and then undid it: page forward to September, the
  // effect re-runs, sees the still-selected August date is not in the displayed
  // month, and snaps straight back. The arrow appeared to flicker and do
  // nothing — and only once a date had been selected, which is why it read as a
  // glitch rather than a dead button.
  //
  // The functional update reads the current month without closing over it, so
  // dropping it from the deps costs no correctness; returning `cur` unchanged
  // when the month already matches also avoids a pointless re-render.
  useEffect(() => {
    if (!selectedDate) return
    const target = startOfMonth(dateKeyToDate(selectedDate))
    setCurrentMonth((cur) => (isSameMonth(target, cur) ? cur : target))
  }, [selectedDate])

  const monthStart = startOfMonth(currentMonth)
  const monthEnd = endOfMonth(currentMonth)
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd })

  // Mon=0 offset
  const firstDow = monthStart.getDay() === 0 ? 6 : monthStart.getDay() - 1
  const paddedDays = [...Array(firstDow).fill(null), ...days]
  while (paddedDays.length % 7 !== 0) paddedDays.push(null)

  const maxDate = dateKeyToDate(maxDateKey)
  const isAtMax = isAfter(startOfMonth(addMonths(currentMonth, 1)), startOfMonth(maxDate))
  const today = startOfDay(new Date())
  const isAtStart = !isAfter(currentMonth, today)

  const availableSet = new Set(availableDates)
  const WEEKDAYS = [
    t('weekdayMon'),
    t('weekdayTue'),
    t('weekdayWed'),
    t('weekdayThu'),
    t('weekdayFri'),
    t('weekdaySat'),
    t('weekdaySun'),
  ]

  return (
    <div className="select-none">
      {/* Month header */}
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
          disabled={isAtStart}
          className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-semibold">{format(currentMonth, 'MMMM yyyy')}</span>
        <button
          onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
          disabled={isAtMax}
          className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {isAtMax && (
        <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-2 py-1 mb-2 text-center">
          {t('showingBookableWindowOnly')}
        </p>
      )}

      {/* Weekday labels */}
      <div className="grid grid-cols-7 mb-1">
        {WEEKDAYS.map((d) => (
          <div key={d} className="text-center text-xs text-muted-foreground py-1 font-medium">
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-y-1">
        {paddedDays.map((day, i) => {
          if (!day) return <div key={`pad-${i}`} />
          const key = toDateKey(day)
          const available = availableSet.has(key)
          const isSelected = selectedDate === key
          const isTodayDay = isToday(day)

          return (
            <button
              key={key}
              onClick={() => available && onSelect(key)}
              disabled={!available}
              className={[
                'aspect-square rounded-full text-xs font-medium transition-all flex items-center justify-center mx-auto w-8 h-8',
                isSelected
                  ? 'bg-primary text-primary-foreground shadow-sm scale-110'
                  : available
                    ? 'hover:bg-primary/10 hover:text-primary cursor-pointer'
                    : 'text-muted-foreground/40 cursor-default',
                isTodayDay && !isSelected ? 'ring-1 ring-primary/40' : '',
              ].join(' ')}
              style={undefined}
            >
              {day.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}
