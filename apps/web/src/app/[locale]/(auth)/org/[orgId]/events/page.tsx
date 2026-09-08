'use client'

import { PageHeader } from '@/components/layout/PageHeader'
import dynamic from 'next/dynamic'

// The team's calendar, mounted here with no sessions. It already takes
// `events[]`, buckets them by date (multi-day events span every day they cover)
// and opens each one in a peek sheet — the schedule page has been passing it
// both all along. Reusing it was the whole point of the request; a second
// calendar is a second set of month-boundary bugs.
//
// `ssr: false` for the same reason the schedule page does it: the grid measures
// itself on mount.
const SessionsCalendar = dynamic(
  () => import('../../../sessions/SessionsCalendar'),
  { ssr: false }
)
// Same reason: the timeline measures its own track on mount, so it has nothing
// to say on the server.
const EventsTimeline = dynamic(
  () => import('@/components/events/EventsTimeline').then((m) => m.EventsTimeline),
  { ssr: false }
)

/** List, calendar, timeline — the three ways to look at the same events. */
const EVENT_VIEWS = ['list', 'calendar', 'timeline'] as const
import { useCallback, useMemo, useState } from 'react'
import { useTabParam } from '@/hooks/useTabParam'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  collection, query, where, orderBy, getDocs, addDoc,
  updateDoc, doc, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useParams } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/ui/search-input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { DateTimePicker } from '@/components/ui/date-picker'
import { Badge } from '@/components/ui/badge'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, Pencil, Trash2, CalendarRange, MapPin, CalendarDays, ChevronRight, Printer } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { eventTypeLabel } from '@/lib/eventTypeLabel'
import { BUILTIN_EVENT_TYPES, EVENTS_COLLECTION } from '@linyup/shared'
import type { Event } from '@linyup/shared'
import type { Route } from 'next'

function createEventSchema(t: ReturnType<typeof useTranslations>) {
  return z
    .object({
      title: z.string().min(1, t('errorRequired')).max(120),
      type: z.enum(['competition', 'camp', 'exam', 'seminar', 'workshop']),
      start: z.date({ required_error: t('errorRequired') }),
      end: z.date({ required_error: t('errorRequired') }),
      location: z.string().max(120).optional(),
      description: z.string().max(1000).optional(),
    })
    .refine((d) => !d.start || !d.end || d.end > d.start, {
      message: t('errorEndAfterStart'),
      path: ['end'],
    })
}

type EventFormData = z.infer<ReturnType<typeof createEventSchema>>

/**
 * Display label for an event type id, for every surface on this page — the badge
 * on a row, the type filter and the create/edit form — so a type never reads one
 * way in the filter and another in the list.
 *
 * The labels come from the `Events` namespace, not `OrgEvents`: that is where a
 * plugin-contributed type registers its copy (`type_hmd_fighting_cup`), and
 * `OrgEvents` carries the built-ins only, so a plugin type resolved there would
 * render its raw id.
 */
function useEventTypeLabel() {
  const t = useTranslations('Events')
  return useCallback(
    (id: string) =>
      eventTypeLabel(
        id,
        (k) => t.has(k as Parameters<typeof t>[0]),
        (k) => t(k as Parameters<typeof t>[0]),
      ),
    [t],
  )
}

function formatDate(ts: { toDate(): Date } | null | undefined) {
  if (!ts) return '—'
  return ts.toDate().toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
}

// ─── data hook ────────────────────────────────────────────────────────────────

function useOrgEvents(orgId: string, upcoming: boolean) {
  return useQuery<Event[]>({
    queryKey: ['org-events', orgId, upcoming ? 'upcoming' : 'past'],
    queryFn: async () => {
      const now = Timestamp.now()
      const q = query(
        collection(db, EVENTS_COLLECTION),
        where('orgId', '==', orgId),
        where('scope', '==', 'org'),
        where('deleted_at', '==', null),
        where('start', upcoming ? '>=' : '<', now),
        orderBy('start', upcoming ? 'asc' : 'desc'),
      )
      const snap = await getDocs(q)
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Event)
    },
  })
}

// ─── Event dialog ─────────────────────────────────────────────────────────────

