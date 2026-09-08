'use client'

import { useState } from 'react'
import { useRegisterTab } from '@/contexts/OpenTabsContext'
import { useTabParam } from '@/hooks/useTabParam'
import { useParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { doc, getDoc, updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useCapabilities } from '@/hooks/useCapabilities'
import { usePlaces } from '@/hooks/usePlaces'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'
import {
  ArrowLeft, CalendarDays, MapPin, CreditCard, Users, Mail,
  Pencil, Trash2, Send, Copy,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { DateTimePicker } from '@/components/ui/date-picker'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { EVENTS_COLLECTION } from '@linyup/shared'
import type { Event, RankingSystem, Team } from '@linyup/shared'
import { PLUGIN_REGISTRY } from '@/plugins/registry'
import { useEventTypes } from '@/hooks/useEventTypes'
import { eventTypeLabel, prettyEventType } from '@/lib/eventTypeLabel'
import { CheckinPanel } from '@/components/events/CheckinPanel'
import { EventDemographicsCard } from '@/components/events/EventDemographicsCard'
import { useEventCheckins } from '@/hooks/useEventCheckins'
import { ProgramTab } from '@/components/events/program/ProgramTab'
import { EventRsvpList, EventInvitationList } from '@/components/events/EventPeopleLists'
import { DuplicateEventDialog } from '@/components/events/DuplicateEventDialog'
import { EventPublishCard } from '@/components/events/EventPublishCard'
import { useOrg } from '@/contexts/OrgContext'
import { pluginSlot } from '@/plugins/slots'
import type { Route } from 'next'
import { Tip } from '@/components/ui/tip'

// ─── subcollection types ──────────────────────────────────────────────────────

// ─── edit schema ──────────────────────────────────────────────────────────────

const editSchema = z
  .object({
    title: z.string().min(1, 'Required').max(120),
    // Open string: built-in slug, installed-plugin type id, or team-custom type id.
    type: z.string().min(1, 'Required'),
    start: z.date({ required_error: 'Required' }),
    end: z.date({ required_error: 'Required' }),
    location: z.string().max(120).optional(),
    placeId: z.string().optional(),
    roomId: z.string().optional(),
    fee: z.string().optional(),
    description: z.string().max(1000).optional(),
  })
  .refine((d) => !d.start || !d.end || d.end > d.start, {
    message: 'End must be after start',
    path: ['end'],
  })

type EditFormData = z.infer<typeof editSchema>

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts?: { toDate(): Date } | null) {
  if (!ts) return '—'
  return ts.toDate().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}
function formatTime(ts?: { toDate(): Date } | null) {
  if (!ts) return ''
  return ts.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function eventDuration(e: Event): string {
  if (!e.start || !e.end) return ''
  const ms = (e.end as { toDate(): Date }).toDate().getTime() - (e.start as { toDate(): Date }).toDate().getTime()
  const mins = Math.round(ms / 60000)
  const days = Math.floor(mins / 1440)
  if (days >= 1) return `${days}d`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}
function statusVariant(status?: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'open': return 'default'
    case 'restricted': return 'secondary'
    case 'closed': return 'outline'
    case 'cancelled': return 'destructive'
    default: return 'secondary'
  }
}
// ─── edit dialog ──────────────────────────────────────────────────────────────

function EditEventDialog({
  event,
  onClose,
  onSaved,
}: {
  event: Event
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('Events')
  // Place and room are SESSION vocabulary — the keys live in that namespace and
  // an event form reuses them rather than owning a second copy of the same four
  // words. Called through `t` they rendered their own ids.
  const tSessions = useTranslations('Sessions')
  const { currentTeamId, team } = useAuth()
  const { types } = useEventTypes(currentTeamId)
  const { data: places = [] } = usePlaces(currentTeamId, team?.org_id ?? null)
  // Keep the event's current type selectable even if its plugin was uninstalled
  // (or it's an unknown/legacy type) — otherwise editing would silently drop it.
  const typeOptions =
    event.type && !types.some((x) => x.id === event.type)
      ? [...types, { id: event.type, name: prettyEventType(event.type), source: 'builtin' as const }]
      : types
  const labelForType = (id: string) =>
    eventTypeLabel(
      id,
      (k) => t.has(k as Parameters<typeof t>[0]),
      (k) => t(k as Parameters<typeof t>[0]),
      typeOptions.find((x) => x.id === id)?.name,
    )
  const { register, handleSubmit, control, watch, setValue, formState: { errors, isSubmitting } } = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      title: event.title,
      type: event.type as EditFormData['type'],
      start: (event.start as { toDate(): Date } | null | undefined)?.toDate() ?? undefined,
      end: (event.end as { toDate(): Date } | null | undefined)?.toDate() ?? undefined,
      location: event.location ?? '',
      placeId: event.placeId ?? '',
      roomId: event.roomId ?? '',
      fee: event.fee != null ? String(event.fee) : '',
      description: event.description ?? '',
    },
  })
  const watchedPlaceId = watch('placeId')
  const placeRooms = places.find((p) => p.id === watchedPlaceId)?.rooms ?? []

  async function onSubmit(data: EditFormData) {
    await updateDoc(doc(db, EVENTS_COLLECTION, event.id), {
      title: data.title,
      type: data.type,
      start: Timestamp.fromDate(data.start),
      end: Timestamp.fromDate(data.end),
      location: data.location ?? '',
      placeId: data.placeId || null,
      roomId: data.roomId || null,
      fee: data.fee ? Number(data.fee) : null,
      description: data.description ?? '',
    })
    onSaved()
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('editEvent')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-2">
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
                      {field.value
                        ? labelForType(field.value)
                        : <span className="text-muted-foreground">—</span>}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {typeOptions.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {labelForType(type.id)}
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

          {places.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{tSessions('fieldPlace')}</Label>
                <Controller name="placeId" control={control} render={({ field }) => (
                  <Select
                    value={field.value || '__none'}
                    onValueChange={(v) => { field.onChange(v === '__none' ? '' : v); setValue('roomId', '') }}
                  >
                    <SelectTrigger><SelectValue placeholder={tSessions('placeNone')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">{tSessions('placeNone')}</SelectItem>
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
              </div>
              {placeRooms.length > 0 && (
                <div className="space-y-1.5">
                  <Label>{tSessions('fieldRoom')}</Label>
                  <Controller name="roomId" control={control} render={({ field }) => (
                    <Select value={field.value || '__none'} onValueChange={(v) => field.onChange(v === '__none' ? '' : v)}>
                      <SelectTrigger><SelectValue placeholder={tSessions('roomNone')} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">{tSessions('roomNone')}</SelectItem>
                        {placeRooms.map((r) => (
                          <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )} />
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ev-location">{t('fieldLocation')}</Label>
              <Input id="ev-location" {...register('location')} placeholder={t('fieldLocationPlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-fee">
                {t('fieldFee')}{' '}
                <span className="text-muted-foreground font-normal text-xs">{t('fieldFeeOptional')}</span>
              </Label>
              <Input id="ev-fee" type="number" min="0" step="0.01" {...register('fee')} placeholder="0.00" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ev-desc">{t('fieldDescription')}</Label>
            <textarea
              id="ev-desc"
              {...register('description')}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t('saving') : t('saveChanges')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── delete confirm dialog ────────────────────────────────────────────────────

function DeleteConfirmDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void
  onCancel: () => void
}) {
  const t = useTranslations('Events')
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('deleteEvent')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground py-2">{t('detail_deleteConfirm')}</p>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="destructive" onClick={onConfirm}>{t('deleteEvent')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number | string
  icon: React.ElementType
}) {
  return (
    <div className="rounded-lg border bg-card p-4 flex items-center gap-3">
      <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div>
        <p className="text-2xl font-bold leading-none">{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
      </div>
    </div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

const DETAIL_TABS = ['overview', 'program', 'checkins', 'categories', 'attendees', 'invitations'] as const
type DetailTab = (typeof DETAIL_TABS)[number]

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { currentTeamId, team, isOrgAdmin } = useAuth()
  const { can } = useCapabilities()
  const { org } = useOrg()
  const t = useTranslations('Events')
  // Programme + duplication copy lives in its own namespace.
  const tp = useTranslations('EventProgram')
  const router = useRouter()
  const qc = useQueryClient()

  // WITH THE OTHER HOOKS, above the loading/not-found early returns — a hook
  // after one of those is called on some renders and not others. Shares
  // `useEventCheckins`' cache key with the Check-ins tab, so mounting both
  // costs one read.
  const checkinsQ = useEventCheckins(id)

  const [tab, setTab] = useTabParam(DETAIL_TABS, 'overview')
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ text: string; isError: boolean } | null>(null)

  // ─── event data ──────────────────────────────────────────────────────────────

  const eventQ = useQuery<Event | null>({
    queryKey: ['event', id],
    enabled: !!id,
    queryFn: async () => {
      const snap = await getDoc(doc(db, EVENTS_COLLECTION, id))
      if (!snap.exists()) return null
      return { id: snap.id, ...snap.data() } as Event
    },
  })


  const event = eventQ.data

  // Register this event as an open tab once loaded (mirrors the header title).
  useRegisterTab({
    href: `/events/${id}`,
    label: event?.title ?? '',
    entityKind: 'event',
    enabled: !!event,
  })

  // ─── actions ─────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!id) return
    await updateDoc(doc(db, EVENTS_COLLECTION, id), { deleted_at: serverTimestamp() })
    router.push('/schedule' as Route)
  }

  async function handleSendInvitations(resend: boolean) {
    setSending(true)
    setSendResult(null)
    try {
      const fn = httpsCallable<{ eventId: string; resend: boolean }, { stats: { sent: number; skipped: number } }>(
        functions,
        'sendEventInvitations',
      )
      const result = await fn({ eventId: id, resend })
      const { sent, skipped } = result.data.stats
      const parts = [t('detail_invitationsSent', { sent })]
      if (skipped > 0) parts.push(t('detail_invitationsSkipped', { skipped }))
      setSendResult({ text: parts.join(' · '), isError: false })
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['event', id] }),
        qc.invalidateQueries({ queryKey: ['event-invitations', id] }),
      ])
    } catch (err) {
      setSendResult({ text: (err as Error).message ?? 'Error', isError: true })
    } finally {
      setSending(false)
    }
  }

  // ─── loading / not found ──────────────────────────────────────────────────────

  if (eventQ.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-24" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
        </div>
      </div>
    )
  }

  if (!event || event.deleted_at) {
    return (
      <div className="space-y-4">
        <Link
          href="/schedule"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('detail_back')}
        </Link>
        <p className="text-muted-foreground">{t('detail_notFound')}</p>
      </div>
    )
  }

  const startDate = formatDate(event.start)
  const startTime = formatTime(event.start)
  const endTime = formatTime(event.end)
  const duration = eventDuration(event)

  // Ranking systems: org-wide events use org.ranking_systems (overrides team config)
  const rankingSystems: RankingSystem[] = org?.ranking_systems ?? team?.ranking_systems ?? []

  // Detect if this event type is backed by a plugin that declares hasCategories
  const eventPlugin = PLUGIN_REGISTRY.find((p) => p.eventType?.id === event.type)
  const showCategoriesTab = !!eventPlugin?.eventType?.hasCategories
  // Resolved from whichever plugin declares `hasCategories` for THIS event type.
  // It used to be a hardcoded import of one customer's plugin, in a core page,
  // while `eventPlugin` sat right here already computed and unused.
  const CategoryManager = eventPlugin && showCategoriesTab
    ? pluginSlot<{ eventId: string }>(eventPlugin.id, 'CategoryManager')
    : null

  // Attendees tab: who accepted an invitation to THIS event. That is not a
  // report, and gating it on `reports.view` alone hid the answers from the
  // person who asked the question: whoever runs the event (`events.manage`)
  // sends the invitations from this very page, and the Invitations tab beside
  // this one is not gated at all — so the sending half was visible while the
  // replies were not. `reports.view` stays because a manager who only reads
  // numbers still legitimately sees the roster; org admins keep it for
  // cross-team events.
  //
  // THIS IS TIDINESS, NOT A SECURITY BOUNDARY, and the distinction matters
  // because the obvious reading of a capability check is that it withholds
  // something. `firestore.rules` grants read on `events/{id}/attendees` to
  // `belongsToUserTeam` — every member of the owning team, no capability
  // required — so a coach or viewer who types the URL is served the roster by
  // the database whatever this page renders. Deciding they should NOT be is a
  // rules change, not a change here.
  const canSeeAttendees = isOrgAdmin || can('events.manage') || can('reports.view')

  const checkinLabel = (() => {
    const total = event.participants_count ?? 0
    const confirmed = event.completed_checkins_count ?? 0
    if (total === 0) return 'Checkins'
    if (confirmed < total) return `Checkins (${confirmed}/${total})`
    return `Checkins (${total})`
  })()

  const TABS: { key: DetailTab; label: string }[] = [
    { key: 'overview',    label: t('detail_tabOverview') },
    // Base feature, never plugin-gated — the program is what distinguishes an
    // event from a session, so the tab is always offered and its empty state
    // is the discovery affordance.
    { key: 'program',     label: t('detail_tabProgram') },
    { key: 'checkins',    label: checkinLabel },
    ...(showCategoriesTab ? [{ key: 'categories' as DetailTab, label: t('detail_tabCategories') }] : []),
    ...(canSeeAttendees ? [{ key: 'attendees' as DetailTab, label: `${t('detail_tabRsvps')}${event.attendees_count ? ` (${event.attendees_count})` : ''}` }] : []),
    { key: 'invitations', label: `${t('detail_tabInvitations')}${event.invitations_sent_count ? ` (${event.invitations_sent_count})` : ''}` },
  ]

  return (
    <div className="space-y-6">
      {/* Back */}
      <Link
        href="/schedule"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('detail_back')}
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <h1 className="text-2xl font-bold tracking-tight">{event.title}</h1>
            <Badge variant="secondary" className="capitalize shrink-0">
              {eventTypeLabel(
                event.type,
                (k) => t.has(k as Parameters<typeof t>[0]),
                (k) => t(k as Parameters<typeof t>[0]),
                eventPlugin?.eventType ? prettyEventType(eventPlugin.eventType.id) : undefined,
              )}
            </Badge>
            {event.status && (
              <Badge variant={statusVariant(event.status)} className="shrink-0">
                {t(`detail_status_${event.status}` as Parameters<typeof t>[0])}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5 shrink-0" />
              {startDate}
              {startTime && (
                <> · {startTime}{endTime && endTime !== startTime ? ` – ${endTime}` : ''}</>
              )}
              {duration && <span className="text-muted-foreground/60 ml-1">({duration})</span>}
            </span>
            {event.location && (
              <span className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                {event.location}
              </span>
            )}
            {event.fee != null && (
              <span className="flex items-center gap-1.5">
                <CreditCard className="h-3.5 w-3.5 shrink-0" />
                {event.fee}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil className="h-4 w-4 mr-1.5" />
            {t('editEvent')}
          </Button>
          <Tip label={tp('duplicateEvent')}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDuplicateOpen(true)}
              aria-label={tp('duplicateEvent')}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </Tip>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive border-destructive/30 hover:border-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Send invitations bar */}
      <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border bg-muted/40">
        <Send className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{t('detail_sendInvitations')}</p>
          {sendResult && (
            <p className={`text-xs mt-0.5 ${sendResult.isError ? 'text-destructive' : 'text-muted-foreground'}`}>
              {sendResult.text}
            </p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            disabled={sending}
            onClick={() => handleSendInvitations(true)}
          >
            {t('detail_resendAll')}
          </Button>
          <Button
            size="sm"
            disabled={sending}
            onClick={() => handleSendInvitations(false)}
          >
            {sending ? t('detail_sending') : t('detail_sendInvitations')}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
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

      {/* ── Overview tab ─────────────────────────────────────────────────────── */}
      {tab === 'overview' && (
        <div className="space-y-6">
          <EventPublishCard
            event={event}
            publicSlug={team?.slug ?? null}
            canEdit={can('events.manage') || isOrgAdmin}
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard
              label={t('detail_statsCheckins')}
              value={event.participants_count ?? 0}
              icon={Users}
            />
            <StatCard
              label={t('detail_statsRSVP')}
              value={event.attendees_count ?? 0}
              icon={Users}
            />
            <StatCard
              label={t('detail_statsInvited')}
              value={event.invitations_sent_count ?? 0}
              icon={Mail}
            />
          </div>

          {event.description ? (
            <div>
              <h3 className="text-sm font-medium mb-2">{t('detail_fieldDescription')}</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{event.description}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">{t('detail_noDescription')}</p>
          )}
          {/* WHO WAS IN THE ROOM. The counters above say how many; this says
              who. Shares `useEventCheckins`' cache key with the Check-ins tab,
              so opening both costs one read, and it renders nothing until the
              event actually has check-ins. */}
          <EventDemographicsCard
            checkins={checkinsQ.data ?? []}
            rankingSystems={rankingSystems}
            loading={checkinsQ.isLoading}
          />
        </div>
      )}

      {/* ── Program tab ──────────────────────────────────────────────────────── */}
      {tab === 'program' && (
        <ProgramTab
          event={event}
          canEdit={can('events.manage') || isOrgAdmin}
          // Surfaces the parent org's shared programme templates in the picker.
          parentOrgId={(team as Team & { org_id?: string })?.org_id ?? null}
        />
      )}

      {/* ── Check-ins tab ───────────────────────────────────────────────────── */}
      {tab === 'checkins' && (
        <CheckinPanel
          eventId={id}
          eventTitle={event.title}
          eventType={event.type}
          eventDate={startDate}
          rankingSystems={rankingSystems}
          orgId={event.orgId ?? (team as Team & { org_id?: string })?.org_id}
        />
      )}

      {/* ── Categories tab (plugin-provided, e.g. fighting_cup) ──────────────── */}
      {tab === 'categories' && showCategoriesTab && CategoryManager && (
        <CategoryManager eventId={id} />
      )}

      {/* ── RSVPs and Invitations ─────────────────────────────────────────────
           Both lists moved to `components/events/EventPeopleLists` so the ORG
           event page can show them too — see that file's header. `linkContacts`
           is on here and off there: a studio can open its own contact, an org
           admin cannot open a member studio's.

           RSVPs are WHO ACCEPTED, not who came. A decline deletes its row
           (`handleEventInvitationResponse`), so the list is the yeses; presence
           is the separate `checkins` collection under the Check-ins tab. The URL
           key stays `attendees` — it matches the subcollection, which is a data
           migration rather than a label. */}
      {tab === 'attendees' && canSeeAttendees && <EventRsvpList eventId={id} linkContacts />}

      {tab === 'invitations' && <EventInvitationList eventId={id} linkContacts />}


      {/* ── Dialogs ──────────────────────────────────────────────────────────── */}
      {editOpen && event && (
        <EditEventDialog
          key={event.id}
          event={event}
          onClose={() => setEditOpen(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['event', id] })}
        />
      )}

      {deleteOpen && (
        <DeleteConfirmDialog
          onConfirm={handleDelete}
          onCancel={() => setDeleteOpen(false)}
        />
      )}

      <DuplicateEventDialog
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
        event={event}
        onDuplicated={(newId) => router.push(`/events/${newId}` as Route)}
      />
    </div>
  )
}
