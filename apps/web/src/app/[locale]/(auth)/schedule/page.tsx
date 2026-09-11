'use client'

import { useSearchParams } from 'next/navigation'
import { useState, useMemo, useEffect, useRef, Fragment } from 'react'
import { useTabParam } from '@/hooks/useTabParam'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  Timestamp,
  doc,
  addDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore'
import { addDays, addMonths } from 'date-fns'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import { deviceTimeZone } from '@/lib/format'
import {
  SESSIONS_COLLECTION,
  ACTIVITIES_COLLECTION,
  EVENTS_COLLECTION,
  TEAMS_COLLECTION,
  TEAM_MEMBERS_SUBCOLLECTION,
  compareActivities,
  isPastSession,
} from '@linyup/shared'
import type { Session, Activity, Event, RegionalFormatter, DateLike } from '@linyup/shared'
import { PastItemNotice } from '@/components/sessions/PastItemNotice'
import { useEventTypes } from '@/hooks/useEventTypes'
import { useCoaches } from '@/hooks/useCoaches'
import { eventTypeLabel, prettyEventType } from '@/lib/eventTypeLabel'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import dynamic from 'next/dynamic'
import type { Route } from 'next'
import { cn } from '@/lib/utils'
import { useAvailabilityTemplates } from '@/components/appointments/AppointmentAvailability'
import { Badge } from '@/components/ui/badge'
import { FloatingSlot } from '@/components/layout/FloatingDock'
import { Skeleton } from '@/components/ui/skeleton'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DateTimePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Plus,
  ChevronDown,
  CalendarDays,
  ChartNoAxesGantt,
  CalendarRange,
  CalendarClock,
  List,
  MapPin,
  Users,
  Pencil,
  Trash2,
  User,
  Repeat2,
  ArrowUpRight,
  EyeOff,
  Zap,
  Loader2,
} from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { SessionFormDialog } from '@/components/sessions/SessionFormDialog'
import { SessionDeleteDialog } from '@/components/sessions/SessionDeleteDialog'
import {
  AppointmentAvailabilityFormDialog,
  AppointmentDetail,
} from '@/components/appointments/AppointmentAvailability'
import { AppointmentFormDialog } from '@/components/appointments/AppointmentFormDialog'
import { useVisibleCalendars, type ScheduleCalendar } from '@/hooks/useVisibleCalendars'
import { useGeneratingSeries } from '@/hooks/useGeneratingSeries'
import { VisibleCalendarsMenu } from '@/components/schedule/VisibleCalendarsMenu'
import { CoachFilterMenu } from '@/components/schedule/CoachFilterMenu'
import { BookableHoursSheet } from '@/components/schedule/BookableHoursSheet'
import { PlacesSheet } from '@/components/schedule/PlacesSheet'
import { QUICK_ACTION_PARAM } from '@/lib/quickActions'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { QuickLinks } from '@/components/layout/QuickLinks'
import { PublicSurfaceLink } from '@/components/layout/PublicSurfaceLink'
import { Tip } from '@/components/ui/tip'

// `ssr: false` for the same reason the org events page does it: the timeline
// measures its own viewport on mount, so it has nothing to say on the server.
const EventsTimeline = dynamic(
  () => import('@/components/events/EventsTimeline').then((m) => m.EventsTimeline),
  { ssr: false }
)

const SessionsCalendar = dynamic(() => import('../sessions/SessionsCalendar'), { ssr: false })

// ─── types ────────────────────────────────────────────────────────────────────

type CalendarView = 'calendar' | 'list' | 'planning'
const TIME_TABS = ['upcoming', 'past'] as const

// How far the list reaches, in months from today. `3` reproduces the window the
// page was hard-coded to before UX-64; the rest are the zoom-out.
const HORIZONS = [3, 6, 12] as const
type Horizon = (typeof HORIZONS)[number]
const DEFAULT_HORIZON: Horizon = 3
type TimeTab = (typeof TIME_TABS)[number]
// What the filter row does is now LAYER VISIBILITY, not filtering — Classes,
// Appointments, Bookable hours and Events are four independent things the
// schedule can DRAW, ticked on and off like the calendars in the sidebar of any
// calendar app. The store, the default set and the reasoning live in
// `hooks/useVisibleCalendars.ts`; the control is `VisibleCalendarsMenu`.
//
// The old model was a single-select `ItemFilter` ('all' | 'classes' |
// 'appointment' | 'events'), which could not express "classes and appointments
// but not events", and bookable hours could not be a member of it at all — so
// they were drawn unconditionally instead, with no control anywhere to stop
// them. Both problems are the same problem, and one tickable set is the fix
// for both.
//
// The row now holds exactly TWO controls, `<who> | <what>`, and they share one
// grammar: a chip with a caret, whose label names the current state, opening a
// list of checkboxes. That symmetry is the point — the four calendars spent one
// release as four bare chips sitting beside a single-select coach chip, which
// made two different kinds of control look like one kind.
type ListItem = { kind: 'session'; data: Session } | { kind: 'event'; data: Event }

