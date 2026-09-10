'use client'

import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  collection, doc, getDoc, getDocs, query, where, collectionGroup,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { statusBadgeClass, statusFillClass } from '@/lib/affiliationStatusColors'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { useAffiliationTerm } from '@/hooks/useAffiliationTerm'
import { useAuth } from '@/contexts/AuthContext'
import { useCapabilities } from '@/hooks/useCapabilities'
import {
  CONTACTS_COLLECTION, ORGANIZATIONS_COLLECTION, ORG_AFFILIATION_STATUSES_SUBCOLLECTION,
  DEFAULT_ORG_AFFILIATION_STATUSES, AFFILIATION_TYPES_SUBCOLLECTION, CONTACT_AFFILIATIONS_SUBCOLLECTION,
} from '@linyup/shared'
import { contactLifecycle } from '@linyup/shared'
import type { Contact, OrgAffiliationStatusDef, Affiliation, AffiliationType } from '@linyup/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/ui/search-input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { EyeOff, IdCard, Settings2 } from 'lucide-react'
import { renewAffiliationCall } from '@/components/affiliations/renew'
import { AffiliationBulkBar, RenewConfirmDialog } from '@/components/affiliations/RenewUI'
import {
  NO_AFFILIATION,
  RemoveAffiliationButton,
  RemoveConfirmDialog,
  removeAffiliationCall,
} from '@/components/affiliations/remove'
import { AffiliationTypesManager } from '@/components/affiliations/AffiliationTypesManager'

// ─── colour map ────────────────────────────────────────────────────────────────


// ─── data hooks ───────────────────────────────────────────────────────────────

/**
 * The organisation's NAME, for the one sentence on this page that has to say
 * WHO can see a contact. A member studio may read its org's root document —
 * see the note on `match /organizations/{orgId}` in `firestore.rules`.
 */
function useOrgName(orgId: string | undefined) {
  return useQuery<string | null>({
    queryKey: ['org-name', orgId ?? null],
    enabled: !!orgId,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      if (!orgId) return null
      const snap = await getDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId))
      return snap.exists() ? ((snap.data().name as string | undefined) ?? null) : null
    },
  })
}

function useTeamContacts(teamId: string | null) {
  return useQuery<Contact[]>({
    queryKey: ['team-contacts-membership', teamId],
    enabled: !!teamId,
    staleTime: 2 * 60_000,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        query(
          collection(db, CONTACTS_COLLECTION),
          where('teamId', '==', teamId),
          where('deleted_at', '==', null),
        ),
      )
      return snap.docs
        .map((d) => ({ ...d.data(), id: d.id } as Contact))
        .sort((a, b) =>
          `${a.lastname ?? ''} ${a.firstname ?? ''}`.localeCompare(`${b.lastname ?? ''} ${b.firstname ?? ''}`),
        )
    },
  })
}

