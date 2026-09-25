'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { CalendarPlus, GripVertical, Plus, Trash2, Wand2 } from 'lucide-react'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ColorPicker } from '@/components/ui/color-picker'
import { SortableItem, SortableList } from '@/components/ui/sortable'
import { useResetOnOpen } from '@/hooks/useResetOnOpen'
import { addDaysISO, daysBetweenISO, sortedDays, sortedTracks, toISODate } from '@linyup/shared'
import type {
  Event, EventProgramConfig, EventProgramItem, ProgramDay, ProgramTrack,
} from '@linyup/shared'

// Days and tracks live in an embedded object on the event doc (they are few),
// so this dialog edits a local draft and saves the whole config in one write.
//
// Destructive branches are handled here rather than silently: removing a day
// takes its items with it (confirmed), while removing a track leaves its items
// in place as plenary — the non-destructive reading of "remove this lane".

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2, 11)}`

/** 'YYYY-MM-DD' for a Firestore Timestamp, read in the browser's local calendar
 *  (the event's start as the studio sees it in the app). */
function isoDateOf(ts: { toDate(): Date } | undefined | null): string | null {
  if (!ts?.toDate) return null
  const d = ts.toDate()
  if (Number.isNaN(d.getTime())) return null
  return toISODate(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())))
}

export interface ProgramStructureDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * The event whose program this is — absent for a TEMPLATE, which has no
   * dates of its own. Without it the "fill from the event's dates" shortcut has
   * nothing to fill from and is not rendered, and a new day is simply appended
   * after the last one.
   */
  event?: Event | null
  /** Hide the per-day date field. Template days are a relative index; see
   *  ProgramTimeline.hideDayDates. */
  hideDates?: boolean
  config: EventProgramConfig
  items: EventProgramItem[]
  onSave: (config: EventProgramConfig) => Promise<void> | void
  /** Deletes a day AND its items in one batch. */
  onDeleteDay: (dayId: string) => Promise<void> | void
  /** Deletes a track, reassigning its items to plenary. */
  onDeleteTrack: (trackId: string) => Promise<void> | void
  saving?: boolean
}

export function ProgramStructureDialog({
  open, onOpenChange, event, hideDates, config, items, onSave, onDeleteDay, onDeleteTrack, saving,
}: ProgramStructureDialogProps) {
  const t = useTranslations('EventProgram')
  const [days, setDays] = useState<ProgramDay[]>(() => sortedDays(config))
  const [tracks, setTracks] = useState<ProgramTrack[]>(() => sortedTracks(config))
  const [timezoneLabel, setTimezoneLabel] = useState(config.timezoneLabel ?? '')
  const [note, setNote] = useState(config.note ?? '')
  const [confirmDay, setConfirmDay] = useState<ProgramDay | null>(null)
  const [confirmTrack, setConfirmTrack] = useState<ProgramTrack | null>(null)

  useResetOnOpen(open, () => {
    setDays(sortedDays(config))
    setTracks(sortedTracks(config))
    setTimezoneLabel(config.timezoneLabel ?? '')
    setNote(config.note ?? '')
  })

  const itemCountForDay = (dayId: string) => items.filter((i) => i.dayId === dayId).length
  const itemCountForTrack = (trackId: string) => items.filter((i) => i.trackId === trackId).length

  function addDay() {
    const last = days[days.length - 1]
    const anchor = (event ? isoDateOf(event.start) : null) ?? toISODate(new Date())
    const date = last ? addDaysISO(last.date, 1) : anchor
    setDays([...days, { id: newId(), date, order: days.length }])
  }

  /** Fill the day list from the event's own start → end dates. The quickest way
   *  to set up a multi-day camp, and the empty-state's primary action. */
  function generateDaysFromEvent() {
    if (!event) return
    const start = isoDateOf(event.start)
    const end = isoDateOf(event.end) ?? start
    if (!start || !end) return
    const span = Math.max(0, daysBetweenISO(start, end))
    const generated: ProgramDay[] = Array.from({ length: span + 1 }, (_, index) => ({
      id: newId(),
      date: addDaysISO(start, index),
      order: index,
    }))
    setDays(generated)
  }

  function addTrack() {
    setTracks([...tracks, { id: newId(), name: '', order: tracks.length }])
  }

  function reorderDays(from: number, to: number) {
    const next = [...days]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setDays(next.map((d, index) => ({ ...d, order: index })))
  }

  function reorderTracks(from: number, to: number) {
    const next = [...tracks]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setTracks(next.map((tr, index) => ({ ...tr, order: index })))
  }

  /** A day or track that has no items yet is only a draft row — drop it locally.
   *  One that has items needs the batched server-side delete. */
  function removeDay(day: ProgramDay) {
    if (itemCountForDay(day.id) > 0) { setConfirmDay(day); return }
    setDays(days.filter((d) => d.id !== day.id).map((d, index) => ({ ...d, order: index })))
  }

  function removeTrack(track: ProgramTrack) {
    if (itemCountForTrack(track.id) > 0) { setConfirmTrack(track); return }
    setTracks(tracks.filter((tr) => tr.id !== track.id).map((tr, index) => ({ ...tr, order: index })))
  }

  async function save() {
    await onSave({
      days: days.map((d, index) => ({ ...d, order: index })),
      tracks: tracks
        .filter((tr) => tr.name.trim())
        .map((tr, index) => ({ ...tr, name: tr.name.trim(), order: index })),
      ...(timezoneLabel.trim() ? { timezoneLabel: timezoneLabel.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    })
    onOpenChange(false)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('structureTitle')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-6">
            {/* ── Days ──────────────────────────────────────────────────────── */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{t('daysTitle')}</h3>
                <div className="flex gap-2">
                  {event && (
                    <Button type="button" size="sm" variant="outline" onClick={generateDaysFromEvent}>
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                      {t('generateDays')}
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="outline" onClick={addDay}>
                    <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
                    {t('addDay')}
                  </Button>
                </div>
              </div>

              {days.length === 0 && (
                <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                  {t('noDaysYet')}
                </p>
              )}

              <SortableList ids={days.map((d) => d.id)} onReorder={reorderDays}>
                <div className="space-y-2">
                  {days.map((day, index) => (
                    <SortableItem key={day.id} id={day.id}>
                      {({ setNodeRef, style, attributes, listeners, isDragging }) => (
                        <div
                          ref={setNodeRef}
                          style={style}
                          className={`flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 ${isDragging ? 'opacity-70' : ''}`}
                        >
                          <button
                            type="button"
                            aria-label={t('reorder')}
                            className="shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground active:cursor-grabbing"
                            {...attributes}
                            {...listeners}
                          >
                            <GripVertical className="h-4 w-4" />
                          </button>
                          <span className="w-12 shrink-0 text-xs text-muted-foreground">
                            {t('dayN', { n: index + 1 })}
                          </span>
                          {!hideDates && (
                            <Input
                              type="date"
                              value={day.date}
                              onChange={(e) =>
                                setDays(days.map((d) => (d.id === day.id ? { ...d, date: e.target.value } : d)))
                              }
                              className="w-[9.5rem] shrink-0"
                            />
                          )}
                          <Input
                            value={day.title ?? ''}
                            placeholder={t('dayTitlePlaceholder')}
                            onChange={(e) =>
                              setDays(days.map((d) => (d.id === day.id ? { ...d, title: e.target.value } : d)))
                            }
                            className="min-w-[8rem] flex-1"
                          />
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t('itemCount', { count: itemCountForDay(day.id) })}
                          </span>
                          <Button
                            type="button" size="icon" variant="ghost"
                            aria-label={t('deleteDay')}
                            className="shrink-0 text-destructive hover:text-destructive"
                            onClick={() => removeDay(day)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </SortableItem>
                  ))}
                </div>
              </SortableList>
            </section>

            {/* ── Tracks ────────────────────────────────────────────────────── */}
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">{t('tracksTitle')}</h3>
                  <p className="text-xs text-muted-foreground">{t('tracksHint')}</p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={addTrack}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  {t('addTrack')}
                </Button>
              </div>

              {tracks.length === 0 && (
                <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                  {t('noTracksYet')}
                </p>
              )}

              <SortableList ids={tracks.map((tr) => tr.id)} onReorder={reorderTracks}>
                <div className="space-y-2">
                  {tracks.map((track) => (
                    <SortableItem key={track.id} id={track.id}>
                      {({ setNodeRef, style, attributes, listeners, isDragging }) => (
                        <div
                          ref={setNodeRef}
                          style={style}
                          className={`flex items-center gap-2 rounded-lg border bg-card p-2 ${isDragging ? 'opacity-70' : ''}`}
                        >
                          <button
                            type="button"
                            aria-label={t('reorder')}
                            className="shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground active:cursor-grabbing"
                            {...attributes}
                            {...listeners}
                          >
                            <GripVertical className="h-4 w-4" />
                          </button>
                          <ColorPicker
                            value={track.color}
                            onChange={(hex) =>
                              setTracks(tracks.map((tr) => (tr.id === track.id ? { ...tr, color: hex } : tr)))
                            }
                            aria-label={t('trackColor')}
                            className="shrink-0"
                          />
                          <Input
                            value={track.name}
                            placeholder={t('trackNamePlaceholder')}
                            onChange={(e) =>
                              setTracks(tracks.map((tr) => (tr.id === track.id ? { ...tr, name: e.target.value } : tr)))
                            }
                            className="flex-1"
                          />
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t('itemCount', { count: itemCountForTrack(track.id) })}
                          </span>
                          <Button
                            type="button" size="icon" variant="ghost"
                            aria-label={t('deleteTrack')}
                            className="shrink-0 text-destructive hover:text-destructive"
                            onClick={() => removeTrack(track)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </SortableItem>
                  ))}
                </div>
              </SortableList>
            </section>

            {/* ── Display options ───────────────────────────────────────────── */}
            <section className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="program-tz">{t('fieldTimezoneLabel')}</Label>
                <Input
                  id="program-tz"
                  value={timezoneLabel}
                  onChange={(e) => setTimezoneLabel(e.target.value)}
                  placeholder={t('fieldTimezonePlaceholder')}
                />
                <p className="text-xs text-muted-foreground">{t('timezoneHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="program-note">{t('fieldNote')}</Label>
                <Input id="program-note" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </section>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="button" onClick={save} disabled={saving}>
              {saving ? t('saving') : t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deleting a day takes its items with it — always confirmed. */}
      <AlertDialog open={!!confirmDay} onOpenChange={(o) => !o && setConfirmDay(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteDayTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteDayDescription', { count: confirmDay ? itemCountForDay(confirmDay.id) : 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!confirmDay) return
                await onDeleteDay(confirmDay.id)
                setDays((prev) =>
                  prev.filter((d) => d.id !== confirmDay.id).map((d, index) => ({ ...d, order: index })),
                )
                setConfirmDay(null)
              }}
            >
              {t('deleteDay')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Deleting a track keeps its items — they become plenary. */}
      <AlertDialog open={!!confirmTrack} onOpenChange={(o) => !o && setConfirmTrack(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTrackTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteTrackDescription', { count: confirmTrack ? itemCountForTrack(confirmTrack.id) : 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!confirmTrack) return
                await onDeleteTrack(confirmTrack.id)
                setTracks((prev) =>
                  prev.filter((tr) => tr.id !== confirmTrack.id).map((tr, index) => ({ ...tr, order: index })),
                )
                setConfirmTrack(null)
              }}
            >
              {t('deleteTrack')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
