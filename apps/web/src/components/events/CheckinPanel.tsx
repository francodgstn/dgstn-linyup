'use client'

import { useState, useMemo, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  collection, query, where, getDocs, updateDoc, doc, serverTimestamp, orderBy,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useEventCheckins as useCheckins } from '@/hooks/useEventCheckins'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { SearchInput, useListKeyboardNav } from '@/components/ui/search-input'
import { cn } from '@/lib/utils'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Check, Search, Download, UserPlus, ClipboardList, Loader2 } from 'lucide-react'
import {
  CONTACTS_COLLECTION, CHECKINS_COLLECTION, TEAMS_COLLECTION, EVENT_TYPES_SUBCOLLECTION,
  isCheckinCompleted,
  personInitials,
} from '@linyup/shared'
import type {
  Contact, EventCheckin, RankingSystem, EventType, EventTypeConfig, EventTypeField, Team,
} from '@linyup/shared'
import { GenericCheckinForm } from './forms/GenericCheckinForm'
import { CampCheckinForm } from './forms/CampCheckinForm'
import { ExamCheckinForm } from './forms/ExamCheckinForm'
import { PLUGIN_REGISTRY } from '@/plugins/registry'
import { pluginSlot } from '@/plugins/slots'
import type { ComponentType } from 'react'
import { Tip } from '@/components/ui/tip'

interface PluginCheckinFormProps {
  contact: Contact
  eventId: string
  existing?: Record<string, unknown>
  onSubmit: (data: Record<string, unknown>) => void
  onCancel: () => void
  busy?: boolean
}

type MinContact = { id: string; firstname: string; lastname: string }

// ─── helpers ──────────────────────────────────────────────────────────────────

function exportCsv(t: ReturnType<typeof useTranslations>, checkins: EventCheckin[], eventTitle: string) {
  const rows: string[][] = [[
    t('csvHeaderFirstName'), t('csvHeaderLastName'), t('csvHeaderStatus'), t('csvHeaderCheckedInAt'),
  ]]
  for (const c of checkins) {
    const at = c.created_at
      ? new Date((c.created_at as { toDate(): Date }).toDate()).toLocaleString()
      : ''
    rows.push([
      c.contact.firstname,
      c.contact.lastname,
      c.is_completed ? t('statusConfirmed') : t('statusPending'),
      at,
    ])
  }
  const csv = rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${eventTitle.replace(/[^a-z0-9]/gi, '_')}_checkins.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── form type router ─────────────────────────────────────────────────────────

type FormType = 'generic' | 'camp' | 'exam' | { pluginId: string; eventTypeId: string }

function resolveFormType(eventType: EventType): FormType {
  const plugin = PLUGIN_REGISTRY.find((p) => p.eventType?.id === eventType)
  if (plugin?.eventType?.hasCheckinForm) return { pluginId: plugin.id, eventTypeId: plugin.eventType.id }
  if (eventType === 'camp') return 'camp'
  if (eventType === 'exam') return 'exam'
  return 'generic'
}

/**
 * A team-authored event type may carry its OWN check-in fields
 * (`EventTypeConfig.checkin_fields`, built in Settings → Event types). This
 * router never saw them, so a studio could design a check-in form and then find
 * an empty sheet at the door.
 *
 * There is deliberately no arm above for them: those documents get Firestore
 * auto-ids, so a custom type is never a built-in slug and never a plugin's
 * event type id — it always lands on 'generic', which is why the fields ride ON
 * the generic form as a prop instead of becoming a fourth component.
 */
function customCheckinFields(
  formType: FormType,
  eventType: EventType,
  eventTypes: EventTypeConfig[],
): EventTypeField[] | undefined {
  if (formType !== 'generic') return undefined
  const fields = eventTypes.find((cfg) => cfg.id === eventType)?.checkin_fields
  return fields && fields.length > 0 ? fields : undefined
}

// ─── data hooks ───────────────────────────────────────────────────────────────

/**
 * The team's own event types, WITH their `checkin_fields`.
 *
 * `useEventTypes` reads the same documents but flattens them into a picker
 * shape that drops the fields, so this reads them again — under that hook's
 * cache key, with the same query and the same result type, so the two share one
 * fetch rather than each paying for their own.
 */
function useTeamEventTypes(teamId: string | null) {
  return useQuery<EventTypeConfig[]>({
    queryKey: ['event-types', teamId],
    enabled: !!teamId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(query(
        collection(db, TEAMS_COLLECTION, teamId, EVENT_TYPES_SUBCOLLECTION),
        orderBy('name'),
      ))
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as EventTypeConfig)
    },
  })
}

