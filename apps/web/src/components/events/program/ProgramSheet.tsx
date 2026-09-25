'use client'

import { Fragment } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  compareProgramItems,
  crossesMidnight,
  itemsForDay,
  parseHHMM,
  sortedDays,
  sortedTracks,
} from '@linyup/shared'
import type { DaysAndTracks, ProgramDay, ProgramTrack } from '@linyup/shared'
import type { TimelineItem } from './ProgramTimeline'

/**
 * THE PROGRAM AS A PRINTED HANDOUT — what a member reads, on screen and on
 * paper.
 *
 * `ProgramTimeline` is the WORKING view: cards, coloured track bars, edit
 * pencils, built for the people assembling the agenda. A member does not
 * assemble anything; they want the sheet a camp hands out at the door. So this
 * is laid out like one: black on white, a time column and a rule under each
 * day, parallel tracks as columns of a table, and nothing that only makes
 * sense with a mouse. The SAME markup is the screen view and the printout —
 * the browser's "Save as PDF" is the PDF, which is the recorded choice over
 * jsPDF (docs/event-program.md → Publishing).
 *
 * It is PAPER IN BOTH THEMES: fixed neutral colours rather than theme tokens,
 * because a handout that inverts in dark mode stops looking like what will
 * come out of the printer.
 *
 * Never pass `showInternalNotes` on a public surface. The public mirror does
 * not carry notes anyway; the flag exists for the staff printout.
 *
 * Avoid `<header>`, `<nav>` and `<aside>` in here: the app's print stylesheet
 * hides those wholesale to drop the dashboard chrome (globals.css, manifest
 * block).
 */

export interface ProgramSheetProps {
  /** The studio or organisation the event belongs to. */
  ownerName?: string | null
  title: string
  start?: Date | null
  end?: Date | null
  location?: string | null
  coachName?: string | null
  description?: string | null
  config: (DaysAndTracks & { timezoneLabel?: string | null; note?: string | null }) | undefined | null
  items: TimelineItem[]
  showInternalNotes?: boolean
  className?: string
}

/** A 'YYYY-MM-DD' program day as a local calendar date — never via UTC, which
 *  would move it a day west of Greenwich. */
