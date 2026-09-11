'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useForm, Controller } from 'react-hook-form'
import { addMonths } from 'date-fns'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  collection, addDoc, updateDoc, doc, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { refreshQueries } from '@/lib/queryRefresh'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DateTimePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { usePlaces } from '@/hooks/usePlaces'
import { useCoaches, coachLabel } from '@/hooks/useCoaches'
import { useAuth } from '@/contexts/AuthContext'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import { useInvalidateSetupChecklist } from '@/hooks/useSetupChecklist'
import { toDateInputValue } from '@/lib/format'
import { SeriesSummary } from '@/components/sessions/SeriesSummary'
import { PastItemNotice } from '@/components/sessions/PastItemNotice'
import { useQueryClient } from '@tanstack/react-query'
import {
  SESSIONS_COLLECTION,
  ACTIVITIES_COLLECTION,
  resolveAutoConfirm,
  isPastSession,
  weekdayOrder,
  SESSION_SERIES_COLLECTION,
} from '@linyup/shared'
import type { Session, Activity } from '@linyup/shared'
import { Loader2, Repeat2, Plus, AlertTriangle, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { PlacesSheet } from '@/components/schedule/PlacesSheet'

// ─── shared helpers (single source of truth for session forms) ─────────────────

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

export function deriveDefaultDuration(s: Session | null): number {
  if (!s) return 60
  if (s.duration_minutes) return s.duration_minutes
  if (s.start && s.end) return Math.max(15, Math.round((s.end.toDate().getTime() - s.start.toDate().getTime()) / 60000))
  return 60
}

/** Same shape as the activities page's own slugify — an activity created from
 *  here must be indistinguishable from one created there. */
function slugifyActivityName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

function defaultStart(): Date {
  const d = new Date()
  d.setHours(d.getHours() + 1, 0, 0, 0)
  return d
}

// ─── error surfacing helpers ────────────────────────────────────────────────
// A write that fails here (most commonly a Firestore rules denial) must never
// look like nothing happened — see the SessionFormDialog write paths below.

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string' && m) return m
  }
  return String(err)
}

class CallableTimeoutError extends Error {}

const CALLABLE_TIMEOUT_MS = 30_000

/** Races a promise against a fixed timeout so a hung callable clears busy state
 *  and surfaces a message instead of spinning forever. */
