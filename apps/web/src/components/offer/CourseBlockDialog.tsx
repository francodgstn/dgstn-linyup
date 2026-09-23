'use client'

// ─── A COURSE: name it, say when it runs, say how many fit ──────────────────
//
// A course is a bounded set of lessons sold as one thing. The hard part of
// authoring one is WHEN, and the lean answer is to ask the question the studio
// is already answering in its head:
//
//   Repeating   "every Wednesday until the end of November, skipping half-term"
//   Days        "a Saturday and a Sunday, different times"
//   One day     "an afternoon in October"
//
// All three resolve to the same list of lessons, server-side
// (`courseBlocks/schedule.ts`), and this dialog previews the count before Save
// because "13 lessons" is what the studio will put on the card and what the
// parent will pay for, a schedule that quietly produces 12 is the mistake this
// preview exists to catch.
//
// The lessons appear on the calendar as ordinary sessions. Removing one is
// cancelling it there, not deleting a row here: people may hold a place on it.

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Timestamp } from 'firebase/firestore'
import { X } from 'lucide-react'
import {
  firstMeeting,
  isAppointmentActivity,
  lastMeeting,
  meetingCount,
  type Activity,
  type CourseBlock,
} from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { useActivities } from '@/hooks/useActivities'
import { useCoaches, coachLabel, type CoachOption } from '@/hooks/useCoaches'
import { usePlaces } from '@/hooks/usePlaces'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import { callFunction } from '@/lib/callFunction'
import { toDateInputValue } from '@/lib/format'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type ScheduleMode = 'repeating' | 'days'

/** One hand-entered lesson, as the form holds it. */
interface DayRow {
  /** `YYYY-MM-DD`, local. */
  date: string
  /** `HH:MM`, local. */
  time: string
  minutes: number
}

const NONE = '__none'

/** A local date+time pair → the instant, through the browser's own timezone , 
 *  which is the studio's. The same spelling `SessionFormDialog` uses. */
function localInstant(date: string, time: string): number | null {
  if (!date || !time) return null
  const at = new Date(`${date}T${time}`)
  return Number.isNaN(at.getTime()) ? null : at.getTime()
}

const emptyDay = (): DayRow => ({ date: '', time: '10:00', minutes: 60 })

