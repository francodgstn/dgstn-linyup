'use client'

import { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react'
import { useTabParam } from '@/hooks/useTabParam'
import { useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { useOpenTabs } from '@/contexts/OpenTabsContext'
import {
  collection, query, where, orderBy, getDocs, getDoc, addDoc, updateDoc,
  doc, serverTimestamp, Timestamp, deleteField, onSnapshot, deleteDoc, setDoc,
  arrayUnion, arrayRemove,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { RankBadge } from '@/components/ranking/RankBadge'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useActiveContacts } from '@/hooks/useActiveContacts'
// The Archived tab's query moved to a hook of its own so the sidebar search can
// run the SAME one — same shape, same key, one cache entry (UX-21).
import { useArchivedContacts } from '@/hooks/useArchivedContacts'
import { useCoaches, coachLabel } from '@/hooks/useCoaches'
import { usePlan } from '@/hooks/usePlan'
import { useUpgradeModal } from '@/contexts/UpgradeModalContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/ui/search-input'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  CONTACTS_COLLECTION, TEAMS_COLLECTION, CONTACT_REQUESTS_SUBCOLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION, ORGANIZATIONS_COLLECTION,
  ORG_AFFILIATION_STATUSES_SUBCOLLECTION, DEFAULT_ORG_AFFILIATION_STATUSES,
  CONTACT_FILTERS_SUBCOLLECTION, contactUsageForPlan, PLAN_ORDER, contactOverageForPlan,
  planHasHardContactCap, resolveIntroOffer,
} from '@linyup/shared'
import type { Contact, ContactGroup, AcquisitionStage, ContactEntry, ContactSource, ContactRequest, RankingSystem, SubscriptionType, SubscriptionPrice, OrgAffiliationStatusDef, SaasPlan, EngagementBand, EngagementThresholds, CustomFieldDefinition, CustomFieldType } from '@linyup/shared'
import { ACQUISITION_STAGES, CONTACT_ENTRIES, CONTACT_SOURCES, ENGAGEMENT_BANDS, contactLifecycle, planGrantExpiryMs } from '@linyup/shared'
// The ONE contact predicate — see packages/shared/src/utils/contactFilter.ts.
// Never re-implement matching here; extend the resolver instead.
import {
  EMPTY_CONTACT_FILTER, emptyContactFilter, normalizeContactFilter, countActiveFilters,
  filterContacts, flattenGroupTree, isDynamicGroup, toGroupRule, ruleWouldDropGroups,
  compareContactsByAttention, contactAttentionReasons, resolveTimestampMs,
  GROUP_NONE, COACH_NONE, expandRankRange, rankFilterIsActive, orderedLevels,
} from '@linyup/shared'
import type {
  ContactAttentionReason,
  ContactFilter, ConsentFilter, InactivityPreset, RankFilter, RankRangeFilter,
  AgeFilter, CustomFieldCondition, CustomFieldOp, WaiverAcceptanceState,
} from '@linyup/shared'
import { formatCurrency } from '@/lib/format'
import { useAskedDocuments, type AskedDocument } from '@/hooks/useContactDocuments'
import { AskToSignDialog } from '@/components/contacts/AskToSignDialog'
import { ExportContactsButton } from '@/components/contacts/ExportContactsButton'
import { FloatingSlot } from '@/components/layout/FloatingDock'
import { QuickLinks } from '@/components/layout/QuickLinks'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import {
  useContactGroups, useInvalidateContactGroups, createGroupFromFilter, useContactFilterContext,
} from '@/plugins/contact-groups/hooks'
import { BulkGroupsDialog } from '@/plugins/contact-groups/BulkGroupsDialog'
import { SaveAsGroupDialog } from '@/plugins/contact-groups/SaveAsGroupDialog'
import { BulkOutreachDialog } from '@/components/contacts/BulkOutreachDialog'
import { BulkSetCustomFieldDialog } from '@/plugins/custom-fields/BulkSetCustomFieldDialog'
import type { CustomFieldValue } from '@/plugins/custom-fields/CustomFieldInput'
import { toast } from 'sonner'
import { GROUP_RULE_HANDOFF_KEY } from '@/plugins/contact-groups/GroupRuleDialog'
import { setGroupRule } from '@/plugins/contact-groups/hooks'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { UserPlus, X, Plus, AlertCircle, ChevronDown, ChevronUp, ChevronRight, Archive, Trash2, RotateCcw, MoreHorizontal, ArrowRightLeft, Mail, Pencil, Award, CreditCard, Tag, Check, Bookmark, BookmarkPlus, BarChart2, Eye, FolderTree, ShieldCheck, UserCheck, StickyNote, ListPlus, QrCode, MailX, DoorOpen } from 'lucide-react'
import type { Route } from 'next'
import { writeQrSheetSelection } from '@/lib/qrSheetSelection'
import { RosterCard } from '@/components/dashboard/RosterCard'
import { DemographicsCard } from '@/components/dashboard/DemographicsCard'
import { getPrimaryRank } from '@/lib/rank-utils'
import { QUICK_ACTION_PARAM } from '@/lib/quickActions'
import { Tip } from '@/components/ui/tip'

// ─── helpers ──────────────────────────────────────────────────────────────────

function initials(c: Contact) {
  return `${c.firstname?.[0] ?? ''}${c.lastname?.[0] ?? ''}`.toUpperCase() || '?'
}


const MEMBERSHIP_COLOR_CLASSES: Record<string, string> = {
  gray:   'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  yellow: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  blue:   'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  purple: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  green:  'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  red:    'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  orange: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
}

function tsToDate(ts: unknown): Date | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: unknown }).toDate === 'function') return (ts as { toDate(): Date }).toDate()
  if (typeof (ts as { seconds?: unknown }).seconds === 'number') return new Date((ts as { seconds: number }).seconds * 1000)
  return null
}

function daysUntilAnonymisation(deletedAt: unknown): number | null {
  const deleted = tsToDate(deletedAt)
  if (!deleted) return null
  const deadline = new Date(deleted.getTime() + 30 * 24 * 60 * 60 * 1000)
  return Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
}

// ─── schema ───────────────────────────────────────────────────────────────────

const createSchema = z.object({
  firstname: z.string().min(1, 'Required').max(60),
  lastname: z.string().min(1, 'Required').max(60),
  email: z.string().email('Invalid email').or(z.literal('')).optional(),
  phone: z.string().max(30).optional(),
  /** Which door they came through — determines birth stage */
  entry: z.enum(['booking', 'walk_in', 'signup', 'import', 'form'] as const),
  source: z.enum(['website', 'referral', 'social', 'event', 'import', 'other'] as const).optional(),
  source_detail: z.string().max(200).optional(),
})
type CreateValues = z.infer<typeof createSchema>

/** Map entry choice → initial acquisition_stage + milestone timestamps. Off-funnel
 *  entries ('shop' / 'form' / 'waitlist') get NO stage — they're not on the trial
 *  funnel. Queueing for a full class is a want, not a booking; the stage is
 *  stamped if and when the seat is claimed. */
function entryToStage(entry: ContactEntry): {
  acquisition_stage?: AcquisitionStage
  trial_attended_at?: ReturnType<typeof serverTimestamp>
  converted_at?: ReturnType<typeof serverTimestamp>
} {
  switch (entry) {
    case 'booking': return { acquisition_stage: 'trial_booked' }
    case 'walk_in': return { acquisition_stage: 'trial_attended', trial_attended_at: serverTimestamp() }
    case 'signup':
    case 'import': return { acquisition_stage: 'joined', converted_at: serverTimestamp() }
    case 'form':
    case 'shop':
    case 'waitlist':
    case 'manual': return {} // off-funnel entry — no acquisition stage
  }
}

// ─── data hooks ───────────────────────────────────────────────────────────────

function useDeletedContacts(teamId: string | null) {
  return useQuery<Contact[]>({
    queryKey: ['contacts', 'deleted', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const q = query(
        collection(db, CONTACTS_COLLECTION),
        where('anonymized_at', '==', null),
        where('teamId', '==', teamId),
        where('deleted_at', '!=', null),
        orderBy('deleted_at', 'desc'),
      )
      const snap = await getDocs(q)
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Contact)
    },
  })
}

function useContactRequests(teamId: string | null) {
  return useQuery<ContactRequest[]>({
    queryKey: ['contact-requests', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const q = query(
        collection(db, TEAMS_COLLECTION, teamId, CONTACT_REQUESTS_SUBCOLLECTION),
        orderBy('requested_at', 'desc'),
      )
      const snap = await getDocs(q)
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as ContactRequest)
    },
  })
}

function useSubscriptionTypes(teamId: string | null) {
  return useQuery<SubscriptionType[]>({
    queryKey: ['subscription-types', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(collection(db, TEAMS_COLLECTION, teamId, SUBSCRIPTION_TYPES_SUBCOLLECTION))
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as SubscriptionType)
    },
  })
}

function useOrgAffiliationStatuses(orgId: string | null | undefined) {
  return useQuery<OrgAffiliationStatusDef[]>({
    queryKey: ['org-membership-statuses', orgId ?? null],
    enabled: !!orgId,
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

function useOrgRankingSystems(orgId: string | null | undefined) {
  return useQuery<RankingSystem[] | null>({
    queryKey: ['org-ranking-systems', orgId ?? null],
    enabled: !!orgId,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      if (!orgId) return null
      const snap = await getDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId))
      if (!snap.exists()) return null
      const systems = snap.data().ranking_systems as RankingSystem[] | undefined
      return systems?.length ? systems : null
    },
  })
}

// ─── create dialog ────────────────────────────────────────────────────────────

function CreateContactDialog({
  open, onOpenChange, teamId, userId, onSaved, atHardCap = false,
}: {
  open: boolean; onOpenChange: (v: boolean) => void
  teamId: string; userId: string; onSaved: () => void
  /** Backstop for the Free plan's hard cap — the open buttons already divert
   *  to the upgrade dialog, this guards a dialog left open across the limit. */
  atHardCap?: boolean
}) {
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const { register, handleSubmit, formState: { errors, isSubmitting }, reset, watch, setValue, control } = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    // Default: "Existing member" — manual coach adds are usually existing members
    defaultValues: { entry: 'signup' },
  })
  const entry = watch('entry')
  // At the hard cap only 'booking' is selectable — snap the default onto it.
  useEffect(() => {
    if (open && atHardCap && entry !== 'booking') setValue('entry', 'booking')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, atHardCap])
  // A coach (own-scoped) creating a contact auto-assigns it to themselves so it
  // lands in their own book and satisfies the own-scope Firestore rules.
  const { ownScoped } = useCapabilities()
  // entry options: booking (trial), walk_in (trial attended), signup (member), import (member)
  const ENTRIES = ['booking', 'walk_in', 'signup'] as const

  const onSubmit = async (values: CreateValues) => {
    // At the Free hard cap only counting entries are blocked — a trial 'booking'
    // lead is PROVISIONAL (doesn't consume allowance) and stays allowed, matching
    // the public booking page which keeps working at cap.
    if (atHardCap && values.entry !== 'booking') {
      onOpenChange(false)
      return
    }
    const stageData = entryToStage(values.entry)
    await addDoc(collection(db, CONTACTS_COLLECTION), {
      teamId,
      firstname: values.firstname,
      lastname: values.lastname,
      email: values.email || null,
      phone: values.phone || null,
      entry: values.entry,
      source: values.source || null,
      source_detail: values.source_detail || null,
      ...stageData,
      // A never-attended trial lead doesn't count toward the cap; attendance /
      // payment / promotion materializes it. See Contact.provisional.
      ...(values.entry === 'booking' ? { provisional: true } : {}),
      acquisition_stage_updated_at: serverTimestamp(),
      lead_acknowledged: false,
      createdBy: userId,
      assigned_coach_ids: ownScoped ? [userId] : [],
      created_at: serverTimestamp(),
      deleted_at: null,
      archived_at: null,
      anonymized_at: null,
    })
    reset()
    onSaved()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('addContact')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="contents">
          <div className="space-y-4 pt-1">
            {/* Entry choice — determines birth stage. At the Free hard cap, only
                'booking' (a non-counting provisional lead) stays selectable. */}
            <div className="flex gap-2">
              {ENTRIES.map((v) => {
                const capBlocked = atHardCap === true && v !== 'booking'
                return (
                  <button
                    key={v}
                    type="button"
                    disabled={capBlocked}
                    onClick={() => setValue('entry', v)}
                    className={`flex-1 py-1.5 px-3 rounded-lg border text-sm font-medium transition-colors ${
                      entry === v
                        ? 'bg-primary text-primary-foreground border-primary'
                        : capBlocked
                          ? 'bg-background text-muted-foreground/40 cursor-not-allowed'
                          : 'bg-background text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t(`entry_${v}`)}
                  </button>
                )
              })}
            </div>
            {atHardCap && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{t('capEntryHint')}</p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-sm font-medium">{t('fieldFirstname')} *</label>
                <Input {...register('firstname')} autoCapitalize="words" />
                {errors.firstname && <p className="text-xs text-destructive">{errors.firstname.message}</p>}
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">{t('fieldLastname')} *</label>
                <Input {...register('lastname')} autoCapitalize="words" />
                {errors.lastname && <p className="text-xs text-destructive">{errors.lastname.message}</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-sm font-medium">{t('colEmail')}</label>
                <Input type="email" {...register('email')} />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">{t('fieldPhone')}</label>
                <Input type="tel" {...register('phone')} />
              </div>
            </div>
            {/* Optional source */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-sm font-medium">{t('fieldAcquisitionSource')}</label>
                <Controller
                  control={control}
                  name="source"
                  render={({ field }) => (
                    <Select value={field.value ?? ''} onValueChange={(v) => field.onChange(v || undefined)}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">—</SelectItem>
                        {CONTACT_SOURCES.map((s) => (
                          <SelectItem key={s} value={s}>{t(`source_${s}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">{t('fieldAcquisitionSourceDetail')}</label>
                <Input {...register('source_detail')} placeholder="—" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <button type="button" onClick={() => onOpenChange(false)}
              className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">
              {t('cancel')}
            </button>
            <button type="submit" disabled={isSubmitting}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
              {isSubmitting ? tCommon('loading') : t('createContact')}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── confirm dialog ───────────────────────────────────────────────────────────

function ConfirmDialog({
  open, onOpenChange, title, desc, confirmLabel, onConfirm, destructive = false,
}: {
  open: boolean; onOpenChange: (v: boolean) => void
  title: string; desc: string; confirmLabel: string
  onConfirm: () => Promise<void>; destructive?: boolean
}) {
  const t = useTranslations('Contacts')
  const [busy, setBusy] = useState(false)

  const handleConfirm = async () => {
    setBusy(true)
    try { await onConfirm() } finally { setBusy(false); onOpenChange(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{desc}</p>
        <DialogFooter>
          <button onClick={() => onOpenChange(false)}
            className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">
            {t('cancel')}
          </button>
          <button onClick={handleConfirm} disabled={busy}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
              destructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}>
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── overview panel ───────────────────────────────────────────────────────────

function OverviewPanel({
  contacts, loading, rankingSystems, engagementThresholds,
}: {
  contacts: Contact[]
  loading: boolean
  rankingSystems?: RankingSystem[]
  engagementThresholds?: EngagementThresholds
}) {
  const t = useTranslations('Contacts')
  const [open, setOpen] = useState(false)

  const activeCount = contacts.filter((c) => c.affiliation_summary?.has_active === true).length
  const trialBookedCount = contacts.filter((c) => c.acquisition_stage === 'trial_booked').length

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg border border-dashed border-border/50 hover:border-border hover:bg-muted/30 transition-colors group"
      >
        <BarChart2 className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground">{t('statsTitle')}</span>
        <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
        {!open && !loading && contacts.length > 0 && (
          <div className="flex items-center gap-3 ml-1 text-xs text-muted-foreground/60">
            <span>{t('statsContactsCount', { count: contacts.length })}</span>
            {activeCount > 0 && <span>{t('statsActiveCount', { count: activeCount })}</span>}
            {trialBookedCount > 0 && <span>{trialBookedCount} {t('statsTrialBooked').toLowerCase()}</span>}
          </div>
        )}
      </button>
      {open && (
        loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Skeleton className="h-52 rounded-xl" />
            <Skeleton className="h-52 rounded-xl" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <RosterCard contacts={contacts} thresholds={engagementThresholds} />
            <DemographicsCard contacts={contacts} rankingSystems={rankingSystems} />
          </div>
        )
      )}
    </div>
  )
}

// ─── filter panel ─────────────────────────────────────────────────────────────

// The filter shape, the predicate and the active-count all live in
// @linyup/shared (utils/contactFilter.ts) so the contacts list, saved presets,
// dynamic groups and the automation engine agree on what "matches" means.
type Filters = ContactFilter
const EMPTY_FILTERS = EMPTY_CONTACT_FILTER

/** How the list is ordered. 'name' is the query's own (lastname, firstname);
 *  the other two are client sorts over the already-loaded list (UX-44). */
type SortMode = 'name' | 'attention' | 'recent'
const SORT_MODES: SortMode[] = ['name', 'attention', 'recent']

// ─── filter chips ─────────────────────────────────────────────────────────────

interface SavedQuery { id: string; name: string; filters: Filters; pinned?: boolean }

/** A built-in preset. It carries a message KEY, not a name: a saved query is the
 *  studio's own words and stays verbatim, but a preset is Linyup's copy and has
 *  to arrive in the reader's language like every other label on this bar. */
interface FilterPreset { id: string; nameKey: string; filters: Filters }

const FILTER_PRESETS: FilterPreset[] = [
  { id: 'p-active', nameKey: 'filterAffiliationActive', filters: { ...EMPTY_FILTERS, statuses: ['active'] } },
  { id: 'p-nosub',  nameKey: 'filterSubscriptionNone',  filters: { ...EMPTY_FILTERS, subscriptions: ['none'] } },
  { id: 'p-trials', nameKey: 'presetTrials',            filters: { ...EMPTY_FILTERS, stages: ['trial_booked', 'trial_attended'] } },
  { id: 'p-alerts', nameKey: 'presetHasAlerts',         filters: { ...EMPTY_FILTERS, hasAlerts: true } },
  { id: 'p-pending-signup', nameKey: 'filterPendingSignup', filters: { ...EMPTY_FILTERS, pendingSignup: true } },
]

/** The presets as ordinary saved queries, named in the reader's language. */
function usePresets(): SavedQuery[] {
  const t = useTranslations('Contacts')
  return FILTER_PRESETS.map((p) => ({
    id: p.id,
    name: t(p.nameKey as Parameters<typeof t>[0]),
    filters: p.filters,
  }))
}

function useScrollLockOnOpen() {
  const [open, setOpen] = useState(false)
  const savedY = useRef(0)
  function onOpenChange(v: boolean) {
    if (v) savedY.current = window.scrollY
    setOpen(v)
  }
  useLayoutEffect(() => {
    if (!open) return
    const y = savedY.current
    window.scrollTo(0, y)
    const restore = () => window.scrollTo(0, y)
    window.addEventListener('scroll', restore)
    let r2: number
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => window.removeEventListener('scroll', restore))
    })
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); window.removeEventListener('scroll', restore) }
  }, [open])
  return { open, onOpenChange }
}

function CheckOption({ label, checked, onToggle, dot }: { label: string; checked: boolean; onToggle: () => void; dot?: string }) {
  return (
    <button type="button" onClick={onToggle}
      className="flex items-center gap-2.5 w-full px-2 py-1.5 text-sm rounded hover:bg-accent transition-colors text-left"
    >
      <span className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${checked ? 'bg-primary border-primary' : 'border-input'}`}>
        {checked && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
      </span>
      {dot && <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${dot}`} />}
      <span className="truncate">{label}</span>
    </button>
  )
}

