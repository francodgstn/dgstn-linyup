'use client'

import { useState, useMemo } from 'react'
import { useParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  doc, getDoc, collection, query, where, getDocs, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useEventCheckins } from '@/hooks/useEventCheckins'
import { EventDemographicsCard } from '@/components/events/EventDemographicsCard'
import { useOrg } from '@/contexts/OrgContext'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, CalendarDays, MapPin, Users, Check, X, Copy } from 'lucide-react'
import { Link, useRouter } from '@/i18n/navigation'
import { EVENTS_COLLECTION, CHECKINS_COLLECTION } from '@linyup/shared'
import type { Event, EventCheckin, EventType } from '@linyup/shared'
import type { Route } from 'next'
import { ProgramTab } from '@/components/events/program/ProgramTab'
import { EventRsvpList, EventInvitationList } from '@/components/events/EventPeopleLists'
import { PLUGIN_REGISTRY } from '@/plugins/registry'
import { pluginSlot } from '@/plugins/slots'
import { DuplicateEventDialog } from '@/components/events/DuplicateEventDialog'
import { Tip } from '@/components/ui/tip'

interface Team { id: string; name: string }

const EVENT_TYPES: EventType[] = ['competition', 'camp', 'exam', 'seminar', 'workshop']

type OrgEventTab = 'overview' | 'program' | 'checkins' | 'categories' | 'rsvps' | 'invitations'

/** The team page's StatCard without the icon column — three numbers, one row. */
function OrgStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function eventTypeLabel(t: ReturnType<typeof useTranslations>, type: string): string {
  return (EVENT_TYPES as string[]).includes(type) ? t(`type_${type}` as Parameters<typeof t>[0]) : type
}

function formatDate(ts: { toDate(): Date } | null | undefined) {
  if (!ts) return '—'
  return ts.toDate().toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function useOrgEvent(eventId: string) {
  return useQuery<Event | null>({
    queryKey: ['event', eventId],
    queryFn: async () => {
      const snap = await getDoc(doc(db, EVENTS_COLLECTION, eventId))
      return snap.exists() ? ({ ...snap.data(), id: snap.id } as Event) : null
    },
  })
}

function useOrgTeams(orgId: string) {
  return useQuery<Team[]>({
    queryKey: ['org-teams-list', orgId],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(query(
        collection(db, 'teams'),
        where('org_id', '==', orgId),
      ))
      return snap.docs.map((d) => ({ id: d.id, name: d.data().name as string }))
    },
  })
}

function initials(c: { contact: { firstname: string; lastname: string } }) {
  return `${c.contact.firstname?.[0] ?? ''}${c.contact.lastname?.[0] ?? ''}`.toUpperCase() || '?'
}

