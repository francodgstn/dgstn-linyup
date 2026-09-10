'use client'

import { PageHeader } from '@/components/layout/PageHeader'
import type { Route } from 'next'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  collection, getDocs, query, where, collectionGroup,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { statusBadgeClass, statusFillClass } from '@/lib/affiliationStatusColors'
import { liveContactConstraints } from '@/lib/liveContacts'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useOrg } from '@/contexts/OrgContext'
import {
  ORGANIZATIONS_COLLECTION, ORG_TEAMS_SUBCOLLECTION,
  CONTACTS_COLLECTION, ORG_AFFILIATION_STATUSES_SUBCOLLECTION,
  DEFAULT_ORG_AFFILIATION_STATUSES, AFFILIATION_TYPES_SUBCOLLECTION, CONTACT_AFFILIATIONS_SUBCOLLECTION,
} from '@linyup/shared'
import type { Contact, OrgAffiliationStatusDef, Affiliation, AffiliationType } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/ui/search-input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import {  } from 'lucide-react'
import { renewAffiliationCall } from '@/components/affiliations/renew'
import { AffiliationBulkBar, RenewConfirmDialog } from '@/components/affiliations/RenewUI'
import {
  NO_AFFILIATION,
  RemoveAffiliationButton,
  RemoveConfirmDialog,
  removeAffiliationCall,
} from '@/components/affiliations/remove'

// ─── colour map ───────────────────────────────────────────────────────────────


// ─── types ────────────────────────────────────────────────────────────────────

interface TeamMeta { id: string; name: string }
interface ContactRow extends Contact { teamName?: string }

// ─── data hooks ───────────────────────────────────────────────────────────────

function useOrgTeamIds(orgId: string) {
  return useQuery<TeamMeta[]>({
    queryKey: ['org-teams-meta', orgId],
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_TEAMS_SUBCOLLECTION),
          where('status', '==', 'active'),
        ),
      )
      const rows = snap.docs.map((d) => ({ id: d.data().teamId as string, name: '' }))
      await Promise.all(
        rows.map(async (row) => {
          const teamSnap = await getDocs(query(collection(db, 'teams'), where('__name__', '==', row.id)))
          if (!teamSnap.empty) row.name = teamSnap.docs[0].data().name ?? row.id
        }),
      )
      return rows
    },
    staleTime: 5 * 60_000,
  })
}

/**
 * THE PEOPLE ON THIS ORGANISATION'S BOOKS — and deliberately not the member
 * studios' contact lists, which this page used to download whole.
 *
 * `affiliation_summary.org_ids` array-contains THIS org: the contact holds an
 * affiliation the organisation issued, in ANY status. Someone a studio looks
 * after who has never been put on the federation's books does not appear here
 * at all, and since `orgAdminMayReadContact` they cannot be read either — so
 * this filter is not a courtesy, it is what keeps the query from being denied
 * document by document. See `docs/org-contact-visibility.md`.
 *
 * `org_ids` and NOT `active_org_ids`: an expired or merely requested licence is
 * precisely what an administrator opens this page to chase. The status columns
 * do the narrowing; the query must not.
 *
 * WHERE SOMEBODY IS ADDED TO THE BOOKS IS THE STUDIO'S PAGE, not this one, and
 * that was already true before the filter: `upsertAffiliation` opens with
 * `assertManager(uid, teamId)` on the STUDIO, so an org admin who is not also a
 * manager there has never been able to create the first row. This page manages
 * the affiliations that exist.
 */