function OrgEventDialog({
  open,
  onClose,
  orgId,
  userId,
  editing,
}: {
  open: boolean
  onClose: () => void
  orgId: string
  userId: string
  editing: Event | null
}) {
  const t = useTranslations('OrgEvents')
  const labelForType = useEventTypeLabel()
  const qc = useQueryClient()
  const eventSchema = useMemo(() => createEventSchema(t), [t])
  const { register, handleSubmit, control, formState: { errors, isSubmitting } } = useForm<EventFormData>({
    resolver: zodResolver(eventSchema),
    defaultValues: editing
      ? {
          title: editing.title,
          type: editing.type as EventFormData['type'],
          start: (editing.start as { toDate(): Date } | null | undefined)?.toDate() ?? undefined,
          end: (editing.end as { toDate(): Date } | null | undefined)?.toDate() ?? undefined,
          location: editing.location ?? '',
          description: editing.description ?? '',
        }
      : { type: 'competition' },
  })

  async function onSubmit(data: EventFormData) {
    const payload = {
      orgId,
      scope: 'org',
      teamId: null,
      title: data.title,
      type: data.type,
      start: Timestamp.fromDate(data.start),
      end: Timestamp.fromDate(data.end),
      location: data.location?.trim() || null,
      description: data.description?.trim() || null,
      status: 'open',
      deleted_at: null,
      createdBy: userId,
    }
    if (editing) {
      await updateDoc(doc(db, EVENTS_COLLECTION, editing.id), { ...payload, updated_at: serverTimestamp() })
    } else {
      await addDoc(collection(db, EVENTS_COLLECTION), { ...payload, created_at: serverTimestamp() })
    }
    qc.invalidateQueries({ queryKey: ['org-events', orgId] })
    // Also invalidate team events (they pick up org events too)
    qc.invalidateQueries({ queryKey: ['events'] })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t('dialogEditTitle') : t('dialogNewTitle')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label>{t('fieldTitle')}</Label>
            <Input {...register('title')} placeholder={t('fieldTitlePlaceholder')} />
            {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldType')}</Label>
            <Controller
              name="type"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={(v) => { if (v) field.onChange(v) }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BUILTIN_EVENT_TYPES.map((type) => (
                      <SelectItem key={type} value={type} className="capitalize">{labelForType(type)}</SelectItem>
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
                render={({ field }) => <DateTimePicker value={field.value} onChange={field.onChange} />}
              />
              {errors.start && <p className="text-xs text-destructive">{errors.start.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>{t('fieldEnd')}</Label>
              <Controller
                name="end"
                control={control}
                render={({ field }) => <DateTimePicker value={field.value} onChange={field.onChange} />}
              />
              {errors.end && <p className="text-xs text-destructive">{errors.end.message}</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldLocation')} <span className="text-muted-foreground text-xs">{t('fieldOptional')}</span></Label>
            <Input {...register('location')} placeholder={t('fieldLocationPlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldDescription')} <span className="text-muted-foreground text-xs">{t('fieldOptional')}</span></Label>
            <Input {...register('description')} placeholder={t('fieldDescriptionPlaceholder')} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>{t('cancel')}</Button>
            <Button type="submit" disabled={isSubmitting}>{isSubmitting ? t('saving') : editing ? t('save') : t('create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const ORG_EVENT_TABS = ['upcoming', 'past'] as const

// Sentinel for "no type filter" — a Select item needs a non-empty value, and the
// same `__all__` marker is what the org affiliations list uses for its type
// selector.
const ALL_TYPES = '__all__'

export default function OrgEventsPage() {
  const t = useTranslations('OrgEvents')
  const { orgId } = useParams<{ orgId: string }>()
  const { user } = useAuth()
  const { isAdmin } = useOrg()
  const qc = useQueryClient()

  const labelForType = useEventTypeLabel()

  const [tab, setTab] = useTabParam(ORG_EVENT_TABS, 'upcoming')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Event | null>(null)
  // IN THE URL, like every other tab in this app. It was `useState`, so a
  // refresh, a pasted link or the Back button dropped whoever was reading the
  // timeline back onto the list — the failure UX-22 named ("the app forgot").
  // `?view=` rather than `?tab=`, because this page already spends `?tab=` on
  // upcoming/past and the two are independent.
  // THE TIMELINE OPENS FIRST (Franco, 2026-09-08). A federation reviewing or
  // planning a season asks how the year is SHAPED before it asks what row 14
  // says, and the timeline now carries the attendance figures the chart used to
  // hold — with a list of what is on screen underneath it, so the list is one
  // scroll away rather than one tab away. The other two views keep their tabs
  // and the URL stays truthful, so a link to `?view=list` still opens the list.
  const [view, setView] = useTabParam(EVENT_VIEWS, 'timeline', 'view')
  const [deleting, setDeleting] = useState<Event | null>(null)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState(ALL_TYPES)

  const upcoming = useOrgEvents(orgId, true)
  const past = useOrgEvents(orgId, false)
  const current = tab === 'upcoming' ? upcoming : past

  // The built-in slugs plus whatever types the loaded events actually carry, so a
  // plugin-contributed type ('hmd_fighting_cup') is offered here without this page
  // knowing that plugins exist. `useEventTypes` is deliberately not used: it is
  // team-scoped and this page has an org, not a team.
  //
  // Derived from BOTH tabs rather than the visible one — the option list must not
  // change under the person who set it when they flip upcoming/past, and an org
  // that has run for two decades has types that only appear in its past.
  const typeOptions = useMemo(() => {
    const present = new Set<string>()
    for (const e of [...(upcoming.data ?? []), ...(past.data ?? [])]) {
      if (e.type) present.add(e.type)
    }
    BUILTIN_EVENT_TYPES.forEach((id) => present.delete(id))
    const extra = [...present].sort((a, b) => labelForType(a).localeCompare(labelForType(b)))
    return [...BUILTIN_EVENT_TYPES, ...extra]
  }, [upcoming.data, past.data, labelForType])

  // Type and search compose, and both compose with the upcoming/past tab that
  // chose `current` in the first place.
  const term = search.trim().toLowerCase()
  const visible = useMemo(() => {
    const rows = current.data ?? []
    return rows.filter((e) => {
      if (typeFilter !== ALL_TYPES && e.type !== typeFilter) return false
      if (term && !(e.title ?? '').toLowerCase().includes(term)) return false
      return true
    })
  }, [current.data, typeFilter, term])

  // The controls are keyed off both tabs for the same reason the options are:
  // a filter row that vanishes when you switch to an empty tab takes the filter
  // you set with it.
  const hasAnyEvent = (upcoming.data?.length ?? 0) + (past.data?.length ?? 0) > 0

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['org-events', orgId] })
    qc.invalidateQueries({ queryKey: ['events'] })
  }

  async function handleSoftDelete() {
    if (!deleting) return
    await updateDoc(doc(db, EVENTS_COLLECTION, deleting.id), {
      deleted_at: serverTimestamp(),
    })
    invalidate()
    setDeleting(null)
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        action={
          // ACTIONS TOGETHER, IN THE HEADER — the shape the studio schedule
          // uses, where bookable hours, places and new sit as a group beside the
          // title. Print used to sit beside the view switcher, which put a page
          // you can go to next to a question about what you are looking at.
          <div className="flex items-center gap-2">
            {/* The season on paper. A link rather than a button because it IS a
                page — one you can bookmark with a window already chosen. */}
            <Link
              href={`/org/${orgId}/events/print` as Route}
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Printer className="h-3.5 w-3.5" />
              {t('printButton')}
            </Link>
            {isAdmin && (
              <Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true) }}>
                <Plus className="h-4 w-4 mr-1.5" />{t('newEvent')}
              </Button>
            )}
          </div>
        }
      />

      {/* WHICH VIEW — ON ITS OWN LINE, ON THE LEFT, the same shape the studio
          schedule uses. It had been in the right-hand group beside Print, which
          is an ACTION: a question about what you are looking at does not belong
          among the things you can do to it.

          `Segmented` rather than the pill tray this had hand-rolled. That
          component exists because the markup had been written twice and "two
          copies of a control are two places for its focus, hover and selected
          states to drift" — this page was the last copy. */}
      <Segmented
        size="sm"
        ariaLabel={t('viewLabel')}
        value={view}
        onChange={setView}
        options={EVENT_VIEWS.map((v) => ({
          value: v,
          label: v === 'list' ? t('viewList') : v === 'calendar' ? t('viewCalendar') : t('viewTimeline'),
        }))}
      />

      {/* UPCOMING/PAST IS A LIST IDEA, so the whole strip is. A calendar shows a
          month and a timeline shows a year — whatever falls in the window, on
          both sides of today — and the tabs cannot describe either. It used to
          render empty in those two views, carrying a rule under nothing once
          Print moved up to the header. */}
      {view === 'list' && (
        <div className="flex gap-1 border-b text-sm">
          {(['upcoming', 'past'] as const).map((tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={`px-4 py-2 border-b-2 -mb-px font-medium capitalize transition-colors ${
                tab === tabKey ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tabKey === 'upcoming' ? t('tabUpcoming') : t('tabPast')}
            </button>
          ))}
        </div>
      )}

      {/* The federation's calendar. Both halves, because a month contains both. */}
      {view === 'calendar' && (
        <SessionsCalendar
          sessions={[]}
          activities={[]}
          events={[...(upcoming.data ?? []), ...(past.data ?? [])]}
          onEdit={() => {}}
          onDelete={() => {}}
          onEventEdit={isAdmin ? (e) => { setEditing(e); setDialogOpen(true) } : undefined}
          onEventDelete={isAdmin ? (e) => setDeleting(e) : undefined}
        />
      )}

      {/* THE SEASON, END TO END. Both halves of the year for the same reason
          the calendar takes both: a window is a window, and the events on
          either side of today are equally in it. */}
      {view === 'timeline' && (
        <EventsTimeline
          events={[...(upcoming.data ?? []), ...(past.data ?? [])]}
          onEdit={isAdmin ? (e) => { setEditing(e); setDialogOpen(true) } : undefined}
          onDelete={isAdmin ? (e) => setDeleting(e) : undefined}
        />
      )}

      {/* Filter row — stacked on a phone, one line from sm up, so it can never
          overflow sideways. */}
      {view === 'list' && !current.isLoading && hasAnyEvent && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="sm:max-w-xs sm:flex-1">
            <SearchInput
              className="h-9 text-sm"
              placeholder={t('searchPlaceholder')}
              value={search}
              onValueChange={setSearch}
            />
          </div>
          <Select value={typeFilter} onValueChange={(v) => { if (v) setTypeFilter(v) }}>
            <SelectTrigger className="h-9 w-full text-sm sm:w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TYPES}>{t('filterAllTypes')}</SelectItem>
              {typeOptions.map((id) => (
                <SelectItem key={id} value={id}>{labelForType(id)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {view === 'list' && (current.isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : !current.data || current.data.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <CalendarRange className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-muted-foreground text-sm">{tab === 'upcoming' ? t('emptyUpcoming') : t('emptyPast')}</p>
          {isAdmin && tab === 'upcoming' && (
            <Button variant="outline" size="sm" onClick={() => { setEditing(null); setDialogOpen(true) }}>
              <Plus className="h-4 w-4 mr-1.5" />{t('newEvent')}
            </Button>
          )}
        </div>
      ) : visible.length === 0 ? (
        // Its own copy, not `emptyUpcoming`/`emptyPast` — a filter that matched
        // nothing and a tab with no events in it are different situations, and
        // reusing the second reads as the events having disappeared.
        <div className="py-16 text-center text-sm text-muted-foreground">
          {term ? t('emptySearch', { query: search.trim() }) : t('emptyTypeFilter')}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((event) => (
            <div key={event.id} className="flex items-start gap-3 rounded-lg border p-3 hover:bg-muted/20 transition-colors">
              <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <CalendarDays className="h-4 w-4 text-primary" />
              </div>
              <Link
                href={`/org/${orgId}/events/${event.id}` as Route}
                className="flex-1 min-w-0 block"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{event.title}</span>
                  <Badge variant="secondary" className="text-xs capitalize shrink-0">{labelForType(event.type)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatDate(event.start as { toDate(): Date })}
                  {event.location && (
                    <span className="ml-2 inline-flex items-center gap-0.5">
                      <MapPin className="h-3 w-3" />{event.location}
                    </span>
                  )}
                </p>
              </Link>
              <div className="flex items-center gap-1 shrink-0">
                {isAdmin && (
                  <>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditing(event); setDialogOpen(true) }}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => setDeleting(event)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
          ))}
        </div>
      ))}

      {user && (
        <OrgEventDialog
          open={dialogOpen}
          onClose={() => { setDialogOpen(false); setEditing(null) }}
          orgId={orgId}
          userId={user.uid}
          editing={editing}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteEventTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteConfirmDescription', { title: deleting?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSoftDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
