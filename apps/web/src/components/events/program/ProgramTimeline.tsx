'use client'

import { useTranslations } from 'next-intl'
import { Clock, MapPin, Users, Star, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  crossesMidnight,
  isPlenary,
  itemsForDay,
  itemsForTrack,
  sortedDays,
  sortedTracks,
} from '@linyup/shared'
import type {
  DaysAndTracks,
  ProgramDay,
  ProgramItemKind,
  ProgramTrack,
} from '@linyup/shared'

// Accepts BOTH the private EventProgramItem and the public mirror's
// PublicProgramItem (which uses null where the private doc uses undefined), so
// the admin, the public page, the Space strip and the print sheet all render
// through one component instead of drifting apart.
export interface TimelineItem {
  id: string
  dayId: string
  trackId?: string | null
  startTime: string
  endTime?: string | null
  allDay?: boolean
  title: string
  subtitle?: string | null
  description?: string | null
  locationText?: string | null
  peopleText?: string | null
  kind?: ProgramItemKind | null
  color?: string | null
  isHighlight?: boolean
  /** Staff-only; only rendered when showInternalNotes is explicitly set. */
  internalNote?: string | null
  order: number
}

// The ONE read-only renderer for an event program. Reused by the admin preview,
// the public event page, the Space strip and the print sheet, so a program looks
// the same everywhere and only has to be got right once.
//
// Layout: with 2+ tracks it renders a column per track, with plenary items
// (no trackId) spanning the full width. With 0-1 tracks it collapses to a plain
// agenda list. On narrow screens the columns become stacked per-track sections
// rather than a horizontally scrolling table — mobile-first, per the UI porting
// principles.

export interface ProgramTimelineProps {
  /** Accepts the private config and the public mirror's nullable one alike. */
  config: (DaysAndTracks & { timezoneLabel?: string | null; note?: string | null }) | undefined
  items: TimelineItem[]
  /** Restrict to one day. Omit to render every day in order. */
  dayId?: string
  /** Show staff-only internal notes. NEVER pass true on a public surface. */
  showInternalNotes?: boolean
  /**
   * Render day headings as "Day 1", "Day 2" instead of calendar dates.
   *
   * For a TEMPLATE, whose days are a relative `dayIndex` and whose dates are a
   * scratch anchor invented so the shared editor has something to key items on.
   * Printing "Monday 1 September" over a reusable programme states a fact that
   * is not one — the studio would reasonably read it as when the camp runs.
   */
  hideDayDates?: boolean
  /** Renders an edit affordance on each item (admin only). */
  onEditItem?: (item: TimelineItem) => void
  className?: string
}