// Band → dot colour for the engagement filter (mirrors the meter on the contact page).
const ENGAGEMENT_DOT: Record<EngagementBand, string> = {
  active: 'bg-emerald-500',
  low: 'bg-amber-500',
  at_risk: 'bg-red-500',
  inactive: 'bg-muted-foreground/40',
}

function FilterChip({ label, activeLabel, isActive, onClear, openOnMount, children }: {
  label: string; activeLabel?: string; isActive: boolean; onClear?: () => void
  /** Freshly added from the "Add filter" menu — open straight away so the
   *  user lands on the values instead of having to click the chip again. */
  openOnMount?: boolean
  children: React.ReactNode
}) {
  const t = useTranslations('Contacts')
  const { open, onOpenChange } = useScrollLockOnOpen()
  const autoOpened = useRef(false)
  useEffect(() => {
    if (openOnMount && !autoOpened.current) { autoOpened.current = true; onOpenChange(true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOnMount])
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border outline-none transition-colors ${
        isActive
          ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/15'
          : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-border'
      }`}>
        <span>{isActive && activeLabel ? activeLabel : label}</span>
        <ChevronDown className="h-3 w-3 opacity-40" />
        {onClear && (
          <span role="button" aria-label={t('removeFilter')}
            onClick={(e) => { e.stopPropagation(); onClear() }}
            className={`rounded-full p-0.5 transition-colors -mr-0.5 ${isActive ? 'hover:bg-primary/20' : 'hover:bg-muted'}`}
          ><X className="h-3 w-3" /></span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-auto min-w-[180px] p-1.5">
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** A boolean filter — no values to pick, so the chip itself is the control. */
function ToggleChip({ label, icon: Icon, isActive, onToggle, onRemove }: {
  label: string; icon: React.ElementType; isActive: boolean
  onToggle: () => void; onRemove: () => void
}) {
  const t = useTranslations('Contacts')
  return (
    <button type="button" onClick={onToggle}
      className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
        isActive
          ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/15'
          : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-border'
      }`}>
      <Icon className="h-3 w-3" />
      {label}
      <span role="button" aria-label={t('removeFilter')}
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        className={`rounded-full p-0.5 -mr-0.5 transition-colors ${isActive ? 'hover:bg-primary/20' : 'hover:bg-muted'}`}
      ><X className="h-3 w-3" /></span>
    </button>
  )
}

function useSavedQueries(teamId: string | null) {
  const { user } = useAuth()
  const [saved, setSaved] = useState<SavedQuery[]>([])
  const [pinnedPresets, setPinnedPresets] = useState<string[]>([])

  useEffect(() => {
    if (!teamId) return
    const colRef = collection(db, TEAMS_COLLECTION, teamId, CONTACT_FILTERS_SUBCOLLECTION)
    return onSnapshot(colRef, (snap) => {
      const presetPinsDoc = snap.docs.find((d) => d.id === '_preset_pins')
      setPinnedPresets(presetPinsDoc?.data()?.ids ?? [])
      setSaved(
        snap.docs
          .filter((d) => d.id !== '_preset_pins')
          .map((d) => ({
            id: d.id,
            name: d.data().name as string,
            // Older saved filters may predate newer keys (e.g. groups) — backfill defaults.
            filters: { ...EMPTY_FILTERS, ...(d.data().filters as Partial<Filters>) },
            pinned: d.data().pinned ?? false,
          }))
      )
    })
  }, [teamId])

  function save(name: string, filters: Filters) {
    if (!teamId || !user) return
    addDoc(collection(db, TEAMS_COLLECTION, teamId, CONTACT_FILTERS_SUBCOLLECTION), {
      name, filters, pinned: false,
      created_at: serverTimestamp(),
      created_by: user.uid,
    })
  }
  function remove(id: string) {
    if (!teamId) return
    deleteDoc(doc(db, TEAMS_COLLECTION, teamId, CONTACT_FILTERS_SUBCOLLECTION, id))
  }
  function togglePin(id: string) {
    if (!teamId) return
    const current = saved.find((q) => q.id === id)
    if (!current) return
    updateDoc(doc(db, TEAMS_COLLECTION, teamId, CONTACT_FILTERS_SUBCOLLECTION, id), { pinned: !current.pinned })
  }
  function togglePresetPin(id: string) {
    if (!teamId) return
    const next = pinnedPresets.includes(id)
      ? pinnedPresets.filter((p) => p !== id)
      : [...pinnedPresets, id]
    setDoc(doc(db, TEAMS_COLLECTION, teamId, CONTACT_FILTERS_SUBCOLLECTION, '_preset_pins'), { ids: next })
  }

  return { saved, save, remove, togglePin, pinnedPresets, togglePresetPin }
}