export default function OrgEventDetailPage() {
  const t = useTranslations('OrgEventDetail')
  // The program tab label lives in the shared Events namespace — one key, not
  // a duplicate per surface.
  const tp = useTranslations('Events')
  // Programme + duplication copy lives in its own namespace.
  const tpp = useTranslations('EventProgram')
  const { orgId, id: eventId } = useParams<{ orgId: string; id: string }>()
  const { isAdmin, org } = useOrg()
  const qc = useQueryClient()

  const [teamFilter, setTeamFilter] = useState<string>('all')
  const [toggling, setToggling] = useState<string | null>(null)
  // PARITY WITH THE TEAM EVENT PAGE. An organisation RUNS the federation's
  // events — HMD's Fighting Cup is the case — and could previously see only the
  // programme and the check-ins, which is the half of the story that happens on
  // the day. Who accepted, who was asked and the competition categories were all
  // team-only, on events the org itself owns.
  //
  // Overview leads, as it does on the team page; check-ins keeps its own render
  // path below (it is `hidden` rather than unmounted, to hold its filter state).
  const [tab, setTab] = useState<OrgEventTab>('overview')
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const router = useRouter()

  const eventQ = useOrgEvent(eventId)
  const checkinsQ = useEventCheckins(eventId)
  const teamsQ = useOrgTeams(orgId)

  const teamMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const team of teamsQ.data ?? []) m.set(team.id, team.name)
    return m
  }, [teamsQ.data])

  const visibleCheckins = useMemo(() => {
    const all = checkinsQ.data ?? []
    return teamFilter === 'all' ? all : all.filter((c) => c.teamId === teamFilter)
  }, [checkinsQ.data, teamFilter])

  const confirmedCount = visibleCheckins.filter((c) => c.is_completed).length

  async function toggleConfirm(checkin: EventCheckin) {
    setToggling(checkin.id)
    try {
      await updateDoc(doc(db, CHECKINS_COLLECTION, checkin.id), {
        is_completed: !checkin.is_completed,
        updated_at: serverTimestamp(),
      })
      qc.invalidateQueries({ queryKey: ['event-checkins', eventId] })
    } finally {
      setToggling(null)
    }
  }

  const event = eventQ.data

  // The plugin that owns this event TYPE, resolved exactly as the team page
  // resolves it — by type id, through the slot convention, so neither page ever
  // names a plugin. `hmd-fighting-cup` is why an org needs this at all: the
  // federation runs the cup, so its categories belong in org scope too.
  const eventPlugin = PLUGIN_REGISTRY.find((p) => p.eventType?.id === event?.type)
  const showCategoriesTab = !!eventPlugin?.eventType?.hasCategories
  const CategoryManager =
    eventPlugin && showCategoriesTab
      ? pluginSlot<{ eventId: string }>(eventPlugin.id, 'CategoryManager')
      : null

  return (
    <div className="space-y-5">
      {/* Back */}
      <Link
        href={`/org/${orgId}/events` as Route}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('backToEvents')}
      </Link>

      {/* Event header */}
      {eventQ.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : !event ? (
        <p className="text-muted-foreground text-sm">{t('eventNotFound')}</p>
      ) : (
        <div className="rounded-lg border p-4 space-y-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{event.title}</h2>
              <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground flex-wrap">
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="h-3.5 w-3.5" />
                  {formatDate(event.start as { toDate(): Date } | null | undefined)}
                  {' — '}
                  {formatDate(event.end as { toDate(): Date } | null | undefined)}
                </span>
                {event.location && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5" />{event.location}
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="secondary" className="capitalize">{eventTypeLabel(t, event.type)}</Badge>
              {isAdmin && (
                <Tip label={tpp('duplicateEvent')}>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDuplicateOpen(true)}
                    aria-label={tpp('duplicateEvent')}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </Tip>
              )}
            </div>
          </div>
          {event.description && (
            <p className="text-sm text-muted-foreground pt-1">{event.description}</p>
          )}
        </div>
      )}

      {/* Tabs — an org event carries a program exactly like a team event does. */}
      {event && (
        <div className="flex gap-1 border-b">
          {([
            { key: 'overview' as const, label: tp('detail_tabOverview') },
            { key: 'program' as const, label: tp('detail_tabProgram') },
            { key: 'checkins' as const, label: t('checkinsTitle') },
            ...(showCategoriesTab
              ? [{ key: 'categories' as const, label: tp('detail_tabCategories') }]
              : []),
            {
              key: 'rsvps' as const,
              label: `${tp('detail_tabRsvps')}${event.attendees_count ? ` (${event.attendees_count})` : ''}`,
            },
            {
              key: 'invitations' as const,
              label: `${tp('detail_tabInvitations')}${event.invitations_sent_count ? ` (${event.invitations_sent_count})` : ''}`,
            },
          ]).map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === entry.key
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

      {/* Overview — the counters the event doc already carries. No publish card:
          publishing an org event is `Event.publicVisibility`, which the org
          events LIST owns, and a second control for one flag is how the two
          disagree. */}
      {event && tab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <OrgStat label={t('checkinsTitle')} value={event.participants_count ?? 0} />
            <OrgStat label={tp('detail_statsRSVP')} value={event.attendees_count ?? 0} />
            <OrgStat label={tp('detail_statsInvited')} value={event.invitations_sent_count ?? 0} />
          </div>
          {event.description ? (
            <div>
              <h3 className="text-sm font-medium mb-2">{tp('detail_fieldDescription')}</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{event.description}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">{tp('detail_noDescription')}</p>
          )}
          {/* WHO WAS IN THE ROOM. The counters above say how many; this says
              who. It renders nothing before the event has any check-ins, so an
              upcoming camp is not given three empty donuts. */}
          <EventDemographicsCard
            checkins={checkinsQ.data ?? []}
            rankingSystems={org?.ranking_systems ?? []}
            loading={checkinsQ.isLoading}
          />
        </div>
      )}

      {/* Categories — plugin-provided (hmd-fighting-cup). Resolved through the
          same slot the team page uses, so a plugin contributing one gets it in
          both scopes without either page naming it. */}
      {event && tab === 'categories' && showCategoriesTab && CategoryManager && (
        <CategoryManager eventId={eventId} />
      )}

      {/* RSVPs and invitations — the shared lists. `linkContacts` is OFF here:
          an org-wide event draws replies from every member studio, and
          `/contacts/{id}` is a studio route an org admin cannot read. */}
      {event && tab === 'rsvps' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('eventDetail_rsvpsHint')}</p>
          <EventRsvpList eventId={eventId} />
        </div>
      )}

      {event && tab === 'invitations' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('eventDetail_invitationsHint')}</p>
          <EventInvitationList eventId={eventId} />
        </div>
      )}

      {/* Program tab — the same component the team event page mounts. It reads
          teamId/orgId/scope off the event doc, so org events need no variant. */}
      {event && tab === 'program' && (
        <ProgramTab event={event} canEdit={isAdmin} />
      )}

      {/* Checkins section */}
      <div className={`space-y-3 ${event && tab !== 'checkins' ? 'hidden' : ''}`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">
              {t('checkinsTitle')}
              {checkinsQ.data && (
                <span className="ml-1.5 text-muted-foreground font-normal">
                  {t('checkinsSummary', { confirmed: confirmedCount, total: visibleCheckins.length })}
                </span>
              )}
            </span>
          </div>

          {/* Team filter */}
          {teamsQ.data && teamsQ.data.length > 1 && (
            <Select value={teamFilter} onValueChange={(v) => setTeamFilter(v ?? 'all')}>
              <SelectTrigger className="w-48 h-8 text-sm">
                <SelectValue placeholder={t('allTeams')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allTeams')}</SelectItem>
                {teamsQ.data.map((team) => (
                  <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="rounded-md border">
          {checkinsQ.isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : visibleCheckins.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center gap-2">
              <Users className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('emptyCheckins')}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5">{t('colParticipant')}</th>
                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5 hidden sm:table-cell">{t('colTeam')}</th>
                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5 hidden md:table-cell">{t('colCheckedIn')}</th>
                  <th className="text-right font-medium text-muted-foreground px-4 py-2.5">{t('colStatus')}</th>
                  {isAdmin && <th className="px-4 py-2.5 w-12" />}
                </tr>
              </thead>
              <tbody className="divide-y">
                {visibleCheckins.map((checkin) => (
                  <tr key={checkin.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary shrink-0">
                          {initials(checkin)}
                        </div>
                        <span className="font-medium">
                          {checkin.contact.firstname} {checkin.contact.lastname}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                      {/* AN UNRESOLVED CLUB IS A DASH, NOT ITS ID. The fallback
                          used to print `checkin.teamId`, which is a 20-character
                          document id and says nothing to the person reading the
                          roster — it just looks like the column is broken.
                          And it is reached often: 211 of HMD's migrated
                          check-ins carry a `teamId` that is not a club at all
                          (hmd-lineup keyed a team by its owner's uid, and these
                          point at clubs that no longer exist in it), with the
                          participant's own contact unable to name one either. So
                          the club is genuinely unknown, and the dash is the same
                          "we do not have this" the Checked-in column beside it
                          already uses. */}
                      {teamMap.get(checkin.teamId) ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell">
                      {checkin.created_at
                        ? new Date((checkin.created_at as { toDate(): Date }).toDate()).toLocaleString()
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Badge variant={checkin.is_completed ? 'default' : 'secondary'}>
                        {checkin.is_completed ? t('statusConfirmed') : t('statusPending')}
                      </Badge>
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        <Tip label={checkin.is_completed ? t('titleUnconfirm') : t('titleConfirm')}>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={toggling === checkin.id}
                            onClick={() => toggleConfirm(checkin)}
                            aria-label={checkin.is_completed ? t('titleUnconfirm') : t('titleConfirm')}
                          >
                            {checkin.is_completed
                              ? <X className="h-3.5 w-3.5 text-muted-foreground" />
                              : <Check className="h-3.5 w-3.5 text-green-600" />}
                          </Button>
                        </Tip>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {event && (
        <DuplicateEventDialog
          open={duplicateOpen}
          onOpenChange={setDuplicateOpen}
          event={event}
          onDuplicated={(newId) => router.push(`/org/${orgId}/events/${newId}` as Route)}
        />
      )}
    </div>
  )
}