interface MemberDoc {
  id: string
  userId: string
  email?: string
  displayName?: string
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// Dates here go through the studio's regional settings (useTeamFormat), never
// `toLocaleDateString([])` — the bare form asks the BROWSER, so an en-US laptop
// showed a German studio US date order and 12-hour times.
function formatDate(fmt: RegionalFormatter, ts: DateLike) {
  return fmt.dateMedium(ts) || '—'
}

function formatTime(fmt: RegionalFormatter, ts: DateLike) {
  return fmt.time(ts)
}

function durationLabel(
  startTs: { toDate(): Date } | null | undefined,
  endTs: { toDate(): Date } | null | undefined
) {
  if (!startTs || !endTs) return ''
  const mins = Math.round((endTs.toDate().getTime() - startTs.toDate().getTime()) / 60000)
  const days = Math.floor(mins / 1440)
  if (days >= 1) return `${days}d`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

function memberLabel(m: MemberDoc) {
  return m.displayName ?? m.email ?? m.userId
}
function getItemMs(item: ListItem) {
  return (item.data.start as { toDate(): Date }).toDate().getTime()
}

// Day-divider helpers — group the list by calendar day with a human label.
//
// THE BUCKET, THE "TODAY" TEST AND THE LABEL ALL READ ONE ZONE: the
// formatter's, which is the studio's display zone (`fmt.isoDate` renders
// `YYYY-MM-DD` in it). They used to disagree — the key and the diff were built
// from `getFullYear()/getDate()`, i.e. the BROWSER's zone, while the label was
// already rendered in the studio's — so a divider could read "Today · 23
// August" over a row dated the 24th, and one bucket could straddle two dates in
// the studio's zone. A day divider is a claim about the rows under it; it has
// to be made in the same zone those rows are printed in.
function dayKey(fmt: RegionalFormatter, ms: number) {
  return fmt.isoDate(ms)
}
/** Midnight in the DEVICE's zone. Used only to snap the list's fetch WINDOW to
 *  a stable query key — not to bucket or label anything. */
function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
/** Shift a `YYYY-MM-DD` key by whole days. Calendar arithmetic on the key
 *  itself, so a DST transition cannot make "tomorrow" land on today. */
function shiftIsoDay(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
function dayDividerLabel(
  fmt: RegionalFormatter,
  ms: number,
  rel: { today: string; tomorrow: string; yesterday: string }
) {
  const key = fmt.isoDate(ms)
  const todayKey = fmt.isoDate(Date.now())
  const dayMonth = fmt.dayMonthLong(ms, key.slice(0, 4) !== todayKey.slice(0, 4))
  if (key === todayKey) return `${rel.today} · ${dayMonth}`
  if (key === shiftIsoDay(todayKey, 1)) return `${rel.tomorrow} · ${dayMonth}`
  if (key === shiftIsoDay(todayKey, -1)) return `${rel.yesterday} · ${dayMonth}`
  return `${fmt.weekdayLong(ms)}, ${dayMonth}`
}

// ─── schemas ──────────────────────────────────────────────────────────────────

const eventSchema = z
  .object({
    title: z.string().min(1, 'Required').max(120),
    // Open string: built-in slug, installed-plugin type id, or team-custom type id.
    type: z.string().min(1, 'Required'),
    scope: z.enum(['team', 'org']).default('team'),
    start: z.date({ required_error: 'Required' }),
    end: z.date({ required_error: 'Required' }),
    location: z.string().max(120).optional(),
    fee: z.string().optional(),
    description: z.string().max(1000).optional(),
    coachId: z.string().optional(),
    coachName: z.string().max(120).optional(),
  })
  .refine((d) => !d.start || !d.end || d.end > d.start, {
    message: 'End must be after start',
    path: ['end'],
  })
type EventForm = z.infer<typeof eventSchema>

// ─── data hooks ───────────────────────────────────────────────────────────────

/**
 * Sessions in an EXPLICIT window.
 *
 * This used to be `useAllSessions(teamId, year, month)`, which hard-coded
 * `[month-1, month+2)` — right for a month grid that wants its neighbours
 * prefetched, and the reason the LIST could never show more than three months
 * (UX-64): the list was reading the calendar's cursor window. A studio planning
 * a season had to page the calendar forward one month at a time and read the
 * list three months at a time.
 *
 * The window is a parameter now, and the two views ask for different ones. Same
 * query shape as before — `teamId ==` + a `start` range + `orderBy(start)` — so
 * it runs on the composite index that already exists (`sessions: teamId ASC,
 * start ASC`). Widening the window needs NO new index; it only costs reads.
 */
function useSessionsInRange(
  teamId: string | null,
  from: Date,
  to: Date,
  { enabled = true }: { enabled?: boolean } = {}
) {
  return useQuery<Session[]>({
    // Bounds in the key, not a view name: two views asking for the same window
    // share one cache entry instead of fetching it twice.
    queryKey: ['sessions', 'range', teamId, from.getTime(), to.getTime()],
    enabled: !!teamId && enabled,
    staleTime: 60_000,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        query(
          collection(db, SESSIONS_COLLECTION),
          where('teamId', '==', teamId),
          where('start', '>=', Timestamp.fromDate(from)),
          where('start', '<', Timestamp.fromDate(to)),
          orderBy('start', 'asc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Session)
    },
  })
}

function useActivities(teamId: string | null) {
  return useQuery<Activity[]>({
    queryKey: ['activities', teamId],
    enabled: !!teamId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        query(
          collection(db, ACTIVITIES_COLLECTION),
          where('teamId', '==', teamId),
          orderBy('name', 'asc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Activity).sort(compareActivities)
    },
  })
}

/** How far before the visible window an event may START and still be shown —
 *  a camp that opened last month and runs into this one. Events are keyed on
 *  `start` (the index the query runs on), so the window is widened backwards
 *  by this much rather than asking for `end`, which would need a second range
 *  field Firestore cannot combine with the first. */
const EVENT_LOOKBACK_DAYS = 31

/** The team's events, and its organisation's, overlapping the visible window.
 *
 *  WINDOWED LIKE THE SESSIONS BESIDE THEM. This read every event the team had
 *  ever held, on every calendar open, while `useSessionsInRange` right above it
 *  asked for the visible months only (docs/scalability-2026-09.md §17 B2). Same
 *  bounds-in-the-key shape, same indexes as before — the range on `start` runs
 *  on the (`teamId`, `deleted_at`, `start`) and (`orgId`, `scope`,
 *  `deleted_at`, `start`) composites the unbounded query already used. */
function useEventsInRange(
  teamId: string | null,
  orgId: string | null | undefined,
  from: Date,
  to: Date
) {
  return useQuery<Event[]>({
    queryKey: ['events', 'range', teamId, orgId ?? null, from.getTime(), to.getTime()],
    enabled: !!teamId,
    staleTime: 2 * 60_000,
    queryFn: async () => {
      if (!teamId) return []
      const lower = Timestamp.fromDate(new Date(from.getTime() - EVENT_LOOKBACK_DAYS * 86_400_000))
      const upper = Timestamp.fromDate(to)
      const teamSnap = await getDocs(
        query(
          collection(db, EVENTS_COLLECTION),
          where('teamId', '==', teamId),
          where('deleted_at', '==', null),
          where('start', '>=', lower),
          where('start', '<', upper),
          orderBy('start', 'asc')
        )
      )
      const teamEvents = teamSnap.docs.map((d) => ({ ...d.data(), id: d.id }) as Event)
      let orgEvents: Event[] = []
      if (orgId) {
        const orgSnap = await getDocs(
          query(
            collection(db, EVENTS_COLLECTION),
            where('orgId', '==', orgId),
            where('scope', '==', 'org'),
            where('deleted_at', '==', null),
            where('start', '>=', lower),
            where('start', '<', upper),
            orderBy('start', 'asc')
          )
        )
        orgEvents = orgSnap.docs.map((d) => ({ ...d.data(), id: d.id }) as Event)
      }
      return [...teamEvents, ...orgEvents]
    },
  })
}

function useTeamMembers(teamId: string | null) {
  return useQuery<MemberDoc[]>({
    queryKey: ['team-members', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, TEAM_MEMBERS_SUBCOLLECTION),
          orderBy('joined')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as MemberDoc)
    },
  })
}

// ─── event form dialog ────────────────────────────────────────────────────────

function EventFormDialog({
  open,
  editing,
  members,
  teamId,
  userId,
  orgId,
  isOrgAdmin,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: Event | null
  members: MemberDoc[]
  teamId: string
  userId: string
  orgId: string | null | undefined
  isOrgAdmin: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('Events')
  const qc = useQueryClient()
  const {
    register,
    handleSubmit,
    control,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EventForm>({
    resolver: zodResolver(eventSchema),
    defaultValues: editing
      ? {
          title: editing.title,
          type: editing.type as EventForm['type'],
          scope: (editing.scope ?? 'team') as 'team' | 'org',
          start: (editing.start as { toDate(): Date }).toDate(),
          end: (editing.end as { toDate(): Date }).toDate(),
          location: editing.location ?? '',
          fee: editing.fee != null ? String(editing.fee) : '',
          description: editing.description ?? '',
          coachId: editing.coachId ?? undefined,
          coachName: editing.coachName ?? '',
        }
      : {
          title: '',
          type: 'competition',
          scope: 'team',
          location: '',
          fee: '',
          description: '',
          coachName: '',
        },
  })

  const { types } = useEventTypes(teamId)
  // Keep the event's current type selectable even if its plugin was uninstalled
  // (or it's an unknown/legacy type) — otherwise editing would silently drop it.
  const typeOptions =
    editing && editing.type && !types.some((x) => x.id === editing.type)
      ? [
          ...types,
          { id: editing.type, name: prettyEventType(editing.type), source: 'builtin' as const },
        ]
      : types
  const labelForType = (id: string) =>
    eventTypeLabel(
      id,
      (k) => t.has(k as Parameters<typeof t>[0]),
      (k) => t(k as Parameters<typeof t>[0]),
      typeOptions.find((x) => x.id === id)?.name
    )

  const onSubmit = async (data: EventForm) => {
    const payload = {
      title: data.title,
      type: data.type,
      start: Timestamp.fromDate(data.start),
      end: Timestamp.fromDate(data.end),
      location: data.location ?? '',
      fee: data.fee ? Number(data.fee) : null,
      description: data.description ?? '',
      coachId: data.coachId || null,
      coachName: data.coachName || null,
    }
    if (editing) {
      await updateDoc(doc(db, EVENTS_COLLECTION, editing.id), payload)
    } else {
      const isOrg = data.scope === 'org'
      await addDoc(collection(db, EVENTS_COLLECTION), {
        ...payload,
        ...(isOrg ? { scope: 'org', orgId, teamId: null } : { teamId, scope: 'team' }),
        createdBy: userId,
        status: 'open',
        participants_count: 0,
        deleted_at: null,
        created_at: serverTimestamp(),
      })
    }
    await qc.invalidateQueries({ queryKey: ['events'] })
    onSaved()
    onClose()
    reset()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          onClose()
          reset()
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t('editEvent') : t('newEvent')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-2">
          {/* Editing something that already happened — same notice, same rule
              and the same component as the session dialog. An event runs for
              days, so `isPastSession`'s `(end ?? start)` matters more here than
              anywhere: a camp is not history until its last day is over. */}
          {editing && isPastSession(editing) && <PastItemNotice />}

          {/* Scope toggle — org admin + new only */}
          {isOrgAdmin && !editing && (
            <Controller
              name="scope"
              control={control}
              render={({ field }) => (
                <div className="space-y-1.5">
                  <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
                    {(['team', 'org'] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => field.onChange(s)}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                          field.value === s
                            ? 'bg-background shadow-sm text-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {t(s === 'team' ? 'scopeTeam' : 'scopeOrg')}
                      </button>
                    ))}
                  </div>
                  {field.value === 'org' && (
                    <p className="text-xs text-muted-foreground">{t('scopeOrgHint')}</p>
                  )}
                </div>
              )}
            />
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ev-title">{t('fieldTitle')}</Label>
            <Input id="ev-title" {...register('title')} autoFocus />
            {errors.title && <p className="text-destructive text-xs">{errors.title.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldType')}</Label>
            <Controller
              name="type"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger className="w-full">
                    <span className="flex flex-1 text-left text-sm truncate">
                      {field.value ? (
                        labelForType(field.value)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {typeOptions.map((tp) => (
                      <SelectItem key={tp.id} value={tp.id}>
                        {labelForType(tp.id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('fieldStart')}</Label>
              <Controller
                name="start"
                control={control}
                render={({ field }) => (
                  <DateTimePicker value={field.value} onChange={field.onChange} />
                )}
              />
              {errors.start && <p className="text-destructive text-xs">{errors.start.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>{t('fieldEnd')}</Label>
              <Controller
                name="end"
                control={control}
                render={({ field }) => (
                  <DateTimePicker value={field.value} onChange={field.onChange} />
                )}
              />
              {errors.end && <p className="text-destructive text-xs">{errors.end.message}</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ev-location">{t('fieldLocation')}</Label>
              <Input
                id="ev-location"
                {...register('location')}
                placeholder={t('fieldLocationPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-fee">
                {t('fieldFee')}{' '}
                <span className="text-muted-foreground font-normal text-xs">
                  {t('fieldFeeOptional')}
                </span>
              </Label>
              <Input
                id="ev-fee"
                type="number"
                min="0"
                step="0.01"
                {...register('fee')}
                placeholder="0.00"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-desc">{t('fieldDescription')}</Label>
            <textarea
              id="ev-desc"
              {...register('description')}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>
          {/* Coach */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('fieldCoachMember')}</Label>
              <Controller
                name="coachId"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value ?? '__none__'}
                    onValueChange={(val) => {
                      if (val === '__none__') {
                        field.onChange(undefined)
                      } else {
                        field.onChange(val)
                        const m = members.find((m) => m.userId === val)
                        if (m) setValue('coachName', memberLabel(m))
                      }
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <span className="flex flex-1 text-left text-sm truncate text-muted-foreground">
                        {field.value
                          ? memberLabel(
                              members.find((m) => m.userId === field.value) ?? {
                                id: '',
                                userId: field.value,
                              }
                            )
                          : t('fieldCoachMemberPlaceholder')}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t('fieldCoachMemberPlaceholder')}</SelectItem>
                      {members.map((m) => (
                        <SelectItem key={m.userId} value={m.userId}>
                          {memberLabel(m)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-coach-name">{t('fieldCoachName')}</Label>
              <Input
                id="ev-coach-name"
                {...register('coachName')}
                placeholder={t('fieldCoachName')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onClose()
                reset()
              }}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t('saving') : editing ? t('saveChanges') : t('createEvent')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── list item row ────────────────────────────────────────────────────────────

const ACTIVITY_PALETTE = ['#7C3AED', '#EC4899', '#3B82F6', '#10B981', '#F59E0B', '#F43F5E']

function activityAccent(activityId?: string | null, activities: Activity[] = []) {
  const custom = activities.find((a) => a.id === activityId)?.color
  if (custom) return custom
  if (!activityId) return ACTIVITY_PALETTE[0]
  let h = 0
  for (const ch of activityId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return ACTIVITY_PALETTE[h % ACTIVITY_PALETTE.length]
}

function ListItemRow({
  item,
  activities,
  onEdit,
  onDelete,
}: {
  item: ListItem
  activities: Activity[]
  onEdit: () => void
  onDelete: () => void
}) {
  const tS = useTranslations('Sessions')
  const tE = useTranslations('Events')
  const tC = useTranslations('Calendar')
  const fmt = useTeamFormat()

  if (item.kind === 'session') {
    const s = item.data
    const accent = activityAccent(s.activityId, activities)
    const dur = durationLabel(s.start, s.end)
    return (
      <div className="flex gap-3 p-4 border-b last:border-0 group hover:bg-muted/30 transition-colors">
        <div className="w-10 shrink-0 flex items-start justify-center pt-0.5">
          <div
            className="h-9 w-9 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: `${accent}22` }}
          >
            <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accent }} />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Link
                  href={`/sessions/${s.id}`}
                  className="font-medium text-sm hover:underline hover:text-primary transition-colors"
                >
                  {s.activityName ?? (
                    <span className="text-muted-foreground italic">{tC('noActivity')}</span>
                  )}
                </Link>
                <Badge variant="secondary" className="text-xs shrink-0">
                  {tS(`type_${s.activityType ?? 'class'}` as Parameters<typeof tS>[0])}
                </Badge>
                {/* Labelled, not bare — the pattern and end date live one click
                    away in the peek sheet, but the glyph must at least say what
                    it means. */}
                {s.seriesId && (
                  <Repeat2
                    className="h-3.5 w-3.5 text-muted-foreground shrink-0"
                    aria-label={tS('partOfSeries')}
                  />
                )}
                {s.bookingMandatory && (
                  <Badge variant="outline" className="text-xs shrink-0">
                    {tS('bookingRequiredChip')}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {formatDate(fmt, s.start)} · {formatTime(fmt, s.start)}
                {dur && <span className="ml-1 text-muted-foreground/60">({dur})</span>}
              </p>
            </div>
            <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <Tip label={tC('openDetail')}>
                <Link
                  href={`/sessions/${s.id}`}
                  aria-label={tC('openDetail')}
                  className="p-1.5 rounded text-muted-foreground hover:text-primary transition-colors"
                >
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </Tip>
              <button
                onClick={onEdit}
                className="p-1.5 rounded text-muted-foreground hover:text-foreground transition-colors"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={onDelete}
                className="p-1.5 rounded text-muted-foreground hover:text-destructive transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
            {s.location && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0" />
                {s.location}
              </span>
            )}
            {s.providerName && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <User className="h-3 w-3 shrink-0" />
                {s.providerName}
              </span>
            )}
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Users className="h-3 w-3 shrink-0" />
              {s.max_participants
                ? `${s.participants_count ?? 0}/${s.max_participants}`
                : (s.participants_count ?? 0)}
            </span>
          </div>
        </div>
      </div>
    )
  }

  const e = item.data
  const dur = durationLabel(e.start, e.end)
  return (
    <div className="flex gap-3 p-4 border-b last:border-0 group hover:bg-muted/30 transition-colors">
      <div className="w-10 shrink-0 flex items-start justify-center pt-0.5">
        <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <CalendarRange className="h-4 w-4 text-primary" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/events/${e.id}`}
                className="font-medium text-sm hover:underline hover:text-primary transition-colors"
              >
                {e.title}
              </Link>
              <Badge variant="secondary" className="text-xs shrink-0">
                {eventTypeLabel(
                  e.type,
                  (k) => tE.has(k as Parameters<typeof tE>[0]),
                  (k) => tE(k as Parameters<typeof tE>[0])
                )}
              </Badge>
              {e.scope === 'org' && (
                <Badge variant="outline" className="text-xs shrink-0">
                  Org
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {formatDate(fmt, e.start)} · {formatTime(fmt, e.start)}
              {dur && <span className="ml-1 text-muted-foreground/60">({dur})</span>}
            </p>
          </div>
          <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={onEdit}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 rounded text-muted-foreground hover:text-destructive transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
          {e.location && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3 shrink-0" />
              {e.location}
            </span>
          )}
          {e.coachName && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <User className="h-3 w-3 shrink-0" />
              {e.coachName}
            </span>
          )}
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Users className="h-3 w-3 shrink-0" />
            {e.participants_count ?? 0}
          </span>
        </div>
      </div>
    </div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

/**
 * "Still filling in" — the visible half of the background series generation.
 *
 * It also owns the REFRESH: while a series is materialising, the sessions
 * query is invalidated on every tick, so the calendar grows as the occurrences
 * land instead of waiting for the studio to reload. When the list empties, one
 * final invalidation picks up whatever arrived after the last tick.
 */
function GeneratingSeriesNotice({ teamId }: { teamId: string | null }) {
  const t = useTranslations('Sessions')
  const qc = useQueryClient()
  const generating = useGeneratingSeries(teamId)
  const count = generating.length
  const prevCount = useRef(0)

  useEffect(() => {
    if (count > 0 || prevCount.current > 0) {
      void qc.invalidateQueries({ queryKey: ['sessions'] })
    }
    prevCount.current = count
  }, [count, qc])

  if (count === 0) return null

  const named = generating.find((g) => g.activityName)?.activityName ?? null

  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      <span className="text-muted-foreground">
        {named ? t('seriesFillingInNamed', { name: named }) : t('seriesFillingIn')}
      </span>
    </div>
  )
}

export default function CalendarPage() {
  // Styled confirmation, replacing a browser `confirm()` (see confirm-dialog).
  const { confirm, confirmDialog } = useConfirm()
  const { currentTeamId, user, team, isOrgAdmin } = useAuth()
  const qc = useQueryClient()
  const t = useTranslations('Calendar')
  const tNav = useTranslations('Nav')
  const tCommon = useTranslations('Common')
  const orgId = team?.org_id ?? null
  const fmt = useTeamFormat()

  const today = useMemo(() => new Date(), [])
  const [viewYear, setViewYear] = useState(() => today.getFullYear())
  const [viewMonth, setViewMonth] = useState(() => today.getMonth())

  const [view, setView] = useState<CalendarView>('calendar')
  const [tab, setTab] = useTabParam(TIME_TABS, 'upcoming')
  // How far the LIST reaches, in months from today. Three was the old hard cap;
  // it stays the default so nothing gets slower for a studio that never touches
  // it, and zooming out to a season or a year is now one click (UX-64).
  const [horizon, setHorizon] = useState<Horizon>(DEFAULT_HORIZON)
  // Which calendars are drawn — a per-browser VIEW PREFERENCE, deliberately
  // not nav memory (see the hook's header before adding anything to it).
  const calendars = useVisibleCalendars()
  const [activityFilter, setActivityFilter] = useState<string | null>(null)
  // Which coaches are in scope. **EMPTY = every coach**, never "none" — see
  // CoachFilterMenu's header. Multi-select, because "what are Anna and Ben doing
  // this week" is an ordinary question the old single-select could not ask.
  const [coachIds, setCoachIds] = useState<string[]>([])
  // Opened straight from the dashboard's quick action. Read ONCE, in a lazy
  // initializer, so closing the dialog is not undone by the next render.
  const quickActionParams = useSearchParams()
  const [sessionDialog, setSessionDialog] = useState<{ open: boolean; editing: Session | null }>({
    open: quickActionParams.get(QUICK_ACTION_PARAM) === '1',
    editing: null,
  })
  const [deletingSession, setDeletingSession] = useState<Session | null>(null)
  const [eventDialog, setEventDialog] = useState<{ open: boolean; editing: Event | null }>({
    open: false,
    editing: null,
  })
  // Appointments, folded into the schedule: the availability CREATE form (from
  // "+ New → Add bookable hours") and a bookings-roster modal (clicking a booked
  // appointment slot). MANAGING availability — schedules per coach, pause/resume,
  // edit, delete, time off — is the /schedule/availability route, reached by name
  // from the header.
  const [newAvailabilityOpen, setNewAvailabilityOpen] = useState(false)
  // MANAGING bookable hours — the side sheet over this calendar. Same component
  // the /schedule/availability route renders, so there is one writer and the
  // route stays a working deep link (see BookableHoursSheet's header).
  const [hoursSheetOpen, setHoursSheetOpen] = useState(false)
  // PLACES — the same arrangement one button along, for the same reason. The
  // route stays live and the sheet's footer links to it.
  const [placesSheetOpen, setPlacesSheetOpen] = useState(false)
  const [appointmentSlot, setAppointmentSlot] = useState<Session | null>(null)
  // Manual booking — a manager books an appointment for a client (or blocks
  // time) on the spot, e.g. a phone booking. Distinct from "Appointment
  // availability" above (the *when* a coach is bookable) — this creates ONE
  // session directly via the staff-only callable.
  const [appointmentFormOpen, setAppointmentFormOpen] = useState(false)

  // ── the window each view asks for ─────────────────────────────────────────
  // The calendar wants the month either side of its cursor (instant paging);
  // the list wants a HORIZON measured from today, which is the thing a studio
  // planning a season actually asks for and which the cursor window could never
  // express (UX-64). Both bounds are snapped to midnight so the query key is
  // stable for the whole day instead of changing on every render.
  const listAnchor = startOfDay(today)
  const range =
    view === 'calendar'
      ? { from: new Date(viewYear, viewMonth - 1, 1), to: new Date(viewYear, viewMonth + 2, 1) }
      : tab === 'upcoming'
        ? { from: listAnchor, to: addMonths(listAnchor, horizon) }
        : { from: addMonths(listAnchor, -horizon), to: addDays(listAnchor, 1) }

  const sessionsQ = useSessionsInRange(currentTeamId, range.from, range.to)
  const activitiesQ = useActivities(currentTeamId)
  const eventsQ = useEventsInRange(currentTeamId, orgId, range.from, range.to)
  const { data: members = [] } = useTeamMembers(currentTeamId)
  const { pickable: coachRoster } = useCoaches(currentTeamId)
  const availabilityQ = useAvailabilityTemplates(currentTeamId)

  const invalidateSessions = () => qc.invalidateQueries({ queryKey: ['sessions'] })
  const invalidateEvents = () => qc.invalidateQueries({ queryKey: ['events'] })

  const handleDeleteSession = (s: Session) => setDeletingSession(s)
  const deleteSessionLabel = deletingSession
    ? deletingSession.activityName
      ? `${deletingSession.activityName} – ${formatDate(fmt, deletingSession.start)}`
      : formatDate(fmt, deletingSession.start)
    : ''

  const handleDeleteEvent = async (e: Event) => {
    const okDeleteEvent = await confirm({
      title: t('deleteEventConfirmTitle'),
      description: t('deleteEventConfirm', { title: e.title }),
      confirmLabel: tCommon('delete'),
    })
    if (!okDeleteEvent) return
    await updateDoc(doc(db, EVENTS_COLLECTION, e.id), { deleted_at: serverTimestamp() })
    invalidateEvents()
  }

  // ── combined list ──

  const nowMs = Date.now()

  // Coach filter — narrows sessions to the selected instructors. Purely
  // client-side: no query takes a coach (sessions come by team+window, bookable
  // hours by team), so this is an array filter and nothing more. Events aren't
  // coach-scoped, so ANY coach selection hides them entirely — the same rule as
  // when this was single-select, and it stays coherent for several coaches:
  // narrowing to people leaves those people's teaching schedule, and an event
  // belongs to no one. Applies to both calendar + list.
  const coachScoped = coachIds.length > 0
  const isAppointment = (s: Session) => s.activityType === 'appointment'
  // Coach scope FIRST, calendars second — the two are different questions ("whose"
  // vs "what kind"), and keeping the coach-scoped set around lets the
  // hidden-calendars notice below ask "would this calendar have shown anything?"
  // without re-deriving the scope.
  const scopedSessions = (sessionsQ.data ?? []).filter(
    // Group classes and appointment (private-lesson) sessions both store the
    // running provider in providerId.
    (s) => !coachScoped || (!!s.providerId && coachIds.includes(s.providerId))
  )
  const filteredSessions = scopedSessions.filter((s) =>
    isAppointment(s) ? calendars.isVisible('appointments') : calendars.isVisible('classes')
  )
  // Events aren't coach-scoped, so any coach selection hides them entirely
  // (unchanged); the Events LAYER is the other half of the condition.
  const scopedEvents = coachScoped ? [] : (eventsQ.data ?? [])
  const filteredEvents = calendars.isVisible('events') ? scopedEvents : []

  // Published bookable hours: a LAYER now, off by default, remembered per
  // browser. They used to be drawn unconditionally as "context" — which was the
  // right instinct with the wrong mechanism, because there was then no way to
  // turn several coaches' windows off on a week where they made the grid
  // unreadable. Scoped to the coach filter when one is set, so "Only me"
  // narrows the bands exactly as it narrows the sessions. Paused schedules never
  // show (they're not bookable).
  //
  // Selecting several coaches meets the calendar's own lane cap, and THE CAP
  // WINS: SessionsCalendar draws one sub-lane per coach up to MAX_AVAIL_LANES
  // (3), coaches past the third share the last lane with their own colour, and
  // the legend says "+N more". That is not a new case introduced here — an
  // unfiltered team with four coaches already renders exactly this — so a
  // five-coach selection degrades the way the unfiltered week already does.
  const activeAvailability = availabilityQ.data?.filter((a) => a.status === 'active') ?? []
  const scopedAvailability = coachScoped
    ? activeAvailability.filter((a) => coachIds.includes(a.providerId))
    : activeAvailability
  const calendarAvailability = calendars.isVisible('bookableHours') ? scopedAvailability : []

  const allItems: ListItem[] = [
    ...filteredSessions.map((s) => ({ kind: 'session' as const, data: s })),
    ...filteredEvents.map((e) => ({ kind: 'event' as const, data: e })),
  ]
  const listItems = allItems
    .filter((item) => (tab === 'upcoming' ? getItemMs(item) >= nowMs : getItemMs(item) < nowMs))
    // Type/coach filtering is already applied to filteredSessions/filteredEvents;
    // here we only narrow further by the optional activity sub-filter.
    .filter(
      (item) =>
        !activityFilter ||
        item.kind !== 'session' ||
        (item.data as Session).activityId === activityFilter!
    )

    .sort((a, b) =>
      tab === 'upcoming' ? getItemMs(a) - getItemMs(b) : getItemMs(b) - getItemMs(a)
    )

  const isListLoading = sessionsQ.isLoading || eventsQ.isLoading
  // ── "you are looking at an empty grid because you hid a calendar" ─────────
  //
  // An empty grid under a hidden calendar is the same defect class as UX-20's
  // "0 upcoming" over a full grid: the screen states something false about the
  // studio's business. So a hidden calendar is only worth mentioning when it
  // WOULD have drawn something — otherwise every studio with a quiet week would
  // be told its calendars are the problem, and the default set hides one, so
  // that misfire would be the common case rather than the rare one.
  const inTimeWindow = (ms: number) =>
    view === 'calendar' ? true : tab === 'upcoming' ? ms >= nowMs : ms < nowMs
  const calendarHasContent = (calendar: ScheduleCalendar): boolean => {
    switch (calendar) {
      case 'classes':
        return scopedSessions.some(
          (s) => !isAppointment(s) && inTimeWindow(s.start.toDate().getTime())
        )
      case 'appointments':
        return scopedSessions.some(
          (s) => isAppointment(s) && inTimeWindow(s.start.toDate().getTime())
        )
      case 'events':
        return scopedEvents.some((e) => inTimeWindow(e.start.toDate().getTime()))
      // Bookable hours draw on the week grid only — in the list there is nothing
      // for them to have been hiding.
      case 'bookableHours':
        return view === 'calendar' && scopedAvailability.length > 0
    }
  }
  const hiddenWithContent = calendars.hidden.filter(calendarHasContent)
  const nothingDrawn =
    view === 'calendar'
      ? filteredSessions.length === 0 &&
        filteredEvents.length === 0 &&
        calendarAvailability.length === 0
      : listItems.length === 0
  const showHiddenCalendarsNotice =
    hiddenWithContent.length > 0 && nothingDrawn && !isListLoading && !availabilityQ.isLoading
  const calendarLabel: Record<ScheduleCalendar, string> = {
    classes: t('filterClasses'),
    appointments: t('filterAppointments'),
    bookableHours: t('bookableHours'),
    events: t('filterEvents'),
  }

  // "Next 6 months" vs "Last 6 months" — the same distance reads differently
  // depending on which way the tab is pointing, and a bare "6 months" beside a
  // Past tab is ambiguous about which six.
  const horizonLabel = (h: Horizon) =>
    tab === 'upcoming' ? t('horizonNext', { months: h }) : t('horizonLast', { months: h })

  const TABS: { key: TimeTab; label: string }[] = [
    { key: 'upcoming', label: t('tabUpcoming') },
    { key: 'past', label: t('tabPast') },
  ]
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          </div>
          {/* NAME THE CLOCK WHEN IT IS NOT THE READER'S. Every time on this page
              is printed in the studio's display zone (`Team.regional.timezone`,
              Swiss by default when the field was never set). When that differs
              from the browser's zone the numbers are correct and still look
              wrong, so the line says which clock they are on and links to the
              control that changes it. Same zone on both sides ⇒ nothing to
              explain, and no line. */}
          {fmt.timeZone !== deviceTimeZone() && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('timezoneNotice', { zone: fmt.timeZone })}{' '}
              <Link
                href={'/settings/team?tab=general' as Route}
                className="underline hover:text-foreground"
              >
                {t('timezoneChange')}
              </Link>
            </p>
          )}
          {/* WHAT FILLS THIS CALENDAR, AND WHAT COMES OUT OF IT. A session is an
              instance of an ACTIVITY and produces BOOKINGS, and the calendar
              pointed at neither — the two pages a studio moves between all day
              (Franco, 2026-08-28). The public booking page is beside them
              because it is where the bookings actually come from; it opens in a
              new tab rather than joining the QuickLinks line, which types its
              hrefs as in-app Routes. */}
          <QuickLinks
            links={[
              { href: '/offer/activities' as Route, label: tNav('activities') },
              { href: '/bookings' as Route, label: tNav('bookings') },
              { href: '/settings/booking' as Route, label: tNav('bookingPage') },
            ]}
          />
          <PublicSurfaceLink subPath="booking" label={tNav('bookingPage')} className="mt-1.5" />
        </div>
        {/* ONE height across this row. These controls were hand-sized
            independently — a `size="sm"` link and a px-4/py-2 trigger — so
            nothing lined up. They all render at the Button default (h-8) now.
            The view toggle used to be here too and kept its own p-1 padding to
            reach the same 32px; it now has its own line below. */}
        <div className="flex items-center gap-2">
          {/* Bookable hours — a NAMED control, at every width. This is what a
              coach hunts for when she wants to be bookable; it was a bare
              chevron on a filter chip and she never found it, so it must never
              be reduced to an icon.
              It now opens the SIDE SHEET rather than navigating: publishing
              hours is done against the week those hours have to fit into, and
              the full page took that week away. The route it used to point at is
              still a route — the sheet's footer links to it — so bookmarks, QR
              codes and habits still land. */}
          <Button
            variant="outline"
            className="shrink-0"
            onClick={() => setHoursSheetOpen(true)}
            disabled={!currentTeamId || !user}
          >
            <CalendarClock className="h-3.5 w-3.5" />
            {t('bookableHours')}
          </Button>
          {/* Places — the locations and rooms the session/event forms pick from.
              It lived in Settings, so adding a room mid-schedule meant leaving the
              calendar and hunting for it (UX-67). Peer of Bookable hours: both are
              the scheduling reference data this page consumes, both are edited
              from here. Label hidden below `sm` only — the icon is a map pin next
              to a labelled sibling, so it does not have to carry the meaning
              alone on a narrow screen.
              It now opens a SIDE SHEET, for the reason its sibling above already
              gives: the moment a room is needed is the moment somebody is
              scheduling into it, and a full page takes away the week they were
              reading. The route still exists and the sheet's footer links to it. */}
          <Button
            variant="outline"
            className="shrink-0"
            title={t('places')}
            onClick={() => setPlacesSheetOpen(true)}
            disabled={!currentTeamId || !user}
          >
            <MapPin className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('places')}</span>
          </Button>
          {/* Add dropdown */}
          {currentTeamId && user && (
            <DropdownMenu>
              {/* `hover:bg-primary/90` is not redundant: the default variant's
                  own hover is `[a]:hover:…`, which never matches a button. */}
              <DropdownMenuTrigger
                className={cn(buttonVariants(), 'hidden sm:inline-flex gap-2 hover:bg-primary/90')}
              >
                <Plus className="h-4 w-4" />
                {t('newEntry')}
                <ChevronDown className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setSessionDialog({ open: true, editing: null })}>
                  <CalendarDays className="h-4 w-4 mr-2" />
                  {t('newSession')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAppointmentFormOpen(true)}>
                  <User className="h-4 w-4 mr-2" />
                  {t('newAppointment')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setEventDialog({ open: true, editing: null })}>
                  <CalendarRange className="h-4 w-4 mr-2" />
                  {t('newEvent')}
                </DropdownMenuItem>
                {/* Four peer verbs, no separator to explain: the last one
                    publishes hours rather than putting one thing on the
                    calendar, and its label says so. */}
                <DropdownMenuItem onClick={() => setNewAvailabilityOpen(true)}>
                  <CalendarClock className="h-4 w-4 mr-2" />
                  {t('newAvailability')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* A recurring series commits on its own doc and materialises behind it
          (SessionFormDialog). Say so, or the classes that have not landed yet
          read as a save that half-worked. */}
      <GeneratingSeriesNotice teamId={currentTeamId} />

      {/* WHICH VIEW — ON ITS OWN LINE, ON THE LEFT (Franco, 2026-09-08).
          It had been sharing the header's right-hand group with three ACTIONS
          (bookable hours, places, new), which put a question about what you are
          looking at among the things you can do to it, and left a long label no
          room. On its own line it is read before the page it switches, in the
          direction the page is read from — and above the filters, because
          choosing a view and narrowing it are different questions. */}
      <div className="hidden w-fit gap-1 rounded-lg bg-muted p-1 sm:flex">
        {(
          [
            { key: 'calendar', icon: CalendarDays, label: t('viewCalendar') },
            { key: 'list', icon: List, label: t('viewList') },
            { key: 'planning', icon: ChartNoAxesGantt, label: t('viewPlanning') },
          ] as const
        ).map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`flex h-6 items-center gap-1.5 px-2.5 rounded-md text-sm font-medium transition-colors ${
              view === key
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Filters — ONE control group, read left to right as <who> | <what>.
          Both chips carry a caret and open checkboxes: same shape, same
          gesture, and the label on each names its current state rather than a
          static noun. Nothing here switches the view.

          HIDDEN IN PLANNING, because neither chip can do anything there but
          subtract: the events layer would empty the view entirely and the coach
          filter blanks `scopedEvents` although an event has no coach to be
          scoped by. A control that is visible and inert is worse than one that
          is absent — it invites the reader to blame it for what they cannot
          see. */}
      <div
        className={`flex flex-wrap items-center gap-x-1 gap-y-2 ${
          view === 'planning' ? 'hidden' : ''
        }`}
      >
        {/* WHO — first, because it scopes everything to its right. */}
        {coachRoster.length > 1 && (
          <>
            <CoachFilterMenu
              coaches={coachRoster}
              selected={coachIds}
              onChange={setCoachIds}
              currentUserId={user?.uid ?? null}
            />
            <span aria-hidden className="mx-1 h-4 w-px self-center bg-border" />
          </>
        )}

        {/* WHAT — four CALENDARS, ticked on and off independently, plus
            show-all and reset-to-default. See VisibleCalendarsMenu. */}
        <VisibleCalendarsMenu
          calendars={calendars}
          calendarView={view === 'calendar'}
          onCalendarHidden={(calendar) => {
            // The activity picker narrows classes; with classes hidden it
            // narrows nothing and would silently survive the calendar coming
            // back.
            if (calendar === 'classes') setActivityFilter(null)
          }}
        />
      </div>

      {/* Hidden-calendars notice — an empty grid must never read as "you have
          nothing scheduled" when the truth is "you switched it off". Only
          raised for calendars that would actually have drawn something (see
          `hiddenWithContent`). */}
      {showHiddenCalendarsNotice && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed bg-muted/20 px-4 py-3">
          <EyeOff className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t('calendars.hiddenTitle')}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t('calendars.hiddenBody', {
                calendars: hiddenWithContent.map((c) => calendarLabel[c]).join(', '),
              })}
            </p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={calendars.showAll}>
            {t('calendars.showAll')}
          </Button>
        </div>
      )}

      {/* Nudge: sessions hang off activities, so surface activity creation first
          when the team hasn't defined any yet. */}
      {!activitiesQ.isLoading && (activitiesQ.data?.length ?? 0) === 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/[0.04] p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t('noActivitiesTitle')}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('noActivitiesBody')}</p>
            <Link
              href="/offer/activities"
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              {t('noActivitiesCta')}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}

      {/* Calendar view */}
      {view === 'calendar' && (
        <SessionsCalendar
          sessions={filteredSessions}
          activities={activitiesQ.data ?? []}
          events={filteredEvents}
          availability={calendarAvailability}
          onEdit={(s) =>
            s.activityType === 'appointment'
              ? setAppointmentSlot(s)
              : setSessionDialog({ open: true, editing: s })
          }
          onDelete={handleDeleteSession}
          onEventEdit={(e) => setEventDialog({ open: true, editing: e })}
          onEventDelete={handleDeleteEvent}
          viewYear={viewYear}
          viewMonth={viewMonth}
          onNavigate={(y, m) => {
            setViewYear(y)
            setViewMonth(m)
          }}
        />
      )}

      {/* ── PLANNING: THE SEASON'S EVENTS, NOT ITS WEEKS ────────────────────
          EVENTS ONLY, and that is the point rather than an omission. A studio
          runs 500-1300 sessions a year against a few dozen events; the
          timeline's whole premise is "one row unless they cross", and at year
          zoom a week's classes sit about 1.5px apart, collide, and correctly
          open a row each. A timeline of a weekly rhythm IS a calendar, which is
          the view next door. The tab is named for what it holds so that
          dropping the classes reads as the view's subject and not as data that
          went missing.

          IT TAKES `eventsQ.data`, NOT `filteredEvents`. Those filters belong to
          a mixed calendar: the `events` calendar layer can only empty this view
          entirely, and the coach filter blanks `scopedEvents` although an event
          has no coach to be scoped by. Both can subtract everything here and
          add nothing.

          The studio's own events and its organisation's arrive together (see
          `useEventsInRange`), which is what makes the timeline's by-owner banding
          worth having: the organisation's dates are the fixed ones to plan
          around. */}
      {view === 'planning' && (
        <EventsTimeline
          events={eventsQ.data ?? []}
          onEdit={(e) => setEventDialog({ open: true, editing: e })}
          onDelete={handleDeleteEvent}
        />
      )}

      {/* List view */}
      {view === 'list' && (
        <>
          {/* Tabs, and — on the same line — HOW FAR the list reaches.
              The horizon belongs beside the upcoming/past switch because it
              modifies exactly that: the tab says which direction from today,
              this says how far. It is not a filter (it does not narrow what is
              shown, it decides what is fetched), so it stays out of the chip row
              above, which is all filters. */}
          <div className="flex items-end justify-between gap-3 border-b">
            <div className="flex gap-1">
              {TABS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === key
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <Select value={String(horizon)} onValueChange={(v) => setHorizon(Number(v) as Horizon)}>
              <SelectTrigger className="h-7 text-xs w-[150px] mb-1" aria-label={t('horizonLabel')}>
                <span className="truncate">{horizonLabel(horizon)}</span>
              </SelectTrigger>
              <SelectContent>
                {HORIZONS.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {horizonLabel(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Activity sub-filter — a genuine FILTER (it narrows one calendar to
              one activity), which is why it is here and not in the filter row
              above. Only meaningful while Classes is drawn. */}
          {calendars.isVisible('classes') && (activitiesQ.data?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={activityFilter ?? '__all__'}
                onValueChange={(v) => setActivityFilter(v === '__all__' ? null : v)}
              >
                <SelectTrigger className="h-8 text-xs w-[160px]">
                  <span className="truncate">
                    {activityFilter
                      ? (activitiesQ.data?.find((a) => a.id === activityFilter)?.name ??
                        t('filterActivity'))
                      : t('filterActivity')}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('filterActivity')}</SelectItem>
                  {activitiesQ.data?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Combined list */}
          <div className="rounded-xl border overflow-hidden bg-card">
            {isListLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex gap-3 p-4 border-b last:border-0">
                  <Skeleton className="h-9 w-9 rounded-lg shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-64" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                </div>
              ))}
            {/* The generic empty line stands down when the notice above is
                already explaining the emptiness — two answers to one question,
                one of them wrong, is worse than either alone. */}
            {!isListLoading && listItems.length === 0 && !showHiddenCalendarsNotice && (
              <div className="py-16 text-center text-muted-foreground text-sm">
                {tab === 'upcoming' ? t('emptyUpcoming') : t('emptyPast')}
              </div>
            )}
            {!isListLoading &&
              (() => {
                let lastDay = ''
                return listItems.map((item) => {
                  const ms = getItemMs(item)
                  const dk = dayKey(fmt, ms)
                  const showDivider = dk !== lastDay
                  lastDay = dk
                  return (
                    <Fragment key={`${item.kind}-${item.data.id}`}>
                      {showDivider && (
                        <div className="px-4 py-1.5 bg-muted/40 border-b text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {dayDividerLabel(fmt, ms, {
                            today: tCommon('today'),
                            tomorrow: tCommon('tomorrow'),
                            yesterday: tCommon('yesterday'),
                          })}
                        </div>
                      )}
                      <ListItemRow
                        item={item}
                        activities={activitiesQ.data ?? []}
                        onEdit={() => {
                          if (item.kind === 'session')
                            item.data.activityType === 'appointment'
                              ? setAppointmentSlot(item.data)
                              : setSessionDialog({ open: true, editing: item.data })
                          else setEventDialog({ open: true, editing: item.data })
                        }}
                        onDelete={() => {
                          if (item.kind === 'session') handleDeleteSession(item.data)
                          else handleDeleteEvent(item.data)
                        }}
                      />
                    </Fragment>
                  )
                })
              })()}
          </div>
        </>
      )}

      {/* Mobile FAB */}
      {currentTeamId && user && (
        <FloatingSlot lane="page-primary" className="sm:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger className="h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary/90 transition-colors">
              <Plus className="h-6 w-6" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuItem onClick={() => setSessionDialog({ open: true, editing: null })}>
                <CalendarDays className="h-4 w-4 mr-2" />
                {t('newSession')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAppointmentFormOpen(true)}>
                <User className="h-4 w-4 mr-2" />
                {t('newAppointment')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEventDialog({ open: true, editing: null })}>
                <CalendarRange className="h-4 w-4 mr-2" />
                {t('newEvent')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setNewAvailabilityOpen(true)}>
                <CalendarClock className="h-4 w-4 mr-2" />
                {t('newAvailability')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </FloatingSlot>
      )}

      {/* Dialogs */}
      {currentTeamId && user && (
        <>
          <SessionFormDialog
            key={sessionDialog.editing?.id ?? 'new-session'}
            open={sessionDialog.open}
            onOpenChange={(v) =>
              setSessionDialog((prev) => ({ open: v, editing: v ? prev.editing : null }))
            }
            editing={sessionDialog.editing}
            activities={activitiesQ.data ?? []}
            teamId={currentTeamId}
            userId={user.uid}
            onSaved={invalidateSessions}
          />
          <SessionDeleteDialog
            open={!!deletingSession}
            onOpenChange={(v) => {
              if (!v) setDeletingSession(null)
            }}
            session={deletingSession}
            label={deleteSessionLabel}
            onDeleted={invalidateSessions}
          />
          <EventFormDialog
            key={eventDialog.editing?.id ?? 'new-event'}
            open={eventDialog.open}
            editing={eventDialog.editing}
            members={members}
            teamId={currentTeamId}
            userId={user.uid}
            orgId={orgId}
            isOrgAdmin={isOrgAdmin}
            onClose={() => setEventDialog({ open: false, editing: null })}
            onSaved={invalidateEvents}
          />
          {/* Bookable hours — the MANAGEMENT sheet over this calendar (list,
              add, edit, pause, remove, time off). Same component the
              /schedule/availability route renders. */}
          <BookableHoursSheet
            open={hoursSheetOpen}
            onOpenChange={setHoursSheetOpen}
            teamId={currentTeamId}
            userId={user.uid}
            calendarVisible={calendars.isVisible('bookableHours')}
            onShowCalendar={() => {
              if (!calendars.isVisible('bookableHours')) calendars.toggle('bookableHours')
            }}
          />
          {/* Places — locations and rooms, over this calendar. Shares the
              `['places', teamId, orgId]` query key with the session form's place
              picker, so a room added here shows up in an open form. */}
          <PlacesSheet
            open={placesSheetOpen}
            onOpenChange={setPlacesSheetOpen}
            teamId={currentTeamId}
            userId={user.uid}
            orgId={team?.org_id ?? null}
          />
          {/* Availability CREATE — one new schedule ("+ New → Add bookable
              hours"). Managing them lives in the sheet above, or at
              /schedule/availability. */}
          <AppointmentAvailabilityFormDialog
            open={newAvailabilityOpen}
            onOpenChange={setNewAvailabilityOpen}
            teamId={currentTeamId}
            userId={user.uid}
          />
          {/* Manual appointment booking — a manager books (or blocks) one slot */}
          <AppointmentFormDialog
            open={appointmentFormOpen}
            onOpenChange={setAppointmentFormOpen}
            activities={activitiesQ.data ?? []}
            coaches={coachRoster}
            teamId={currentTeamId}
            userId={user.uid}
            onSaved={invalidateSessions}
          />
          {/* Appointment slot detail — bookings roster + cancel */}
          <AppointmentDetail
            slot={appointmentSlot}
            onClose={() => setAppointmentSlot(null)}
            onCancelled={() => {
              setAppointmentSlot(null)
              invalidateSessions()
            }}
          />
        </>
      )}
      {confirmDialog}
    </div>
  )
}