function useOrgContacts(orgId: string, teams: TeamMeta[] | undefined) {
  const teamIds = teams?.map((t) => t.id) ?? []
  return useQuery<ContactRow[]>({
    queryKey: ['org-contacts', orgId, teamIds],
    enabled: teamIds.length > 0,
    staleTime: 2 * 60_000,
    queryFn: async () => {
      const teamNameById = Object.fromEntries((teams ?? []).map((t) => [t.id, t.name]))
      const results: ContactRow[] = []
      const chunks: string[][] = []
      for (let i = 0; i < teamIds.length; i += 30) chunks.push(teamIds.slice(i, i + 30))
      await Promise.all(
        chunks.map(async (chunk) => {
          // LIVE CONTACTS ONLY. `deleted_at` alone let ARCHIVED people — the
          // ones who left — into the federation's roster and into the two
          // counts beside its filters. Same omission the org dashboard shipped
          // with; the pair now has one owner (lib/liveContacts.ts).
          const snap = await getDocs(
            query(
              collection(db, CONTACTS_COLLECTION),
              where('teamId', 'in', chunk),
              ...liveContactConstraints(),
              where('affiliation_summary.org_ids', 'array-contains', orgId),
            ),
          )
          snap.docs.forEach((d) => {
            const data = { ...d.data(), id: d.id } as ContactRow
            data.teamName = teamNameById[data.teamId] ?? data.teamId
            results.push(data)
          })
        }),
      )
      return results.sort((a, b) =>
        `${a.lastname ?? ''} ${a.firstname ?? ''}`.localeCompare(`${b.lastname ?? ''} ${b.firstname ?? ''}`),
      )
    },
  })
}

function useStatusDefs(orgId: string) {
  return useQuery<OrgAffiliationStatusDef[]>({
    queryKey: ['org-membership-statuses', orgId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const snap = await getDocs(
        collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_AFFILIATION_STATUSES_SUBCOLLECTION),
      )
      if (snap.empty) return DEFAULT_ORG_AFFILIATION_STATUSES
      const defs = snap.docs.map((d) => ({ ...d.data(), id: d.id } as OrgAffiliationStatusDef))
      const byId = Object.fromEntries(DEFAULT_ORG_AFFILIATION_STATUSES.map((s) => [s.id, s]))
      defs.forEach((d) => { byId[d.id] = d })
      return Object.values(byId).sort((a, b) => a.order - b.order)
    },
  })
}

function useOrgAffiliationTypes(orgId: string) {
  return useQuery<AffiliationType[]>({
    queryKey: ['org-affiliation-types', orgId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const snap = await getDocs(
        collection(db, ORGANIZATIONS_COLLECTION, orgId, AFFILIATION_TYPES_SUBCOLLECTION),
      )
      return snap.docs
        .map((d) => ({ ...d.data(), id: d.id } as AffiliationType))
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    },
  })
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatExpiry(ts: { toDate(): Date } | null | undefined, fallback: string) {
  if (!ts) return fallback
  return ts.toDate().toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
}

function contactName(c: Contact) {
  return [c.firstname, c.lastname].filter(Boolean).join(' ') || '—'
}

// An affiliation is "expiring soon" if it's currently active and its validity ends
// within the next 30 days — the target set for a renewal-season bulk renew.
const EXPIRING_WINDOW_DAYS = 30
function isExpiringSoon(aff: Affiliation | undefined): boolean {
  if (!aff?.active || !aff.valid_until) return false
  const until = (aff.valid_until as unknown as { toDate(): Date }).toDate().getTime()
  return until <= Date.now() + EXPIRING_WINDOW_DAYS * 86_400_000
}

// ─── status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ statusId, defs }: { statusId: string; defs: OrgAffiliationStatusDef[] }) {
  const t = useTranslations('OrgAffiliations')
  // Reachable only in theory on this page — the roster now asks for contacts
  // that hold one of this org's affiliations, so every row has a status. Kept
  // because a query and a render should not have to agree for the screen to be
  // truthful, and because falling back to `guest` (as it did) would relabel an
  // unknown status rather than admit it.
  if (statusId === NO_AFFILIATION) {
    return <span className="text-xs text-muted-foreground">{t('statusNone')}</span>
  }
  const def = defs.find((s) => s.id === statusId)
  if (!def) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(def.color)}`}>
      {def.label}
    </span>
  )
}

// ─── affiliation summary chip ─────────────────────────────────────────────────

function AffiliationSummaryChip({ contact, affiliationTypes }: { contact: Contact; affiliationTypes: AffiliationType[] }) {
  const summary = contact.affiliation_summary
  if (!summary?.has_active) return <span className="text-xs text-muted-foreground">—</span>
  const labels = (summary.types ?? []).map(
    (key) => affiliationTypes.find((t) => t.key === key)?.label ?? key,
  )
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((l) => (
        <span key={l} className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass('green')}`}>
          {l}
        </span>
      ))}
    </div>
  )
}

// ─── expiration dialog ────────────────────────────────────────────────────────

function ExpirationDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean
  onConfirm: (date: Date | null) => void
  onCancel: () => void
}) {
  const t = useTranslations('OrgAffiliations')
  const [value, setValue] = useState('')

  function handleConfirm() {
    onConfirm(value ? new Date(value) : null)
    setValue('')
  }
  function handleCancel() {
    setValue('')
    onCancel()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleCancel() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('expirationDialogTitle')}</DialogTitle>
          <DialogDescription>{t('expirationDialogDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label htmlFor="exp-date">{t('expirationLabel')}</Label>
          <Input
            id="exp-date"
            type="date"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>{t('cancel')}</Button>
          <Button onClick={handleConfirm}>{t('expirationSave')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── contact row ──────────────────────────────────────────────────────────────

function ContactAffiliationRow({
  contact,
  affiliation,
  defs,
  isAdmin,
  orgId,
  affiliationTypeId,
  onUpdated,
  selectable,
  selected,
  onToggleSelect,
}: {
  contact: ContactRow
  affiliation: Affiliation | undefined
  defs: OrgAffiliationStatusDef[]
  isAdmin: boolean
  orgId: string
  affiliationTypeId: string
  onUpdated: () => void
  selectable: boolean
  selected: boolean
  onToggleSelect: (checked: boolean) => void
}) {
  const t = useTranslations('OrgAffiliations')
  const currentStatusId = affiliation?.status_id ?? NO_AFFILIATION
  const [pending, setPending] = useState<string | null>(null)
  const [showExpiry, setShowExpiry] = useState(false)
  const [showRemove, setShowRemove] = useState(false)

  const upsertAffiliation = httpsCallable(functions, 'upsertAffiliation')

  const { mutate: saveAffiliation, isPending: saving } = useMutation({
    mutationFn: async ({ statusId, validUntil }: { statusId: string; validUntil?: string | null }) => {
      await upsertAffiliation({
        teamId: contact.teamId,
        contactId: contact.id,
        affiliationId: affiliation?.id,
        affiliation_type_id: affiliationTypeId,
        issuer: 'org',
        org_id: orgId,
        status_id: statusId,
        valid_until: validUntil ?? null,
      })
    },
    onSuccess: onUpdated,
  })

  // Removing the row is what takes the person off this federation's books, and
  // off its roster — see `components/affiliations/remove.tsx`. Gated the same way
  // every write on this page is: `removeAffiliation` runs `affiliationWriteAllowed`,
  // which requires studio-manager rights, so an org admin who is not also staff
  // at the studio is refused server-side exactly as they are for a status change.
  const { mutate: removeAffiliation, isPending: removing } = useMutation({
    mutationFn: async () => {
      if (!affiliation) return
      await removeAffiliationCall({
        teamId: contact.teamId,
        contactId: contact.id,
        affiliationId: affiliation.id,
      })
    },
    onSuccess: () => {
      setShowRemove(false)
      onUpdated()
    },
  })

  function handleStatusChange(statusId: string | null) {
    if (!statusId) return
    const def = defs.find((s) => s.id === statusId)
    if (!def) return
    if (def.countsAsActive) {
      setPending(statusId)
      setShowExpiry(true)
    } else {
      saveAffiliation({ statusId, validUntil: null })
    }
  }

  return (
    <>
      <tr className="border-b last:border-0 hover:bg-muted/20 transition-colors">
        <td className="px-2 py-3 w-8">
          {selectable && (
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => onToggleSelect(e.target.checked)}
              className="h-4 w-4 rounded border-input accent-primary align-middle"
            />
          )}
        </td>
        <td className="px-4 py-3">
          <div className="font-medium text-sm">{contactName(contact)}</div>
          {contact.email && (
            <div className="text-xs text-muted-foreground truncate max-w-[200px]">{contact.email}</div>
          )}
        </td>
        <td className="px-4 py-3 text-sm text-muted-foreground hidden sm:table-cell">
          {contact.teamName ?? '—'}
        </td>
        <td className="px-4 py-3">
          {isAdmin ? (
            <Select value={currentStatusId} onValueChange={handleStatusChange} disabled={saving}>
              <SelectTrigger className="h-7 w-[160px] text-xs border-0 bg-transparent p-0 shadow-none focus:ring-0 hover:bg-muted rounded px-2">
                <SelectValue>
                  <StatusBadge statusId={currentStatusId} defs={defs} />
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {defs.map((s) => (
                  <SelectItem key={s.id} value={s.id} textValue={s.label}>
                    <div className="flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 rounded-full ${statusFillClass(s.color)}`} />
                      <span>{s.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <StatusBadge statusId={currentStatusId} defs={defs} />
          )}
        </td>
        <td className="px-2 py-3 w-8">
          {isAdmin && affiliation && (
            <RemoveAffiliationButton
              label={t('removeAction')}
              onClick={() => setShowRemove(true)}
              disabled={removing || saving}
            />
          )}
        </td>
        <td className="px-4 py-3 text-sm text-muted-foreground hidden md:table-cell">
          {affiliation?.valid_until
            ? formatExpiry(affiliation.valid_until as { toDate(): Date }, t('noExpiration'))
            : t('noExpiration')}
        </td>
      </tr>
      <ExpirationDialog
        open={showExpiry}
        onConfirm={(date) => {
          setShowExpiry(false)
          if (pending) saveAffiliation({ statusId: pending, validUntil: date ? date.toISOString() : null })
          setPending(null)
        }}
        onCancel={() => { setShowExpiry(false); setPending(null) }}
      />
      <RemoveConfirmDialog
        open={showRemove}
        onOpenChange={setShowRemove}
        title={t('removeTitle')}
        description={t('removeBody', { name: contactName(contact) })}
        confirmLabel={t('removeConfirm')}
        cancelLabel={t('cancel')}
        onConfirm={() => removeAffiliation()}
        busy={removing}
      />
    </>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function OrgAffiliationsPage() {
  const tNav = useTranslations('Org')
  const { orgId } = useParams<{ orgId: string }>()
  const t = useTranslations('OrgAffiliations')
  const { isAdmin, affiliationTerm } = useOrg()
  const qc = useQueryClient()

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('__all__')
  const [selectedTypeId, setSelectedTypeId] = useState<string>('__all__')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [renewConfirm, setRenewConfirm] = useState(false)
  const [renewBusy, setRenewBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const { data: teams, isLoading: teamsLoading } = useOrgTeamIds(orgId)
  const { data: contacts, isLoading: contactsLoading } = useOrgContacts(orgId, teams)
  const { data: rawDefs } = useStatusDefs(orgId)
  const { data: affiliationTypes = [], isLoading: typesLoading } = useOrgAffiliationTypes(orgId)

  const defs: OrgAffiliationStatusDef[] = rawDefs ?? DEFAULT_ORG_AFFILIATION_STATUSES
  const isLoading = teamsLoading || contactsLoading || typesLoading

  const activeTypeId = selectedTypeId !== '__all__' ? selectedTypeId : null

  // Load affiliations by type for the org
  const { data: affiliationsByContact = {} } = useQuery<Record<string, Affiliation>>({
    queryKey: ['org-affiliations-for-type', orgId, activeTypeId],
    enabled: !!orgId && !!activeTypeId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!orgId || !activeTypeId) return {}
      const result: Record<string, Affiliation> = {}
      const snap = await getDocs(
        query(
          collectionGroup(db, CONTACT_AFFILIATIONS_SUBCOLLECTION),
          where('org_id', '==', orgId),
          where('affiliation_type_id', '==', activeTypeId),
        ),
      )
      snap.docs.forEach((d) => {
        const contactId = d.ref.parent.parent?.id
        if (contactId) result[contactId] = { ...d.data(), id: d.id } as Affiliation
      })
      return result
    },
  })

  const totalActive = useMemo(
    () => contacts?.filter((c) => c.affiliation_summary?.has_active).length ?? 0,
    [contacts],
  )

  const filtered = useMemo(() => {
    if (!contacts) return []
    return contacts.filter((c) => {
      if (selectedTypeId === '__all__') {
        if (statusFilter === 'affiliated' && !c.affiliation_summary?.has_active) return false
        if (statusFilter === 'not_affiliated' && c.affiliation_summary?.has_active) return false
      } else {
        const aff = affiliationsByContact[c.id]
        if (statusFilter === '__expiring__') {
          if (!isExpiringSoon(aff)) return false
        } else if (statusFilter !== '__all__') {
          const statusId = aff?.status_id ?? NO_AFFILIATION
          if (statusId !== statusFilter) return false
        }
      }
      if (search) {
        const name = contactName(c).toLowerCase()
        if (!name.includes(search.toLowerCase())) return false
      }
      return true
    })
  }, [contacts, statusFilter, search, selectedTypeId, affiliationsByContact])

  const countsByStatus = useMemo(() => {
    if (selectedTypeId === '__all__') return {}
    const map: Record<string, number> = {}
    contacts?.forEach((c) => {
      const aff = affiliationsByContact[c.id]
      const s = aff?.status_id ?? NO_AFFILIATION
      map[s] = (map[s] ?? 0) + 1
    })
    return map
  }, [contacts, selectedTypeId, affiliationsByContact])

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['org-contacts'] })
    qc.invalidateQueries({ queryKey: ['org-affiliations-for-type', orgId, activeTypeId] })
  }

  const expiringCount = useMemo(() => {
    if (selectedTypeId === '__all__') return 0
    let n = 0
    contacts?.forEach((c) => { if (isExpiringSoon(affiliationsByContact[c.id])) n++ })
    return n
  }, [contacts, selectedTypeId, affiliationsByContact])

  // Bulk selection (org admins only), over rows that hold an affiliation of this type.
  const selectableIds = useMemo(
    () => (isAdmin ? filtered.filter((c) => affiliationsByContact[c.id]).map((c) => c.id) : []),
    [filtered, affiliationsByContact, isAdmin],
  )
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))

  function toggleAll(checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) selectableIds.forEach((id) => next.add(id))
      else selectableIds.forEach((id) => next.delete(id))
      return next
    })
  }
  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function renewSelected() {
    setRenewBusy(true)
    try {
      const ids = [...selected].filter((cid) => affiliationsByContact[cid])
      const results = await Promise.allSettled(
        // Each affiliation carries its own teamId (the contact's team).
        ids.map((cid) =>
          renewAffiliationCall({
            teamId: affiliationsByContact[cid]!.teamId,
            contactId: cid,
            affiliationId: affiliationsByContact[cid]!.id,
          }),
        ),
      )
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const failed = results.length - ok
      // An org admin can select contacts across teams they don't manage — those
      // calls 403; renew what succeeded and report the rest instead of silently hanging.
      invalidate()
      setSelected(new Set())
      setRenewConfirm(false)
      setToast(failed ? t('bulkRenewedPartial', { ok, failed }) : t('bulkRenewedToast', { count: ok }))
      setTimeout(() => setToast(null), 4000)
    } finally {
      setRenewBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={affiliationTerm}
        subtitle={
          contacts ? t('subtitle', { total: contacts.length, active: totalActive }) : undefined
        }
        // THE ROSTER, AND THE WAY TO WHAT DEFINES IT. The statuses and types
        // used to render beneath this list, which made a roster you scrolled
        // past to reach a form. They now have their own destination and this is
        // the link to it (Franco, 2026-09-05).
        quickLinks={[
          {
            href: `/org/${orgId}/affiliation-settings` as Route,
            label: tNav('affiliationSettings'),
          },
        ]}
      />

      {/* Type selector */}
      {affiliationTypes.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            value={selectedTypeId}
            onValueChange={(v) => {
              if (!v) return
              setSelectedTypeId(v)
              setSelected(new Set())
              setStatusFilter('__all__')
            }}
          >
            <SelectTrigger className="w-[200px] h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('allTypes')}</SelectItem>
              {affiliationTypes.map((at) => (
                <SelectItem key={at.id} value={at.id}>{at.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Status filter pills */}
      {!isLoading && (
        <div className="flex flex-wrap gap-1.5">
          {selectedTypeId === '__all__' ? (
            <>
              <button
                onClick={() => setStatusFilter('__all__')}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  statusFilter === '__all__' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('filterAll')} {contacts ? `(${contacts.length})` : ''}
              </button>
              <button
                onClick={() => setStatusFilter('affiliated')}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  statusFilter === 'affiliated' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('filterActive')} ({totalActive})
              </button>
              <button
                onClick={() => setStatusFilter('not_affiliated')}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  statusFilter === 'not_affiliated' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('filterNone')} ({(contacts?.length ?? 0) - totalActive})
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setStatusFilter('__all__')}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  statusFilter === '__all__' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('filterAll')} {contacts ? `(${contacts.length})` : ''}
              </button>
              {expiringCount > 0 && (
                <button
                  onClick={() => setStatusFilter('__expiring__')}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    statusFilter === '__expiring__' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t('filterExpiring')} ({expiringCount})
                </button>
              )}
              {defs.map((s) => {
                const count = countsByStatus[s.id] ?? 0
                if (count === 0) return null
                return (
                  <button
                    key={s.id}
                    onClick={() => setStatusFilter(s.id)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                      statusFilter === s.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {s.label} ({count})
                  </button>
                )
              })}
            </>
          )}
        </div>
      )}

      {/* Search */}
      <div className="max-w-xs">
        <SearchInput
          className="h-9 text-sm"
          placeholder={t('searchPlaceholder')}
          value={search}
          onValueChange={setSearch}
        />
      </div>

      {/* Table */}
      <div className="rounded-md border overflow-hidden">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground text-sm">{t('noContacts')}</div>
        ) : selectedTypeId === '__all__' ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left font-medium text-muted-foreground px-4 py-3">{t('colName')}</th>
                <th className="text-left font-medium text-muted-foreground px-4 py-3 hidden sm:table-cell">{t('colTeam')}</th>
                <th className="text-left font-medium text-muted-foreground px-4 py-3">{t('colType')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-sm">{contactName(c)}</div>
                    {c.email && <div className="text-xs text-muted-foreground truncate max-w-[200px]">{c.email}</div>}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground hidden sm:table-cell">{(c as ContactRow).teamName ?? '—'}</td>
                  <td className="px-4 py-3">
                    <AffiliationSummaryChip contact={c} affiliationTypes={affiliationTypes} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-2 py-3 w-8">
                  {isAdmin && (
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) => toggleAll(e.target.checked)}
                      disabled={selectableIds.length === 0}
                      className="h-4 w-4 rounded border-input accent-primary align-middle"
                      aria-label={t('selectAll')}
                    />
                  )}
                </th>
                <th className="text-left font-medium text-muted-foreground px-4 py-3">{t('colName')}</th>
                <th className="text-left font-medium text-muted-foreground px-4 py-3 hidden sm:table-cell">{t('colTeam')}</th>
                <th className="text-left font-medium text-muted-foreground px-4 py-3">{t('colStatus')}</th>
                {/* The remove control's column — unlabelled, like the studio's. */}
                <th className="px-2 py-3 w-8" />
                <th className="text-left font-medium text-muted-foreground px-4 py-3 hidden md:table-cell">{t('colExpires')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <ContactAffiliationRow
                  key={c.id}
                  contact={c as ContactRow}
                  affiliation={affiliationsByContact[c.id]}
                  defs={defs}
                  isAdmin={isAdmin}
                  orgId={orgId}
                  affiliationTypeId={selectedTypeId}
                  onUpdated={invalidate}
                  selectable={isAdmin && !!affiliationsByContact[c.id]}
                  selected={selected.has(c.id)}
                  onToggleSelect={(checked) => toggleOne(c.id, checked)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected.size > 0 && (
        <AffiliationBulkBar
          selectedLabel={t('bulkSelected', { count: selected.size })}
          renewLabel={t('bulkRenew')}
          clearLabel={t('clearSelection')}
          onRenew={() => setRenewConfirm(true)}
          onClear={() => setSelected(new Set())}
          busy={renewBusy}
        />
      )}
      <RenewConfirmDialog
        open={renewConfirm}
        onOpenChange={setRenewConfirm}
        title={t('bulkRenewTitle')}
        description={t('bulkRenewDesc', { count: selected.size })}
        confirmLabel={t('bulkRenew')}
        cancelLabel={t('cancel')}
        onConfirm={renewSelected}
        busy={renewBusy}
      />
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 rounded-lg bg-green-600 px-4 py-2.5 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
      {/* THE VOCABULARY, beneath the roster it describes.
          It used to live three screens down the org Settings page, so the
          statuses were configured in one place and read in another. An
          administrator now adds "Suspended" on the screen that shows who is
          suspended. Each card applies the `isAdmin` gate itself. */}
      <div className="space-y-4 border-t pt-6">
      </div>
    </div>
  )
}