export function CourseBlockDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The live document when editing; absent when creating. */
  editing?: CourseBlock | null
  onSaved?: (id: string) => void
}) {
  // A namespace of its own, not the online-courses plugin's `Courses`: the two
  // are displayed as *Course* and *Online course*, and sharing a namespace is
  // how two different things end up sharing a word by accident.
  const t = useTranslations('CourseBlocks')
  const tSessions = useTranslations('Sessions')
  const { currentTeamId } = useAuth()
  const qc = useQueryClient()
  const fmt = useTeamFormat()
  const { data: activities = [] } = useActivities(currentTeamId)
  // `pickable` is the roster this form may assign, the hook's own answer to
  // who can lead a session, so this dialog does not re-derive it.
  const { pickable: coaches } = useCoaches(currentTeamId)
  const { data: places = [] } = usePlaces(currentTeamId)

  // A course runs on a CLASS. An appointment has no calendar until somebody
  // books it, so a set of them is not a course, the server refuses one too.
  const classes = useMemo(() => activities.filter((a: Activity) => !isAppointmentActivity(a)), [activities])

  const [name, setName] = useState('')
  const [activityId, setActivityId] = useState(NONE)
  const [placeId, setPlaceId] = useState(NONE)
  const [providerId, setProviderId] = useState(NONE)
  const [places_, setPlaces] = useState('')
  const [mode, setMode] = useState<ScheduleMode>('repeating')

  // Repeating
  const [startDate, setStartDate] = useState('')
  const [startTime, setStartTime] = useState('15:45')
  const [minutes, setMinutes] = useState(60)
  const [weekday, setWeekday] = useState<number | null>(null)
  const [endDate, setEndDate] = useState('')
  const [skipDates, setSkipDates] = useState<string[]>([])

  // Days
  const [days, setDays] = useState<DayRow[]>([emptyDay()])

  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setSaving(false)
    if (editing) {
      setName(editing.name ?? '')
      setActivityId(editing.activityId ?? NONE)
      setPlaceId(editing.placeId ?? NONE)
      setProviderId(editing.providerId ?? NONE)
      setPlaces(editing.places ? String(editing.places) : '')
      // An existing course is re-opened on the shape it was authored in, so the
      // studio edits what it typed rather than a list of thirteen dates.
      const rule = editing.pattern?.recurrence
      if (rule) {
        setMode('repeating')
        const from = rule.startDate?.toDate?.()
        if (from) {
          setStartDate(toDateInputValue(from))
          setStartTime(
            `${String(from.getHours()).padStart(2, '0')}:${String(from.getMinutes()).padStart(2, '0')}`
          )
          setWeekday(rule.daysOfWeek?.[0] ?? from.getDay())
        }
        setMinutes(rule.duration ?? 60)
        const until = rule.endDate?.toDate?.()
        setEndDate(until ? toDateInputValue(until) : '')
        setSkipDates((rule.excludeDates ?? []).map((d) => toDateInputValue(d.toDate())))
      } else {
        setMode('days')
        setDays(
          (editing.meetings ?? []).map((m) => {
            const at = m.start.toDate()
            return {
              date: toDateInputValue(at),
              time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
              minutes: Math.max(1, Math.round((m.end.toMillis() - m.start.toMillis()) / 60_000)),
            }
          })
        )
      }
      return
    }
    setName('')
    setActivityId(NONE)
    setPlaceId(NONE)
    setProviderId(NONE)
    setPlaces('')
    setMode('repeating')
    setStartDate('')
    setStartTime('15:45')
    setMinutes(60)
    setWeekday(null)
    setEndDate('')
    setSkipDates([])
    setDays([emptyDay()])
  }, [open, editing])

  // ── The preview: the same arithmetic the server will do ──────────────────
  //
  // Not a call, the studio is typing, and a round trip per keystroke to be told
  // "13" is a worse answer than counting here. The server resolves it again on
  // save and is the authority; a disagreement would show up as a different count
  // on the saved course, which is exactly where it should show up.
  const previewDates = useMemo<Date[]>(() => {
    if (mode === 'days') {
      return days
        .map((d) => localInstant(d.date, d.time))
        .filter((ms): ms is number => ms !== null)
        .sort((a, b) => a - b)
        .map((ms) => new Date(ms))
    }
    const from = localInstant(startDate, startTime)
    if (from === null || !endDate) return []
    const until = new Date(`${endDate}T23:59`)
    if (Number.isNaN(until.getTime())) return []
    const skip = new Set(skipDates)
    const out: Date[] = []
    const cursor = new Date(from)
    const day = weekday ?? cursor.getDay()
    // Walk to the first matching weekday, then weekly.
    while (cursor.getDay() !== day && cursor <= until) cursor.setDate(cursor.getDate() + 1)
    while (cursor <= until && out.length <= 400) {
      if (!skip.has(toDateInputValue(cursor))) out.push(new Date(cursor))
      cursor.setDate(cursor.getDate() + 7)
    }
    return out
  }, [mode, days, startDate, startTime, endDate, weekday, skipDates])

  const nameInvalid = name.trim().length === 0
  const scheduleInvalid = previewDates.length === 0
  const canSave = !nameInvalid && !scheduleInvalid && !saving

  async function save() {
    if (!currentTeamId || !canSave) return
    setSaving(true)
    try {
      const schedule =
        mode === 'repeating'
          ? {
              kind: 'repeating' as const,
              recurrence: {
                frequency: 'weekly' as const,
                interval: 1,
                daysOfWeek: [weekday ?? new Date(`${startDate}T${startTime}`).getDay()],
                duration: minutes,
                startDate: Timestamp.fromDate(new Date(`${startDate}T${startTime}`)),
                endCondition: 'date' as const,
                endDate: Timestamp.fromDate(new Date(`${endDate}T23:59`)),
                excludeDates: skipDates.map((d) => Timestamp.fromDate(new Date(`${d}T12:00`))),
              },
            }
          : {
              kind: 'dates' as const,
              meetings: days
                .map((d) => ({ startMs: localInstant(d.date, d.time), durationMinutes: d.minutes }))
                .filter((m): m is { startMs: number; durationMinutes: number } => m.startMs !== null),
            }

      const payload = {
        teamId: currentTeamId,
        name: name.trim(),
        activityId: activityId === NONE ? '' : activityId,
        placeId: placeId === NONE ? '' : placeId,
        providerId: providerId === NONE ? '' : providerId,
        providerName: (() => {
          if (providerId === NONE) return ''
          const picked = coaches.find((c: CoachOption) => c.userId === providerId)
          return picked ? coachLabel(picked) : ''
        })(),
        places: places_,
        schedule,
      }

      const res = editing
        ? await callFunction<typeof payload & { blockId: string }, { id: string }>('updateCourseBlock')({
            ...payload,
            blockId: editing.id,
          })
        : await callFunction<typeof payload, { id: string }>('createCourseBlock')(payload)

      await qc.invalidateQueries({ queryKey: ['course-blocks', currentTeamId] })
      toast.success(editing ? t('saved') : t('created', { count: previewDates.length }))
      onSaved?.(res.data.id)
      onOpenChange(false)
    } catch (err) {
      console.error('[course save] failed:', err)
      toast.error(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? t('editTitle') : t('newTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="course-name">{t('nameLabel')}</Label>
            <Input
              id="course-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('activityLabel')}</Label>
              <Select value={activityId} onValueChange={(v) => setActivityId(v ?? NONE)}>
                <SelectTrigger>
                  <SelectValue placeholder={t('activityNone')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('activityNone')}</SelectItem>
                  {classes.map((a: Activity) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('activityHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="course-places">{t('placesLabel')}</Label>
              <Input
                id="course-places"
                type="number"
                min={0}
                value={places_}
                onChange={(e) => setPlaces(e.target.value)}
                placeholder={t('placesPlaceholder')}
              />
              <p className="text-xs text-muted-foreground">{t('placesHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t('placeLabel')}</Label>
              <Select value={placeId} onValueChange={(v) => setPlaceId(v ?? NONE)}>
                <SelectTrigger>
                  <SelectValue placeholder={t('placeNone')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('placeNone')}</SelectItem>
                  {places.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('coachLabel')}</Label>
              <Select value={providerId} onValueChange={(v) => setProviderId(v ?? NONE)}>
                <SelectTrigger>
                  <SelectValue placeholder={t('coachNone')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('coachNone')}</SelectItem>
                  {coaches.map((c: CoachOption) => (
                    <SelectItem key={c.userId} value={c.userId}>
                      {coachLabel(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── WHEN ─────────────────────────────────────────────────────── */}
          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t('whenLabel')}</span>
              <div className="ml-auto flex gap-1">
                {(['repeating', 'days'] as ScheduleMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`rounded-md px-2 py-1 text-xs transition-colors ${
                      mode === m ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {m === 'repeating' ? t('modeRepeating') : t('modeDays')}
                  </button>
                ))}
              </div>
            </div>

            {mode === 'repeating' ? (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="course-start">{t('firstLesson')}</Label>
                    <Input
                      id="course-start"
                      type="date"
                      value={startDate}
                      onChange={(e) => {
                        setStartDate(e.target.value)
                        if (e.target.value) setWeekday(new Date(`${e.target.value}T12:00`).getDay())
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="course-time">{t('timeLabel')}</Label>
                    <Input
                      id="course-time"
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="course-minutes">{t('minutesLabel')}</Label>
                    <Input
                      id="course-minutes"
                      type="number"
                      min={1}
                      value={minutes}
                      onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="course-end">{t('lastLesson')}</Label>
                  <Input
                    id="course-end"
                    type="date"
                    min={startDate || undefined}
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <span className="text-sm text-muted-foreground">{tSessions('skipDates')}</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[...skipDates].sort().map((d) => (
                      <span
                        key={d}
                        className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                      >
                        {fmt.dateMedium(new Date(`${d}T12:00`))}
                        <button
                          type="button"
                          onClick={() => setSkipDates(skipDates.filter((x) => x !== d))}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={tSessions('skipDatesRemove', {
                            date: fmt.dateMedium(new Date(`${d}T12:00`)),
                          })}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    <input
                      type="date"
                      value=""
                      min={startDate || undefined}
                      max={endDate || undefined}
                      onChange={(e) => {
                        if (!e.target.value || skipDates.includes(e.target.value)) return
                        setSkipDates([...skipDates, e.target.value])
                      }}
                      className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      aria-label={tSessions('skipDatesAdd')}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {days.map((d, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Input
                      type="date"
                      value={d.date}
                      onChange={(e) =>
                        setDays(days.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))
                      }
                      className="w-40"
                      aria-label={t('firstLesson')}
                    />
                    <Input
                      type="time"
                      value={d.time}
                      onChange={(e) =>
                        setDays(days.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))
                      }
                      className="w-28"
                      aria-label={t('timeLabel')}
                    />
                    <Input
                      type="number"
                      min={1}
                      value={d.minutes}
                      onChange={(e) =>
                        setDays(
                          days.map((x, j) =>
                            j === i ? { ...x, minutes: Math.max(1, Number(e.target.value) || 1) } : x
                          )
                        )
                      }
                      className="w-24"
                      aria-label={t('minutesLabel')}
                    />
                    {days.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setDays(days.filter((_, j) => j !== i))}
                        aria-label={t('removeDay')}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => setDays([...days, emptyDay()])}>
                  {t('addDay')}
                </Button>
                <p className="text-xs text-muted-foreground">{t('daysHint')}</p>
              </div>
            )}

            {/* THE COUNT, before Save. "13 lessons" is what goes on the card and
                what the parent pays for; a schedule that quietly makes 12 is the
                mistake this catches. */}
            <div className="rounded-md bg-muted/50 p-2.5 text-sm" role="status" aria-live="polite">
              {previewDates.length === 0 ? (
                <span className="text-muted-foreground">{t('previewEmpty')}</span>
              ) : (
                <>
                  <span className="font-medium">{t('previewCount', { count: previewDates.length })}</span>
                  <span className="text-muted-foreground">
                    {' · '}
                    {fmt.dateMedium(previewDates[0])}
                    {previewDates.length > 1 ? ` – ${fmt.dateMedium(previewDates[previewDates.length - 1])}` : ''}
                  </span>
                </>
              )}
            </div>
          </div>

          {editing && (
            <p className="text-xs text-muted-foreground">{t('editScheduleNote')}</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {saving ? t('saving') : editing ? t('save') : t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The one-line summary a row shows: "13 lessons · 20 Aug – 26 Nov · 4/9". */
export function courseBlockSummary(
  block: CourseBlock,
  fmt: { dateMedium: (d: Date) => string },
  t: (key: string, values?: Record<string, unknown>) => string
): string {
  const first = firstMeeting(block)
  const last = lastMeeting(block)
  const parts = [t('previewCount', { count: meetingCount(block) })]
  if (first) {
    parts.push(
      last && last.start.toMillis() !== first.start.toMillis()
        ? `${fmt.dateMedium(first.start.toDate())} – ${fmt.dateMedium(last.start.toDate())}`
        : fmt.dateMedium(first.start.toDate())
    )
  }
  if (typeof block.places === 'number' && block.places > 0) {
    parts.push(`${block.places_taken ?? 0}/${block.places}`)
  }
  return parts.join(' · ')
}