function useOrgTeams(orgId: string | undefined, enabled: boolean) {
  return useQuery<Pick<Team, 'id' | 'name'>[]>({
    queryKey: ['org-teams', orgId],
    enabled: !!orgId && enabled,
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

// ─── add checkin dialog ───────────────────────────────────────────────────────
// Loads contacts lazily — only when the dialog is open.

/**
 * Admit people to an event — several at once.
 *
 * ── WHY THIS ADMITS RATHER THAN COMPLETES ────────────────────────────────────
 * Picking a contact used to open the check-in form immediately, so a queue of
 * twenty at a competition desk was twenty rounds of search → click → fill a form
 * → submit, with the queue waiting through every form.
 *
 * That is the wrong order for a door. Getting people IN is the urgent part;
 * their belt, weight or division is paperwork that can follow. So this dialog
 * writes a BASE check-in for everyone picked — `checkinData: {}` — and each is
 * finalised individually afterwards by tapping its row, which opens the same
 * form it always did.
 *
 * ── AND FOR SOME EVENT TYPES THERE IS NOTHING TO FINALISE ────────────────────
 * `is_completed` is not ours to assert: the server derives it from the SAME
 * `isCheckinCompleted(eventType, checkinData)` this file imports. With empty
 * data that is `false` for `exam`, `camp` and the plugin types — which do
 * collect something — and `true` for `competition`, `seminar` and `workshop`,
 * which collect nothing at all.
 *
 * That is the right answer rather than a gap: an event type with no form has no
 * second step, so those people are done the moment they are admitted. It is why
 * the footer note is conditional — promising "fill in their details afterwards"
 * on a seminar would point at a screen that does not exist.
 *
 * Nothing on the server changed: `is_completed`, the pending count and the
 * per-row form were already the model. This only stops the door waiting on the
 * paperwork.
 */
function AddCheckinDialog({
  teamId,
  eventType,
  hasCheckinFields,
  checkedInIds,
  onAdd,
  onClose,
}: {
  teamId: string
  /** Decides whether a base check-in leaves anything to finalise — see below. */
  eventType: EventType
  /** True when the event type's own authored fields give it a second step that
   *  `isCheckinCompleted` cannot see. */
  hasCheckinFields: boolean
  checkedInIds: Set<string>
  /** Writes a base (incomplete) check-in for each contact. */
  onAdd: (contacts: Contact[]) => Promise<void>
  onClose: () => void
}) {
  const t = useTranslations('CheckinPanel')
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  // ArrowDown out of the search field lands on the first row; ArrowUp off the
  // first row comes back. See useListKeyboardNav.
  const searchRef = useRef<HTMLInputElement>(null)
  const { listRef, focusFirst, onListKeyDown } = useListKeyboardNav<HTMLDivElement>(searchRef)

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const contactsQ = useQuery<Contact[]>({
    queryKey: ['contacts', 'active', teamId],
    enabled: !!teamId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(query(
        collection(db, CONTACTS_COLLECTION),
        where('teamId', '==', teamId),
        where('deleted_at', '==', null),
        where('archived_at', '==', null),
        orderBy('lastname'),
        orderBy('firstname'),
      ))
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Contact)
    },
  })

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (contactsQ.data ?? [])
      .filter((c) => !checkedInIds.has(c.id))
      .filter((c) =>
        !q ||
        `${c.firstname} ${c.lastname}`.toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q),
      )
  }, [contactsQ.data, checkedInIds, search])

  async function commit() {
    const chosen = (contactsQ.data ?? []).filter((c) => picked.has(c.id))
    if (chosen.length === 0) return
    setAdding(true)
    try {
      await onAdd(chosen)
      onClose()
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      {/* FIXED HEIGHT, NOT MAX-HEIGHT — the search field must not move.
          `DialogBody` alone gives a max-height, so the popup grew and shrank
          with the result count; and because a desktop dialog is CENTRED
          (-translate-y-1/2), a changing height moves the TOP edge, so the
          search box climbed and dropped on every keystroke while being typed
          into. A fixed height makes the list the only thing that changes.

          Two values, one rule: on a phone, fill the screen the dialog is
          already pinned to the top of (see the max-sm rule in ui/dialog.tsx);
          on desktop, hold roughly the 18rem of list this had before
          `DialogBody` replaced its own `max-h-72` scroller. */}
      <DialogContent className="sm:max-w-md h-[calc(100dvh-2rem)] sm:h-[32rem]">
        <DialogHeader>
          <DialogTitle>{t('addCheckinDialogTitle')}</DialogTitle>
        </DialogHeader>

        <div className="mb-3">
          <SearchInput
            placeholder={t('searchContactsPlaceholder')}
            value={search}
            onValueChange={setSearch}
            inputRef={searchRef}
            onArrowDown={focusFirst}
            autoFocus
          />
        </div>

        <DialogBody ref={listRef} onKeyDown={onListKeyDown} className="rounded-lg border divide-y p-0">
          {contactsQ.isLoading && (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                <Skeleton className="h-3.5 w-36" />
              </div>
            ))
          )}
          {!contactsQ.isLoading && visible.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {search ? t('noContactsMatch') : t('allContactsCheckedIn')}
            </p>
          )}
          {!contactsQ.isLoading && visible.map((c) => {
            const isPicked = picked.has(c.id)
            return (
              <button
                key={c.id}
                type="button"
                data-list-row
                onClick={() => toggle(c.id)}
                aria-pressed={isPicked}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-3 transition-colors text-left',
                  isPicked ? 'bg-primary/5' : 'hover:bg-muted/50',
                )}
              >
                <span
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                    isPicked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                  )}
                >
                  {isPicked && <Check className="h-3 w-3" />}
                </span>
                <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold shrink-0">
                  {personInitials(c)}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{c.firstname} {c.lastname}</p>
                  {c.email && <p className="text-xs text-muted-foreground truncate">{c.email}</p>}
                </div>
              </button>
            )
          })}
        </DialogBody>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col sm:items-stretch">
          {/* Said before the click, not discovered after it.
              THE PROMISE IS CONDITIONAL, because the outcome is: an empty
              `checkinData` runs through the SAME `isCheckinCompleted` the server
              uses, and for an event type that collects nothing (competition,
              seminar, workshop) that returns true — those people are simply
              done, and there is no second step to send them to. Only exam, camp
              and the plugin types leave anything to finalise. Printing "fill in
              their details afterwards" on a seminar would describe a screen that
              does not exist.

              A team-authored type is the one case the predicate cannot answer:
              its fields live in the tenant's configuration, so `isCheckinCompleted`
              auto-confirms it and would hide a note that IS true. Hence the
              second term — see the note on `customFields` below. */}
          {(!isCheckinCompleted(eventType, {}) || hasCheckinFields) && (
            <p className="text-xs text-muted-foreground">{t('addCheckinBaseNote')}</p>
          )}
          <Button onClick={commit} disabled={picked.size === 0 || adding}>
            {adding && <Loader2 className="h-4 w-4 animate-spin" />}
            {picked.size === 0
              ? t('addCheckinConfirm')
              : t('addCheckinConfirmCount', { count: picked.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── component ────────────────────────────────────────────────────────────────

export function CheckinPanel({
  eventId,
  eventTitle,
  eventType,
  eventDate = '',
  rankingSystems = [],
  orgId,
}: {
  eventId: string
  eventTitle: string
  eventType: EventType
  eventDate?: string
  rankingSystems?: RankingSystem[]
  orgId?: string
}) {
  const t = useTranslations('CheckinPanel')
  const { currentTeamId, isOrgAdmin } = useAuth()
  const qc = useQueryClient()

  const [search, setSearch] = useState('')
  // sheetTarget: the contact + optional existing checkin shown in the side sheet
  const [sheetTarget, setSheetTarget] = useState<{
    contact: MinContact
    existing?: EventCheckin
    teamId: string
  } | null>(null)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  // selectedAddTeamId: which team's contacts to pick from when adding (org admins can switch)
  const [selectedAddTeamId, setSelectedAddTeamId] = useState<string>(currentTeamId ?? '')
  const [busy, setBusy] = useState(false)

  const { data: checkins = [], isLoading } = useCheckins(eventId)

  // Org teams — only queried for org admins with an orgId
  const orgTeamsQ = useOrgTeams(orgId, isOrgAdmin)
  const showTeamSelector = isOrgAdmin && (orgTeamsQ.data?.length ?? 0) > 1

  const checkedInIds = useMemo(() => new Set(checkins.map((c) => c.contact.id)), [checkins])

  const filteredCheckins = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return checkins
    return checkins.filter((c) =>
      `${c.contact.firstname} ${c.contact.lastname}`.toLowerCase().includes(q),
    )
  }, [checkins, search])

  const formType = resolveFormType(eventType)

  // A team-authored event type's own check-in fields — see customCheckinFields.
  //
  // NOTE: `isCheckinCompleted` (@linyup/shared) has no arm for these, and its
  // default arm auto-confirms, so a custom-field check-in is CONFIRMED the
  // moment it is written whether or not the fields were filled. Required fields
  // are enforced by the form, not by completion. Making completion depend on
  // them means teaching that predicate about tenant configuration — it runs on
  // the server too, where it is handed only the event type slug and the data —
  // so it needs a plugin/tenant hook in shared, which is a change of its own.
  const { data: teamEventTypes = [] } = useTeamEventTypes(currentTeamId ?? null)
  const customFields = useMemo(
    () => customCheckinFields(formType, eventType, teamEventTypes),
    [formType, eventType, teamEventTypes],
  )

  const PluginCheckinForm = useMemo((): ComponentType<PluginCheckinFormProps> | null => {
    if (typeof formType === 'object') {
      return pluginSlot<PluginCheckinFormProps>(formType.pluginId, 'CheckinForm')
    }
    return null
  }, [formType])

  // Plugin-provided lineup exports (e.g. fighting cup PDF + competitors CSV).
  // Replaces the generic CSV button when the event type declares export support.
  const exportPlugin = useMemo(
    () =>
      PLUGIN_REGISTRY.find(
        (p) =>
          p.eventType?.id === eventType &&
          (p.eventType.hasPdfExport || p.eventType.hasCsvExport),
      ),
    [eventType],
  )

  const PluginExports = useMemo((): ComponentType<{
    eventId: string
    eventTitle: string
    eventDate: string
    checkins: EventCheckin[]
  }> | null => {
    if (!exportPlugin) return null
    return pluginSlot(exportPlugin.id, 'Exports')
  }, [exportPlugin])

  const invalidate = () => qc.invalidateQueries({ queryKey: ['event-checkins', eventId] })

  async function handleSubmit(data: Record<string, unknown>) {
    if (!sheetTarget) return
    setBusy(true)
    try {
      const fn = httpsCallable<unknown, { id: string; is_completed: boolean }>(
        functions, 'addEventCheckin',
      )
      // No `contact` payload: the callable reads the stored contact itself, so
      // the name on a check-in cannot be whatever the client felt like sending.
      await fn({
        eventId,
        contactId: sheetTarget.contact.id,
        checkinData: data,
        checkinTeamId: sheetTarget.teamId,
      })
      await invalidate()
      setSheetTarget(null)
    } catch (err) {
      // A refusal used to close the sheet as though it had saved.
      toast.error(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Admit everyone picked, as BASE check-ins — `checkinData: {}`, which
   * `addEventCheckin` resolves to `is_completed: false`. They appear in the
   * pending list and are finalised one at a time from there.
   *
   * `allSettled`, not `all`: one contact failing (a permission edge on an org
   * event, a dropped request) must not discard the twenty that succeeded, and
   * the roster refresh below shows exactly who got in. The callable is
   * idempotent per (event, contact), so a retry of a partial run is safe.
   *
   * BUT THE REJECTIONS ARE READ. They used to be discarded unexamined, so a
   * refusal for all twenty produced an unchanged roster and no message at all —
   * indistinguishable from a slow refresh. The first reason is shown, because
   * twenty rejections from one batch are twenty copies of the same cause.
   */
  async function handleAddBaseCheckins(chosen: Contact[]) {
    const fn = httpsCallable<unknown, { id: string; is_completed: boolean }>(
      functions, 'addEventCheckin',
    )
    const teamIdForCheckin = selectedAddTeamId || currentTeamId || ''
    const results = await Promise.allSettled(
      chosen.map((c) =>
        fn({
          eventId,
          contactId: c.id,
          checkinData: {},
          checkinTeamId: teamIdForCheckin,
        }),
      ),
    )
    await invalidate()

    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    if (failed.length > 0) {
      const reason = failed[0].reason
      const detail = reason instanceof Error ? reason.message : String(reason)
      toast.error(t('addFailed', { count: failed.length, total: chosen.length, detail }))
    }
  }

  async function toggleComplete(checkin: EventCheckin, e: React.MouseEvent) {
    e.stopPropagation()
    await updateDoc(doc(db, CHECKINS_COLLECTION, checkin.id), {
      is_completed: !checkin.is_completed,
      updated_at: serverTimestamp(),
    })
    invalidate()
  }

  const confirmedCount = checkins.filter((c) => c.is_completed).length
  const pendingCount = checkins.length - confirmedCount

  return (
    <div className="space-y-4">
      {/* Summary bar — sticky so "Add checkin" stays visible while list scrolls.
          `top-14` on mobile clears the sticky app header (see MobileHeader). */}
      <div className="sticky top-14 md:top-0 z-10 bg-background py-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{t.rich('checkinsCount', { count: checkins.length, strong: (chunks) => <strong className="text-foreground">{chunks}</strong> })}</span>
          {confirmedCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
              {t.rich('confirmedCount', { count: confirmedCount, strong: (chunks) => <strong className="text-foreground">{chunks}</strong> })}
            </span>
          )}
          {pendingCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
              {t.rich('pendingCount', { count: pendingCount, strong: (chunks) => <strong className="text-foreground">{chunks}</strong> })}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {PluginExports ? (
            <PluginExports
              eventId={eventId}
              eventTitle={eventTitle}
              eventDate={eventDate}
              checkins={checkins}
            />
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportCsv(t, checkins, eventTitle)}
              disabled={checkins.length === 0}
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              {t('exportCsvButton')}
            </Button>
          )}
          <Button size="sm" onClick={() => setAddDialogOpen(true)}>
            <UserPlus className="h-3.5 w-3.5 mr-1.5" />
            {t('addCheckinButton')}
          </Button>
        </div>
      </div>

      {/* Org team selector — visible to org admins when event has multiple teams */}
      {showTeamSelector && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground shrink-0">{t('showingTeamLabel')}</span>
          <Select value={selectedAddTeamId} onValueChange={(v) => { if (v) setSelectedAddTeamId(v) }}>
            <SelectTrigger className="h-8 text-xs w-48">
              <SelectValue placeholder={orgTeamsQ.data?.find((team) => team.id === selectedAddTeamId)?.name ?? selectedAddTeamId}>
                {orgTeamsQ.data?.find((team) => team.id === selectedAddTeamId)?.name ?? selectedAddTeamId}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {orgTeamsQ.data?.map((team) => (
                <SelectItem key={team.id} value={team.id} className="text-xs">{team.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Search */}
      {checkins.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t('searchCheckinsPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {/* Checkins list — only contacts with a checkin record */}
      {isLoading && (
        <div className="rounded-xl border overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b last:border-0">
              <Skeleton className="h-9 w-9 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && checkins.length === 0 && (
        <div className="py-16 flex flex-col items-center gap-3 text-muted-foreground">
          <ClipboardList className="h-8 w-8 opacity-30" />
          <p className="text-sm">{t('noCheckinsYet')}</p>
          <Button size="sm" variant="outline" onClick={() => setAddDialogOpen(true)}>
            <UserPlus className="h-3.5 w-3.5 mr-1.5" />
            {t('addFirstCheckinButton')}
          </Button>
        </div>
      )}

      {!isLoading && filteredCheckins.length > 0 && (
        <div className="rounded-xl border overflow-hidden">
          {filteredCheckins.map((checkin) => (
            <div
              key={checkin.id}
              className="flex items-center gap-3 px-4 py-3 border-b last:border-0 hover:bg-muted/40 transition-colors cursor-pointer"
              onClick={() => setSheetTarget({
                contact: checkin.contact,
                existing: checkin,
                teamId: checkin.teamId,
              })}
            >
              {/* Avatar */}
              <div className={`h-9 w-9 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0 ${
                checkin.is_completed ? 'bg-green-500' : 'bg-amber-400'
              }`}>
                <Check className="h-4 w-4" />
              </div>

              {/* Name */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {checkin.contact.firstname} {checkin.contact.lastname}
                </p>
                {checkin.teamId && checkin.teamId !== currentTeamId && (
                  <p className="text-xs text-muted-foreground truncate">
                    {orgTeamsQ.data?.find((team) => team.id === checkin.teamId)?.name ?? checkin.teamId}
                  </p>
                )}
              </div>

              {/* Status + confirm toggle */}
              <div className="shrink-0 flex items-center gap-2">
                {checkin.is_completed ? (
                  <Badge variant="default" className="text-xs bg-green-600 hover:bg-green-600">{t('statusConfirmed')}</Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs text-amber-600 border-amber-200 bg-amber-50">{t('statusPending')}</Badge>
                )}
                <Tip label={checkin.is_completed ? t('markPending') : t('markConfirmed')}>
                  <button
                    onClick={(e) => toggleComplete(checkin, e)}
                    className={`p-1.5 rounded-full border transition-colors ${
                      checkin.is_completed
                        ? 'bg-green-600 text-white border-green-600'
                        : 'border-border hover:bg-muted'
                    }`}
                    aria-label={checkin.is_completed ? t('markPending') : t('markConfirmed')}
                  >
                    <Check className="h-3 w-3" />
                  </button>
                </Tip>
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && filteredCheckins.length === 0 && checkins.length > 0 && (
        <p className="text-sm text-muted-foreground text-center py-6">{t('noCheckinsMatchSearch')}</p>
      )}

      {/* Add checkin dialog */}
      {addDialogOpen && currentTeamId && (
        <AddCheckinDialog
          teamId={selectedAddTeamId || currentTeamId}
          eventType={eventType}
          hasCheckinFields={!!customFields}
          checkedInIds={checkedInIds}
          onAdd={handleAddBaseCheckins}
          onClose={() => setAddDialogOpen(false)}
        />
      )}

      {/* Checkin form sheet */}
      <Sheet open={!!sheetTarget} onOpenChange={(o) => { if (!o) setSheetTarget(null) }}>
        <SheetContent side="right" className="w-full sm:max-w-md px-6">
          <SheetHeader className="mb-4">
            <SheetTitle>{sheetTarget?.existing ? t('sheetTitleUpdate') : t('sheetTitleAdd')}</SheetTitle>
            {sheetTarget && (
              <p className="text-sm text-muted-foreground">
                {sheetTarget.contact.firstname} {sheetTarget.contact.lastname}
              </p>
            )}
          </SheetHeader>

          {sheetTarget && (
            <>
              {formType === 'generic' && (
                <GenericCheckinForm
                  contact={sheetTarget.contact}
                  existing={sheetTarget.existing?.checkin_data}
                  fields={customFields}
                  onSubmit={handleSubmit}
                  onCancel={() => setSheetTarget(null)}
                  busy={busy}
                />
              )}
              {formType === 'camp' && (
                <CampCheckinForm
                  contact={sheetTarget.contact}
                  existing={sheetTarget.existing?.checkin_data}
                  onSubmit={handleSubmit}
                  onCancel={() => setSheetTarget(null)}
                  busy={busy}
                />
              )}
              {formType === 'exam' && (
                <ExamCheckinForm
                  contact={sheetTarget.contact}
                  rankingSystems={rankingSystems}
                  existing={sheetTarget.existing?.checkin_data}
                  onSubmit={handleSubmit}
                  onCancel={() => setSheetTarget(null)}
                  busy={busy}
                />
              )}
              {typeof formType === 'object' && PluginCheckinForm && (
                <PluginCheckinForm
                  contact={sheetTarget.contact as Contact}
                  eventId={eventId}
                  existing={sheetTarget.existing?.checkin_data}
                  onSubmit={handleSubmit}
                  onCancel={() => setSheetTarget(null)}
                  busy={busy}
                />
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