function useStatusDefs(orgId: string | null | undefined) {
  return useQuery<OrgAffiliationStatusDef[]>({
    queryKey: ['org-membership-statuses', orgId],
    enabled: true,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      if (!orgId) return DEFAULT_ORG_AFFILIATION_STATUSES
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

function useAffiliationTypes(teamId: string | null, orgId: string | null | undefined) {
  return useQuery<AffiliationType[]>({
    queryKey: ['affiliation-types', teamId, orgId],
    enabled: !!teamId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const results: AffiliationType[] = []
      if (orgId) {
        const snap = await getDocs(
          collection(db, ORGANIZATIONS_COLLECTION, orgId, AFFILIATION_TYPES_SUBCOLLECTION),
        )
        snap.docs.forEach((d) => results.push({ ...d.data(), id: d.id } as AffiliationType))
      }
      if (teamId) {
        const snap = await getDocs(
          collection(db, 'teams', teamId, AFFILIATION_TYPES_SUBCOLLECTION),
        )
        snap.docs.forEach((d) => {
          if (!results.find((r) => r.id === d.id)) {
            results.push({ ...d.data(), id: d.id } as AffiliationType)
          }
        })
      }
      return results.sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    },
  })
}

function useContactAffiliations(contactIds: string[], typeId: string | null) {
  return useQuery<Record<string, Affiliation>>({
    queryKey: ['contact-affiliations-by-type', contactIds, typeId],
    enabled: contactIds.length > 0 && !!typeId,
    staleTime: 60_000,
    queryFn: async () => {
      const result: Record<string, Affiliation> = {}
      // Query the affiliations sub-collection for each contact in batches
      const chunks: string[][] = []
      for (let i = 0; i < contactIds.length; i += 10) chunks.push(contactIds.slice(i, i + 10))
      await Promise.all(
        chunks.map(async (chunk) => {
          const snap = await getDocs(
            query(
              collectionGroup(db, CONTACT_AFFILIATIONS_SUBCOLLECTION),
              where('affiliation_type_id', '==', typeId),
              where('teamId', '==', chunk[0].split('__')[0] || chunk[0]), // use teamId filter
            ),
          )
          snap.docs.forEach((d) => {
            const aff = { ...d.data(), id: d.id } as Affiliation
            // parent doc id is the contactId
            const contactId = d.ref.parent.parent?.id
            if (contactId && chunk.includes(contactId)) {
              result[contactId] = aff
            }
          })
        }),
      )
      return result
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

/**
 * The person's name, linked to their record — the same fix UX-63 made on
 * /bookings and UX-91 on the session rosters. The ROW cannot be the link here
 * (it holds an inline status Select), so the name carries it. A row with no
 * contact id stays plain text rather than linking to nothing.
 */
function ContactNameLink({ contact }: { contact: Contact }) {
  const base = 'font-medium text-sm'
  if (!contact.id) return <div className={base}>{contactName(contact)}</div>
  return (
    <Link href={`/contacts/${contact.id}` as Route} className={`${base} hover:underline`}>
      {contactName(contact)}
    </Link>
  )
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
  const t = useTranslations('TeamAffiliations')
  // NO AFFILIATION IS NOT A STATUS. It used to fall back to the built-in `guest`
  // def, which dressed "holds nothing" as a value somebody could also SELECT —
  // and selecting it wrote a row. The empty state now says so in its own words,
  // and an unknown id (a status def the org deleted) renders as `—` rather than
  // being quietly relabelled.
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

// ─── affiliation summary chip (All types view) ────────────────────────────────

function AffiliationSummaryChip({ contact, affiliationTypes }: { contact: Contact; affiliationTypes: AffiliationType[] }) {
  const summary = contact.affiliation_summary
  if (!summary?.has_active) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
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
  const t = useTranslations('TeamAffiliations')
  const [value, setValue] = useState('')

  function handleConfirm() { onConfirm(value ? new Date(value) : null); setValue('') }
  function handleCancel() { setValue(''); onCancel() }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleCancel() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('expirationDialogTitle')}</DialogTitle>
          <DialogDescription>{t('expirationDialogDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label htmlFor="tm-exp-date">{t('expirationLabel')}</Label>
          <Input id="tm-exp-date" type="date" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>{t('cancel')}</Button>
          <Button onClick={handleConfirm}>{t('expirationSave')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── contact row (type-specific view) ────────────────────────────────────────

function ContactAffiliationRow({
  contact,
  affiliation,
  defs,
  canEdit,
  affiliationTypeId,
  teamId,
  onUpdated,
  selectable,
  selected,
  onToggleSelect,
}: {
  contact: Contact
  affiliation: Affiliation | undefined
  defs: OrgAffiliationStatusDef[]
  canEdit: boolean
  affiliationTypeId: string
  teamId: string
  onUpdated: () => void
  selectable: boolean
  selected: boolean
  onToggleSelect: (checked: boolean) => void
}) {
  const t = useTranslations('TeamAffiliations')
  const currentStatusId = affiliation?.status_id ?? NO_AFFILIATION
  const [pending, setPending] = useState<string | null>(null)
  const [showExpiry, setShowExpiry] = useState(false)
  const [showRemove, setShowRemove] = useState(false)

  const upsertAffiliation = httpsCallable(functions, 'upsertAffiliation')

  const { mutate: saveAffiliation, isPending: saving } = useMutation({
    mutationFn: async ({ statusId, validUntil }: { statusId: string; validUntil?: string | null }) => {
      await upsertAffiliation({
        teamId,
        contactId: contact.id,
        affiliationId: affiliation?.id,
        affiliation_type_id: affiliationTypeId,
        issuer: 'team',
        status_id: statusId,
        valid_until: validUntil ?? null,
      })
    },
    onSuccess: onUpdated,
  })

  // REMOVING THE ROW, not setting a status on it — see the module header of
  // `components/affiliations/remove.tsx` for why the two are separate controls.
  const { mutate: removeAffiliation, isPending: removing } = useMutation({
    mutationFn: async () => {
      if (!affiliation) return
      await removeAffiliationCall({ teamId, contactId: contact.id, affiliationId: affiliation.id })
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
          <ContactNameLink contact={contact} />
          {contact.email && (
            <div className="text-xs text-muted-foreground truncate max-w-[200px]">{contact.email}</div>
          )}
        </td>
        <td className="px-4 py-3">
          {canEdit ? (
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
          {/* Only where there IS a row to remove. Nothing to take off the books
              means nothing to confirm. */}
          {canEdit && affiliation && (
            <RemoveAffiliationButton
              label={t('removeAction')}
              onClick={() => setShowRemove(true)}
              disabled={removing || saving}
            />
          )}
        </td>
        <td className="px-4 py-3 text-sm text-muted-foreground hidden sm:table-cell">
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

export default function TeamAffiliationsPage() {
  const t = useTranslations('TeamAffiliations')
  const { currentTeamId, team } = useAuth()
  const { can } = useCapabilities()
  const affiliationTerm = useAffiliationTerm()
  const qc = useQueryClient()
  const [typesOpen, setTypesOpen] = useState(false)

  const orgId = team?.org_id
  const { data: orgName } = useOrgName(orgId)
  // Affiliation types are studio "offerings" — manager+ may edit them.
  const canEdit = can('offerings.manage')

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('__all__')
  const [selectedTypeId, setSelectedTypeId] = useState<string>('__all__')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [renewConfirm, setRenewConfirm] = useState(false)
  const [renewBusy, setRenewBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const { data: contacts, isLoading: contactsLoading } = useTeamContacts(currentTeamId)
  const { data: rawDefs, isLoading: defsLoading } = useStatusDefs(orgId)
  const { data: affiliationTypes = [], isLoading: typesLoading } = useAffiliationTypes(currentTeamId, orgId)

  const defs: OrgAffiliationStatusDef[] = rawDefs ?? DEFAULT_ORG_AFFILIATION_STATUSES
  const isLoading = contactsLoading || defsLoading || typesLoading

  // For type-specific view: load each contact's affiliation for the selected type
  const contactIds = useMemo(() => contacts?.map((c) => c.id) ?? [], [contacts])
  const activeTypeId = selectedTypeId !== '__all__' ? selectedTypeId : null

  // Fetch affiliations per contact for the selected type using collectionGroup
  const { data: affiliationsByContact = {} } = useQuery<Record<string, Affiliation>>({
    queryKey: ['contact-affiliations-for-type', currentTeamId, activeTypeId],
    enabled: !!currentTeamId && !!activeTypeId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!currentTeamId || !activeTypeId) return {}
      const result: Record<string, Affiliation> = {}
      const snap = await getDocs(
        query(
          collectionGroup(db, CONTACT_AFFILIATIONS_SUBCOLLECTION),
          where('teamId', '==', currentTeamId),
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

  const filtered = useMemo(() => {
    if (!contacts) return []
    return contacts.filter((c) => {
      // In "all types" view: filter by affiliation_summary.has_active
      if (selectedTypeId === '__all__') {
        if (statusFilter === 'affiliated' && !c.affiliation_summary?.has_active) return false
        if (statusFilter === 'not_affiliated' && c.affiliation_summary?.has_active) return false
      } else {
        // In type-specific view: filter by the loaded affiliation's status
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

  const totalActive = useMemo(
    () => contacts?.filter((c) => c.affiliation_summary?.has_active).length ?? 0,
    [contacts],
  )

  // NOT ON THE ORGANISATION'S BOOKS — the studio's own people, and the number
  // that tells the manager what the federation cannot see.
  //
  // `org_ids` (any status), never `has_active`: the filter chips above already
  // answer "is their affiliation current", and this is a different question —
  // whether the organisation knows this person AT ALL. A contact with a lapsed
  // licence is inactive but very much on the books, and counting them here
  // would tell a manager the org cannot see somebody it can.
  //
  // ── ACTIVE ONLY, AND EVERY OTHER BUCKET IS EXCLUDED FOR ITS OWN REASON ─────
  //
  // This page's query filters `deleted_at` alone, so `contacts` still holds
  // people no manager should be nudged about. The notice asks "should this
  // person be on the federation's books?", which is only a real question for
  // somebody on the roster today:
  //
  //   archived     they left. The federation cannot see them and should not.
  //   external     trains here without being looked after — a partner-app
  //                drop-in (`contactLifecycle` in shared). Affiliating one is
  //                the LAST thing this notice should suggest, and at HMD Basel
  //                there are 93 of them: the number alone would read as a
  //                backlog and push a manager to clear it.
  //   provisional  a lead whose registration has not materialised. Not a
  //                federation candidate yet, and may never be.
  //
  // That last pressure is the whole reason the notice is styled neutrally, so
  // counting those people would undo in one number what the styling is for.
  const notOnOrgBooks = useMemo(() => {
    if (!orgId || !contacts) return 0
    return contacts.filter(
      (c) =>
        contactLifecycle(c) === 'active' &&
        !(c.affiliation_summary?.org_ids ?? []).includes(orgId)
    ).length
  }, [contacts, orgId])

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
    qc.invalidateQueries({ queryKey: ['team-contacts-membership', currentTeamId] })
    qc.invalidateQueries({ queryKey: ['contact-affiliations-for-type', currentTeamId, activeTypeId] })
  }

  const expiringCount = useMemo(() => {
    if (selectedTypeId === '__all__') return 0
    let n = 0
    contacts?.forEach((c) => { if (isExpiringSoon(affiliationsByContact[c.id])) n++ })
    return n
  }, [contacts, selectedTypeId, affiliationsByContact])

  // Bulk selection is available in the type-specific view, over rows that actually
  // hold an affiliation of that type (only those can be renewed).
  const selectableIds = useMemo(
    () => (canEdit ? filtered.filter((c) => affiliationsByContact[c.id]).map((c) => c.id) : []),
    [filtered, affiliationsByContact, canEdit],
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
    if (!currentTeamId) return
    setRenewBusy(true)
    try {
      const ids = [...selected].filter((cid) => affiliationsByContact[cid])
      const results = await Promise.allSettled(
        ids.map((cid) =>
          renewAffiliationCall({
            teamId: currentTeamId,
            contactId: cid,
            affiliationId: affiliationsByContact[cid]!.id,
          }),
        ),
      )
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const failed = results.length - ok
      // Some renewals may have succeeded even if others failed — always refresh.
      invalidate()
      setSelected(new Set())
      setRenewConfirm(false)
      setToast(failed ? t('bulkRenewedPartial', { ok, failed }) : t('bulkRenewedToast', { count: ok }))
      setTimeout(() => setToast(null), 4000)
    } finally {
      setRenewBusy(false)
    }
  }

  if (!orgId && affiliationTypes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <IdCard className="h-10 w-10 opacity-30" />
        <p className="text-sm">{t('noOrg')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header — the roster IS this page; the types are set-up, one click away.
          They used to be a tab of "Plans & affiliations" while the roster had no
          nav item at all, so the daily task was reachable only through a link
          inside the set-up screen. A peer tab would have implied the two are
          equals; one is opened weekly and the other at setup. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{affiliationTerm}</h1>
          {contacts && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {t('subtitle', { total: contacts.length, active: totalActive })}
            </p>
          )}
        </div>
        {canEdit && team && currentTeamId && (
          <Button variant="outline" size="sm" onClick={() => setTypesOpen(true)}>
            <Settings2 className="h-4 w-4" />
            {t('manageTypes')}
          </Button>
        )}
      </div>

      {/* WHAT THE ORGANISATION CANNOT SEE — stated to the studio, because the
          studio is the only party that can see both sides of it.

          A studio inside a federation has contacts who are nobody's business but
          its own: someone training at the club spot, a lead from a fitness app,
          a person doing an activity the studio runs under its own name. Since
          `orgAdminMayReadContact`, the organisation cannot read them at all —
          which is the intent, and is also exactly the kind of guarantee that is
          worthless if the person relying on it cannot tell whether it is
          holding. So the studio gets the number.

          NEUTRAL, NEVER A WARNING. Having unaffiliated contacts is the normal,
          supported state and the whole reason this boundary exists; styling it
          as a problem would push managers to affiliate people who should not be,
          which is the exact outcome the design is there to prevent. It reports,
          and names the action without demanding it.

          See `docs/org-contact-visibility.md`. */}
      {orgId && notOnOrgBooks > 0 && (
        <div className="rounded-md border bg-muted/40 p-3">
          <p className="flex items-start gap-2 text-sm">
            <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>
              <span className="font-medium">
                {t('notOnBooksTitle', { count: notOnOrgBooks })}
              </span>{' '}
              <span className="text-muted-foreground">
                {/* The organisation's own word for an affiliation is the H1 of
                    this page, so the sentence does not repeat it — and cannot:
                    `affiliationTerm` is tenant-configurable, so any article in
                    front of it ("Add a {term}") is a grammar bug waiting for the
                    tenant that renames it. It read "Add a Affiliation" on the
                    seeded org. */}
                {orgName
                  ? t('notOnBooksBody', { org: orgName })
                  : t('notOnBooksBodyBare')}
              </span>
            </span>
          </p>
        </div>
      )}

      {/* The types manager, unchanged, in a dialog. On close the types query is
          invalidated so a type added here shows up in the selector below without
          a reload — the manager writes them, this page reads them, and they are
          two different queries. */}
      {team && currentTeamId && (
        <Dialog
          open={typesOpen}
          onOpenChange={(v) => {
            setTypesOpen(v)
            if (!v) void qc.invalidateQueries({ queryKey: ['affiliation-types', currentTeamId] })
          }}
        >
          <DialogContent className="sm:max-w-3xl h-[calc(100dvh-2rem)] sm:h-[40rem] p-0 gap-0">
            <DialogHeader className="border-b px-4 py-3 pr-12">
              <DialogTitle className="text-base">{t('manageTypes')}</DialogTitle>
            </DialogHeader>
            <DialogBody className="p-4">
              <AffiliationTypesManager team={team} teamId={currentTeamId} />
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}

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

      {/* Status filter pills — different depending on type selected */}
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
              {/* NOT AFFILIATED — the bucket the removed `guest` pill used to
                  fill. It is a tally key, never a status, so it is rendered here
                  rather than found in `defs`. */}
              {(countsByStatus[NO_AFFILIATION] ?? 0) > 0 && (
                <button
                  onClick={() => setStatusFilter(NO_AFFILIATION)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    statusFilter === NO_AFFILIATION ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t('statusNone')} ({countsByStatus[NO_AFFILIATION]})
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
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground text-sm">{t('noContacts')}</div>
        ) : selectedTypeId === '__all__' ? (
          /* All types — read-only chip overview from affiliation_summary */
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left font-medium text-muted-foreground px-4 py-3">{t('colName')}</th>
                <th className="text-left font-medium text-muted-foreground px-4 py-3">{t('colType')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <ContactNameLink contact={c} />
                    {c.email && <div className="text-xs text-muted-foreground truncate max-w-[200px]">{c.email}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <AffiliationSummaryChip contact={c} affiliationTypes={affiliationTypes} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          /* Type-specific — editable status per contact */
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-2 py-3 w-8">
                  {canEdit && (
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
                <th className="text-left font-medium text-muted-foreground px-4 py-3">{t('colStatus')}</th>
                {/* The remove control's column. Deliberately unlabelled — an icon
                    action needs no heading, and naming it would put "Remove" at
                    the top of a column of blanks. */}
                <th className="px-2 py-3 w-8" />
                <th className="text-left font-medium text-muted-foreground px-4 py-3 hidden sm:table-cell">{t('colExpires')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <ContactAffiliationRow
                  key={c.id}
                  contact={c}
                  affiliation={affiliationsByContact[c.id]}
                  defs={defs}
                  canEdit={canEdit}
                  affiliationTypeId={selectedTypeId}
                  teamId={currentTeamId!}
                  onUpdated={invalidate}
                  selectable={canEdit && !!affiliationsByContact[c.id]}
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
    </div>
  )
}