function dayDate(iso: string): Date | null {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Items on a track that no longer exists fall back to plenary — the same
 *  reading as removing a lane in the structure dialog. */
function laneOf(item: TimelineItem, trackIds: Set<string>): string | null {
  return item.trackId && trackIds.has(item.trackId) ? item.trackId : null
}

/** Sort key for a row: all-day items first, then by start time. */
function slotKey(item: TimelineItem): string {
  return item.allDay ? '' : item.startTime
}

type SheetRow =
  | { kind: 'plenary'; item: TimelineItem }
  | { kind: 'tracks'; time: string; allDay: boolean; cells: Map<string, TimelineItem[]> }

/** Lay a multi-track day out as table rows: items that start together share a
 *  row, one cell per track; a plenary item gets a row of its own across every
 *  track, above the tracks that start at the same time. */
function buildRows(dayItems: TimelineItem[], trackIds: Set<string>): SheetRow[] {
  type Slot = { plenary: TimelineItem[]; cells: Map<string, TimelineItem[]> }
  const bySlot = new Map<string, Slot>()
  for (const item of dayItems) {
    const key = slotKey(item)
    const slot: Slot = bySlot.get(key) ?? { plenary: [], cells: new Map() }
    const lane = laneOf(item, trackIds)
    if (lane === null) slot.plenary.push(item)
    else slot.cells.set(lane, [...(slot.cells.get(lane) ?? []), item])
    bySlot.set(key, slot)
  }
  const rows: SheetRow[] = []
  // All-day ('') first, then by clock time — parsed, so '9:00' and '09:00'
  // cannot sort apart; an unparseable time goes last, as compareProgramItems does.
  const minutes = (key: string) => (key === '' ? -1 : parseHHMM(key) ?? Number.MAX_SAFE_INTEGER)
  for (const key of [...bySlot.keys()].sort((a, b) => minutes(a) - minutes(b))) {
    const slot = bySlot.get(key)!
    for (const item of slot.plenary) rows.push({ kind: 'plenary', item })
    if (slot.cells.size > 0) rows.push({ kind: 'tracks', time: key, allDay: key === '', cells: slot.cells })
  }
  return rows
}

const QUIET_KINDS = new Set(['meal', 'break', 'transfer', 'free'])

function TimeRange({ item }: { item: TimelineItem }) {
  const t = useTranslations('EventProgram')
  if (item.allDay) return <>{t('allDay')}</>
  return (
    <>
      {item.startTime}
      {item.endTime ? `–${item.endTime}` : ''}
      {crossesMidnight(item) && <sup title={t('crossesMidnight')}> +1</sup>}
    </>
  )
}

function ItemBody({
  item,
  showInternalNotes,
  trackLabel,
  showEnd,
}: {
  item: TimelineItem
  showInternalNotes?: boolean
  /** Printed above the title where the track is not given by a column. */
  trackLabel?: string | null
  /** In a track cell the time column shows only the shared start. */
  showEnd?: boolean
}) {
  const t = useTranslations('EventProgram')
  const quiet = item.kind ? QUIET_KINDS.has(item.kind) : false
  const meta = [item.locationText, item.peopleText].filter(Boolean).join(' · ')
  const until =
    showEnd && !item.allDay && item.endTime ? t('sheetUntil', { time: item.endTime }) : null

  return (
    <div className={cn(item.isHighlight && 'border-l-2 border-neutral-900 pl-2')}>
      {trackLabel && (
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
          {trackLabel}
        </p>
      )}
      <p
        className={cn(
          'leading-snug',
          quiet ? 'italic text-neutral-600' : 'font-medium text-neutral-900',
          item.isHighlight && 'font-semibold',
        )}
      >
        {item.title}
      </p>
      {item.subtitle && <p className="text-[13px] text-neutral-600">{item.subtitle}</p>}
      {item.description && (
        <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-700">
          {item.description}
        </p>
      )}
      {(meta || until) && (
        <p className="mt-0.5 text-xs text-neutral-500">{[until, meta].filter(Boolean).join(' · ')}</p>
      )}
      {showInternalNotes && item.internalNote && (
        <p className="mt-1 border border-dashed border-neutral-400 px-1.5 py-0.5 text-xs italic text-neutral-600">
          {t('sheetInternalNote', { note: item.internalNote })}
        </p>
      )}
    </div>
  )
}

function DayBlock({
  day,
  dayItems,
  tracks,
  showInternalNotes,
}: {
  day: ProgramDay
  dayItems: TimelineItem[]
  tracks: ProgramTrack[]
  showInternalNotes?: boolean
}) {
  const t = useTranslations('EventProgram')
  const format = useFormatter()
  const date = dayDate(day.date)
  const dateLabel = date
    ? format.dateTime(date, { weekday: 'long', day: 'numeric', month: 'long' })
    : day.date
  const trackIds = new Set(tracks.map((tr) => tr.id))
  const multiTrack = tracks.length > 1
  const trackName = (item: TimelineItem) => {
    const lane = laneOf(item, trackIds)
    return lane ? tracks.find((tr) => tr.id === lane)?.name ?? null : t('sheetAllTracks')
  }

  return (
    <section className="program-day break-inside-avoid">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 border-b border-neutral-900 pb-1">
        <h2 className="font-serif text-lg font-semibold text-neutral-900">{day.title || dateLabel}</h2>
        <p className="text-xs uppercase tracking-[0.12em] text-neutral-500">
          {day.title ? dateLabel : ''}
          {day.subtitle ? `${day.title ? ' · ' : ''}${day.subtitle}` : ''}
        </p>
      </div>

      {dayItems.length === 0 ? (
        <p className="py-3 text-sm italic text-neutral-500">{t('dayEmpty')}</p>
      ) : (
        <>
          {/* ONE LANE — and the phone layout of a multi-track day: a time column
              and the agenda, with the track named on each row. A table of four
              tracks does not fit a phone, and a sideways-scrolling handout is
              not one. */}
          <table className={cn('w-full border-collapse text-sm', multiTrack && 'sheet-stacked sm:hidden')}>
            <tbody>
              {dayItems.map((item) => (
                <tr key={item.id} className="border-b border-neutral-200 last:border-0 align-top">
                  <td className="w-[6.5rem] whitespace-nowrap py-2 pr-3 tabular-nums text-neutral-700">
                    <TimeRange item={item} />
                  </td>
                  <td className="py-2">
                    <ItemBody
                      item={item}
                      showInternalNotes={showInternalNotes}
                      trackLabel={multiTrack ? trackName(item) : null}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* PARALLEL TRACKS — a column each, as a printed camp schedule has
              them. Items that start together share a row; a plenary item runs
              across all the columns. */}
          {multiTrack && (
            <table className="sheet-grid hidden w-full table-fixed border-collapse text-sm sm:table">
              <thead>
                <tr className="border-b border-neutral-300 text-left">
                  <th className="w-[5.5rem] py-1.5 pr-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                    {t('sheetTime')}
                  </th>
                  {tracks.map((track) => (
                    <th
                      key={track.id}
                      className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-700"
                    >
                      {track.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {buildRows(dayItems, trackIds).map((row, i) =>
                  row.kind === 'plenary' ? (
                    <tr key={row.item.id} className="border-b border-neutral-200 align-top">
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-neutral-700">
                        <TimeRange item={row.item} />
                      </td>
                      <td colSpan={tracks.length} className="bg-neutral-50 px-2 py-2">
                        <ItemBody item={row.item} showInternalNotes={showInternalNotes} />
                      </td>
                    </tr>
                  ) : (
                    <tr key={`slot-${i}`} className="border-b border-neutral-200 align-top">
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-neutral-700">
                        {row.allDay ? t('allDay') : row.time}
                      </td>
                      {tracks.map((track) => (
                        <td key={track.id} className="border-l border-neutral-200 px-2 py-2">
                          {(row.cells.get(track.id) ?? []).map((item, j) => (
                            <Fragment key={item.id}>
                              {j > 0 && <div className="my-1.5 border-t border-dotted border-neutral-300" />}
                              <ItemBody item={item} showInternalNotes={showInternalNotes} showEnd />
                            </Fragment>
                          ))}
                        </td>
                      ))}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  )
}

export function ProgramSheet({
  ownerName,
  title,
  start,
  end,
  location,
  coachName,
  description,
  config,
  items,
  showInternalNotes,
  className,
}: ProgramSheetProps) {
  const format = useFormatter()
  const t = useTranslations('EventProgram')
  const days = sortedDays(config ?? undefined)
  const tracks = sortedTracks(config ?? undefined)
  const sortedItems = [...items].sort(compareProgramItems)

  const full = { day: 'numeric', month: 'long', year: 'numeric' } as const
  const when = start
    ? !end || sameDay(start, end)
      ? format.dateTime(start, { weekday: 'long', ...full })
      : `${format.dateTime(start, start.getFullYear() === end.getFullYear() ? { day: 'numeric', month: 'long' } : full)} – ${format.dateTime(end, full)}`
    : null
  const facts = [when, location, coachName].filter(Boolean).join(' · ')

  return (
    <article
      className={cn(
        'program-sheet bg-white px-6 py-8 text-neutral-900 sm:px-10 sm:py-10',
        className,
      )}
    >
      <div className="border-b-2 border-neutral-900 pb-4">
        {ownerName && (
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-neutral-500">{ownerName}</p>
        )}
        <h1 className="mt-1 font-serif text-3xl font-semibold leading-tight">{title}</h1>
        {facts && <p className="mt-2 text-sm text-neutral-600">{facts}</p>}
      </div>

      {description && (
        <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-neutral-700">{description}</p>
      )}

      {config?.note && (
        <p className="mt-4 whitespace-pre-wrap border-l-2 border-neutral-400 pl-3 text-sm text-neutral-700">
          {config.note}
        </p>
      )}

      {days.length > 0 && sortedItems.length > 0 && (
        <div className="mt-8 space-y-8">
          {days.map((day) => (
            <DayBlock
              key={day.id}
              day={day}
              dayItems={itemsForDay(sortedItems, day.id)}
              tracks={tracks}
              showInternalNotes={showInternalNotes}
            />
          ))}
        </div>
      )}

      {config?.timezoneLabel && sortedItems.length > 0 && (
        <p className="mt-8 text-xs text-neutral-500">{t('timesShownIn', { zone: config.timezoneLabel })}</p>
      )}
    </article>
  )
}