function SavedMenu({ filters, onChange, saved, save, remove, togglePin, pinnedPresets, togglePresetPin, onSaveAsGroup }: {
  filters: Filters; onChange: (f: Filters) => void
  saved: SavedQuery[]; save: (name: string, filters: Filters) => void
  remove: (id: string) => void; togglePin: (id: string) => void
  pinnedPresets: string[]; togglePresetPin: (id: string) => void
  /** Contact Groups plugin installed — offer "turn this filter into a group". */
  onSaveAsGroup?: () => void
}) {
  const t = useTranslations('Contacts')
  const presets = usePresets()
  const { open, onOpenChange } = useScrollLockOnOpen()
  const [saveName, setSaveName] = useState('')
  const hasActive = countActiveFilters(filters) > 0

  // Older presets predate newer keys (search, tags, age…) — backfill defaults so
  // applying one never leaves the filter object with holes.
  function apply(q: SavedQuery) { onChange(normalizeContactFilter(q.filters)); onOpenChange(false) }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border border-border/60 text-muted-foreground hover:text-foreground hover:border-border outline-none transition-colors">
        <Bookmark className="h-3 w-3" />
        {t('savedMenu')}
        <ChevronDown className="h-3 w-3 opacity-40" />
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-52 p-1.5">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 pt-1 pb-0.5">{t('savedPresetsHeading')}</p>
        {presets.map((q) => {
          const isPinned = pinnedPresets.includes(q.id)
          return (
            <div key={q.id} className="flex items-center gap-1 rounded hover:bg-accent group px-1">
              <button type="button" onClick={() => apply(q)} className="flex-1 px-1 py-1.5 text-sm text-left truncate">{q.name}</button>
              {/* Showing a saved filter as a chip in the filter bar. Deliberately
                  NOT called "pin": that word belongs to the open-tabs strip, and
                  this is not a destination at all — see THE NAV-MEMORY CENSUS in
                  contexts/NavPinsContext.tsx. */}
              <Tip label={isPinned ? t('savedHideFromFilterBar') : t('savedShowInFilterBar')}>
                <button type="button" onClick={() => togglePresetPin(q.id)}
                  className={`shrink-0 p-1 transition-all ${isPinned ? 'text-primary opacity-100' : 'opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary'}`}
                  aria-label={isPinned ? t('savedHideFromFilterBar') : t('savedShowInFilterBar')}
                ><Eye className="h-3 w-3" /></button>
              </Tip>
            </div>
          )
        })}
        {saved.length > 0 && (
          <>
            <div className="my-1 border-t mx-1" />
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 pb-0.5">{t('savedYoursHeading')}</p>
            {saved.map((q) => (
              <div key={q.id} className="flex items-center gap-1 rounded hover:bg-accent group px-1">
                <button type="button" onClick={() => apply(q)} className="flex-1 px-1 py-1.5 text-sm text-left truncate">{q.name}</button>
                <Tip label={q.pinned ? t('savedHideFromFilterBar') : t('savedShowInFilterBar')}>
                  <button type="button" onClick={() => togglePin(q.id)}
                    className={`shrink-0 p-1 transition-all ${q.pinned ? 'text-primary opacity-100' : 'opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary'}`}
                    aria-label={q.pinned ? t('savedHideFromFilterBar') : t('savedShowInFilterBar')}
                  ><Eye className="h-3 w-3" /></button>
                </Tip>
                <button type="button" onClick={() => remove(q.id)}
                  className="shrink-0 p-1 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                ><X className="h-3 w-3" /></button>
              </div>
            ))}
          </>
        )}
        {hasActive && (
          <>
            <div className="my-1 border-t mx-1" />
            <div className="flex items-center gap-1.5 px-1 py-1">
              <Input value={saveName} onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && saveName.trim()) { save(saveName.trim(), filters); setSaveName(''); onOpenChange(false) } }}
                placeholder={t('savedSaveAsPlaceholder')} className="h-7 text-xs"
              />
              <button type="button" disabled={!saveName.trim()}
                onClick={() => { if (saveName.trim()) { save(saveName.trim(), filters); setSaveName(''); onOpenChange(false) } }}
                className="shrink-0 p-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
              ><BookmarkPlus className="h-3.5 w-3.5" /></button>
            </div>
            {/* The shortcut from a query to a first-class, nestable group. The
                dialog chooses snapshot (members copied now) vs dynamic (the
                filter IS the membership, re-evaluated on every read). */}
            {onSaveAsGroup && (
              <button type="button"
                onClick={() => { onSaveAsGroup(); onOpenChange(false) }}
                className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent transition-colors text-left">
                <FolderTree className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">{t('saveAsGroup')}</span>
              </button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

function RankFilterContent({ rankingSystems, rankFilter, rankRanges, onChange }: {
  rankingSystems: RankingSystem[]
  rankFilter: RankFilter | null
  rankRanges: Record<string, RankRangeFilter> | null
  onChange: (rf: RankFilter | null, rr: Record<string, RankRangeFilter> | null) => void
}) {
  const t = useTranslations('Contacts')
  const firstActiveId = rankFilter ? Object.keys(rankFilter).find((id) => rankFilter[id].length > 0) : null
  const defaultId = firstActiveId ?? rankingSystems.find((s) => s.is_primary)?.id ?? rankingSystems[0]?.id ?? ''
  const [activeId, setActiveId] = useState(defaultId)
  const system = rankingSystems.find((s) => s.id === activeId) ?? rankingSystems[0]
  const selected = rankFilter?.[activeId] ?? []
  const range = rankRanges?.[activeId] ?? null

  // Ascending by VALUE — the scale's own order — through the shared helper that
  // every progression reader already uses, rather than a second sort here.
  // Nothing sorts `levels` on write, so the stored array can be out of order;
  // BOTH views below render from this one, so the tick-list and the range picker
  // cannot disagree about which belt is higher.
  const ordered = useMemo(() => (system ? orderedLevels(system) : []), [system])

  // MODE IS STATE, NOT A DERIVATION of "is a band stored". Deriving it meant the
  // panel flipped itself back to the tick-list the moment the band went inert —
  // so setting From to "Any" while To was still "Any" (the natural order for
  // building "Blue and below") deleted the filter and swapped the UI underneath
  // the user mid-edit.
  const [mode, setMode] = useState<'levels' | 'range'>(range ? 'range' : 'levels')

  // What was ticked before the user tried Range. Switching back restores it,
  // instead of handing back the band's EXPANSION — which is every level the band
  // covered, and would silently widen a two-belt filter to "anyone with a rank"
  // (and any dynamic group saved from it).
  const ticksBeforeRange = useRef<number[] | null>(null)

  /**
   * ONE writer of both keys.
   *
   * A band is the truth and `rankFilter[systemId]` is its mirror, written here
   * with `expandRankRange` so a resolver that predates bands still filters
   * correctly during a deploy skew (see RankRangeFilter in @linyup/shared).
   * Writing the mirror anywhere else, or by hand, is how the two drift.
   */
  function commit(nextLevels: number[], nextRange: RankRangeFilter | null) {
    const filters: RankFilter = { ...(rankFilter ?? {}) }
    const ranges: Record<string, RankRangeFilter> = { ...(rankRanges ?? {}) }

    const expanded =
      nextRange && (nextRange.min != null || nextRange.max != null)
        ? expandRankRange(system?.levels ?? [], nextRange)
        : null

    // THE INVARIANT: a band is stored only WITH a non-empty mirror. An empty
    // mirror reads as "dimension off" to every `length > 0` guard in the app and
    // to any resolver that predates bands, so storing a band beside one would
    // mean "nobody" here and "everybody" there. The select clamps so this cannot
    // normally arise; this is the guard that makes it true rather than likely.
    if (expanded && expanded.length > 0) {
      ranges[activeId] = nextRange!
      filters[activeId] = expanded
    } else {
      delete ranges[activeId]
      if (nextLevels.length) filters[activeId] = nextLevels
      else delete filters[activeId]
    }

    // An entry that selects nothing is not a filter. Dropping it keeps every
    // "is this dimension active" test in the app honest — they all count levels.
    Object.keys(filters).forEach((k) => { if (!filters[k].length) delete filters[k] })

    onChange(
      Object.keys(filters).length ? filters : null,
      Object.keys(ranges).length ? ranges : null,
    )
  }

  function toggle(value: number) {
    const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
    commit(next, null)
  }

  function switchMode(next: 'levels' | 'range') {
    if (next === mode) return
    setMode(next)
    if (next === 'range') {
      // Remember the ticks so the trip is reversible, then seed a band that
      // actually filters — an all-open one would store nothing and leave the
      // panel looking broken.
      ticksBeforeRange.current = selected
      commit([], { min: ordered[0]?.value ?? null, max: null })
    } else {
      commit(ticksBeforeRange.current ?? [], null)
      ticksBeforeRange.current = null
    }
  }

  return (
    <div className="min-w-[160px]">
      {rankingSystems.length > 1 && (
        <div className="flex gap-0.5 p-1 border-b mb-1">
          {rankingSystems.map((s) => {
            const count = rankFilter?.[s.id]?.length ?? 0
            return (
              <button key={s.id} type="button" onClick={() => setActiveId(s.id)}
                className={`relative flex-1 px-2 py-1 text-xs font-medium rounded transition-colors ${
                  activeId === s.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                }`}
              >
                {s.name}
                {count > 0 && (
                  <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </button>
            )
          })}
        </div>
      )}
      {/* Ticking every belt individually is not the same question as "Blue and
          above": the tick-list is a snapshot that silently goes wrong the moment
          a belt is inserted into the scale, the band keeps meaning what it said. */}
      <div className="flex gap-0.5 p-0.5 mx-1 mb-1 rounded-md bg-muted/60">
        {(['levels', 'range'] as const).map((m) => (
          <button key={m} type="button" onClick={() => switchMode(m)}
            className={`flex-1 px-2 py-1 text-xs font-medium rounded transition-colors ${
              mode === m ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}>
            {m === 'levels' ? t('filterRankModeLevels') : t('filterRankModeRange')}
          </button>
        ))}
      </div>

      {mode === 'range' ? (
        <div className="px-1 pb-1 space-y-1.5">
          {(['min', 'max'] as const).map((end) => (
            <label key={end} className="flex items-center gap-2 text-xs">
              <span className="w-9 shrink-0 text-muted-foreground">
                {end === 'min' ? t('filterRankFrom') : t('filterRankTo')}
              </span>
              <Select
                value={range?.[end] == null ? '' : String(range[end])}
                onValueChange={(v) => {
                  const picked = v === '' ? null : Number(v)
                  const next: RankRangeFilter = {
                    min: range?.min ?? null,
                    max: range?.max ?? null,
                    [end]: picked,
                  }
                  // CLAMP so the band can never be unsatisfiable. A crossed band
                  // (From above To) expands to NO levels, and an empty mirror is
                  // indistinguishable from "this dimension is off" — every guard
                  // in the app, and in any resolver that predates bands, tests
                  // `length > 0`. The band would then mean "nobody" while the
                  // mirror meant "everybody", which is the one direction this
                  // whole design exists to rule out. Dragging one end past the
                  // other pushes the other end with it, as a range picker should.
                  if (picked != null) {
                    if (end === 'min' && next.max != null && next.max < picked) next.max = picked
                    if (end === 'max' && next.min != null && next.min > picked) next.min = picked
                  }
                  commit([], next)
                }}
              >
                <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
                  <span className="flex flex-1 text-left text-xs truncate">
                    {range?.[end] == null
                      ? t('filterRankAny')
                      : (ordered.find((l) => l.value === range[end])?.label ?? t('filterRankAny'))}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {/* An open end is "any", not a missing answer — so it is a real
                      option with a label, never an empty trigger. */}
                  <SelectItem value="" className="text-xs">{t('filterRankAny')}</SelectItem>
                  {ordered.map((level) => (
                    <SelectItem key={level.value} value={String(level.value)} className="text-xs">
                      {level.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ))}
        </div>
      ) : (
        ordered.map((level) => (
          <button key={level.value} type="button" onClick={() => toggle(level.value)}
            className="flex items-center gap-2.5 w-full px-2 py-1.5 text-sm rounded hover:bg-accent transition-colors text-left"
          >
            <span className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
              selected.includes(level.value) ? 'bg-primary border-primary' : 'border-input'
            }`}>
              {selected.includes(level.value) && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
            </span>
            {level.color && (
              <span className="h-3 w-3 rounded-full shrink-0 border border-border/30"
                style={{ backgroundColor: level.color }} />
            )}
            <span>{level.label}</span>
          </button>
        ))
      )}
    </div>
  )
}

// ─── age + custom-field editors ───────────────────────────────────────────────

function AgeFilterContent({ value, onChange }: {
  value: AgeFilter | null; onChange: (v: AgeFilter | null) => void
}) {
  const t = useTranslations('Contacts')
  const age: AgeFilter = value ?? { mode: 'age', min: null, max: null }

  function patch(next: Partial<AgeFilter>) {
    const merged = { ...age, ...next }
    onChange(merged.min == null && merged.max == null && !merged.includeUnknown ? null : merged)
  }

  return (
    <div className="min-w-[210px] p-1 space-y-1.5">
      {/* Age vs birth year are different questions: rosters and competition
          categories are year-based, so a December and a January child share a
          category all season even though their ages differ for most of it. */}
      <div className="flex gap-0.5 p-0.5 rounded-md bg-muted/60">
        {(['age', 'birth_year'] as const).map((m) => (
          <button key={m} type="button" onClick={() => patch({ mode: m, min: null, max: null })}
            className={`flex-1 px-2 py-1 text-xs font-medium rounded transition-colors ${
              age.mode === m ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}>
            {m === 'age' ? t('filterAgeModeAge') : t('filterAgeModeBirthYear')}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5 px-0.5">
        <Input type="number" inputMode="numeric"
          placeholder={age.mode === 'age' ? t('filterAgeMin') : t('filterBirthYearMin')}
          value={age.min ?? ''}
          onChange={(e) => patch({ min: e.target.value ? Number(e.target.value) : null })}
          className="h-7 text-xs w-24" />
        <span className="text-xs text-muted-foreground">–</span>
        <Input type="number" inputMode="numeric"
          placeholder={age.mode === 'age' ? t('filterAgeMax') : t('filterBirthYearMax')}
          value={age.max ?? ''}
          onChange={(e) => patch({ max: e.target.value ? Number(e.target.value) : null })}
          className="h-7 text-xs w-24" />
      </div>
      {/* A missing birthdate is common; dropping those contacts silently is the
          kind of thing nobody notices until a roster is wrong. */}
      <CheckOption label={t('filterAgeIncludeUnknown')} checked={age.includeUnknown === true}
        onToggle={() => patch({ includeUnknown: !age.includeUnknown })} />
    </div>
  )
}

const CUSTOM_FIELD_OPS: Record<CustomFieldType, CustomFieldOp[]> = {
  text:     ['contains', 'equals', 'is_set', 'is_empty'],
  select:   ['equals', 'is_set', 'is_empty'],
  number:   ['equals', 'gt', 'lt', 'is_set', 'is_empty'],
  date:     ['gt', 'lt', 'equals', 'is_set', 'is_empty'],
  checkbox: ['equals', 'is_set', 'is_empty'],
}

function CustomFieldsFilterContent({ defs, value, onChange }: {
  defs: CustomFieldDefinition[]
  value: CustomFieldCondition[]
  onChange: (v: CustomFieldCondition[]) => void
}) {
  const t = useTranslations('Contacts')

  function update(i: number, patch: Partial<CustomFieldCondition>) {
    onChange(value.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }
  function addCondition() {
    const first = defs[0]
    if (!first) return
    onChange([...value, { fieldId: first.id, op: CUSTOM_FIELD_OPS[first.type][0] }])
  }

  return (
    <div className="min-w-[280px] p-1 space-y-1.5">
      {value.map((cond, i) => {
        const def = defs.find((d) => d.id === cond.fieldId)
        const ops = def ? CUSTOM_FIELD_OPS[def.type] : (['equals'] as CustomFieldOp[])
        const needsValue = cond.op !== 'is_set' && cond.op !== 'is_empty'
        return (
          <div key={i} className="flex items-center gap-1">
            <Select value={cond.fieldId}
              onValueChange={(v) => {
                const next = defs.find((d) => d.id === v)
                update(i, { fieldId: v ?? '', op: next ? CUSTOM_FIELD_OPS[next.type][0] : 'equals', value: undefined })
              }}>
              <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
                <span className="flex flex-1 text-left text-xs truncate">{def?.label ?? cond.fieldId}</span>
              </SelectTrigger>
              <SelectContent>
                {defs.map((d) => <SelectItem key={d.id} value={d.id} className="text-xs">{d.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={cond.op}
              onValueChange={(v) => update(i, { op: (v ?? 'equals') as CustomFieldOp, value: undefined })}>
              <SelectTrigger className="h-7 w-28 shrink-0 text-xs">
                <span className="flex flex-1 text-left text-xs truncate">
                  {t(`customFieldOp_${cond.op}` as Parameters<typeof t>[0])}
                </span>
              </SelectTrigger>
              <SelectContent>
                {ops.map((op) => (
                  <SelectItem key={op} value={op} className="text-xs">
                    {t(`customFieldOp_${op}` as Parameters<typeof t>[0])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {needsValue && (
              def?.type === 'select' ? (
                <Select value={String(cond.value ?? '')}
                  onValueChange={(v) => update(i, { value: v ?? '' })}>
                  <SelectTrigger className="h-7 w-24 shrink-0 text-xs">
                    <span className="flex flex-1 text-left text-xs truncate">
                      {String(cond.value ?? '') || '—'}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {(def.options ?? []).map((o) => (
                      <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : def?.type === 'checkbox' ? (
                <Select value={cond.value === true ? 'true' : 'false'}
                  onValueChange={(v) => update(i, { value: v === 'true' })}>
                  <SelectTrigger className="h-7 w-24 shrink-0 text-xs">
                    <span className="flex flex-1 text-left text-xs truncate">
                      {cond.value === true ? t('customFieldYes') : t('customFieldNo')}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true" className="text-xs">{t('customFieldYes')}</SelectItem>
                    <SelectItem value="false" className="text-xs">{t('customFieldNo')}</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type={def?.type === 'number' ? 'number' : def?.type === 'date' ? 'date' : 'text'}
                  value={String(cond.value ?? '')}
                  onChange={(e) => update(i, { value: def?.type === 'number' ? Number(e.target.value) : e.target.value })}
                  className="h-7 w-24 shrink-0 text-xs" />
              )
            )}
            <button type="button" onClick={() => onChange(value.filter((_, idx) => idx !== i))}
              className="shrink-0 p-1 text-muted-foreground hover:text-destructive transition-colors">
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
      <button type="button" onClick={addCondition}
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground">
        <Plus className="h-3 w-3" />{t('customFieldAddCondition')}
      </button>
    </div>
  )
}

/**
 * The consent dimension's popover: ONE document × the states its signature may
 * be in.
 *
 * The states are `waiverAcceptanceState`'s five and are listed in its fixed
 * order, so the picker cannot suggest a state machine the gate does not have.
 * Choosing a document with no state selected preselects "Not signed" — the
 * question a studio comes here to ask.
 */
function ConsentFilterContent({ documents, value, onChange }: {
  documents: AskedDocument[]
  value: ConsentFilter | null
  onChange: (v: ConsentFilter | null) => void
}) {
  const t = useTranslations('Contacts')
  // The five state names are owned by the Waivers namespace, which is where the
  // chip, the signers table and the contact tab read them. One vocabulary: a
  // filter that called `superseded` something else would describe a different
  // product from the tab beside it.
  const tWaivers = useTranslations('Waivers')
  const documentId = value?.documentId || documents[0]?.documentId || ''
  const states = value?.states ?? []
  const selected = documents.find((d) => d.documentId === documentId)

  const setDocument = (id: string) =>
    onChange({ documentId: id, states: states.length ? states : ['none'] })
  const toggleState = (s: WaiverAcceptanceState) =>
    onChange({
      documentId,
      states: states.includes(s) ? states.filter((x) => x !== s) : [...states, s],
    })

  return (
    <div className="min-w-[260px] p-1 space-y-1.5">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 py-0.5">
        {t('filterConsentDocument')}
      </p>
      <Select value={documentId} onValueChange={(v) => setDocument(v ?? '')}>
        <SelectTrigger className="h-7 w-full text-xs">
          <span className="flex flex-1 text-left text-xs truncate">
            {selected?.title ?? t('filterConsentDocument')}
          </span>
        </SelectTrigger>
        <SelectContent>
          {documents.map((d) => (
            <SelectItem key={d.documentId} value={d.documentId} className="text-xs">
              {d.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="border-t my-1.5 mx-1" />
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 py-0.5">
        {t('filterConsentState')}
      </p>
      {CONSENT_STATES.map((s) => (
        <CheckOption
          key={s}
          label={tWaivers(`state_${s}` as 'state_none')}
          checked={states.includes(s)}
          onToggle={() => toggleState(s)}
        />
      ))}
      {/* A signup-only document records a tick and refuses nobody. Saying so
          here keeps the filter honest about what "not signed" costs that
          person: nothing, until the studio also requires it before booking. */}
      {selected && !selected.requiredBeforeBooking && (
        <p className="px-2 pt-1.5 text-[11px] leading-snug text-muted-foreground">
          {t('filterConsentSignupOnly')}
        </p>
      )}
    </div>
  )
}

/** `waiverAcceptanceState`'s five, in its fixed order. */
const CONSENT_STATES: WaiverAcceptanceState[] = [
  'none',
  'revoked',
  'superseded',
  'expired',
  'valid',
]

// ─── filter bar ───────────────────────────────────────────────────────────────
// Every dimension is declared once here, then rendered only when it carries a
// value or the user explicitly added it. With 13 dimensions an always-on chip
// row was a wall; the "Add filter" menu keeps the bar to what's in play.

/**
 * Are two filters the same? Compared on a key-SORTED normalization: a plain
 * JSON.stringify depends on key insertion order, so a preset saved before a new
 * dimension existed would never light up as active after being backfilled.
 */
function sameFilter(a: Partial<ContactFilter>, b: Partial<ContactFilter>): boolean {
  const stable = (f: Partial<ContactFilter>) => {
    const n = normalizeContactFilter(f) as unknown as Record<string, unknown>
    return JSON.stringify(Object.keys(n).sort().map((k) => [k, n[k]]))
  }
  return stable(a) === stable(b)
}

interface FilterDimension {
  key: string
  label: string
  /** Hidden entirely when false — plugin not installed, or no data to pick from. */
  available: boolean
  isActive: (f: Filters) => boolean
  clear: (f: Filters) => Filters
  activeLabel?: (f: Filters) => string
  /** Boolean dimensions render as a ToggleChip instead of a popover. */
  toggle?: (f: Filters) => Filters
  icon?: React.ElementType
  render?: (f: Filters, onChange: (f: Filters) => void) => React.ReactNode
}

function FilterChips({
  filters, onChange, subscriptionTypes, teamId, rankingSystems, contactGroups,
  allTags, customFieldDefs, consentDocuments, onSaveAsGroup,
}: {
  filters: Filters; onChange: (f: Filters) => void
  subscriptionTypes: SubscriptionType[]; teamId: string | null
  rankingSystems: RankingSystem[]
  contactGroups: ContactGroup[] | null  // null = plugin not installed
  allTags: string[]
  customFieldDefs: CustomFieldDefinition[]
  /** Everything this studio asks anybody to accept — both surfaces. Empty = the
   *  dimension is not offered, because there is nothing to ask about. */
  consentDocuments: AskedDocument[]
  onSaveAsGroup?: () => void
}) {
  const t = useTranslations('Contacts')
  // See ConsentFilterContent: the five acceptance-state names live once, in the
  // Waivers namespace.
  const tWaivers = useTranslations('Waivers')
  // The assignable staff — the same roster the contact detail page assigns from
  // (`CoachAssignment`), so the filter can only offer people who could actually
  // be in `assigned_coach_ids`.
  const { pickable: coachOptions } = useCoaches(teamId)
  const { saved, save, remove, togglePin, pinnedPresets, togglePresetPin } = useSavedQueries(teamId)
  const presets = usePresets()
  const pinnedQueries = [
    ...presets.filter((q) => pinnedPresets.includes(q.id)),
    ...saved.filter((q) => q.pinned),
  ]

  // Dimensions the user added but hasn't given a value to yet. Removing a chip
  // drops it from here too, so the bar never keeps an empty leftover.
  const [revealed, setRevealed] = useState<string[]>([])
  const [justAdded, setJustAdded] = useState<string | null>(null)

  const STAGE_OPTS  = (ACQUISITION_STAGES as readonly AcquisitionStage[]).map((v) => ({ value: v, label: t(`stage_${v}` as Parameters<typeof t>[0]) }))
  const SOURCE_OPTS = (CONTACT_SOURCES as readonly ContactSource[]).map((v) => ({ value: v, label: t(`source_${v}` as Parameters<typeof t>[0]) }))
  const AFFIL_OPTS = [
    { value: 'active', label: t('filterAffiliationActive') },
    { value: 'none', label: t('filterAffiliationNone') },
  ]
  const SUB_OPTS    = [{ value: 'none', label: t('filterSubscriptionNone') }, ...subscriptionTypes.map((s) => ({ value: s.id, label: s.name }))]
  const INACTIVITY_OPTS: { value: InactivityPreset; label: string }[] = [
    { value: 'never', label: t('filterInactivityNever') },
    { value: '30d',   label: t('filterInactivity30d') },
    { value: '60d',   label: t('filterInactivity60d') },
    { value: '90d',   label: t('filterInactivity90d') },
  ]
  const ENGAGEMENT_OPTS = (ENGAGEMENT_BANDS as readonly EngagementBand[]).map((v) => ({
    value: v, label: t(`engagement_${v}` as Parameters<typeof t>[0]), dot: ENGAGEMENT_DOT[v],
  }))

  function chip(arr: string[], opts: { value: string; label: string }[], noun: string) {
    if (!arr.length) return ''
    return arr.length === 1 ? (opts.find((o) => o.value === arr[0])?.label ?? arr[0]) : `${arr.length} ${noun}`
  }

  function toggle<T extends string>(arr: T[], v: T): T[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]
  }

  const DIMENSIONS: FilterDimension[] = [
    {
      key: 'acquisition',
      label: t('filterAcquisition'),
      available: true,
      isActive: (f) => f.stages.length > 0 || f.sources.length > 0,
      clear: (f) => ({ ...f, stages: [], sources: [] }),
      activeLabel: (f) => {
        const parts: string[] = []
        if (f.stages.length) parts.push(chip(f.stages, STAGE_OPTS, t('filterStagesNoun')))
        if (f.sources.length) parts.push(chip(f.sources, SOURCE_OPTS, t('filterSourcesNoun')))
        return parts.join(' · ')
      },
      render: (f, set) => (
        <div className="p-1 space-y-0.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 py-0.5">{t('filterStage')}</p>
          {STAGE_OPTS.map((o) => <CheckOption key={o.value} label={o.label} checked={f.stages.includes(o.value)}
            onToggle={() => set({ ...f, stages: toggle(f.stages, o.value) })} />)}
          <div className="border-t my-1.5 mx-1" />
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 py-0.5">{t('filterSource')}</p>
          {SOURCE_OPTS.map((o) => <CheckOption key={o.value} label={o.label} checked={f.sources.includes(o.value)}
            onToggle={() => set({ ...f, sources: toggle(f.sources, o.value) })} />)}
        </div>
      ),
    },
    {
      key: 'statuses',
      label: t('filterAffiliation'),
      available: true,
      isActive: (f) => f.statuses.length > 0,
      clear: (f) => ({ ...f, statuses: [] }),
      activeLabel: (f) => chip(f.statuses, AFFIL_OPTS, t('filterAffiliationsNoun')),
      render: (f, set) => AFFIL_OPTS.map((o) => (
        <CheckOption key={o.value} label={o.label} checked={f.statuses.includes(o.value)}
          onToggle={() => set({ ...f, statuses: toggle(f.statuses, o.value) })} />
      )),
    },
    {
      key: 'rankFilter',
      label: t('filterRank'),
      available: rankingSystems.length > 0,
      // The SHARED answer, not a local one. Counting levels here while
      // `activeFilterKeys` counted band-or-mirror was a second opinion, and the
      // two disagreed exactly when it hurt: an empty result list, a badge
      // reading 1, and no chip on screen to clear.
      isActive: (f) => rankFilterIsActive(f),
      clear: (f) => ({ ...f, rankFilter: null, rankRanges: null }),
      activeLabel: (f) => {
        const rf = f.rankFilter
        if (!rf) return ''
        const active = Object.entries(rf).filter(([, lvls]) => lvls.length > 0)
        if (!active.length) return ''
        const total = active.reduce((n, [, lvls]) => n + lvls.length, 0)
        if (active.length === 1) {
          const [systemId, levels] = active[0]
          const sys = rankingSystems.find((s) => s.id === systemId)
          const prefix = rankingSystems.length > 1 ? `${sys?.name ?? ''}: ` : ''
          // A BAND NAMES ITS BOUNDS, never its expansion: "Blue and above" is
          // what the studio asked for, and "6 ranks" is an implementation
          // detail of it that also goes stale the moment a belt is added.
          const range = f.rankRanges?.[systemId]
          if (sys && range && (range.min != null || range.max != null)) {
            const name = (v: number | null) =>
              v == null ? null : sys.levels.find((l) => l.value === v)?.label ?? null
            const lo = name(range.min)
            const hi = name(range.max)
            // A bound whose level was deleted has no name; fall back rather than
            // render an empty string where a belt should be.
            if (range.max == null && lo) return `${prefix}${t('filterRankAtLeast', { level: lo })}`
            if (range.min == null && hi) return `${prefix}${t('filterRankAtMost', { level: hi })}`
            if (lo && hi) return `${prefix}${t('filterRankBetween', { from: lo, to: hi })}`
          }
          if (sys && levels.length === 1)
            return sys.levels.find((l) => l.value === levels[0])?.label ?? t('filterRanksCount', { count: 1 })
          return `${prefix}${t('filterRanksCount', { count: levels.length })}`
        }
        return t('filterRanksCount', { count: total })
      },
      render: (f, set) => (
        <RankFilterContent rankingSystems={rankingSystems} rankFilter={f.rankFilter}
          rankRanges={f.rankRanges ?? null}
          onChange={(rf, rr) => set({ ...f, rankFilter: rf, rankRanges: rr })} />
      ),
    },
    {
      key: 'subscriptions',
      label: t('filterSubscription'),
      available: true,
      isActive: (f) => f.subscriptions.length > 0,
      clear: (f) => ({ ...f, subscriptions: [] }),
      activeLabel: (f) => chip(f.subscriptions, SUB_OPTS, t('filterSubscriptionsNoun')),
      render: (f, set) => SUB_OPTS.map((o) => (
        <CheckOption key={o.value} label={o.label} checked={f.subscriptions.includes(o.value)}
          onToggle={() => set({ ...f, subscriptions: toggle(f.subscriptions, o.value) })} />
      )),
    },
    {
      key: 'groups',
      label: t('filterGroups'),
      available: !!contactGroups && contactGroups.length > 0,
      isActive: (f) => f.groups.length > 0,
      clear: (f) => ({ ...f, groups: [] }),
      activeLabel: (f) =>
        chip(
          f.groups,
          [
            { value: GROUP_NONE, label: t('filterGroupNone') },
            ...(contactGroups ?? []).map((g) => ({ value: g.id, label: g.name })),
          ],
          t('filterGroupsNoun')
        ),
      render: (f, set) => (
        <>
          {/* "In no group" — who has fallen through the studio's own
              segmentation. Resolved against DYNAMIC groups too (the predicate
              asks every group, it never reads a stored flag), which is why it
              belongs in this dimension rather than being a separate toggle. */}
          <CheckOption
            label={t('filterGroupNone')}
            checked={f.groups.includes(GROUP_NONE)}
            onToggle={() => set({ ...f, groups: toggle(f.groups, GROUP_NONE) })} />
          <div className="border-t my-1.5 mx-1" />
          {flattenGroupTree(contactGroups ?? []).map(({ group, depth }) => (
            <div key={group.id} style={{ paddingLeft: `${depth * 14}px` }}>
              <CheckOption
                label={group.name}
                // A dynamic group resolves its rule at read time; the dot marks it
                // so a manual and a derived group are never confused in a picker.
                dot={isDynamicGroup(group) ? 'bg-violet-500' : undefined}
                checked={f.groups.includes(group.id)}
                onToggle={() => set({ ...f, groups: toggle(f.groups, group.id) })} />
            </div>
          ))}
        </>
      ),
    },
    {
      key: 'coaches',
      label: t('filterCoach'),
      // Offered once there is more than one person it could distinguish — a
      // solo owner filtering by "assigned to me" narrows nothing.
      available: coachOptions.length > 1,
      isActive: (f) => f.coaches.length > 0,
      clear: (f) => ({ ...f, coaches: [] }),
      activeLabel: (f) =>
        chip(
          f.coaches,
          [
            { value: COACH_NONE, label: t('filterCoachNone') },
            ...coachOptions.map((c) => ({ value: c.userId, label: coachLabel(c) })),
          ],
          t('filterCoachesNoun')
        ),
      render: (f, set) => (
        <>
          <CheckOption
            label={t('filterCoachNone')}
            checked={f.coaches.includes(COACH_NONE)}
            onToggle={() => set({ ...f, coaches: toggle(f.coaches, COACH_NONE) })} />
          <div className="border-t my-1.5 mx-1" />
          {coachOptions.map((c) => (
            <CheckOption
              key={c.userId}
              label={coachLabel(c)}
              checked={f.coaches.includes(c.userId)}
              onToggle={() => set({ ...f, coaches: toggle(f.coaches, c.userId) })} />
          ))}
        </>
      ),
    },
    {
      key: 'age',
      label: t('filterAge'),
      available: true,
      isActive: (f) => !!f.age && (f.age.min != null || f.age.max != null),
      clear: (f) => ({ ...f, age: null }),
      activeLabel: (f) => {
        const a = f.age
        if (!a || (a.min == null && a.max == null)) return ''
        const range = a.min != null && a.max != null ? `${a.min}–${a.max}`
          : a.min != null ? `${a.min}+`
          : `≤${a.max}`
        return a.mode === 'birth_year' ? `${t('filterAgeModeBirthYear')} ${range}` : `${t('filterAge')} ${range}`
      },
      render: (f, set) => (
        <AgeFilterContent value={f.age} onChange={(age) => set({ ...f, age })} />
      ),
    },
    {
      key: 'tags',
      label: t('filterTags'),
      available: allTags.length > 0,
      isActive: (f) => f.tags.length > 0,
      clear: (f) => ({ ...f, tags: [] }),
      activeLabel: (f) => chip(f.tags, allTags.map((tg) => ({ value: tg, label: tg })), t('filterTagsNoun')),
      render: (f, set) => (
        <div className="max-h-64 overflow-y-auto">
          {allTags.map((tg) => (
            <CheckOption key={tg} label={tg} checked={f.tags.includes(tg)}
              onToggle={() => set({ ...f, tags: toggle(f.tags, tg) })} />
          ))}
        </div>
      ),
    },
    {
      key: 'activity',
      label: t('filterActivity'),
      available: true,
      isActive: (f) => f.inactivity !== null || f.sessionsMin !== null || f.sessionsMax !== null,
      clear: (f) => ({ ...f, inactivity: null, sessionsMin: null, sessionsMax: null }),
      activeLabel: (f) => {
        const parts: string[] = []
        if (f.inactivity) parts.push(INACTIVITY_OPTS.find((o) => o.value === f.inactivity)?.label ?? '')
        if (f.sessionsMin != null && f.sessionsMax != null) parts.push(t('filterSessionsRange', { min: f.sessionsMin, max: f.sessionsMax }))
        else if (f.sessionsMin != null) parts.push(t('filterSessionsMinOnly', { min: f.sessionsMin }))
        else if (f.sessionsMax != null) parts.push(t('filterSessionsMaxOnly', { max: f.sessionsMax }))
        return parts.join(' · ')
      },
      render: (f, set) => (
        <div className="p-1 space-y-0.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 py-0.5">{t('filterLastActive')}</p>
          {INACTIVITY_OPTS.map((o) => (
            <button key={o.value} type="button"
              onClick={() => set({ ...f, inactivity: f.inactivity === o.value ? null : o.value })}
              className={`flex items-center gap-2.5 w-full px-2 py-1.5 text-sm rounded hover:bg-accent transition-colors text-left ${f.inactivity === o.value ? 'font-medium' : 'text-muted-foreground'}`}
            >
              <span className={`h-3.5 w-3.5 rounded-full border flex items-center justify-center shrink-0 ${f.inactivity === o.value ? 'bg-primary border-primary' : 'border-input'}`}>
                {f.inactivity === o.value && <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
              </span>
              {o.label}
            </button>
          ))}
          <div className="border-t my-1.5 mx-1" />
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 py-0.5">{t('filterSessions')}</p>
          <div className="flex items-center gap-1.5 px-1 pb-1">
            <Input type="number" min="0" placeholder={t('filterSessionsMin')}
              value={f.sessionsMin ?? ''}
              onChange={(e) => set({ ...f, sessionsMin: e.target.value ? Number(e.target.value) : null })}
              className="h-7 text-xs w-20" />
            <span className="text-xs text-muted-foreground">–</span>
            <Input type="number" min="0" placeholder={t('filterSessionsMax')}
              value={f.sessionsMax ?? ''}
              onChange={(e) => set({ ...f, sessionsMax: e.target.value ? Number(e.target.value) : null })}
              className="h-7 text-xs w-20" />
          </div>
        </div>
      ),
    },
    {
      key: 'engagement',
      label: t('filterEngagement'),
      available: true,
      isActive: (f) => f.engagement.length > 0,
      clear: (f) => ({ ...f, engagement: [] }),
      activeLabel: (f) => chip(f.engagement, ENGAGEMENT_OPTS, t('filterEngagementNoun')),
      render: (f, set) => ENGAGEMENT_OPTS.map((o) => (
        <CheckOption key={o.value} label={o.label} dot={o.dot} checked={f.engagement.includes(o.value)}
          onToggle={() => set({ ...f, engagement: toggle(f.engagement, o.value) })} />
      )),
    },
    {
      key: 'customFields',
      label: t('filterCustomFields'),
      available: customFieldDefs.length > 0,
      isActive: (f) => f.customFields.length > 0,
      clear: (f) => ({ ...f, customFields: [] }),
      activeLabel: (f) => {
        if (!f.customFields.length) return ''
        if (f.customFields.length === 1) {
          return customFieldDefs.find((d) => d.id === f.customFields[0].fieldId)?.label ?? t('filterCustomFields')
        }
        return `${f.customFields.length} ${t('filterCustomFieldsNoun')}`
      },
      render: (f, set) => (
        <CustomFieldsFilterContent defs={customFieldDefs} value={f.customFields}
          onChange={(customFields) => set({ ...f, customFields })} />
      ),
    },
    {
      // CONSENT — "who has, and who has not, accepted this document". The whole
      // point of putting it here rather than on a screen of its own: it is one
      // dimension of the ONE predicate, so it is simultaneously a chip, a saved
      // preset, a dynamic group and an automation condition.
      key: 'consent',
      label: t('filterConsent'),
      available: consentDocuments.length > 0,
      icon: ShieldCheck,
      isActive: (f) => !!f.consent?.documentId && f.consent.states.length > 0,
      clear: (f) => ({ ...f, consent: null }),
      activeLabel: (f) => {
        if (!f.consent?.documentId || !f.consent.states.length) return ''
        const title =
          consentDocuments.find((d) => d.documentId === f.consent!.documentId)?.title ?? ''
        const states =
          f.consent.states.length === 1
            ? tWaivers(`state_${f.consent.states[0]}` as 'state_none')
            : `${f.consent.states.length} ${t('filterConsentStatesNoun')}`
        return title ? `${title}: ${states}` : states
      },
      render: (f, set) => (
        <ConsentFilterContent
          documents={consentDocuments}
          value={f.consent}
          onChange={(consent) => set({ ...f, consent })}
        />
      ),
    },
    {
      key: 'hasAlerts',
      label: t('filterAlertsLabel'),
      available: true,
      icon: AlertCircle,
      isActive: (f) => f.hasAlerts,
      clear: (f) => ({ ...f, hasAlerts: false }),
      toggle: (f) => ({ ...f, hasAlerts: !f.hasAlerts }),
    },
    {
      // Reads `notes_count`, maintained by the trackContactNotes trigger — the
      // predicate never leaves the contact document it was handed.
      key: 'hasNotes',
      label: t('filterNotesLabel'),
      available: true,
      icon: StickyNote,
      isActive: (f) => f.hasNotes,
      clear: (f) => ({ ...f, hasNotes: false }),
      toggle: (f) => ({ ...f, hasNotes: !f.hasNotes }),
    },
    {
      // The campaign filter: who a studio cannot reach or identify by mail.
      // Pair it with "Print QR slips" and an owner hands out only the slips
      // somebody actually needs — otherwise "Select all" prints the roster.
      key: 'missingEmail',
      label: t('filterMissingEmail'),
      available: true,
      icon: MailX,
      isActive: (f) => f.missingEmail,
      clear: (f) => ({ ...f, missingEmail: false }),
      toggle: (f) => ({ ...f, missingEmail: !f.missingEmail }),
    },
    {
      key: 'pendingSignup',
      label: t('filterPendingSignup'),
      available: true,
      icon: UserCheck,
      isActive: (f) => f.pendingSignup,
      clear: (f) => ({ ...f, pendingSignup: false }),
      toggle: (f) => ({ ...f, pendingSignup: !f.pendingSignup }),
    },
    {
      // The filter twin of the "Needs attention" SORT — same predicate, and it
      // is a filter dimension rather than a one-off so it saves as a preset, a
      // dynamic group and an automation condition for free.
      key: 'needsAttention',
      label: t('filterNeedsAttention'),
      available: true,
      icon: AlertCircle,
      isActive: (f) => f.needsAttention,
      clear: (f) => ({ ...f, needsAttention: false }),
      toggle: (f) => ({ ...f, needsAttention: !f.needsAttention }),
    },
  ]

  const visible = DIMENSIONS.filter((d) => d.available && (d.isActive(filters) || revealed.includes(d.key)))
  const addable = DIMENSIONS.filter((d) => d.available && !visible.includes(d))

  function addDimension(dim: FilterDimension) {
    setRevealed((r) => (r.includes(dim.key) ? r : [...r, dim.key]))
    setJustAdded(dim.key)
    // A boolean dimension has nothing to pick, so adding it turns it on.
    if (dim.toggle) onChange(dim.toggle(filters))
  }

  function removeDimension(dim: FilterDimension) {
    setRevealed((r) => r.filter((k) => k !== dim.key))
    if (dim.key === justAdded) setJustAdded(null)
    onChange(dim.clear(filters))
  }

  function clearAll() {
    setRevealed([])
    setJustAdded(null)
    // Keep the search box — it has its own visible input and its own ×.
    onChange({ ...emptyContactFilter(), search: filters.search })
  }

  // Search is excluded: it has its own visible input and its own ×, and
  // clearAll deliberately leaves it alone — so counting it here would leave a
  // "Clear filters" button that appears to do nothing.
  const activeCount = countActiveFilters({ ...filters, search: '' })

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SavedMenu filters={filters} onChange={onChange} saved={saved} save={save} remove={remove}
        togglePin={togglePin} pinnedPresets={pinnedPresets} togglePresetPin={togglePresetPin}
        onSaveAsGroup={onSaveAsGroup} />

      {pinnedQueries.map((q) => {
        const isActive = sameFilter(filters, q.filters)
        return (
          <button key={q.id} type="button"
            onClick={() => onChange(isActive ? EMPTY_FILTERS : normalizeContactFilter(q.filters))}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              isActive
                ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/15'
                : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-border'
            }`}
          >
            <Eye className="h-3 w-3 opacity-50 shrink-0" />
            {q.name}
            {isActive && (
              <span role="button" aria-label={t('clearFilters')}
                onClick={(e) => { e.stopPropagation(); clearAll() }}
                className="rounded-full p-0.5 hover:bg-primary/20 -mr-0.5"
              ><X className="h-3 w-3" /></span>
            )}
          </button>
        )
      })}

      {visible.length > 0 && <div className="h-5 w-px bg-border/50 shrink-0 mx-0.5" />}

      {visible.map((dim) => dim.toggle ? (
        <ToggleChip key={dim.key} label={dim.label} icon={dim.icon ?? AlertCircle}
          isActive={dim.isActive(filters)}
          onToggle={() => onChange(dim.toggle!(filters))}
          onRemove={() => removeDimension(dim)} />
      ) : (
        <FilterChip key={dim.key} label={dim.label}
          activeLabel={dim.activeLabel?.(filters)}
          isActive={dim.isActive(filters)}
          openOnMount={dim.key === justAdded}
          onClear={() => removeDimension(dim)}>
          {dim.render?.(filters, onChange)}
        </FilterChip>
      ))}

      {addable.length > 0 && <AddFilterMenu dimensions={addable} onAdd={addDimension} />}

      {activeCount > 0 && (
        <>
          <div className="h-5 w-px bg-border/50 shrink-0 mx-0.5" />
          <button type="button" onClick={clearAll}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border border-destructive/30 text-destructive/80 hover:text-destructive hover:bg-destructive/5 hover:border-destructive/50 transition-colors">
            <X className="h-3 w-3" />{t('clearFilters')}
          </button>
        </>
      )}
    </div>
  )
}

function AddFilterMenu({ dimensions, onAdd }: {
  dimensions: FilterDimension[]; onAdd: (d: FilterDimension) => void
}) {
  const t = useTranslations('Contacts')
  const { open, onOpenChange } = useScrollLockOnOpen()
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border border-dashed border-border/70 text-muted-foreground hover:text-foreground hover:border-border outline-none transition-colors">
        <Plus className="h-3 w-3" />
        {t('addFilter')}
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-48 p-1.5">
        {dimensions.map((d) => (
          <button key={d.key} type="button"
            onClick={() => { onAdd(d); onOpenChange(false) }}
            className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent transition-colors text-left">
            {d.icon ? <d.icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <span className="w-3.5 shrink-0" />}
            <span className="truncate">{d.label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function ContactRow({
  contact,
  selectable,
  selected,
  onSelect,
  rankingSystems = [],
  attentionReason,
}: {
  contact: Contact
  selectable: boolean
  selected: boolean
  onSelect: (id: string) => void
  rankingSystems?: RankingSystem[]
  /** The single most urgent reason this contact is waiting on the studio, or
   *  undefined when the list is not ordered by it (UX-44). */
  attentionReason?: ContactAttentionReason
}) {
  const router = useRouter()
  const { openInNewTab } = useOpenTabs()
  const t = useTranslations('Contacts')
  const isNew = contact.lead_acknowledged === false
  const contactHref = `/contacts/${contact.id}`
  const contactLabel = `${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim() || contactHref
  // ctrl/⌘/middle-click opens the contact in a background tab (keeps the list).
  const openContactInNewTab = () => openInNewTab(contactHref, contactLabel, 'contact')
  // The whole LEVEL, not just its colour — a level may identify itself by an
  // emoji or uploaded artwork instead, and RankBadge decides which one wins.
  const rankLevel = rankingSystems.length > 0
    ? getPrimaryRank(contact, rankingSystems)?.level
    : undefined

  return (
    <div className="flex items-center border-b last:border-0 hover:bg-muted/50 transition-colors">
      <button
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            openContactInNewTab()
            return
          }
          router.push(contactHref as Route)
        }}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault()
            openContactInNewTab()
          }
        }}
        className="flex-1 flex items-center gap-3 px-4 py-3 text-left min-w-0"
      >
        {/* Avatar */}
        <div className="h-10 w-10 rounded-full shrink-0 flex items-center justify-center bg-muted text-muted-foreground text-sm font-semibold relative">
          {initials(contact)}
          {rankLevel && (
            <span className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-background bg-background">
              <RankBadge level={rankLevel} size="sm" />
            </span>
          )}
        </div>

        {/* Text block */}
        <div className="flex-1 min-w-0 space-y-0.5">
          {/* Line 1: name */}
          <p className="font-medium text-sm truncate">
            {contact.firstname} {contact.lastname}
            {isNew && (
              <span className="ml-2 text-xs font-semibold text-blue-500">{t('newBadge')}</span>
            )}
          </p>
          {/* Line 2: email */}
          <p className="text-xs text-muted-foreground flex items-center gap-2 min-w-0">
            <span className="truncate">{contact.email ?? contact.phone ?? '—'}</span>
          </p>
          {/* Line 3: stage + affiliation + subscription chips */}
          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
            {/* Off the roster (Contact.external). Shown on the row itself so the
                same person reads the same way in a session's participant list
                or a search result as on the External tab. */}
            {contact.external === true && (
              <Badge variant="outline" className="text-xs gap-1" title={t('externalHint')}>
                <DoorOpen className="h-3 w-3" />
                {t('externalBadge')}
              </Badge>
            )}
            {contact.acquisition_stage && contact.acquisition_stage !== 'joined' && (
              <Badge variant="outline" className="text-xs">{t(`stage_${contact.acquisition_stage}` as Parameters<typeof t>[0])}</Badge>
            )}
            {contact.pending_signup && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                {t('pendingSignup')}
              </span>
            )}
            {/* Shop registration awaiting payment — the ONLY provisional kind with a
                purge deadline; trial/form leads show their normal stage badges. */}
            {contact.provisional === true && contact.provisional_expires_at != null && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                {t('unconfirmedBadge', {
                  days: Math.max(
                    0,
                    Math.ceil(
                      ((contact.provisional_expires_at?.toDate?.().getTime() ?? Date.now()) - Date.now()) /
                        86_400_000
                    )
                  ),
                })}
              </span>
            )}
            {contact.affiliation_summary?.has_active && (
              <span
                title={`${t('affiliationChip')}${contact.affiliation_summary.types.length ? `: ${contact.affiliation_summary.types.join(', ')}` : ''}`}
                className="inline-flex items-center text-emerald-600 dark:text-emerald-400"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
              </span>
            )}
            {(contact.active_subscriptions?.length ?? 0) > 0 ? (
              <Badge variant="secondary" className="text-xs font-normal">
                {contact.active_subscriptions![0].subscription_type_name ??
                  contact.subscription_type_name}
                {contact.active_subscriptions!.length > 1 &&
                  ` +${contact.active_subscriptions!.length - 1}`}
              </Badge>
            ) : contact.subscription_type_name ? (
              <Badge variant="secondary" className="text-xs font-normal">
                {contact.subscription_type_name}
              </Badge>
            ) : null}
          </div>
        </div>
      </button>

      {/* WHY this row is near the top, shown only while the list is ordered by
          it: an urgency ranking nobody can see the reason for is a ranking
          nobody trusts. */}
      {attentionReason && (
        <span className="shrink-0 px-2 text-[11px] font-medium text-amber-600 dark:text-amber-400">
          {t(`attention_${attentionReason}` as 'attention_alerts')}
        </span>
      )}

      {/* Alerts indicator */}
      {(contact.alerts_count ?? 0) > 0 && (
        <div className="flex items-center gap-1 shrink-0 px-3 text-destructive">
          <AlertCircle className="h-4 w-4" />
          <span className="text-xs font-semibold">{contact.alerts_count}</span>
        </div>
      )}

      {/* Checkbox — right side */}
      {selectable && (
        <label className="pr-4 pl-2 py-3 cursor-pointer shrink-0" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onSelect(contact.id)}
            className="h-4 w-4 rounded border-border"
          />
        </label>
      )}
    </div>
  )
}

// ─── deleted row ──────────────────────────────────────────────────────────────

function DeletedRow({
  contact, selected, onSelect,
}: {
  contact: Contact; selected: boolean; onSelect: (id: string) => void
}) {
  const t = useTranslations('Contacts')
  const days = daysUntilAnonymisation(contact.deleted_at)

  return (
    <div className="flex items-center gap-1 border-b last:border-0 px-4 py-3">
      <label className="mr-2 cursor-pointer">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onSelect(contact.id)}
          className="h-4 w-4 rounded border-border"
        />
      </label>
      <div className="h-10 w-10 rounded-full shrink-0 flex items-center justify-center bg-muted text-muted-foreground text-sm font-semibold">
        {initials(contact)}
      </div>
      <div className="flex-1 min-w-0 ml-3">
        <p className="font-medium text-sm truncate">{contact.firstname} {contact.lastname}</p>
        {days !== null && (
          <p className={`text-xs ${days <= 7 ? 'text-destructive' : 'text-amber-600'}`}>
            {t('deletedDaysLeft', { days })}
          </p>
        )}
      </div>
    </div>
  )
}

// ─── requests tab ─────────────────────────────────────────────────────────────

// Fields a contact may submit in a data-update request (mirrors the function's
// ALLOWED_UPDATE_FIELDS). Used to render the current → requested comparison.
const REQUEST_FIELDS = [
  'firstname', 'lastname', 'phone', 'birthdate', 'gender',
  'birthplace', 'residence', 'emergencyContact', 'notes',
] as const

function formatRequestValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  if (v instanceof Timestamp) return v.toDate().toLocaleDateString()
  if (typeof v === 'object') {
    return Object.values(v as Record<string, unknown>)
      .filter((x) => x !== null && x !== undefined && x !== '')
      .map((x) => String(x))
      .join(' · ')
  }
  return String(v)
}

function ContactRequestDialog({
  request, teamId, onClose, onActioned,
}: {
  request: ContactRequest | null
  teamId: string
  onClose: () => void
  onActioned: () => void
}) {
  const t = useTranslations('Contacts')
  const [busy, setBusy] = useState<null | 'approve' | 'discard'>(null)
  const [error, setError] = useState(false)

  // Current contact values, to show what each requested field would change.
  const { data: contact } = useQuery<Record<string, unknown> | null>({
    queryKey: ['contact-doc', request?.contact_id],
    enabled: !!request?.contact_id,
    queryFn: async () => {
      if (!request?.contact_id) return null
      const snap = await getDoc(doc(db, CONTACTS_COLLECTION, request.contact_id))
      return snap.exists() ? (snap.data() as Record<string, unknown>) : null
    },
  })

  useEffect(() => { setError(false); setBusy(null) }, [request?.id])

  const submitted = request?.submitted_data ?? {}
  const rows = REQUEST_FIELDS
    .map((field) => ({ field, requested: formatRequestValue(submitted[field]) }))
    .filter((r) => r.requested !== '')

  async function act(action: 'approve' | 'discard') {
    if (!request) return
    setBusy(action)
    setError(false)
    try {
      const fn = httpsCallable(functions, 'manageContactUpdateRequest')
      await fn({ teamId, requestId: request.id, action })
      onActioned()
      onClose()
    } catch (e) {
      console.error('manageContactUpdateRequest failed', e)
      setError(true)
      setBusy(null)
    }
  }

  return (
    <Dialog open={!!request} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('reqTitle')}</DialogTitle>
        </DialogHeader>
        {request && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium">{request.contact_name ?? request.contact_id}</p>
              {request.contact_email && (
                <p className="text-xs text-muted-foreground">{request.contact_email}</p>
              )}
              <p className="text-xs text-muted-foreground mt-0.5">
                {request.requested_at?.toDate().toLocaleString()}
              </p>
            </div>

            {request.note && (
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-xs font-medium text-muted-foreground mb-1">{t('reqNote')}</p>
                <p className="text-sm whitespace-pre-wrap">{request.note}</p>
              </div>
            )}

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">{t('reqChanges')}</p>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('reqNoChanges')}</p>
              ) : (
                <div className="divide-y rounded-lg border">
                  {rows.map((r) => {
                    const current = formatRequestValue(contact?.[r.field])
                    const changed = current !== r.requested
                    return (
                      <div key={r.field} className="px-3 py-2">
                        <p className="text-xs font-medium">{t(`reqf_${r.field}`)}</p>
                        <div className="mt-1 grid grid-cols-2 gap-3 text-sm">
                          <div className="min-w-0">
                            <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                              {t('reqCurrent')}
                            </span>
                            <p className="truncate text-muted-foreground">
                              {current || t('reqEmptyValue')}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                              {t('reqRequested')}
                            </span>
                            <p className={`truncate ${changed ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                              {r.requested || t('reqEmptyValue')}
                            </p>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{t('reqError')}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => act('discard')} disabled={busy !== null}>
            {busy === 'discard' ? t('reqProcessing') : t('reqDiscard')}
          </Button>
          <Button onClick={() => act('approve')} disabled={busy !== null}>
            {busy === 'approve' ? t('reqProcessing') : t('reqApprove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RequestsTab({ teamId }: { teamId: string }) {
  const t = useTranslations('Contacts')
  const qc = useQueryClient()
  const { data: allRequests = [], isLoading } = useContactRequests(teamId)
  const requests = allRequests.filter((r) => (r.status ?? 'pending') === 'pending')
  const [selected, setSelected] = useState<ContactRequest | null>(null)

  if (isLoading) return (
    <div className="space-y-2 py-2">
      {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
    </div>
  )
  if (requests.length === 0) return (
    <div className="py-16 text-center text-muted-foreground text-sm">{t('reqEmpty')}</div>
  )
  return (
    <>
      <div className="rounded-xl border overflow-hidden bg-card">
        {requests.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setSelected(r)}
            className="flex w-full items-start gap-3 px-4 py-3 border-b last:border-0 text-left hover:bg-muted/50 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{r.contact_name ?? r.contact_id}</p>
              {r.note && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{r.note}</p>}
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {r.requested_at?.toDate().toLocaleDateString()}
            </span>
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </button>
        ))}
      </div>
      <ContactRequestDialog
        request={selected}
        teamId={teamId}
        onClose={() => setSelected(null)}
        onActioned={() => qc.invalidateQueries({ queryKey: ['contact-requests', teamId] })}
      />
    </>
  )
}

// ─── bulk edit dialogs ────────────────────────────────────────────────────────

function BulkSetRankDialog({
  open, onOpenChange, rankingSystems, count, onConfirm,
}: {
  open: boolean; onOpenChange: (v: boolean) => void
  rankingSystems: RankingSystem[]; count: number
  onConfirm: (systemId: string, value: number | null) => Promise<void>
}) {
  const t = useTranslations('Contacts')
  const [systemId, setSystemId] = useState(rankingSystems[0]?.id ?? '')
  const [level, setLevel] = useState<number | 'clear' | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) { setSystemId(rankingSystems[0]?.id ?? ''); setLevel(null) }
  }, [open, rankingSystems])

  const system = rankingSystems.find((s) => s.id === systemId)
  const useButtons = (system?.levels.length ?? 0) <= 6

  const handleConfirm = async () => {
    if (!systemId || level === null) return
    setBusy(true)
    try { await onConfirm(systemId, level === 'clear' ? null : level); onOpenChange(false) }
    finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{t('bulkSetRankTitle')}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          {rankingSystems.length > 1 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('bulkRankSystem')}</p>
              <div className="flex flex-wrap gap-1.5">
                {rankingSystems.map((s) => (
                  <button key={s.id}
                    onClick={() => { setSystemId(s.id); setLevel(null) }}
                    className={`px-3 py-1 rounded-lg border text-sm font-medium transition-colors ${
                      systemId === s.id ? 'border-primary bg-primary/5 text-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >{s.name}</button>
                ))}
              </div>
            </div>
          )}

          {system && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('bulkRankLevel')}</p>
              {useButtons ? (
                <div className="flex flex-wrap gap-1.5">
                  {system.levels.map((l) => (
                    <button key={l.value}
                      onClick={() => setLevel(level === l.value ? null : l.value)}
                      className={`flex items-center gap-1.5 py-1 px-2.5 rounded-lg border text-sm font-medium transition-colors ${
                        level === l.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {l.color && <div className="h-2.5 w-2.5 rounded-full shrink-0 border border-border" style={{ background: l.color }} />}
                      {l.label}
                    </button>
                  ))}
                </div>
              ) : (
                <Select
                  value={typeof level === 'number' ? String(level) : ''}
                  onValueChange={(v) => setLevel(v === '' ? null : Number(v))}
                >
                  <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {system.levels.map((l) => (
                      <SelectItem key={l.value} value={String(l.value)} textValue={l.label}>
                        <span className="flex items-center gap-2">
                          {l.color && <span className="inline-block h-2.5 w-2.5 rounded-full border border-border" style={{ background: l.color }} />}
                          {l.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <button
                onClick={() => setLevel(level === 'clear' ? null : 'clear')}
                className={`text-xs transition-colors ${level === 'clear' ? 'text-destructive font-medium' : 'text-muted-foreground hover:text-destructive'}`}
              >
                {t('bulkClearRank')}
              </button>
            </div>
          )}
        </div>
        <DialogFooter>
          <button onClick={() => onOpenChange(false)} className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">{t('cancel')}</button>
          <button onClick={handleConfirm} disabled={busy || level === null}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
            {t('bulkApplyTo', { count })}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The "record no price" choice. Not a price id — a deliberate null. */
const NO_PRICE = '__no_price__'

// Bulk plan change.
//
// IT ASKS FOR THE PRICE, and that is the whole repair. It used to write two
// fields — `subscription_type_id` and `subscription_type_name` — and leave
// `subscription_price_id`, `subscription_recurrence` and `subscription_amount`
// exactly as the PREVIOUS plan had set them. So a studio that moved twenty
// members from Basic to Premium believed it had repriced them and had not: the
// contact carried Premium's name at Basic's amount, on Basic's price id.
//
// That was never only a display bug. `onContactSubscriptionChange` fires on the
// type change and copies those three fields verbatim into the member's
// `subscription_history` entry AND into the team's `subscription_transitions`
// analytics row — so the studio's own record of what it charges was written
// wrong, permanently, at the moment of the change.
//
// Hence: every one of the five fields is written on every apply, including the
// nulls. Choosing "no price" is an option here (some types are just containers,
// and the per-contact dialog allows it too) — but it is a CHOICE the studio
// makes, never the silent survival of the old plan's money.
//
// The intro offer is deliberately not involved. `SubscriptionType.introOffer` is
// a property of the CHECKOUT — a Stripe Coupon minted on the connected account
// by the membership checkout callables — and a bulk assignment is an offline
// record that creates no Stripe subscription. The note below says so rather than
// leaving the studio to assume the discount was applied.
function BulkSetSubscriptionDialog({
  open, onOpenChange, subscriptionTypes, count, currency, onConfirm,
}: {
  open: boolean; onOpenChange: (v: boolean) => void
  subscriptionTypes: SubscriptionType[]; count: number
  currency: string
  onConfirm: (type: SubscriptionType | null, price: SubscriptionPrice | null) => Promise<void>
}) {
  const t = useTranslations('Contacts')
  const tSettings = useTranslations('TeamSettings')
  const [picked, setPicked] = useState<string | null>(null)
  // null = nothing chosen yet; NO_PRICE = "record no price", deliberately.
  const [pickedPrice, setPickedPrice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (open) { setPicked(null); setPickedPrice(null) } }, [open])

  const pickedType = picked && picked !== 'none'
    ? subscriptionTypes.find((s) => s.id === picked) ?? null
    : null
  const activePrices = (pickedType?.prices ?? []).filter((p) => p.active !== false)
  // A type with prices must have one named — otherwise "apply" would again mean
  // "leave the amount to whatever was there".
  const priceChosen = activePrices.length === 0 || pickedPrice !== null
  const selectedPrice =
    pickedPrice && pickedPrice !== NO_PRICE
      ? activePrices.find((p) => p.id === pickedPrice) ?? null
      : null
  const introOffer = pickedType && selectedPrice
    ? resolveIntroOffer(pickedType, selectedPrice.id)
    : null

  const handleConfirm = async () => {
    if (!picked || !priceChosen) return
    setBusy(true)
    const type = picked === 'none' ? null : pickedType
    try { await onConfirm(type, type ? selectedPrice : null); onOpenChange(false) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{t('bulkSetSubscriptionTitle')}</DialogTitle></DialogHeader>
        <div className="space-y-1 py-1 max-h-72 overflow-y-auto">
          <button
            onClick={() => { setPicked(picked === 'none' ? null : 'none'); setPickedPrice(null) }}
            className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${picked === 'none' ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
          >
            <p className="font-medium text-muted-foreground">{t('bulkSubscriptionNone')}</p>
          </button>
          {subscriptionTypes.map((st) => (
            <button key={st.id}
              onClick={() => { setPicked(picked === st.id ? null : st.id); setPickedPrice(null) }}
              className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${picked === st.id ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
            >
              <div className="flex items-center gap-2">
                <p className="font-medium flex-1">{st.name}</p>
                {/* The exception, not the rule — see SubscriptionTypesManager. */}
                {st.source === 'aggregator' && (
                  <Badge variant="secondary" className="text-xs shrink-0">
                    {tSettings('subTypeSourceAggregator')}
                  </Badge>
                )}
              </div>
              {st.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{st.description}</p>}
            </button>
          ))}
          {subscriptionTypes.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">{t('bulkNoSubscriptions')}</p>
          )}

          {/* The price of the plan being moved TO. Without this step the amount
              on every one of these contacts stays whatever their old plan cost. */}
          {activePrices.length > 0 && (
            <div className="pt-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">
                {t('bulkSubscriptionPrice')}
              </p>
              {activePrices.map((p) => (
                <button key={p.id}
                  onClick={() => setPickedPrice(pickedPrice === p.id ? null : p.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${pickedPrice === p.id ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
                >
                  {p.label ? `${p.label} · ` : ''}
                  {formatCurrency(p.amount, currency)} · {t(`recurrence_${p.recurrence}`)}
                </button>
              ))}
              <button
                onClick={() => setPickedPrice(pickedPrice === NO_PRICE ? null : NO_PRICE)}
                className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${pickedPrice === NO_PRICE ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
              >
                <span className="text-muted-foreground">{t('bulkSubscriptionNoPrice')}</span>
              </button>
            </div>
          )}
        </div>

        {/* What the apply will write. Stated because the old behaviour — the
            previous plan's price surviving the move — was invisible until it
            reached the books. */}
        {picked && (
          <p className="text-xs text-muted-foreground">
            {picked === 'none' ? t('bulkSubscriptionClearNote') : t('bulkSubscriptionReplaceNote')}
          </p>
        )}
        {introOffer && (
          <p className="text-xs text-muted-foreground">{t('bulkSubscriptionIntroNote')}</p>
        )}

        <DialogFooter>
          <button onClick={() => onOpenChange(false)} className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">{t('cancel')}</button>
          <button onClick={handleConfirm} disabled={busy || !picked || !priceChosen}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
            {t('bulkApplyTo', { count })}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BulkPromoteStageDialog({
  open, onOpenChange, count, onConfirm,
}: {
  open: boolean; onOpenChange: (v: boolean) => void
  count: number
  onConfirm: (stage: AcquisitionStage) => Promise<void>
}) {
  const t = useTranslations('Contacts')
  const [selected, setSelected] = useState<AcquisitionStage | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (open) setSelected(null) }, [open])

  const handleConfirm = async () => {
    if (!selected) return
    setBusy(true)
    try { await onConfirm(selected); onOpenChange(false) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs">
        <DialogHeader><DialogTitle>{t('bulkSetStageTitle')}</DialogTitle></DialogHeader>
        <div className="py-1">
          <div className="flex gap-2">
            {(ACQUISITION_STAGES as readonly AcquisitionStage[]).map((v) => (
              <button key={v}
                onClick={() => setSelected(selected === v ? null : v)}
                className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  selected === v ? 'bg-primary text-primary-foreground border-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t(`stage_${v}` as Parameters<typeof t>[0])}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <button onClick={() => onOpenChange(false)} className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">{t('cancel')}</button>
          <button onClick={handleConfirm} disabled={busy || !selected}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
            {t('bulkApplyTo', { count })}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── bulk action bar ──────────────────────────────────────────────────────────

interface MoreAction {
  label: string
  icon: React.ElementType
  onClick: () => void
  destructive?: boolean
  disabled?: boolean
}

function BulkBar({
  count, tab, onArchive, onDelete, onRestore, onConfirm, onMarkExternal, onMarkActive, onClear, moreActions = [], editActions = [],
}: {
  count: number; tab: TabId
  onArchive?: () => void; onDelete?: () => void; onRestore?: () => void
  /** Unconfirmed tab: manually confirm provisional contacts (clears the purge deadline). */
  onConfirm?: () => void
  /** Active tab → External tab, and back. See Contact.external. */
  onMarkExternal?: () => void
  onMarkActive?: () => void
  onClear: () => void
  moreActions?: MoreAction[]
  editActions?: MoreAction[]
}) {
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  return (
    <FloatingSlot lane="page-bar">
    <div className="flex items-center gap-2 bg-card border rounded-full shadow-lg px-4 py-2">
      <span className="text-sm font-medium mr-2">{t('bulkSelected', { count })}</span>

      {editActions.length > 0 && (
        <>
          <Popover>
            <PopoverTrigger className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm hover:bg-muted transition-colors">
              <Pencil className="h-3.5 w-3.5" />
              {t('bulkEditFields')}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </PopoverTrigger>
            <PopoverContent side="top" align="center" className="w-52 p-1">
              {editActions.map((action) => (
                <button key={action.label} onClick={action.onClick}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-muted transition-colors text-left">
                  <action.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {action.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>
          <div className="w-px h-5 bg-border mx-0.5 shrink-0" />
        </>
      )}

      {onConfirm && (
        <button onClick={onConfirm}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm hover:bg-muted transition-colors">
          <UserCheck className="h-3.5 w-3.5" />{t('bulkConfirm')}
        </button>
      )}
      {onMarkActive && (
        <button onClick={onMarkActive}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm hover:bg-muted transition-colors">
          <UserCheck className="h-3.5 w-3.5" />{t('bulkMarkActive')}
        </button>
      )}
      {onMarkExternal && (
        <button onClick={onMarkExternal}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm hover:bg-muted transition-colors">
          <DoorOpen className="h-3.5 w-3.5" />{t('bulkMarkExternal')}
        </button>
      )}
      {onArchive && (
        <button onClick={onArchive}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm hover:bg-muted transition-colors">
          <Archive className="h-3.5 w-3.5" />{t('bulkArchive')}
        </button>
      )}
      {onRestore && (
        <button onClick={onRestore}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm hover:bg-muted transition-colors">
          <RotateCcw className="h-3.5 w-3.5" />{t('bulkRestore')}
        </button>
      )}
      {onDelete && (
        <button onClick={onDelete}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm text-destructive hover:bg-destructive/10 transition-colors">
          <Trash2 className="h-3.5 w-3.5" />{t('bulkDelete')}
        </button>
      )}

      {moreActions.length > 0 && (
        <>
          <div className="w-px h-5 bg-border mx-0.5 shrink-0" />
          <Popover>
            <PopoverTrigger
              className="p-1.5 rounded-full hover:bg-muted transition-colors text-muted-foreground"
              aria-label={t('bulkMore')}
            >
              <MoreHorizontal className="h-4 w-4" />
            </PopoverTrigger>
            <PopoverContent side="top" align="center" className="w-52 p-1">
              {moreActions.map((action) => (
                <button
                  key={action.label}
                  onClick={action.disabled ? undefined : action.onClick}
                  disabled={action.disabled}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                    action.disabled
                      ? 'opacity-40 cursor-not-allowed'
                      : action.destructive
                        ? 'text-destructive hover:bg-destructive/10'
                        : 'hover:bg-muted'
                  }`}
                >
                  <action.icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{action.label}</span>
                  {action.disabled && (
                    <span className="text-xs text-muted-foreground">{tCommon('comingSoon')}</span>
                  )}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        </>
      )}

      <button onClick={onClear}
        className="p-1.5 rounded-full hover:bg-muted transition-colors ml-0.5 text-muted-foreground">
        <X className="h-4 w-4" />
      </button>
    </div>
    </FloatingSlot>
  )
}

// ─── tab types ────────────────────────────────────────────────────────────────

const TAB_IDS = ['active', 'leads', 'external', 'archived', 'deleted', 'requests'] as const
type TabId = (typeof TAB_IDS)[number]

// ─── page ─────────────────────────────────────────────────────────────────────

export default function ContactsPage() {
  const { currentTeamId, user, team } = useAuth()
  const pageRouter = useRouter()
  const { isAtLeast, plan } = usePlan()
  const { ownScoped } = useCapabilities()
  const { openUpgradeModal } = useUpgradeModal()
  const qc = useQueryClient()
  const t = useTranslations('Contacts')
  const tNav = useTranslations('Nav')
  const tLink = useTranslations('ContactLink')

  // Coaches (own-scoped) see only their assigned contacts and have no
  // archived/deleted admin views (those queries would be denied by the rules).
  const coachScopeUid = ownScoped ? (user?.uid ?? null) : null
  const { data: allActive = [], isLoading: loadingActive } = useActiveContacts(currentTeamId, coachScopeUid)
  // ONE live query, split three ways by `contactLifecycle` (the one reader of
  // the markers): PROVISIONAL contacts — the not-yet-materialized leads (shop
  // registrations awaiting payment, trial bookings never attended, form leads)
  // — live in the "Leads" tab and don't count toward the plan cap; EXTERNAL
  // contacts — people who train here without being looked after — in their own
  // tab; the Active tab is what is left. Mirrors server-side canCreateContact
  // (contactCap.ts) for leads and getActiveContacts for externals.
  const active = useMemo(() => allActive.filter((c) => contactLifecycle(c) === 'active'), [allActive])
  const leads = useMemo(() => allActive.filter((c) => contactLifecycle(c) === 'provisional'), [allActive])
  const external = useMemo(() => allActive.filter((c) => contactLifecycle(c) === 'external'), [allActive])
  const { data: archived = [], isLoading: loadingArchived } = useArchivedContacts(ownScoped ? null : currentTeamId)
  const { data: deleted = [], isLoading: loadingDeleted } = useDeletedContacts(ownScoped ? null : currentTeamId)
  const { data: requests = [] } = useContactRequests(currentTeamId)
  const { data: subscriptionTypes = [] } = useSubscriptionTypes(currentTeamId)
  const { isInstalled } = useInstalledPlugins()
  const groupsEnabled = isInstalled('contact-groups')
  const { data: contactGroups = [] } = useContactGroups(groupsEnabled ? currentTeamId : null)
  const inOrg = !!team?.org_id

  // Tag vocabulary is free-form (automations and manual edits both write it),
  // so the filter's options come from what the loaded contacts actually carry.
  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const c of [...active, ...leads, ...archived]) for (const tg of c.tags ?? []) set.add(tg)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [active, leads, archived])
  const customFieldDefs = useMemo(
    () => (isInstalled('custom-fields') ? team?.custom_field_definitions ?? [] : []),
    [isInstalled, team?.custom_field_definitions],
  )
  const [saveAsGroupOpen, setSaveAsGroupOpen] = useState(false)
  const [bulkOutreachOpen, setBulkOutreachOpen] = useState(false)
  const [askToSignOpen, setAskToSignOpen] = useState(false)
  const invalidateGroups = useInvalidateContactGroups(currentTeamId)

  // "Edit in contacts" on a dynamic group hands its rule over here, because this
  // page IS the filter editor — there is no second place where matching is
  // decided. Saving it back goes through the normal "Save as group" path.
  const [editingRuleFor, setEditingRuleFor] = useState<{ groupId: string; name: string } | null>(null)
  useEffect(() => {
    const raw = window.sessionStorage.getItem(GROUP_RULE_HANDOFF_KEY)
    if (!raw) return
    window.sessionStorage.removeItem(GROUP_RULE_HANDOFF_KEY)
    try {
      const { groupId, name, filter } = JSON.parse(raw) as {
        groupId: string; name: string; filter: Partial<ContactFilter>
      }
      setFilters(normalizeContactFilter(filter))
      setEditingRuleFor({ groupId, name })
    } catch {
      // A malformed handoff is not worth surfacing — the page just opens unfiltered.
    }
  }, [])

  // Contact cap usage: counts what the SERVER counts (contactCap.ts) — every
  // live contact except the provisional leads, so an EXTERNAL counts too: the
  // cap is about records held, not people looked after. Reading `active.length`
  // here would show "0 / 250" to a studio whose whole book is externals while
  // the server still refuses the 251st. Over-cap behaviour is tier-specific
  // (contactOverageForPlan) and never per-contact metered: Free hard-blocks
  // manual adds (portal signups still land), Coach is prompted to upgrade,
  // Studio can buy +contact blocks. Org is unlimited.
  const usage = contactUsageForPlan(plan, active.length + external.length)
  const overage = contactOverageForPlan(plan)
  const freeCapBlocked = planHasHardContactCap(plan) && usage.atOrOverLimit && !loadingActive
  const planIdx = plan ? PLAN_ORDER.indexOf(plan) : -1
  const nextPlan: SaasPlan | null = planIdx >= 0 && planIdx < PLAN_ORDER.length - 1 ? PLAN_ORDER[planIdx + 1] : null

  const [tab, setTab] = useTabParam(TAB_IDS, 'active')

  /**
   * `?attention=1` — THE Needs-attention view, entered from outside.
   *
   * The dashboard's attention block shows the top few and links here for the
   * full answer, so this page has to be able to open ON that answer. It is the
   * two controls the view is made of, set together: the `needsAttention` filter
   * dimension and the attention sort — no third representation of "needs
   * attention" is introduced, and `contactAttentionReasons` stays the one
   * predicate.
   *
   * Read ONCE at mount via lazy initialisers rather than in an effect, so there
   * is no unfiltered first paint, and so clearing the filter by hand afterwards
   * is not snapped back by a re-render.
   */
  const searchParams = useSearchParams()
  const [openOnAttention] = useState(() => searchParams.get('attention') === '1')
  // Ephemeral on purpose: a persisted per-device sort is one more of the
  // device-local preferences UX-23 counts, and this one is cheap to re-pick.
  const [sortMode, setSortMode] = useState<SortMode>(openOnAttention ? 'attention' : 'name')
  // The Unconfirmed tab only exists while provisional contacts do — hop back to
  // Active when the last one is confirmed/deleted (its tab entry disappears).
  useEffect(() => {
    if (tab === 'leads' && !loadingActive && leads.length === 0) setTab('active')
    if (tab === 'external' && !loadingActive && external.length === 0) setTab('active')
  }, [tab, loadingActive, leads.length, external.length])
  const [filters, setFilters] = useState<Filters>(() =>
    openOnAttention
      ? normalizeContactFilter({ ...EMPTY_FILTERS, needsAttention: true })
      : EMPTY_FILTERS,
  )
  // Search lives INSIDE the filter object so "Save as…" captures it — the old
  // separate state meant a saved preset silently lost its text query.
  const search = filters.search
  const setSearch = (v: string) => setFilters((f) => ({ ...f, search: v }))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Opened straight from the dashboard's quick action. Read ONCE, in a lazy
  // initializer, so clearing the param or closing the dialog is not undone by
  // the next render — the same shape as `openOnAttention` on the contacts list.
  const [dialogOpen, setDialogOpen] = useState(
    () => searchParams.get(QUICK_ACTION_PARAM) === '1'
  )

  // The create dialog always opens — at the Free hard cap it restricts the entry
  // choice to 'booking' (a non-counting provisional lead) instead of blocking.
  const openCreateDialog = () => setDialogOpen(true)
  const [bulkEditMode, setBulkEditMode] = useState<'rank' | 'subscription' | 'stage' | 'group-add' | 'group-remove' | 'custom-field' | null>(null)

  // confirm dialogs
  const [confirmArchive, setConfirmArchive] = useState<string[]>([])
  const [confirmExternal, setConfirmExternal] = useState<string[]>([])
  const [confirmDelete, setConfirmDelete] = useState<string[]>([])
  const [confirmRestore, setConfirmRestore] = useState<string[]>([])

  const invalidateContacts = () => qc.invalidateQueries({ queryKey: ['contacts'] })
  const invalidateAll = () => { invalidateContacts(); setSelected(new Set()) }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ── filter + search ───────────────────────────────────────────────────────
  // Matching itself lives in @linyup/shared (matchesFilter). This page only
  // supplies the context: the team's groups (so a selected parent expands to its
  // subgroups, and a DYNAMIC group resolves its rule) and the engagement
  // thresholds. Search is part of the filter object, so saved presets carry it.

  // The consent dimension reads a ledger the contacts list does not hold — one
  // query per DOCUMENT (never per contact), loaded by the context hook from the
  // documents this filter and the team's dynamic groups actually name.
  const { documents: askedDocuments } = useAskedDocuments(currentTeamId)
  const filterContext = useContactFilterContext(contactGroups, [filters])
  // Until the named ledger has arrived the dimension matches nobody (it fails
  // closed, deliberately), so the list must say "loading" rather than "nothing
  // matched" — an empty result a manager reads as an answer.
  const consentLedgerPending =
    !!filters.consent?.documentId &&
    filters.consent.states.length > 0 &&
    !filterContext.consent?.[filters.consent.documentId]

  const filteredActive   = useMemo(() => filterContacts(active,   filters, filterContext), [active,   filters, filterContext])
  const filteredLeads    = useMemo(() => filterContacts(leads,    filters, filterContext), [leads,    filters, filterContext])
  const filteredExternal = useMemo(() => filterContacts(external, filters, filterContext), [external, filters, filterContext])
  const filteredArchived = useMemo(() => filterContacts(archived, filters, filterContext), [archived, filters, filterContext])
  const filteredDeleted  = useMemo(() => filterContacts(deleted,  filters, filterContext), [deleted,  filters, filterContext])

  // ── current list & loading state ──────────────────────────────────────────

  const currentListUnsorted =
    tab === 'active' ? filteredActive
    : tab === 'leads' ? filteredLeads
    : tab === 'external' ? filteredExternal
    : tab === 'archived' ? filteredArchived
    : filteredDeleted
  // ORDERING (UX-44). Surname order answers "where is Meier?" — the question you
  // ask when you already know the name. It cannot answer the one a studio opens
  // this page with: WHO IS WAITING ON ME. That answer is derived (see
  // `contactAttentionReasons`), so it can only be a client sort — there is no
  // stored field to index, and the (lastname, firstname) index the list query
  // needs is untouched. The list is already loaded and already filtered in
  // memory, so sorting it costs nothing extra.
  const currentList = useMemo(() => {
    if (sortMode === 'name') return currentListUnsorted // already (lastname, firstname)
    const list = [...currentListUnsorted]
    if (sortMode === 'attention')
      return list.sort((a, b) => compareContactsByAttention(a, b, filterContext))
    return list.sort(
      (a, b) => (resolveTimestampMs(b.created_at) ?? 0) - (resolveTimestampMs(a.created_at) ?? 0)
    )
  }, [currentListUnsorted, sortMode, filterContext])
  // The same tab BEFORE filtering — a dynamic rule can resolve wider than the
  // current view (it can't keep the `groups` dimension), so previewing it
  // against `currentList` would understate the group.
  const currentUnfilteredList =
    tab === 'active' ? active
    : tab === 'leads' ? leads
    : tab === 'external' ? external
    : tab === 'archived' ? archived
    : deleted
  const isLoading =
    (tab === 'active' || tab === 'leads' || tab === 'external' ? loadingActive
    : tab === 'archived' ? loadingArchived
    : loadingDeleted) || consentLedgerPending

  // ── bulk handlers ─────────────────────────────────────────────────────────

  const archiveContacts = async (ids: string[]) => {
    await Promise.all(ids.map((id) =>
      updateDoc(doc(db, CONTACTS_COLLECTION, id), { archived_at: serverTimestamp() })
    ))
    invalidateAll()
  }

  const deleteContacts = async (ids: string[]) => {
    await Promise.all(ids.map((id) =>
      updateDoc(doc(db, CONTACTS_COLLECTION, id), { deleted_at: serverTimestamp() })
    ))
    invalidateAll()
  }

  const restoreContacts = async (ids: string[]) => {
    await Promise.all(ids.map((id) =>
      updateDoc(doc(db, CONTACTS_COLLECTION, id), { archived_at: null, deleted_at: null })
    ))
    invalidateAll()
  }

  // Manually confirm provisional (shop-registered) contacts — the "keep" action of
  // the Unconfirmed tab. Clears the flags so the purge task leaves them alone;
  // normally a first payment does this via the webhook.
  const confirmProvisional = async (ids: string[]) => {
    await Promise.all(ids.map((id) =>
      updateDoc(doc(db, CONTACTS_COLLECTION, id), {
        provisional: deleteField(),
        provisional_expires_at: deleteField(),
      })
    ))
    invalidateAll()
  }

  // Roster ↔ external. `external` is present ONLY when true (see
  // Contact.external), so bringing someone back deletes the fields rather
  // than writing false — a `false` would be a third shape every reader had
  // to know about. Nothing else moves: journey, plan and affiliation stay.
  const markExternal = async (ids: string[]) => {
    await Promise.all(ids.map((id) =>
      updateDoc(doc(db, CONTACTS_COLLECTION, id), {
        external: true,
        external_since: serverTimestamp(),
      })
    ))
    invalidateAll()
  }
  const markActive = async (ids: string[]) => {
    await Promise.all(ids.map((id) =>
      updateDoc(doc(db, CONTACTS_COLLECTION, id), {
        external: deleteField(),
        external_since: deleteField(),
      })
    ))
    invalidateAll()
  }

  const { data: orgRankingSystems } = useOrgRankingSystems(team?.org_id)
  // Org-level ranking systems override team-level ones (per CLAUDE.md spec)
  const rankingSystems = orgRankingSystems ?? team?.ranking_systems ?? []

  const bulkSetRank = async (systemId: string, value: number | null) => {
    const fieldKey = `ranks.${systemId}`
    await Promise.all([...selected].map((id) =>
      updateDoc(doc(db, CONTACTS_COLLECTION, id), {
        [fieldKey]: value !== null ? value : deleteField(),
        updatedAt: serverTimestamp(),
      })
    ))
    invalidateContacts()
  }

  // THE SAME FIELDS the per-contact dialog writes, every time — see the note on
  // BulkSetSubscriptionDialog. The price fields are written even when they are
  // null: an omitted key on `updateDoc` leaves the PREVIOUS plan's price
  // standing, which is exactly the defect this replaced, and it reaches the
  // subscription history and the transitions ledger, not just the screen. The
  // grant's end date obeys the same rule and for a sharper reason — inherited
  // from a previous plan it would expire the one being assigned right now.
  const bulkSetSubscription = async (
    type: SubscriptionType | null,
    price: SubscriptionPrice | null
  ) => {
    const grantExpiryMs = planGrantExpiryMs(price)
    await Promise.all([...selected].map((id) =>
      updateDoc(doc(db, CONTACTS_COLLECTION, id), {
        subscription_type_id: type?.id ?? null,
        subscription_type_name: type?.name ?? null,
        subscription_price_id: price?.id ?? null,
        subscription_recurrence: price?.recurrence ?? null,
        subscription_amount: price?.amount ?? null,
        subscription_expires_at:
          grantExpiryMs === null ? null : Timestamp.fromMillis(grantExpiryMs),
        subscription_type_updated_at: serverTimestamp(),
        // Assigning a subscription materializes a provisional lead (offline-paid
        // members count toward the cap too). See Contact.provisional.
        ...(type ? { provisional: deleteField(), provisional_expires_at: deleteField() } : {}),
        updatedAt: serverTimestamp(),
      })
    ))
    invalidateContacts()
  }

  // THE SAME `custom_fields.{id}` dotted path bulkSetRank uses for
  // `ranks.{systemId}` — an `updateDoc` key with a dot in it is a Firestore
  // field PATH, so this only ever touches the one field being set, leaving
  // every other custom field on the contact (and every contact not selected)
  // untouched. `null` means "clear" (the dialog never calls this for a field
  // nobody explicitly touched) — same `deleteField()` shape bulkSetRank uses.
  const bulkSetCustomField = async (fieldId: string, value: CustomFieldValue | null) => {
    const fieldKey = `custom_fields.${fieldId}`
    await Promise.all([...selected].map((id) =>
      updateDoc(doc(db, CONTACTS_COLLECTION, id), {
        [fieldKey]: value !== null ? value : deleteField(),
        updatedAt: serverTimestamp(),
      })
    ))
    invalidateContacts()
  }

  const bulkGroupUpdate = async (groupId: string, op: 'add' | 'remove') => {
    await Promise.all([...selected].map((id) =>
      updateDoc(doc(db, CONTACTS_COLLECTION, id), {
        group_ids: op === 'add' ? arrayUnion(groupId) : arrayRemove(groupId),
      })
    ))
    invalidateContacts()
  }

  const bulkPromoteStage = async (stage: AcquisitionStage) => {
    const now = serverTimestamp()
    await Promise.all([...selected].map((id) =>
      updateDoc(doc(db, CONTACTS_COLLECTION, id), {
        acquisition_stage: stage,
        acquisition_stage_updated_at: now,
        ...(stage === 'trial_attended' ? { trial_attended_at: now } : {}),
        ...(stage === 'joined' ? { converted_at: now } : {}),
        // Promoting past 'trial_booked' MATERIALIZES a provisional lead — it now
        // counts toward the contact cap. See Contact.provisional.
        ...(stage === 'trial_attended' || stage === 'joined'
          ? { provisional: deleteField(), provisional_expires_at: deleteField() }
          : {}),
        updatedAt: now,
      })
    ))
    invalidateContacts()
  }

  // ── select all ────────────────────────────────────────────────────────────

  const allSelected = currentList.length > 0 && (currentList as Contact[]).every((c) => selected.has(c.id))
  const someSelected = !allSelected && (currentList as Contact[]).some((c) => selected.has(c.id))
  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set((currentList as Contact[]).map((c) => c.id)))
    }
  }

  // ── tabs ──────────────────────────────────────────────────────────────────

  const TABS: { id: TabId; label: string; count: number }[] = [
    { id: 'active',   label: t('tabActive'),   count: active.length },
    // Leads = ALL provisional contacts (trial bookings never attended, form leads,
    // shop registrations awaiting payment) — the cap-exclusion set. Shown whenever
    // any exist, INCLUDING for own-scoped coaches (their assigned leads live here).
    ...(leads.length === 0
      ? []
      : [{ id: 'leads' as TabId, label: t('tabLeads'), count: leads.length }]),
    // External = people who train here without being looked after (a
    // partner-app drop-in, a former member who still comes now and then).
    // Same rule as Leads: the tab exists only while somebody is in it.
    ...(external.length === 0
      ? []
      : [{ id: 'external' as TabId, label: t('tabExternal'), count: external.length }]),
    // Archived/deleted are studio-admin views — hidden for own-scoped coaches.
    ...(ownScoped ? [] : [{ id: 'archived' as TabId, label: t('tabArchived'), count: archived.length }]),
    ...(ownScoped ? [] : [{ id: 'deleted' as TabId, label: t('tabDeleted'), count: deleted.length }]),
    { id: 'requests', label: t('tabRequests'),  count: requests.filter((r) => (r.status ?? 'pending') === 'pending').length },
  ]

  const selectable = tab === 'active' || tab === 'leads' || tab === 'external' || tab === 'archived' || tab === 'deleted'
  const selectedList = [...selected]
  // Resolved rows, not just ids — the outreach dialog needs each contact's
  // email + unsubscribe flag to say who will actually receive the message.
  // Selection is cleared on tab change, so the current tab is the right source.
  const selectedContacts = currentList.filter((c) => selected.has(c.id))

  return (
    <div className="space-y-6 pb-24">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          </div>
          {/* The head-count used to sit here. The list itself already answers
              "how many", and the two pages a studio reaches for from a contact
              list — what they booked, and what they paid — had no pointer. */}
          <QuickLinks
            links={[
              { href: '/bookings' as Route, label: tNav('bookings') },
              { href: '/payments' as Route, label: tNav('payments') },
            ]}
          />
          {!loadingActive && !usage.isUnlimited && (
            <div className="mt-1.5 flex items-center gap-2 max-w-xs">
              <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${usage.atOrOverLimit ? 'bg-destructive' : 'bg-primary'}`}
                  style={{ width: `${usage.percent}%` }}
                />
              </div>
              <span className={`text-xs tabular-nums ${usage.atOrOverLimit ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                {t('usageMeter', { used: usage.used, included: usage.included ?? 0 })}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Hidden for a coach, whose data access is own-scoped — the whole
              roster in one file is exactly what that scoping prevents. This is
              UX only; `exportContacts` asserts manager server-side regardless. */}
          {!ownScoped && currentTeamId && <ExportContactsButton teamId={currentTeamId} />}
          <button
            onClick={openCreateDialog}
            className="hidden sm:inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <UserPlus className="h-4 w-4" />
            {t('addContact')}
          </button>
        </div>
      </div>

      {/* Contact-cap warning. Tier-specific, never per-contact metered: Free
          hard-blocks (portal signups still arrive), Coach is prompted to
          upgrade, Studio can buy +contact blocks. Org is unlimited (no banner). */}
      {!loadingActive && usage.atOrOverLimit && !usage.isUnlimited && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/[0.04] px-4 py-3 flex items-start justify-between gap-3">
          <div className="text-sm">
            <p className="font-medium">{t('capWarnTitle')}</p>
            <p className="text-muted-foreground">
              {overage.kind === 'hard'
                ? t('capWarnBodyFreeHard', { used: usage.used, included: usage.included ?? 0 })
                : overage.kind === 'block'
                  ? t('capWarnBodyBlock', {
                      used: usage.used,
                      included: usage.included ?? 0,
                      blockSize: overage.block.size,
                      blockPrice: overage.block.monthly,
                    })
                  : t('capWarnBodyUpgrade', { used: usage.used, included: usage.included ?? 0 })}
            </p>
          </div>
          {nextPlan && (
            <button
              type="button"
              onClick={() => openUpgradeModal({ minPlan: nextPlan })}
              className="shrink-0 inline-flex items-center px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              {t('capWarnCta')}
            </button>
          )}
        </div>
      )}

      {/* Overview — collapsed by default, always visible */}
      {/* `rankingSystems` is the EFFECTIVE list resolved above. This used to pass
          `team.ranking_systems`, which left the belt breakdown blank for every
          org-managed tenant while the list and filter beside it were fine. */}
      <OverviewPanel
        contacts={active}
        loading={loadingActive}
        rankingSystems={rankingSystems}
        engagementThresholds={team?.engagement_thresholds}
      />

      {/* Search — sticky, clears with ×. `top-14` on mobile clears the sticky
          app header (h-14, see components/layout/MobileHeader.tsx); on desktop
          there is no top bar, so it pins to 0.
          This field's markup was the ONLY one in the app with a clear button;
          it is now `SearchInput`, and the other six contact searches use the
          same component rather than six more copies of it. */}
      <div className="sticky top-14 md:top-0 z-10 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 bg-background/95 backdrop-blur-sm border-b border-border/40">
        <SearchInput
          placeholder={t('searchPlaceholder')}
          value={search}
          onValueChange={setSearch}
          className="h-11 bg-white dark:bg-zinc-900"
        />
      </div>

      {/* Editing a dynamic group's rule — adjust the filters, then save back. */}
      {editingRuleFor && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2">
          <span className="text-sm">
            {t('editingRuleFor', { name: editingRuleFor.name })}
            {ruleWouldDropGroups(filters) && (
              <span className="block text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                {t('ruleDropsGroups')}
              </span>
            )}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setEditingRuleFor(null)}>
              {t('cancelRuleEdit')}
            </Button>
            <Button size="sm" onClick={async () => {
              if (!currentTeamId) return
              // Store what will actually evaluate — a rule can't keep the
              // `groups` dimension, so saving `filters` verbatim would persist a
              // constraint that silently vanishes on every read.
              await setGroupRule(currentTeamId, editingRuleFor.groupId, toGroupRule(filters))
              invalidateGroups()
              setEditingRuleFor(null)
              toast.success(t('ruleSaved', { name: editingRuleFor.name }))
            }}>
              {t('saveRule')}
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      {tab !== 'requests' && (
        <FilterChips
          filters={filters}
          onChange={setFilters}
          subscriptionTypes={subscriptionTypes}
          teamId={currentTeamId}
          rankingSystems={rankingSystems}
          contactGroups={groupsEnabled ? contactGroups : null}
          allTags={allTags}
          customFieldDefs={customFieldDefs}
          consentDocuments={askedDocuments}
          onSaveAsGroup={groupsEnabled ? () => setSaveAsGroupOpen(true) : undefined}
        />
      )}

      {/* Tabs */}
      <div className="flex gap-0.5 border-b overflow-x-auto">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            onClick={() => { setTab(tb.id); setSelected(new Set()) }}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === tb.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tb.label}
            {tb.count > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 ${
                tab === tb.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}>{tb.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Requests tab body */}
      {tab === 'requests' && currentTeamId && <RequestsTab teamId={currentTeamId} />}

      {/* Main list */}
      {tab !== 'requests' && (
        <div className="rounded-xl border overflow-hidden bg-card">
          {/* Ordering (UX-44). Rendered above the list rather than hidden in the
              filter panel: a filter removes people, a sort answers a different
              question about the same people, and conflating the two is why
              "who needs me today" had nowhere to live. */}
          {!isLoading && currentList.length > 0 && (
            <div className="flex items-center justify-end gap-2 px-4 py-2 border-b bg-muted/10">
              <span className="text-xs text-muted-foreground">{t('sortLabel')}</span>
              <div className="flex gap-1">
                {SORT_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSortMode(m)}
                    aria-pressed={sortMode === m}
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                      sortMode === m
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t(`sort_${m}` as 'sort_name')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Select-all header */}
          {!isLoading && currentList.length > 0 && selectable && (
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
              <span className="text-xs text-muted-foreground flex items-center gap-2">
                <span className="font-medium tabular-nums">{currentList.length}</span>
                {selected.size > 0 ? t('selectAllCount', { count: selected.size, total: currentList.length }) : t('selectAll')}
              </span>
              <label className="cursor-pointer pr-0.5">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected }}
                  onChange={toggleSelectAll}
                  className="h-4 w-4 rounded border-border"
                />
              </label>
            </div>
          )}

          {isLoading && Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b last:border-0">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}

          {!isLoading && currentList.length === 0 && (
            <div className="px-4 py-16 text-center text-muted-foreground text-sm">
              {/* Any active dimension means "nothing matched", not "nothing exists".
                  The old hand-listed check missed every dimension added after it. */}
              {countActiveFilters(filters) > 0 ? t('emptySearch') : t('empty')}
            </div>
          )}

          {!isLoading && tab !== 'deleted' && (currentList as Contact[]).map((c) => (
            <ContactRow
              key={c.id}
              contact={c}
              selectable={selectable}
              selected={selected.has(c.id)}
              onSelect={toggleSelect}
              rankingSystems={rankingSystems}
              attentionReason={
                sortMode === 'attention'
                  ? contactAttentionReasons(c, filterContext)[0]
                  : undefined
              }
            />
          ))}

          {!isLoading && tab === 'deleted' && (currentList as Contact[]).map((c) => (
            <DeletedRow
              key={c.id}
              contact={c}
              selected={selected.has(c.id)}
              onSelect={toggleSelect}
            />
          ))}
        </div>
      )}

      {/* Mobile FAB */}
      {selected.size === 0 && (
        <FloatingSlot lane="page-primary" className="sm:hidden">
          <button
            onClick={openCreateDialog}
            className="h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary/90 transition-colors"
            aria-label={t('addContact')}
          >
            <UserPlus className="h-6 w-6" />
          </button>
        </FloatingSlot>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          tab={tab}
          onArchive={tab === 'active' || tab === 'leads' || tab === 'external' ? () => setConfirmArchive(selectedList) : undefined}
          onConfirm={tab === 'leads' ? () => confirmProvisional(selectedList) : undefined}
          onMarkExternal={tab === 'active' ? () => setConfirmExternal(selectedList) : undefined}
          onMarkActive={tab === 'external' ? () => markActive(selectedList) : undefined}
          onRestore={tab === 'archived' || tab === 'deleted' ? () => setConfirmRestore(selectedList) : undefined}
          onDelete={tab !== 'deleted' ? () => setConfirmDelete(selectedList) : undefined}
          onClear={() => setSelected(new Set())}
          editActions={tab !== 'deleted' ? [
            ...(rankingSystems.length > 0 ? [{ label: t('bulkSetRank'), icon: Award, onClick: () => setBulkEditMode('rank') }] : []),
            { label: t('bulkSetSubscription'), icon: CreditCard, onClick: () => setBulkEditMode('subscription') },
            { label: t('bulkSetStage'), icon: Tag, onClick: () => setBulkEditMode('stage') },
            ...(groupsEnabled ? [
              { label: t('bulkAddToGroup'),      icon: FolderTree, onClick: () => setBulkEditMode('group-add') },
              { label: t('bulkRemoveFromGroup'), icon: FolderTree, onClick: () => setBulkEditMode('group-remove') },
            ] : []),
            ...(customFieldDefs.length > 0 ? [{ label: t('bulkSetCustomField'), icon: ListPlus, onClick: () => setBulkEditMode('custom-field') }] : []),
          ] : []}
          // The menu itself is no longer plan-gated: gating the whole thing made
          // it vanish, so a Coach had no way to discover outreach exists or to
          // reach the upgrade prompt. The ACTION is gated instead.
          moreActions={tab === 'active' ? [
            { label: t('bulkMove'), icon: ArrowRightLeft, onClick: () => {}, disabled: true },
            {
              label: t('bulkOutreach'),
              icon: Mail,
              onClick: () => isAtLeast('studio')
                ? setBulkOutreachOpen(true)
                : openUpgradeModal({ minPlan: 'studio' }),
            },
            // Only where there IS a required document to ask about: a studio with
            // none would open a dialog with an empty picker. Not plan-gated —
            // operating a live requirement is not creating one.
            ...(askedDocuments.some((d) => d.requiredBeforeBooking)
              ? [{ label: t('bulkAskToSign'), icon: ShieldCheck, onClick: () => setAskToSignOpen(true) }]
              : []),
            // The EXACT ids are handed over, not the filter: this list is live,
            // and re-deriving it on the sheet would print a different set from
            // the one that was ticked.
            {
              label: tLink('sheetAction'),
              icon: QrCode,
              onClick: () => {
                writeQrSheetSelection(selectedList)
                pageRouter.push('/contacts/qr-sheet' as Route)
              },
            },
          ] : []}
        />
      )}

      {/* Dialogs */}
      {currentTeamId && user && (
        <CreateContactDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          teamId={currentTeamId}
          userId={user.uid}
          onSaved={invalidateAll}
          atHardCap={freeCapBlocked}
        />
      )}

      <ConfirmDialog
        open={confirmArchive.length > 0}
        onOpenChange={(v) => { if (!v) setConfirmArchive([]) }}
        title={t('archiveContactTitle')}
        desc={t('archiveContactDesc', { name: `${confirmArchive.length} contacts` })}
        confirmLabel={t('bulkArchive')}
        onConfirm={() => archiveContacts(confirmArchive)}
      />

      <ConfirmDialog
        open={confirmExternal.length > 0}
        onOpenChange={(v) => { if (!v) setConfirmExternal([]) }}
        title={t('markExternalTitle', { count: confirmExternal.length })}
        desc={t('markExternalDesc')}
        confirmLabel={t('bulkMarkExternal')}
        onConfirm={() => markExternal(confirmExternal)}
      />

      <ConfirmDialog
        open={confirmDelete.length > 0}
        onOpenChange={(v) => { if (!v) setConfirmDelete([]) }}
        title={t('deleteContactTitle')}
        desc={t('deleteContactDesc', { name: `${confirmDelete.length} contacts` })}
        confirmLabel={t('bulkDelete')}
        destructive
        onConfirm={() => deleteContacts(confirmDelete)}
      />

      <ConfirmDialog
        open={confirmRestore.length > 0}
        onOpenChange={(v) => { if (!v) setConfirmRestore([]) }}
        title={t('restoreContactTitle')}
        desc={t('restoreContactDesc', { name: `${confirmRestore.length} contacts` })}
        confirmLabel={t('bulkRestore')}
        onConfirm={() => restoreContacts(confirmRestore)}
      />

      <BulkSetRankDialog
        open={bulkEditMode === 'rank'}
        onOpenChange={(v) => { if (!v) setBulkEditMode(null) }}
        rankingSystems={rankingSystems}
        count={selected.size}
        onConfirm={bulkSetRank}
      />

      <BulkSetSubscriptionDialog
        open={bulkEditMode === 'subscription'}
        onOpenChange={(v) => { if (!v) setBulkEditMode(null) }}
        subscriptionTypes={subscriptionTypes}
        count={selected.size}
        currency={(team?.default_currency ?? 'CHF').toUpperCase()}
        onConfirm={bulkSetSubscription}
      />

      <BulkPromoteStageDialog
        open={bulkEditMode === 'stage'}
        onOpenChange={(v) => { if (!v) setBulkEditMode(null) }}
        count={selected.size}
        onConfirm={bulkPromoteStage}
      />

      {groupsEnabled && (
        <BulkGroupsDialog
          open={bulkEditMode === 'group-add' || bulkEditMode === 'group-remove'}
          onOpenChange={(v) => { if (!v) setBulkEditMode(null) }}
          mode={bulkEditMode === 'group-remove' ? 'remove' : 'add'}
          groups={contactGroups}
          count={selected.size}
          onConfirm={(groupId) => bulkGroupUpdate(groupId, bulkEditMode === 'group-remove' ? 'remove' : 'add')}
        />
      )}

      <BulkSetCustomFieldDialog
        open={bulkEditMode === 'custom-field'}
        onOpenChange={(v) => { if (!v) setBulkEditMode(null) }}
        definitions={customFieldDefs}
        count={selected.size}
        onConfirm={bulkSetCustomField}
      />

      <AskToSignDialog
        open={askToSignOpen}
        onOpenChange={setAskToSignOpen}
        teamId={currentTeamId}
        documents={askedDocuments}
        contactIds={selectedList}
        // The request writes NO consent state, so no contact changed. The
        // ledgers are refreshed anyway, because the dialog reports who was
        // already signed and a stale map is what would have produced that
        // selection in the first place.
        onSent={() => qc.invalidateQueries({ queryKey: ['consent-ledgers'] })}
      />

      <BulkOutreachDialog
        open={bulkOutreachOpen}
        onOpenChange={setBulkOutreachOpen}
        teamId={currentTeamId}
        contacts={selectedContacts}
        // The per-contact activity log gains an outreach_email_sent entry.
        onSent={() => qc.invalidateQueries({ queryKey: ['contact-activity-log'] })}
      />

      {groupsEnabled && (
        <SaveAsGroupDialog
          open={saveAsGroupOpen}
          onOpenChange={setSaveAsGroupOpen}
          filter={filters}
          groups={contactGroups}
          matches={currentList}
          allContacts={currentUnfilteredList}
          filterContext={filterContext}
          onCreate={async ({ name, parentId, mode, rule, memberIds }) => {
            if (!currentTeamId || !user) return
            await createGroupFromFilter(currentTeamId, user.uid, {
              name, parentId, mode, filter: rule, memberIds,
            })
            invalidateGroups()
            if (mode === 'snapshot') qc.invalidateQueries({ queryKey: ['contacts'] })
          }}
        />
      )}
    </div>
  )
}