function withTimeout<T>(promise: Promise<T>, ms = CALLABLE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallableTimeoutError('timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ─── duration picker (preset chips + free minutes input) ───────────────────────
// Replaces the old slider — imprecise, and its thumb rendered poorly inside a
// scrolling dialog.

const DURATION_PRESETS = [30, 45, 60, 75, 90, 120]

function DurationPicker({ value, onChange, minutesLabel }: {
  value: number
  onChange: (v: number) => void
  minutesLabel: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {DURATION_PRESETS.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={value === m}
          className={`h-9 rounded-md border px-2.5 text-sm transition-colors ${
            value === m
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          {formatDuration(m)}
        </button>
      ))}
      <div className="flex h-9 items-center gap-1.5 rounded-md border border-input bg-background pl-2.5 pr-3 focus-within:ring-2 focus-within:ring-ring">
        <input
          type="number"
          min={15}
          max={480}
          step={5}
          value={value}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
          onBlur={(e) => onChange(Math.max(15, Math.min(480, Math.round(Number(e.target.value) || 60))))}
          aria-label={minutesLabel}
          className="w-12 bg-transparent text-right text-sm focus:outline-none"
        />
        <span className="text-xs text-muted-foreground">{minutesLabel}</span>
      </div>
    </div>
  )
}

// `SectionLabel` was this file's own copy of the group heading. It IS the shape
// that won the 2026-08-23 form sweep — small, uppercase, muted — so it moved to
// `components/ui/form-section.tsx` and everything else adopted it. Kept here as
// a one-line alias rather than rewritten at three call sites: the sections in
// this dialog carry no rules between them (they sit inside their own bordered
// blocks) and converting them would change this form's look for no reason.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  )
}

type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly'
type EndCondition        = 'never' | 'date' | 'count'

interface RecurrencePattern {
  frequency:      RecurrenceFrequency
  interval:       number
  daysOfWeek:     number[]
  endCondition:   EndCondition
  endDate:        Date | null
  maxOccurrences: number
}

// How far ahead the backend actually materialises a series — SERIES_HORIZON_MONTHS
// in packages/functions/src/sessions/series.ts. The daily `rollSessionSeries`
// task keeps an open-ended series topped up to this horizon, so "never" is now a
// truthful option; it is nonetheless not the DEFAULT, because a timetable that
// runs for ever is a decision, and the form should not make it silently on a
// studio's behalf. Defaulting to a visible date six months out states the
// horizon the product has and leaves "never" one click away.
const RECURRENCE_HORIZON_MONTHS = 6

function defaultRecurrence(from: Date = new Date()): RecurrencePattern {
  return {
    frequency: 'weekly', interval: 1, daysOfWeek: [],
    endCondition: 'date', endDate: addMonths(from, RECURRENCE_HORIZON_MONTHS),
    maxOccurrences: 10,
  }
}

function getPreviewDates(pattern: RecurrencePattern, startDate: Date, count = 5): Date[] {
  const dates: Date[] = []
  const cursor = new Date(startDate)
  const max = count * 400
  for (let i = 0; i < max && dates.length < count; i++) {
    const dow = cursor.getDay()
    const include =
      pattern.frequency === 'daily'   ? true :
      pattern.frequency === 'weekly'  ? pattern.daysOfWeek.includes(dow) :
      cursor.getDate() === startDate.getDate()
    if (include && (dates.length === 0 || cursor.getTime() !== startDate.getTime())) {
      dates.push(new Date(cursor))
      if (pattern.endCondition === 'count' && dates.length >= pattern.maxOccurrences) break
      if (pattern.endCondition === 'date'  && pattern.endDate && cursor >= pattern.endDate) break
    }
    if (pattern.frequency === 'daily') {
      cursor.setDate(cursor.getDate() + (include ? pattern.interval : 1))
    } else if (pattern.frequency === 'weekly') {
      cursor.setDate(cursor.getDate() + 1)
      if (cursor.getDay() === (startDate.getDay() + 1) % 7 && dates.length > 0 && pattern.interval > 1)
        cursor.setDate(cursor.getDate() + (pattern.interval - 1) * 7)
    } else {
      cursor.setMonth(cursor.getMonth() + pattern.interval)
    }
  }
  return dates
}

// ─── schema ───────────────────────────────────────────────────────────────────

// This dialog schedules CLASSES only. An appointment is never placed on the
// calendar by hand: it's a provider's exclusive time, created lazily by
// `bookAppointment` from published availability, with a deterministic id
// (`apt_{providerId}_{startMs}`) and an overlap-safe transaction. A hand-made
// appointment session would carry none of that — and, with no activity behind
// it, no accessRule either, which is exactly the orphan the 2026-07 refactor
// deleted the slot generator to eliminate. `bookSession` refuses appointments
// for the same reason. Appointments are edited via AppointmentDetail, so this
// form only ever sees classes.
const sessionSchema = z.object({
  activityId:      z.string().optional(),
  start:           z.date({ required_error: 'Required' }),
  duration:        z.number().min(15).max(480),
  location:        z.string().max(120).optional(),
  placeId:         z.string().optional(),
  roomId:          z.string().optional(),
  providerId:      z.string().optional(),
  providerName:    z.string().max(120).optional(),
  // Optional cap; kept as text and coerced to a number on save (empty ⇒ no cap).
  maxParticipants: z.string().max(6).optional(),
  notes:           z.string().max(2000).optional(),
  headline:        z.string().max(200).optional(),
  headlinePublic:  z.boolean().optional(),
  allowBooking:    z.boolean().optional(),
  bookingMandatory: z.boolean().optional(),
})
type SessionFormValues = z.infer<typeof sessionSchema>

// ─── recurrence panel ─────────────────────────────────────────────────────────


function RecurrencePanel({ value, onChange, startDate }: {
  value: RecurrencePattern; onChange: (p: RecurrencePattern) => void; startDate: Date | undefined
}) {
  const t = useTranslations('Sessions')
  // The studio's regional settings decide how the preview reads and where the
  // day picker starts: a Sunday-first studio seeing a Monday-first row here is
  // the version of the bug people notice first, and it is this dialog that a
  // coach types a schedule into.
  //
  // The ZONE, though, is the DEVICE's, and deliberately: `getPreviewDates`
  // picks its dates with device-local weekday arithmetic (`cursor.getDay()`,
  // `cursor.setDate()`) from a start date the device-local picker produced.
  // Labelling those instants in the studio's zone would name a weekday the
  // coach never ticked and a clock time they never typed. Week start, date
  // order and hour cycle still come from the team — the override moves the zone
  // and nothing else (see the `zone` option in hooks/useTeamFormat.ts).
  const fmt = useTeamFormat({ zone: 'device' })
  const daysOfWeek = weekdayOrder(fmt.weekStartsOn)

  function set<K extends keyof RecurrencePattern>(key: K, val: RecurrencePattern[K]) {
    onChange({ ...value, [key]: val })
  }
  function toggleDay(day: number) {
    const days = value.daysOfWeek.includes(day)
      ? value.daysOfWeek.filter(d => d !== day)
      : [...value.daysOfWeek, day]
    if (days.length > 0) set('daysOfWeek', days)
  }
  const dayLabels: Record<number, string> = {
    1: t('dayMon'), 2: t('dayTue'), 3: t('dayWed'),
    4: t('dayThu'), 5: t('dayFri'), 6: t('daySat'), 0: t('daySun'),
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const previewDates = useMemo(() => startDate ? getPreviewDates(value, startDate, 5) : [], [value, startDate?.getTime()])

  return (
    <div className="space-y-4 rounded-lg bg-muted/40 p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground">{t('repeatEvery')}</span>
        <input type="number" min={1} max={52} value={value.interval}
          onChange={e => set('interval', Math.max(1, Math.min(52, Number(e.target.value) || 1)))}
          className="w-16 rounded-md border border-input bg-background px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-ring" />
        <Select value={value.frequency} onValueChange={v => set('frequency', v as RecurrenceFrequency)}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">{t('freqDay')}</SelectItem>
            <SelectItem value="weekly">{t('freqWeek')}</SelectItem>
            <SelectItem value="monthly">{t('freqMonth')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {value.frequency === 'weekly' && (
        <div className="space-y-1.5">
          <span className="text-sm text-muted-foreground">{t('repeatOnDays')}</span>
          <div className="flex gap-1 flex-wrap">
            {daysOfWeek.map(day => (
              <button key={day} type="button" onClick={() => toggleDay(day)}
                className={`h-8 w-10 rounded-md text-xs font-medium transition-colors border ${
                  value.daysOfWeek.includes(day)
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-input hover:bg-muted'
                }`}>
                {dayLabels[day]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-2">
        <span className="text-sm text-muted-foreground">{t('repeatEnds')}</span>
        <div className="space-y-1.5">
          {(['never', 'date', 'count'] as EndCondition[]).map(cond => (
            <label key={cond} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="endCondition" checked={value.endCondition === cond}
                onChange={() => set('endCondition', cond)} className="accent-primary" />
              <span className="text-sm">
                {cond === 'never' && t('endsNever')}
                {cond === 'date' && (
                  <span className="inline-flex items-center gap-2">
                    {t('endsOnDate')}
                    {/* The date field round-trips through `toDateInputValue`, not
                        `toISOString()` — see its docstring: converting to UTC
                        first makes midnight in any zone ahead of UTC serialise
                        as the PREVIOUS day. */}
                    {value.endCondition === 'date' && (
                      <input type="date"
                        value={toDateInputValue(value.endDate)}
                        min={toDateInputValue(startDate)}
                        onChange={e => set('endDate', e.target.value ? new Date(e.target.value) : null)}
                        className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        onClick={e => e.stopPropagation()} />
                    )}
                  </span>
                )}
                {cond === 'count' && (
                  <span className="inline-flex items-center gap-2">
                    {t('endsAfter')}
                    {value.endCondition === 'count' && (
                      <input type="number" min={1} max={365} value={value.maxOccurrences}
                        onChange={e => set('maxOccurrences', Math.max(1, Number(e.target.value) || 1))}
                        className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-ring"
                        onClick={e => e.stopPropagation()} />
                    )}
                    {t('endsOccurrences')}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      </div>
      {previewDates.length > 0 && (
        <div className="rounded-lg bg-background border p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground mb-2">{t('repeatPreview')}</p>
          {previewDates.map((d, i) => (
            <p key={i} className="text-xs text-muted-foreground">
              {fmt.dateMedium(d)}{' '}{fmt.time(d)}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── responsive modal shell (dialog on desktop, bottom sheet on mobile) ────────

function ResponsiveModal({ open, onOpenChange, title, children }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; children: React.ReactNode
}) {
  const isDesktop = useMediaQuery('(min-width: 640px)')

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-3xl p-0 gap-0 max-h-[92dvh] flex flex-col overflow-hidden">
          <DialogHeader className="px-6 py-4 border-b flex-shrink-0">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="p-0 gap-0 max-h-[92dvh] flex flex-col rounded-t-2xl overflow-hidden">
        <SheetHeader className="px-5 py-4 border-b flex-shrink-0">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  )
}

// ─── session form dialog ───────────────────────────────────────────────────────

/** A copy lands one WEEK later — same weekday, same time. It is the intent
 *  behind almost every "run this again", and it is the only default that cannot
 *  quietly create a second session in a slot that already has one. */
const COPY_OFFSET_DAYS = 7

function copyStart(source: Session): Date {
  const d = source.start?.toDate() ?? new Date()
  return new Date(d.getTime() + COPY_OFFSET_DAYS * 86400000)
}

export function SessionFormDialog({
  open, onOpenChange, editing, duplicating, activities, teamId, userId, onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  editing: Session | null
  /**
   * The session a NEW one is being copied from. `editing` stays null, so the
   * submit runs the CREATE path: a fresh doc, `participants_count: 0`, no
   * bookings, no waitlist, no attendance, no `seriesId` (a copy of one
   * occurrence is a standalone session — it can be made recurring in its own
   * right, since the recurrence controls are shown for a create).
   */
  duplicating?: Session | null
  activities: Activity[]
  teamId: string
  userId: string
  onSaved: () => void
}) {
  const t = useTranslations('Sessions')
  const tCommon = useTranslations('Common')
  // The setup checklist's `sessions` step (a future session people can actually
  // book) is one of its COUNTED ones, and this dialog is a write the browser
  // makes itself — so the checklist is invalidated beside every `onSaved()`
  // rather than left to notice on its own. A recurring save writes only the
  // `session_series` doc here and the occurrences arrive afterwards from
  // `generateRecurringSessions`, which no invalidation can see; that case is
  // what the checklist's own bounded poll exists for (hooks/useSetupChecklist.ts).
  const invalidateChecklist = useInvalidateSetupChecklist()

  const seed = editing ?? duplicating ?? null
  const isSeries = !!editing?.seriesId

  const [isRecurring, setIsRecurring] = useState(false)
  const [recurrence, setRecurrence] = useState<RecurrencePattern>(() => defaultRecurrence())
  const [busyMsg, setBusyMsg] = useState<string | null>(null)
  /**
   * THE CONFIRM STEP FOR A SESSION THAT HAS PEOPLE ON IT.
   *
   * `PastItemNotice` argues against exactly this, and its argument is right as
   * far as it goes: a guard that fires on every legitimate back-fill is
   * dismissed without reading within a week. So this one does NOT fire on every
   * back-fill — it fires only when somebody is attached (Franco, 2026-08-21).
   *
   * That is the case worth stopping for. Editing an empty session is moving a
   * placeholder; editing one with bookings or check-ins moves a time people
   * were told about, and on a past session it edits the record of who was
   * there. Setting up next term's timetable — the common case, dozens of empty
   * sessions — never sees this dialog, which is what keeps it worth reading on
   * the day it is right.
   *
   * The notice stays: it answers "which occurrence is this?" on sight, before
   * anything is typed. This answers "are you sure?" at the commit. Different
   * questions, different moments.
   */
  const [confirmStep, setConfirmStep] = useState(false)
  // Edit-scope chooser shown when saving a session that belongs to a series.
  const [scopeStep, setScopeStep] = useState(false)
  const [pendingValues, setPendingValues] = useState<SessionFormValues | null>(null)
  const [editScope, setEditScope] = useState<'single' | 'future'>('single')

  const { register, handleSubmit, control, watch, setValue, reset, formState: { errors, isSubmitting } } =
    useForm<SessionFormValues>({
      resolver: zodResolver(sessionSchema),
      defaultValues: {
        activityId:      seed?.activityId ?? '',
        start:           duplicating
          ? copyStart(duplicating)
          : (editing?.start?.toDate() ?? defaultStart()),
        duration:        deriveDefaultDuration(seed),
        location:        seed?.location ?? '',
        placeId:         seed?.placeId ?? '',
        roomId:          seed?.roomId ?? '',
        providerId:      seed?.providerId ?? '',
        providerName:    seed?.providerName ?? '',
        maxParticipants: seed?.max_participants != null ? String(seed.max_participants) : '',
        notes:           seed?.notes ?? '',
        headline:        seed?.headline ?? '',
        headlinePublic:  seed?.headlinePublic ?? false,
        // A NEW session opts IN to online booking; an EDIT or a DUPLICATE keeps
        // exactly what its source had. The asymmetry is the whole point: a
        // studio scheduling a class means it to be bookable (with the old
        // default the setup checklist went green with the door shut — see
        // hooks/useSetupChecklist.ts), while a legacy doc carrying no
        // `allowBooking` field must stay closed rather than be flipped open by
        // somebody merely opening the dialog to fix a typo.
        allowBooking:    seed ? (seed.allowBooking ?? false) : true,
        // Deliberately NOT changed with it: mandatory booking is a refinement of
        // the door, not the door.
        bookingMandatory: seed?.bookingMandatory ?? false,
      },
    })

  // Class activities only. Picking an appointment offering here would mint a
  // session outside the appointment model — no deterministic id, no overlap
  // check, no booking — i.e. the orphan "open slot" the refactor removed.
  // Appointments are published as availability instead (Schedule → "+ New
  // entry" → Appointment availability).
  const classActivities = useMemo(
    () => activities.filter(a => (a.type ?? 'class') !== 'appointment'),
    [activities],
  )

  const watchedStart       = watch('start')
  const watchedPlaceId     = watch('placeId')
  const watchedProviderId  = watch('providerId')
  const watchedAllowBooking = watch('allowBooking')

  const { team } = useAuth()
  const qc = useQueryClient()
  const { data: places = [] } = usePlaces(teamId, team?.org_id ?? null)
  const placeRooms = places.find((p) => p.id === watchedPlaceId)?.rooms ?? []

  // ── The two empty states this form has to answer for itself ────────────────
  // A session is scheduled FROM an activity INTO a place, and both of those are
  // created on other screens. Sending someone there mid-form loses everything
  // they have typed, so both are handled here: the activity is created inline
  // (a class needs only a name to exist; everything else has a sane default and
  // is edited later on /offer/activities), and the place opens its own sheet
  // OVER this dialog. The sheet is free — it already shares the
  // ['places', teamId, orgId] query key with the picker below, so a place
  // created in it appears here with no wiring, no event and no reload.
  const [newActivityName, setNewActivityName] = useState('')
  const [creatingActivity, setCreatingActivity] = useState(false)
  const [placesOpen, setPlacesOpen] = useState(false)

  async function createClassActivity() {
    const name = newActivityName.trim()
    if (!name || creatingActivity) return
    setCreatingActivity(true)
    try {
      const ref = await addDoc(collection(db, ACTIVITIES_COLLECTION), {
        name,
        description: '',
        prerequisites: '',
        confirmationInstructions: '',
        type: 'class' as const,
        level: null,
        color: '',
        // Open and free to book, which is the least surprising default: a gate
        // nobody asked for is invisible until a member is refused at the door.
        isFreeTrial: true,
        accessRule: { type: 'open' as const },
        dropIn: { enabled: false },
        trialEnabled: false,
        waitlistEnabled: false,
        autoConfirm: true,
        slug: slugifyActivityName(name),
        teamId,
        createdBy: userId,
        isActive: true,
        order: activities.length,
        created_at: serverTimestamp(),
      })
      refreshQueries(qc, ['activities'])
      setValue('activityId', ref.id)
      setNewActivityName('')
    } catch (err) {
      toast.error(t('saveError', { message: errorMessage(err) }))
    } finally {
      setCreatingActivity(false)
    }
  }
  const { pickable: coaches } = useCoaches(teamId)
  const watchedDuration   = watch('duration')

  // Trigger label for the instructor picker: matched coach → legacy typed name → placeholder.
  const instructorLabel = (() => {
    const c = coaches.find((m) => m.userId === watchedProviderId)
    if (c) return coachLabel(c)
    return watch('providerName') || null
  })()


  function handleRecurringToggle(on: boolean) {
    setIsRecurring(on)
    if (!on) return
    setRecurrence(p => ({
      ...p,
      daysOfWeek: p.daysOfWeek.length === 0 && watchedStart ? [watchedStart.getDay()] : p.daysOfWeek,
      // Anchor the default end date on the session's own start rather than on
      // whenever the dialog happened to open.
      endDate:
        p.endCondition === 'date' && watchedStart
          ? (p.endDate ?? addMonths(watchedStart, RECURRENCE_HORIZON_MONTHS))
          : p.endDate,
    }))
  }

  function close() {
    reset()
    setScopeStep(false)
    setPendingValues(null)
    setEditScope('single')
    setBusyMsg(null)
    onOpenChange(false)
  }

  function basePayload(values: SessionFormValues) {
    const activityEntry = activities.find(a => a.id === values.activityId)
    return {
      teamId,
      activityId:     values.activityId || null,
      activityName:   activityEntry?.name ?? null,
      activityType:   'class',
      // Denormalised from the picked activity so the booking callable can read it
      // off the session without a second lookup. Falls back to the kind default
      // when no activity is picked yet.
      autoConfirm:    resolveAutoConfirm(activityEntry ?? { type: 'class' }),
      location:       values.location || null,
      placeId:        values.placeId || null,
      roomId:         values.roomId || null,
      providerId:     values.providerId || null,
      providerName:   values.providerName || null,
      max_participants: values.maxParticipants ? Number(values.maxParticipants) : null,
      notes:          values.notes || null,
      headline:       values.headline || null,
      headlinePublic: (values.headline ?? '').trim() ? (values.headlinePublic ?? false) : false,
      allowBooking:   values.allowBooking ?? false,
      bookingMandatory: (values.allowBooking ?? false) ? (values.bookingMandatory ?? false) : false,
      duration_minutes: values.duration,
    }
  }

  // ── create (single or recurring series) ──
  async function runCreate(values: SessionFormValues) {
    const startDate = values.start
    const endDate   = new Date(startDate.getTime() + values.duration * 60000)
    const activityEntry = activities.find(a => a.id === values.activityId)

    if (isRecurring) {
      // ── THE SERIES DOC IS THE COMMIT; GENERATION IS NOT ───────────────────
      // Materialising a series is one dedupe query and one write per
      // occurrence: a 6-month weekly class is ~26 server round-trips, a daily
      // one ~180. Waiting for that behind a spinner is what the 30-second
      // timeout below existed to survive.
      //
      // So the dialog commits on the SERIES doc — the thing that actually
      // records the studio's intent — and generation runs behind it. Nothing is
      // lost if it dies mid-way: `materializeOccurrences` is idempotent
      // (dedupe by seriesId + instanceDate) and the daily `rollSessionSeries`
      // task tops every ACTIVE series back up to the horizon, so the worst case
      // is a series that finishes filling in later rather than one that is
      // wrong. Until it does, the schedule says so — see `useGeneratingSeries`,
      // which reads the `lastGeneratedUntil: null` this write leaves behind.
      setBusyMsg(t('creatingSeries'))
      try {
        const seriesRef = await addDoc(collection(db, SESSION_SERIES_COLLECTION), {
          teamId, teacher: userId, createdBy: userId,
          template: {
            activityId: values.activityId || null,
            activityName: activityEntry?.name ?? null,
            activityType: 'class',
            autoConfirm: resolveAutoConfirm(activityEntry ?? { type: 'class' }),
            location: values.location || null,
            placeId: values.placeId || null,
            roomId: values.roomId || null,
            tags: [], notes: values.notes || '',
            headline: values.headline || null,
            headlinePublic: (values.headline ?? '').trim() ? (values.headlinePublic ?? false) : false,
            duration: values.duration,
            allowBooking: values.allowBooking ?? false,
            bookingMandatory: (values.allowBooking ?? false) ? (values.bookingMandatory ?? false) : false,
            providerName: values.providerName || null,
            providerId: values.providerId || null,
            max_participants: values.maxParticipants ? Number(values.maxParticipants) : null,
          },
          recurrence: {
            frequency:      recurrence.frequency,
            interval:       recurrence.interval,
            daysOfWeek:     recurrence.daysOfWeek,
            endCondition:   recurrence.endCondition,
            endDate:        recurrence.endDate ? Timestamp.fromDate(recurrence.endDate) : null,
            maxOccurrences: recurrence.endCondition === 'count' ? recurrence.maxOccurrences : null,
            duration:       values.duration,
            startDate:      Timestamp.fromDate(startDate),
          },
          status: 'active',
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
          totalOccurrences: 0, lastGeneratedUntil: null,
        })
        // Deliberately NOT awaited. A callable keeps running server-side after
        // the client stops listening, so this is a fire-and-forget with a
        // reported failure rather than a request nobody watches: the catch
        // still runs if the promise rejects, and the toast is the only place
        // that failure could surface once the dialog is gone.
        const generate = httpsCallable<{ seriesId: string }, { generatedCount: number }>(functions, 'generateRecurringSessions')
        void generate({ seriesId: seriesRef.id }).catch((err) => {
          toast.error(t('seriesGenerateFailed', { message: errorMessage(err) }))
        })
        setBusyMsg(null)
        toast.success(t('seriesCreatingToast'))
        invalidateChecklist()
        onSaved()
        close()
      } catch (err) {
        // Only the SERIES write can reach here now, and a failed one means
        // nothing exists — keep the dialog open so the retry is the same save.
        setBusyMsg(null)
        toast.error(t('saveError', { message: errorMessage(err) }))
      }
      return
    }

    try {
      await addDoc(collection(db, SESSIONS_COLLECTION), {
        ...basePayload(values),
        start: Timestamp.fromDate(startDate),
        end:   Timestamp.fromDate(endDate),
        createdBy: userId, teacher: userId,
        participants_count: 0,
        created_at: serverTimestamp(),
      })
      invalidateChecklist()
      onSaved()
      close()
    } catch (err) {
      toast.error(t('saveError', { message: errorMessage(err) }))
    }
  }

  // ── edit a standalone session (no series) ──
  async function runSingleSessionEdit(values: SessionFormValues) {
    const startDate = values.start
    const endDate   = new Date(startDate.getTime() + values.duration * 60000)
    try {
      await updateDoc(doc(db, SESSIONS_COLLECTION, editing!.id), {
        ...basePayload(values),
        start: Timestamp.fromDate(startDate),
        end:   Timestamp.fromDate(endDate),
        updatedAt: serverTimestamp(),
      })
      invalidateChecklist()
      onSaved()
      close()
    } catch (err) {
      toast.error(t('saveError', { message: errorMessage(err) }))
    }
  }

  // ── edit a session that belongs to a series (scoped) ──
  async function runSeriesEdit(values: SessionFormValues, scope: 'single' | 'future') {
    setBusyMsg(t('updatingSeries'))
    const startDate = values.start
    const endDate   = new Date(startDate.getTime() + values.duration * 60000)
    const activityEntry = activities.find(a => a.id === values.activityId)
    const update = httpsCallable<{ sessionId: string; editScope: string; updates: Record<string, unknown> }, { updatedCount: number }>(
      functions, 'updateRecurringSession',
    )
    try {
      const res = await withTimeout(update({
        sessionId: editing!.id,
        editScope: scope,
        updates: {
          activityId:     values.activityId || null,
          activityName:   activityEntry?.name ?? null,
          activityType:   'class',
          autoConfirm:    resolveAutoConfirm(activityEntry ?? { type: 'class' }),
          start:          startDate.toISOString(),
          end:            endDate.toISOString(),
          duration:       values.duration,
          location:       values.location || null,
          providerId:     values.providerId || null,
          providerName:   values.providerName || null,
          max_participants: values.maxParticipants ? Number(values.maxParticipants) : null,
          notes:          values.notes || null,
          allowBooking:   values.allowBooking ?? false,
          bookingMandatory: (values.allowBooking ?? false) ? (values.bookingMandatory ?? false) : false,
        },
      }))
      setBusyMsg(t('seriesUpdated', { count: res.data.updatedCount || 1 }))
      invalidateChecklist()
      onSaved()
      setTimeout(close, 1000)
    } catch (err) {
      setBusyMsg(null)
      if (err instanceof CallableTimeoutError) toast.error(t('saveTimeoutError'))
      else toast.error(t('saveError', { message: errorMessage(err) }))
    }
  }

  // Bookings and check-ins are different records of the same fact — somebody is
  // expected here — and either one is reason enough to ask.
  const attendeeCount = (editing?.bookings_count ?? 0) + (editing?.participants_count ?? 0)
  const needsEditConfirm = !!editing && attendeeCount > 0

  const onSubmit = async (values: SessionFormValues) => {
    if (!editing) { await runCreate(values); return }
    if (needsEditConfirm) { setPendingValues(values); setConfirmStep(true); return }
    if (isSeries) { setPendingValues(values); setScopeStep(true); return }
    await runSingleSessionEdit(values)
  }

  /** Past the confirm, into whatever the save actually needed — the series
   *  scope chooser, or the write. The two steps STACK rather than replace: a
   *  recurring class with people on it asks both, in that order. */
  async function confirmEdit() {
    const values = pendingValues
    if (!values) return
    setConfirmStep(false)
    if (isSeries) { setScopeStep(true); return }
    await runSingleSessionEdit(values)
  }

  async function confirmScope() {
    if (!pendingValues) return
    setScopeStep(false)
    await runSeriesEdit(pendingValues, editScope)
  }

  const title = editing ? t('editSession') : duplicating ? tCommon('duplicate') : t('newSession')

  return (
    <>
    {/* Mounted beside the modal rather than inside it: the sheet portals to the
        body either way, and keeping it out of the form means opening it can
        never unmount the fields it was opened to fill in. */}
    <PlacesSheet
      open={placesOpen}
      onOpenChange={setPlacesOpen}
      teamId={teamId}
      userId={userId}
      orgId={team?.org_id ?? null}
    />
    <ResponsiveModal open={open} onOpenChange={(v) => { if (!v) close() }} title={title}>
      {busyMsg ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{busyMsg}</p>
        </div>
      ) : confirmStep ? (
        // ── "there are people on this one" ──
        // Same geometry as the scope chooser below, on purpose: they are two
        // steps of one save, and a reader should not have to re-learn the
        // furniture between them.
        <div className="flex flex-col flex-1 min-h-0">
          <div className="overflow-y-auto flex-1 px-6 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              {t('editConfirmTitle')}
            </div>
            <p className="text-sm text-muted-foreground">
              {t('editConfirmBody', { count: attendeeCount })}
            </p>
            {/* The past adds a second fact, so it gets a second line rather
                than a reworded first one — the count is true either way. */}
            {editing && isPastSession(editing) && (
              <p className="text-sm text-muted-foreground">{t('editConfirmPast')}</p>
            )}
          </div>
          <div className="border-t bg-muted/30 px-6 py-3 flex justify-end gap-2 flex-shrink-0">
            <button type="button" onClick={() => { setConfirmStep(false); setPendingValues(null) }}
              className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">
              {t('cancel')}
            </button>
            <button type="button" onClick={confirmEdit}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
              {t('editConfirmAction')}
            </button>
          </div>
        </div>
      ) : scopeStep ? (
        // ── edit-scope chooser ──
        <div className="flex flex-col flex-1 min-h-0">
          <div className="overflow-y-auto flex-1 px-6 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Repeat2 className="h-4 w-4 text-primary" />
              {t('editScopeTitle')}
            </div>
            <p className="text-sm text-muted-foreground">{t('editScopeDescription')}</p>
            <div className="space-y-2 pt-1">
              {(['single', 'future'] as const).map(scope => (
                <label key={scope}
                  className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    editScope === scope ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/50'
                  }`}>
                  <input type="radio" name="editScope" checked={editScope === scope}
                    onChange={() => setEditScope(scope)} className="accent-primary" />
                  <span className="text-sm">{scope === 'single' ? t('editScopeThis') : t('editScopeFuture')}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="border-t bg-muted/30 px-6 py-3 flex justify-end gap-2 flex-shrink-0">
            <button type="button" onClick={() => setScopeStep(false)}
              className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">
              {t('cancel')}
            </button>
            <button type="button" onClick={confirmScope}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
              {t('applyChanges')}
            </button>
          </div>
        </div>
      ) : (
        // ── main form ──
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0">
          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">
            {/* Editing something that already happened. Above the series banner
                on purpose: which occurrence this is matters before what pattern
                it belongs to, and a past occurrence shows both. Only on a real
                edit — `duplicating` seeds a NEW session from an old one, which
                is exactly how a finished class gets repeated and is not history. */}
            {editing && isPastSession(editing) && <PastItemNotice />}

            {isSeries && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 text-xs text-primary">
                <Repeat2 className="h-3.5 w-3.5 shrink-0" />
                <span>{t('partOfSeries')}</span>
                {/* When it stops. Recurrence itself is still create-only, but a
                    manager editing an occurrence can at least SEE the pattern
                    and its end date instead of guessing. */}
                <SeriesSummary seriesId={editing!.seriesId!} className="text-primary/80" />
              </div>
            )}

            {/* ── Basics: what is taught ── */}
            <section className="space-y-3">
              <SectionLabel>{t('sectionBasics')}</SectionLabel>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('fieldActivity')}</label>
                <Controller name="activityId" control={control} render={({ field }) => (
                  <Select value={field.value || '__none__'} onValueChange={v => field.onChange(v === '__none__' ? '' : v)}>
                    <SelectTrigger className="w-full">
                      <span className="flex flex-1 text-left text-sm truncate">
                        {field.value && field.value !== '__none__'
                          ? activities.find(a => a.id === field.value)?.name ?? field.value
                          : <span className="text-muted-foreground">—</span>}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">—</SelectItem>
                      {classActivities.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )} />
                {/* A team with no class activity used to find an empty picker
                    and a LINK to the page that fills it — which navigates away
                    and takes every field typed here with it. It creates one
                    inline instead, like the availability dialog next door. The
                    old note said a class "carries a name, a level and an access
                    rule nobody can invent on the studio's behalf": only the name
                    is true. A level is optional by design, and the access rule
                    has a correct default (open), so the one thing that cannot be
                    guessed is the one thing this asks for. Everything else is
                    edited later on /offer/activities. */}
                {classActivities.length === 0 && (
                  <div className="rounded-md border border-dashed p-3 space-y-2">
                    <p className="text-xs text-muted-foreground">{t('noClassActivitiesHint')}</p>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={newActivityName}
                        onChange={(e) => setNewActivityName(e.target.value)}
                        onKeyDown={(e) => {
                          // Enter must not submit the SESSION form from inside
                          // a nested create.
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void createClassActivity()
                          }
                        }}
                        placeholder={t('newActivityNamePlaceholder')}
                        className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={!newActivityName.trim() || creatingActivity}
                        onClick={() => void createClassActivity()}
                      >
                        {creatingActivity ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                        {t('createActivityAction')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <div className="border-t" />

            {/* ── Schedule: when it happens (and how often) ── */}
            <section className="space-y-3">
              <SectionLabel>{t('sectionSchedule')}</SectionLabel>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t('fieldStart')}</label>
                  <Controller name="start" control={control} render={({ field }) => (
                    <DateTimePicker value={field.value} onChange={field.onChange} />
                  )} />
                  {errors.start && <p className="text-xs text-destructive">{errors.start.message}</p>}
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    {t('fieldDuration')}
                    <span className="ml-2 font-normal text-muted-foreground">{formatDuration(watchedDuration ?? 60)}</span>
                  </label>
                  <Controller name="duration" control={control} render={({ field }) => (
                    <DurationPicker value={field.value} onChange={field.onChange} minutesLabel={t('durationMinutes')} />
                  )} />
                  {errors.duration && <p className="text-xs text-destructive">{errors.duration.message}</p>}
                </div>
              </div>

              {/* Recurrence — new sessions only */}
              {!editing && (
                <>
                  <label className="flex items-center gap-2.5 cursor-pointer select-none pt-1">
                    <div role="checkbox" aria-checked={isRecurring}
                      onClick={() => handleRecurringToggle(!isRecurring)}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                        isRecurring ? 'bg-primary' : 'bg-input'
                      }`}>
                      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
                        isRecurring ? 'translate-x-4' : 'translate-x-0'
                      }`} />
                    </div>
                    <span className="text-sm font-medium inline-flex items-center gap-1.5">
                      <Repeat2 className="h-4 w-4 text-muted-foreground" />
                      {t('fieldRepeat')}
                    </span>
                  </label>
                  {isRecurring && (
                    <RecurrencePanel value={recurrence} onChange={setRecurrence} startDate={watchedStart} />
                  )}
                </>
              )}
            </section>

            <div className="border-t" />

            {/* ── Details: the scattered per-session settings, gathered into one
                outlined group — label left, control right, one per row (same
                pattern as the Activities form). ── */}
            <section className="space-y-3">
              <SectionLabel>{t('sectionDetails')}</SectionLabel>
              <div className="divide-y rounded-lg border">
                <div className="flex items-center justify-between gap-4 p-3">
                  <label className="text-sm font-medium">{t('fieldInstructor')}</label>
                  <Controller name="providerId" control={control} render={({ field }) => (
                    <Select
                      value={field.value || '__none__'}
                      onValueChange={(v) => {
                        if (v === '__none__') {
                          field.onChange('')
                          setValue('providerName', '')
                        } else {
                          field.onChange(v)
                          const c = coaches.find((m) => m.userId === v)
                          setValue('providerName', c ? coachLabel(c) : '')
                        }
                      }}
                    >
                      <SelectTrigger className="w-48">
                        <span className="flex flex-1 text-left text-sm truncate">
                          {instructorLabel ?? <span className="text-muted-foreground">{t('instructorNone')}</span>}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t('instructorNone')}</SelectItem>
                        {coaches.map((m) => (
                          <SelectItem key={m.userId} value={m.userId}>{coachLabel(m)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )} />
                </div>

                {/* ── WHERE: PLACE FIRST, LOCATION UNDER IT ────────────────
                    Place is the field that gets TRACKED — a venue the studio
                    keeps, with rooms, that everything downstream can group by.
                    Location is free text: a quick alternative before any place
                    exists, or a detail added on top of one.

                    The layout used to state the opposite. Place was hidden
                    entirely when the team had none (`places.length > 0 &&`), so
                    the tracked field was the one that disappeared — while a
                    free-text box placeheld "Gym, dojo…", which is a description
                    of a Place. A new studio typed "Gym" into free text forever
                    and never discovered Places existed. So Place is ALWAYS
                    rendered, and when there is nothing to pick it says what a
                    place is and opens the sheet that creates one. */}
                {places.length > 0 ? (
                  <div className="flex items-center justify-between gap-4 p-3">
                    <label className="text-sm font-medium">{t('fieldPlace')}</label>
                    <div className="flex shrink-0 items-center gap-2">
                      <Controller name="placeId" control={control} render={({ field }) => (
                        <Select
                          value={field.value || '__none'}
                          onValueChange={(v) => { field.onChange(v === '__none' ? '' : v); setValue('roomId', '') }}
                        >
                          <SelectTrigger className="w-36">
                            <span className="flex flex-1 text-left text-sm truncate">
                              {field.value
                                ? places.find((p) => p.id === field.value)?.name ?? field.value
                                : <span className="text-muted-foreground">{t('placeNone')}</span>}
                            </span>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none">{t('placeNone')}</SelectItem>
                            {places.map((p) => (
                              <SelectItem
                                key={p.id}
                                value={p.id}
                                // Composed text must ride on `label`, or the trigger prints the raw
                                // place id (select.tsx only derives a label from a plain string child).
                                label={`${p.name}${p.scope === 'org' ? ' · org' : ''}`}
                              />
                            ))}
                          </SelectContent>
                        </Select>
                      )} />
                      {placeRooms.length > 0 && (
                        <Controller name="roomId" control={control} render={({ field }) => (
                          <Select value={field.value || '__none'} onValueChange={(v) => field.onChange(v === '__none' ? '' : v)}>
                            <SelectTrigger className="w-32">
                              <span className="flex flex-1 text-left text-sm truncate">
                                {field.value
                                  ? placeRooms.find((r) => r.id === field.value)?.name ?? field.value
                                  : <span className="text-muted-foreground">{t('roomNone')}</span>}
                              </span>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none">{t('roomNone')}</SelectItem>
                              {placeRooms.map((r) => (
                                <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )} />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="p-3">
                    <div className="rounded-md border border-dashed p-3 space-y-2">
                      <p className="text-sm font-medium">{t('fieldPlace')}</p>
                      <p className="text-xs text-muted-foreground">{t('noPlacesHint')}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setPlacesOpen(true)}
                      >
                        <MapPin className="h-3.5 w-3.5" />
                        {t('createPlaceAction')}
                      </Button>
                    </div>
                  </div>
                )}

                {/* SUBORDINATE to the block above, and its copy says which of
                    the two it is: an addition once a place is picked, the quick
                    alternative while none is. */}
                <div className="flex items-center justify-between gap-4 py-3 pl-6 pr-3">
                  <label className="min-w-0 text-sm font-medium">
                    {/* NOT `fieldLocation`. In German and French that key is the
                        SAME WORD as `fieldPlace` ("Ort"/"Ort", "Lieu"/"Lieu"),
                        so the two fields were labelled identically and the hint
                        below was the only thing telling them apart. This key
                        names the free-text one for what it is; `fieldLocation`
                        is left alone for the other surfaces that read it. */}
                    {t('fieldLocationNote')}
                    <span className="ml-2 font-normal text-muted-foreground">{t('optional')}</span>
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {watchedPlaceId ? t('locationHintWithPlace') : t('locationHintNoPlace')}
                    </span>
                  </label>
                  <input type="text" {...register('location')} placeholder={t('locationNotePlaceholder')}
                    className="h-9 w-48 shrink-0 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>

                <div className="flex items-center justify-between gap-4 p-3">
                  <label className="text-sm font-medium">
                    {t('fieldMaxParticipants')}
                    <span className="ml-2 font-normal text-muted-foreground">{t('optional')}</span>
                  </label>
                  <input type="number" min={1} step={1} inputMode="numeric"
                    {...register('maxParticipants')} placeholder={t('maxParticipantsPlaceholder')}
                    className="h-9 w-28 shrink-0 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>

                <Controller name="allowBooking" control={control} render={({ field }) => (
                  <label className="flex cursor-pointer items-center justify-between gap-4 p-3">
                    <span className="text-sm font-medium">{t('fieldAllowBooking')}</span>
                    <input type="checkbox" checked={field.value ?? false}
                      onChange={field.onChange} className="h-4 w-4 shrink-0 rounded border-input accent-primary" />
                  </label>
                )} />

                {/* Booking-required — a refinement of allowBooking; only relevant once
                    booking is offered. Drives the "Booking required" chip in the public flow. */}
                {watchedAllowBooking && (
                  <Controller name="bookingMandatory" control={control} render={({ field }) => (
                    <label className="flex cursor-pointer items-center justify-between gap-4 p-3">
                      <span className="min-w-0 pr-4">
                        <span className="block text-sm font-medium">{t('fieldBookingMandatory')}</span>
                        <span className="block text-xs text-muted-foreground">{t('bookingMandatoryHint')}</span>
                      </span>
                      <input type="checkbox" checked={field.value ?? false}
                        onChange={field.onChange} className="h-4 w-4 shrink-0 rounded border-input accent-primary" />
                    </label>
                  )} />
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('fieldNotes')}
                  <span className="ml-2 font-normal text-muted-foreground">{t('optional')}</span>
                </label>
                <textarea {...register('notes')} rows={2}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none" />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('fieldHeadline')}
                  <span className="ml-2 font-normal text-muted-foreground">{t('optional')}</span>
                </label>
                <input type="text" {...register('headline')} placeholder={t('headlinePlaceholder')}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" {...register('headlinePublic')} className="rounded border-input" />
                  {t('headlinePublicLabel')}
                </label>
              </div>
            </section>
          </div>

          <div className="border-t bg-muted/30 px-6 py-3 flex justify-end gap-2 flex-shrink-0">
            <button type="button" onClick={close}
              className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">
              {t('cancel')}
            </button>
            <button type="submit" disabled={isSubmitting}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
              {isSubmitting ? tCommon('loading') : editing ? t('saveChanges') : t('createSession')}
            </button>
          </div>
        </form>
      )}
    </ResponsiveModal>
    </>
  )
}