function formatDayDate(date: string): string {
  // Parse as a plain calendar date. Appending T00:00:00 keeps the browser from
  // reading a bare 'YYYY-MM-DD' as UTC and shifting it a day west of Greenwich.
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return date
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

function ItemCard({
  item,
  showInternalNotes,
  onEdit,
  accent,
}: {
  item: TimelineItem
  showInternalNotes?: boolean
  onEdit?: (item: TimelineItem) => void
  accent?: string
}) {
  const t = useTranslations('EventProgram')
  const color = item.color ?? accent

  return (
    <div
      className={cn(
        'group relative rounded-lg border bg-card p-3 text-left',
        item.isHighlight && 'ring-1 ring-primary/40',
      )}
      style={color ? { borderLeftColor: color, borderLeftWidth: 3 } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3 shrink-0" />
            <span className="font-medium tabular-nums">
              {item.allDay ? t('allDay') : item.startTime}
              {!item.allDay && item.endTime ? `–${item.endTime}` : ''}
            </span>
            {crossesMidnight(item) && (
              <span title={t('crossesMidnight')} className="text-xs">
                +1
              </span>
            )}
            {item.isHighlight && <Star className="h-3 w-3 shrink-0 text-primary" />}
          </div>

          <p className="mt-1 text-sm font-medium leading-snug">{item.title}</p>
          {item.subtitle && (
            <p className="text-xs text-muted-foreground">{item.subtitle}</p>
          )}
          {item.description && (
            <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
              {item.description}
            </p>
          )}

          {(item.locationText || item.peopleText) && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {item.locationText && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3 shrink-0" />
                  {item.locationText}
                </span>
              )}
              {item.peopleText && (
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3 w-3 shrink-0" />
                  {item.peopleText}
                </span>
              )}
            </div>
          )}

          {showInternalNotes && item.internalNote && (
            <p className="mt-2 rounded border border-dashed px-2 py-1 text-xs italic text-muted-foreground">
              {item.internalNote}
            </p>
          )}
        </div>

        {onEdit && (
          <button
            type="button"
            onClick={() => onEdit(item)}
            aria-label={t('editItem')}
            className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

function DaySection({
  day,
  dayIndex,
  dayItems,
  tracks,
  showInternalNotes,
  onEditItem,
  showDayHeading,
  hideDayDates,
}: {
  day: ProgramDay
  dayIndex: number
  dayItems: TimelineItem[]
  tracks: ProgramTrack[]
  showInternalNotes?: boolean
  onEditItem?: (item: TimelineItem) => void
  showDayHeading: boolean
  hideDayDates?: boolean
}) {
  const t = useTranslations('EventProgram')
  const multiTrack = tracks.length > 1
  const plenary = itemsForTrack(dayItems, null)
  const dayCaption = hideDayDates ? t('dayN', { n: dayIndex + 1 }) : formatDayDate(day.date)

  return (
    <section className="program-day space-y-3">
      {showDayHeading && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="text-sm font-semibold">
            {day.title || dayCaption}
          </h3>
          {day.title && (
            <span className="text-xs text-muted-foreground">{dayCaption}</span>
          )}
          {day.subtitle && (
            <span className="text-xs text-muted-foreground">· {day.subtitle}</span>
          )}
        </div>
      )}

      {dayItems.length === 0 && (
        <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
          {t('dayEmpty')}
        </p>
      )}

      {/* Single lane: plain agenda list. Also the mobile layout for multi-track
          days, where the grid below collapses to stacked per-track sections. */}
      {!multiTrack && dayItems.length > 0 && (
        <div className="space-y-2">
          {dayItems.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              showInternalNotes={showInternalNotes}
              onEdit={onEditItem}
              accent={tracks.find((tr) => tr.id === item.trackId)?.color}
            />
          ))}
        </div>
      )}

      {multiTrack && dayItems.length > 0 && (
        <div className="space-y-2">
          {/* Plenary items span every track — rendered full width, above the grid. */}
          {plenary.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              showInternalNotes={showInternalNotes}
              onEdit={onEditItem}
            />
          ))}

          <div
            className="grid gap-3 md:grid-cols-[repeat(var(--program-tracks),minmax(0,1fr))]"
            style={{ ['--program-tracks' as string]: String(tracks.length) }}
          >
            {tracks.map((track) => {
              const trackItems = itemsForTrack(dayItems, track.id)
              return (
                <div key={track.id} className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: track.color || 'var(--muted-foreground)' }}
                    />
                    <span className="text-xs font-medium">{track.name}</span>
                  </div>
                  {trackItems.length === 0 ? (
                    <p className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
                      —
                    </p>
                  ) : (
                    trackItems.map((item) => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        showInternalNotes={showInternalNotes}
                        onEdit={onEditItem}
                        accent={track.color}
                      />
                    ))
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

export function ProgramTimeline({
  config,
  items,
  dayId,
  showInternalNotes,
  onEditItem,
  className,
  hideDayDates,
}: ProgramTimelineProps) {
  const t = useTranslations('EventProgram')
  const days = sortedDays(config)
  const tracks = sortedTracks(config)
  const visibleDays = dayId ? days.filter((d) => d.id === dayId) : days

  if (visibleDays.length === 0) {
    return (
      <p className={cn('py-10 text-center text-sm text-muted-foreground', className)}>
        {t('emptyProgram')}
      </p>
    )
  }

  return (
    <div className={cn('space-y-6', className)}>
      {config?.note && (
        <p className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-sm">
          {config.note}
        </p>
      )}

      {visibleDays.map((day) => (
        <DaySection
          key={day.id}
          day={day}
          // Index within the WHOLE programme, not within `visibleDays` — with one
          // day selected the filtered list is length 1 and every day would
          // caption itself "Day 1".
          dayIndex={days.findIndex((d) => d.id === day.id)}
          dayItems={itemsForDay(items, day.id)}
          tracks={tracks}
          showInternalNotes={showInternalNotes}
          onEditItem={onEditItem}
          // With a single day selected the surrounding UI already names it.
          showDayHeading={!dayId}
          hideDayDates={hideDayDates}
        />
      ))}

      {config?.timezoneLabel && (
        <p className="text-xs text-muted-foreground">
          {t('timesShownIn', { zone: config.timezoneLabel })}
        </p>
      )}
    </div>
  )
}

/** Convenience predicate for surfaces that only want to show a program section
 *  when there is actually something to show. */
export function hasProgram(
  config: DaysAndTracks | undefined,
  items: Array<{ id: string }> | undefined,
): boolean {
  return (config?.days?.length ?? 0) > 0 && (items?.length ?? 0) > 0
}

export { isPlenary }
