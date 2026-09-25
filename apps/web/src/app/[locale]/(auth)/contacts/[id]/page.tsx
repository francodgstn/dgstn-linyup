'use client'

import { useConfirm } from '@/components/ui/confirm-dialog'
import { useState, use, useMemo, useEffect, useCallback } from 'react'
import { useRegisterTab } from '@/contexts/OpenTabsContext'
import { useRecentContacts } from '@/contexts/RecentContactsContext'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { useBack } from '@/hooks/useBackNavigation'
import { useTabParam } from '@/hooks/useTabParam'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import {
  doc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  collectionGroup,
  getDocs,
  addDoc,
  deleteDoc,
  deleteField,
  serverTimestamp,
  Timestamp,
  limit,
  documentId,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { formatCurrency } from '@/lib/format'
import { ConsentHistoryPanel } from '@/components/contacts/ConsentHistoryPanel'
import { useAuth } from '@/contexts/AuthContext'
import { RankBadge } from '@/components/ranking/RankBadge'
import { useCapabilities } from '@/hooks/useCapabilities'
import { Badge } from '@/components/ui/badge'
import { SaveBarProvider, useSaveBarSection } from '@/components/forms/SaveBar'
import { HintTip } from '@/components/settings/SettingsSection'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Segmented } from '@/components/ui/segmented'
import { useSubscriptionHistory } from '@/hooks/useSubscriptionHistory'
import { LedgerSegment } from './LedgerSegment'
import { ReceiptsSegment } from './ReceiptsSegment'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { DatePicker } from '@/components/ui/date-picker'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  // aliased: a local component in this file is already named `AlertDialog`
  AlertDialog as ConfirmDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  CONTACTS_COLLECTION,
  TEAMS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION,
  CONTACT_ALERTS_SUBCOLLECTION,
  ALERT_PRESETS_SUBCOLLECTION,
  TEAM_ACTIVITY_LOG_SUBCOLLECTION,
  contactDeletionState,
  readAlert,
  alertIsFired,
  personInitials,
  ORG_AFFILIATION_STATUSES_SUBCOLLECTION,
  OUTREACH_TEMPLATES_SUBCOLLECTION,
  PARTICIPANTS_SUBCOLLECTION,
  SESSIONS_COLLECTION,
  SESSION_BOOKINGS_SUBCOLLECTION,
  findRankLevel,
  rankLevelKey,
} from '@linyup/shared'
import type {
  DateLike,
  HeldPlan,
  RegionalFormatter,
  Contact,
  AcquisitionStage,
  ContactEntry,
  ContactSource,
  ContactGender,
  SubscriptionType,
  SubscriptionPrice,
  SubscriptionHistoryEntry,
  ContactAlert,
  AlertScheduleType,
  RawContactAlert,
  RankingSystem,
  ActivityLogEntry,
  ActivityEventType,
  PlanFeature,
  Affiliation,
  AffiliationType,
  OrgAffiliationStatusDef,
  EngagementBand,
  EngagementThresholds,
  Booking,
} from '@linyup/shared'
import {
  ACQUISITION_STAGES,
  CONTACT_ENTRIES,
  CONTACT_SOURCES,
  CONTACT_AFFILIATIONS_SUBCOLLECTION,
  AFFILIATION_TYPES_SUBCOLLECTION,
  DEFAULT_ORG_AFFILIATION_STATUSES,
  computeEngagementBand,
  MAX_CONTACT_LOGIN_EMAILS,
  subscriptionIsCancelling,
  heldMemberships,
} from '@linyup/shared'
import { usePlan } from '@/hooks/usePlan'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'

import { useUpgradeModal } from '@/contexts/UpgradeModalContext'
import { useForm, Controller, useFieldArray, type Control } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  ArrowLeft,
  CalendarDays,
  Mail,
  Copy,
  Phone,
  StickyNote,
  Star,
  Flame,
  BookOpen,
  Award,
  Plus,
  Trash2,
  Trophy,
  Bell,
  Timer,
  Activity,
  ArchiveRestore,
  AlertTriangle,
  UserPlus,
  UserX,
  Archive,
  RotateCcw,
  ArrowRightLeft,
  CheckCircle,
  XCircle,
  CalendarCheck,
  CalendarX,
  CreditCard,
  Wallet,
  BarChart2,
  Lock,
  Flag,
  Pencil,
  ShieldCheck,
  ShieldOff,
  MoreVertical,
  DoorOpen,
  UserCheck,
  User,
  Check,
  IdCard,
  RefreshCw,
  Ticket,
  FileSignature,
  CheckSquare,
  Search,
  Zap,
  Ellipsis,
  Banknote,
  SlidersHorizontal,
  UserPen,
} from 'lucide-react'
import { toast } from 'sonner'

import { GoalsTab } from './GoalsTab'
import { NotesTab, useContactNotesCount } from './NotesTab'
import { PlansList } from './PlansList'
import { PaymentsTab } from './PaymentsTab'
import { useContactPayments } from '@/hooks/useConnect'
import {
  byoToUnified,
  connectToUnified,
  formatMoneyMinor,
  mergePaymentRows,
} from '@/lib/payments'
import { useContactMemberSubscriptions } from '@/components/contacts/MemberSubscriptionsSection'
import { InsightsCard } from './InsightsCard'
import { ENGAGEMENT_BAR, ENGAGEMENT_TEXT } from './engagement'
import { PlanGate } from '@/components/plan/PlanGate'
import { SortableList, SortableItem } from '@/components/ui/sortable'
import { RenewConfirmDialog } from '@/components/affiliations/RenewUI'
import { ContactUpdateLinkDialog } from '@/components/contacts/ContactUpdateLinkDialog'
import { RecordPaymentDialog } from '@/components/payments/RecordPaymentDialog'
import {
  CustomiseQuickActionsDialog,
  useContactQuickActions,
  type QuickActionId,
  type QuickActionOption,
} from './quickActions'
import { renewAffiliationCall, previewRenewedUntil } from '@/components/affiliations/renew'
import { ContactGroupsChips } from '@/plugins/contact-groups/ContactGroupsChips'
import { WhatsAppConsentRow } from '@/components/contacts/WhatsAppConsentRow'
import { CustomFieldsCardBody } from '@/plugins/custom-fields/CustomFieldsCardBody'
import {
  BookingRow,
  buildBookingStatusLabels,
  type BookingStatus,
} from '@/components/bookings/BookingRow'
import {
  RebookDialog,
  useFutureSessions,
  EMPTY_SESSION_IDS,
} from '@/components/bookings/RebookDialog'
import {
  useBookingAction,
  useRebookAction,
  type BookingAction,
} from '@/hooks/useBookingActions'
import { useContactBookedSessions, type SessionInfo } from '@/hooks/useBookingsWindow'
import { Tip } from '@/components/ui/tip'
import { callFunction } from '@/lib/callFunction'

// ─── helpers ──────────────────────────────────────────────────────────────────



/** The page's date: "20 Jul 2026", in the studio's language, order and zone
 *  (`useTeamFormat`). It was `toLocaleDateString([])`, the BROWSER's locale,
 *  so a 24-hour studio read "08:00 AM" on a laptop set to English (US). */
const DATE_OPTS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }

function formatDate(fmt: RegionalFormatter, ts: DateLike, opts?: Intl.DateTimeFormatOptions) {
  if (!ts) return '—'
  return fmt.custom(ts, opts ?? DATE_OPTS) || '—'
}

function tsToDate(ts: unknown): Date | undefined {
  if (!ts) return undefined
  if (ts instanceof Timestamp) return ts.toDate()
  if (ts instanceof Date) return ts
  if (typeof ts === 'object' && 'toDate' in (ts as object))
    return (ts as { toDate(): Date }).toDate()
  return undefined
}

// Elapsed whole days since a date — the caller maps this to a localised,
// human-readable span ("3 years", "5 months", …) via ICU plurals.
function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86_400_000)
}

// ─── tab order (per-browser) ──────────────────────────────────────────────────
// The contact-detail tab strip is user-reorderable in an opt-in "edit" mode; the
// chosen order is saved per-browser (same pattern as the sidebar's collapse state).
const CONTACT_TAB_ORDER_KEY = 'linyup_contact_tab_order'

function useContactTabOrder(): [string[], (order: string[]) => void] {
  const [order, setOrderState] = useState<string[]>([])
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CONTACT_TAB_ORDER_KEY)
      if (raw) setOrderState(JSON.parse(raw) as string[])
    } catch {
      /* ignore malformed storage */
    }
  }, [])
  const setOrder = (next: string[]) => {
    setOrderState(next)
    try {
      localStorage.setItem(CONTACT_TAB_ORDER_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }
  return [order, setOrder]
}

// Stable-sort tabs by their position in the saved order; unknown ids keep their
// natural order at the end (so a newly-installed plugin tab just appends).
function applyTabOrder<T extends { id: string }>(tabs: T[], order: string[]): T[] {
  if (order.length === 0) return tabs
  const rank = (id: string) => {
    const i = order.indexOf(id)
    return i === -1 ? Number.POSITIVE_INFINITY : i
  }
  return [...tabs].sort((a, b) => rank(a.id) - rank(b.id))
}

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

// Read-only engagement band — a derived signal-strength "meter" next to the join
// date. More bars lit + colour = healthier: green = healthy, amber = watch,
// red = urgent (intervention pays off), grey = dormant/lapsed (not an alarm).
const ENGAGEMENT_LEVEL: Record<EngagementBand, number> = {
  active: 4,
  low: 3,
  at_risk: 2,
  inactive: 1,
}
function EngagementBadge({
  contact,
  thresholds,
}: {
  contact: Contact
  thresholds?: EngagementThresholds
}) {
  const t = useTranslations('Contacts')
  // Recency of attendance is the signal; fall back to join date for contacts who
  // have never attended (so a brand-new contact reads "active", not "inactive").
  const lastMs = tsToDate(contact.last_session_at)?.getTime() ?? null
  const refMs = lastMs ?? tsToDate(contact.created_at)?.getTime() ?? null
  const band = computeEngagementBand(refMs, thresholds)
  const daysAgo = lastMs != null ? Math.floor((Date.now() - lastMs) / 86_400_000) : null
  const tip = `${t('engagementLabel')} · ${
    daysAgo == null ? t('engagementNoSessions') : t('engagementLastSession', { days: daysAgo })
  }`
  const level = ENGAGEMENT_LEVEL[band]
  return (
    <span title={tip} className="inline-flex w-fit items-center gap-1.5">
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`w-1 rounded-[1px] ${i < level ? ENGAGEMENT_BAR[band] : 'bg-muted'}`}
            style={{ height: `${5 + i * 3}px` }}
          />
        ))}
      </span>
      <span className={`text-xs font-medium ${ENGAGEMENT_TEXT[band]}`}>
        {t(`engagement_${band}` as Parameters<typeof t>[0])}
      </span>
    </span>
  )
}

// ─── schema ───────────────────────────────────────────────────────────────────

const profileSchema = z.object({
  firstname: z.string().min(1).max(60),
  lastname: z.string().min(1).max(60),
  email: z.string().email().or(z.literal('')).optional(),
  phone: z.string().max(30).optional(),
  // Passwordless-login allow-list (extra emails on top of the primary). Held as
  // { value } objects for react-hook-form's useFieldArray; flattened on submit.
  login_emails: z
    .array(z.object({ value: z.string().email() }))
    .max(MAX_CONTACT_LOGIN_EMAILS)
    .optional(),
  gender: z.enum(['M', 'F', 'other']).optional(),
  birthdate: z.date().optional(),
  birthplace: z.string().max(100).optional(),
  weight: z.coerce.number().min(0).max(500).optional(),
  address_route: z.string().max(100).optional(),
  address_street_number: z.string().max(20).optional(),
  address_postal_code: z.string().max(20).optional(),
  address_locality: z.string().max(100).optional(),
  // Entry — editable for data-entry correction; does NOT move acquisition_stage
  // Derived from the union, never re-typed: a hand-copied list silently went
  // stale against `entry: 'manual'` (written by createStaffAppointment), and a
  // z.enum that rejects a value already ON the contact fails validation of the
  // form's own default — blocking submit on that contact for every field.
  entry: z.enum(CONTACT_ENTRIES).optional(),
  // Source axis
  source: z.enum(['website', 'referral', 'social', 'event', 'import', 'other'] as const).optional(),
  source_detail: z.string().max(500).optional(),
  // Acquisition milestone dates — editable (e.g. backdating an imported member)
  trial_booked_at: z.date().optional(),
  trial_attended_at: z.date().optional(),
  converted_at: z.date().optional(),
  // A RankRef per system: the level's id (what this form writes), or a legacy
  // number on a contact the data flip has not reached yet.
  ranks: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  custom_fields: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  emergency_contacts: z
    .array(
      z.object({
        name: z.string().min(1),
        phone: z.string().optional(),
        email: z.string().email().optional().or(z.literal('')),
      })
    )
    .max(2)
    .optional(),
})
type ProfileValues = z.infer<typeof profileSchema>

// ─── data hooks ───────────────────────────────────────────────────────────────

function useContact(id: string) {
  return useQuery<Contact | null>({
    queryKey: ['contact', id],
    queryFn: async () => {
      const d = await getDoc(doc(db, CONTACTS_COLLECTION, id))
      if (!d.exists()) return null
      return { ...d.data(), id: d.id } as Contact
    },
  })
}

function useSubscriptionTypes(teamId: string | null) {
  return useQuery<SubscriptionType[]>({
    queryKey: ['subscription-types', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        collection(db, TEAMS_COLLECTION, teamId, SUBSCRIPTION_TYPES_SUBCOLLECTION)
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as SubscriptionType)
    },
  })
}

function useTeamRankingSystems(teamId: string | null, orgId?: string | null) {
  return useQuery<RankingSystem[]>({
    queryKey: ['team-ranking-systems', teamId, orgId ?? null],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      // Org-level ranking systems override individual team systems when present
      if (orgId) {
        const orgSnap = await getDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId))
        const orgSystems = (orgSnap.data()?.ranking_systems as RankingSystem[] | undefined) ?? []
        if (orgSystems.length > 0) return orgSystems
      }
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId))
      return (snap.data()?.ranking_systems as RankingSystem[] | undefined) ?? []
    },
  })
}

// `useSubscriptionHistory` moved to @/hooks/useSubscriptionHistory — the Overview
// ledger needs the same query and the same cache entry, and a second copy would
// have doubled the reads while inviting the two to drift.

/** How many of a contact's bookings this tab loads. Newest first, so the cap
 *  trims the oldest history rather than the part anybody is looking at, and it
 *  bounds the session hydration below to at most one batch per 30 rows. */
const CONTACT_BOOKINGS_LIMIT = 60

export interface ContactBookings {
  bookings: Booking[]
  /** Session info for the loaded bookings, keyed by session id — same shape
   *  the bookings list uses, so `BookingRow` renders identically here. */
  sessions: Record<string, SessionInfo>
  /** The cap was hit: `bookings` is the newest 60, not the whole history. A
   *  contact sitting on EXACTLY 60 rows reads as truncated too — the same
   *  imprecision `useBookingsWindow`'s booking axis accepts for not having to
   *  fetch one extra row just to know. */
  truncated: boolean
}

/**
 * A contact's bookings.
 *
 * THE FILTER FIELD IS `contact`, NOT `contactId`. Every writer of a booking
 * document — `bookSession`, `rebookSession`, `createDropInCheckout`, the
 * appointment rails — stores the contact id under `contact` (the doc id is the
 * contact id too, but a collection-group query cannot filter on that). This
 * query asked for `contactId`, a field no booking has ever carried, so it
 * matched nothing for everybody, always: a confirmed booking left the contact
 * record looking like the person had never booked at all (UX-89). The composite
 * index that was already deployed — `(teamId, contact, joinedAt DESC)` in
 * firestore.index.json — is the query as it was meant to be written.
 *
 * NOT the same question as the header's "Total sessions": that counter is
 * `contact.total_sessions`, written only by the `sessions/{id}/participants`
 * trigger, i.e. by ATTENDANCE. Zero attended after a booking is correct; the
 * number that was missing is this one.
 *
 * Returns the SAME shape `useBookingsWindow` does (`Booking[]` +
 * `Record<sessionId, SessionInfo>`) rather than a bespoke summary, because the
 * row is now `BookingRow` — the general bookings list's row — and it wants a
 * real `Booking`. The old shape kept `id: d.ref.path`, which every action
 * (`doc(db,'sessions', b.session, 'bookings', b.id)`) would have turned into a
 * broken ref built from a full Firestore path instead of a bare doc id.
 *
 * No server-side status filter: that would need a new composite index, and
 * the bookings page already filters status client-side over an already-loaded
 * page, which this hook feeds identically.
 */
function useContactBookings(contactId: string, teamId: string | null) {
  return useQuery<ContactBookings>({
    // `teamId` in the key: two different tenants must never share a cache
    // entry keyed only by `contactId` (which is not itself tenant-scoped).
    queryKey: ['contact-bookings', teamId, contactId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return { bookings: [], sessions: {}, truncated: false }
      const snap = await getDocs(
        query(
          collectionGroup(db, SESSION_BOOKINGS_SUBCOLLECTION),
          where('teamId', '==', teamId),
          where('contact', '==', contactId),
          orderBy('joinedAt', 'desc'),
          limit(CONTACT_BOOKINGS_LIMIT)
        )
      )
      const bookings = snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Booking)

      // WHAT and WHEN come from the SESSION, not the booking. Batched by
      // documentId, 30 at a time — Firestore's `in` limit.
      const sessionIds = [...new Set(bookings.map((b) => b.session).filter((s): s is string => !!s))]
      const sessions: Record<string, SessionInfo> = {}
      for (let i = 0; i < sessionIds.length; i += 30) {
        const batch = sessionIds.slice(i, i + 30)
        const sSnap = await getDocs(
          query(collection(db, SESSIONS_COLLECTION), where(documentId(), 'in', batch))
        )
        sSnap.docs.forEach((sd) => {
          const s = sd.data()
          sessions[sd.id] = {
            activityName: s.activityName as string | undefined,
            start: tsToDate(s.start)?.toISOString(),
            end: tsToDate(s.end)?.toISOString(),
            allowBooking: s.allowBooking as boolean | undefined,
          }
        })
      }

      return { bookings, sessions, truncated: bookings.length === CONTACT_BOOKINGS_LIMIT }
    },
  })
}

const PAGE_SIZE = 100

function useContactActivityLog(contactId: string, teamId: string | null, days?: number | null) {
  return useQuery<ActivityLogEntry[]>({
    // key on stable `days` value — date is computed inside queryFn to avoid
    // re-fetching on every render (new Date() changes every millisecond)
    queryKey: ['contact-activity-log', contactId, days ?? 'all'],
    enabled: !!teamId,
    queryFn: async () => {
      const since = days ? new Date(Date.now() - days * 86_400_000) : null
      const constraints = since
        ? [
            where('refs.contact', '==', contactId),
            where('created_at', '>=', Timestamp.fromDate(since)),
            orderBy('created_at', 'desc'),
            limit(PAGE_SIZE),
          ]
        : [where('refs.contact', '==', contactId), orderBy('created_at', 'desc'), limit(PAGE_SIZE)]
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, TEAM_ACTIVITY_LOG_SUBCOLLECTION),
          ...constraints
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as ActivityLogEntry)
    },
  })
}

interface RecentSession {
  id: string
  checkedInAt: { toDate(): Date } | null
}

/**
 * The sessions this contact was actually checked in to, most recent first.
 *
 * ORDERED ON `checkedInAt`, WHICH IS THE FIELD THE WRITER WRITES. It asked for
 * `joinedAt` — a field `buildParticipantDoc` (the ONE writer of an attendance
 * row) has never set — and the index behind that query is sparse, so every real
 * check-in was silently absent and the list came back empty. Only the seeders
 * write `joinedAt` on participants, which is why this looked alive on demo data
 * and dead for every studio. Same failure as the bookings query above, one
 * collection over.
 */
function useContactRecentSessions(contactId: string, count: number) {
  return useQuery<RecentSession[]>({
    queryKey: ['contact-recent-sessions', contactId, count],
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collectionGroup(db, PARTICIPANTS_SUBCOLLECTION),
          where('contactId', '==', contactId),
          orderBy('checkedInAt', 'desc'),
          limit(count)
        )
      )
      return snap.docs.map((d) => ({ id: d.id, checkedInAt: d.data().checkedInAt ?? null }))
    },
  })
}

// TWO shapes exist in `contact_alerts` (a flat pair this page/the migration
// write, and a nested `schedule: { type, value }` the server writers use) —
// `readAlert()` (`@linyup/shared`) is the one reader that understands both.
// See its module header for the mobile bug that motivated it.

function useContactAlerts(contactId: string) {
  return useQuery<ContactAlert[]>({
    queryKey: ['contact-alerts', contactId],
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, CONTACTS_COLLECTION, contactId, CONTACT_ALERTS_SUBCOLLECTION),
          orderBy('created_at', 'desc')
        )
      )
      return snap.docs.map((d) => readAlert(d.id, d.data() as RawContactAlert))
    },
  })
}

interface AlertPresetRecord {
  id: string
  name: string
  schedule_type: AlertScheduleType
  schedule_value?: number
  message: string
  show_in_app?: boolean
}

function useAlertPresets(teamId: string | null) {
  return useQuery<AlertPresetRecord[]>({
    queryKey: ['alert-presets', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        collection(db, TEAMS_COLLECTION, teamId, ALERT_PRESETS_SUBCOLLECTION)
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as AlertPresetRecord)
    },
  })
}

// ─── affiliation hooks ────────────────────────────────────────────────────────

function useContactAffiliations(contactId: string) {
  return useQuery<Affiliation[]>({
    queryKey: ['contact-affiliations', contactId],
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, CONTACTS_COLLECTION, contactId, CONTACT_AFFILIATIONS_SUBCOLLECTION),
          orderBy('created_at', 'desc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Affiliation)
    },
  })
}

function useAffiliationTypes(teamId: string | null, orgId?: string | null) {
  return useQuery<AffiliationType[]>({
    queryKey: ['affiliation-types', teamId, orgId ?? null],
    enabled: !!teamId,
    queryFn: async () => {
      const results: AffiliationType[] = []
      if (teamId) {
        const snap = await getDocs(
          collection(db, TEAMS_COLLECTION, teamId, AFFILIATION_TYPES_SUBCOLLECTION)
        )
        snap.docs.forEach((d) => results.push({ ...d.data(), id: d.id } as AffiliationType))
      }
      if (orgId) {
        const snap = await getDocs(
          collection(db, ORGANIZATIONS_COLLECTION, orgId, AFFILIATION_TYPES_SUBCOLLECTION)
        )
        snap.docs.forEach((d) => results.push({ ...d.data(), id: d.id } as AffiliationType))
      }
      return results
    },
  })
}

function useOrgAffiliationStatuses(orgId?: string | null) {
  return useQuery<OrgAffiliationStatusDef[]>({
    queryKey: ['org-affiliation-statuses', orgId ?? null],
    enabled: !!orgId,
    queryFn: async () => {
      if (!orgId) return DEFAULT_ORG_AFFILIATION_STATUSES
      const snap = await getDocs(
        collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_AFFILIATION_STATUSES_SUBCOLLECTION)
      )
      if (snap.empty) return DEFAULT_ORG_AFFILIATION_STATUSES
      const docs = snap.docs
        .map((d) => ({ ...d.data(), id: d.id }) as OrgAffiliationStatusDef)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      return docs.length > 0 ? docs : DEFAULT_ORG_AFFILIATION_STATUSES
    },
  })
}

// ─── field wrapper ────────────────────────────────────────────────────────────

function Field({
  label,
  required,
  hint,
  children,
  error,
  className,
}: {
  label: string
  required?: boolean
  /** Behind an ⓘ beside the label, not a grey line under the control. */
  hint?: React.ReactNode
  children: React.ReactNode
  error?: string
  className?: string
}) {
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <label className="flex items-center gap-1.5 text-sm font-medium">
        <span>
          {label}
          {required && <span className="text-destructive ml-1">*</span>}
        </span>
        {hint && <HintTip>{hint}</HintTip>}
      </label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

// ─── read-only detail row ─────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: React.ReactNode; value?: string | null }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-2 py-2 border-b last:border-0">
      <span className="text-sm text-muted-foreground flex items-center gap-1">{label}</span>
      <span className="text-sm">{value || '—'}</span>
    </div>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-4 pb-1 first:pt-0">
      {children}
    </h3>
  )
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 mt-6 mb-1">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
        {label}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

function FormBlock({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4 space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
        {title}
      </p>
      {children}
    </div>
  )
}

// ─── promote stage button ─────────────────────────────────────────────────────

function PromoteStageButton({
  contact,
  onPromoted,
}: {
  contact: Contact
  onPromoted: () => void
}) {
  const t = useTranslations('Contacts')
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()

  // An off-funnel contact (no stage — e.g. entered via shop/form) can be placed ON
  // the funnel at the first stage; from there it advances normally.
  const nextStage: AcquisitionStage | null =
    !contact.acquisition_stage ? 'trial_booked'
    : contact.acquisition_stage === 'trial_booked' ? 'trial_attended'
    : contact.acquisition_stage === 'trial_attended' ? 'joined'
    : null

  if (!nextStage) return null

  const promote = async () => {
    setBusy(true)
    try {
      const now = serverTimestamp()
      await updateDoc(doc(db, CONTACTS_COLLECTION, contact.id), {
        acquisition_stage: nextStage,
        acquisition_stage_updated_at: now,
        ...(nextStage === 'trial_booked' ? { trial_booked_at: now } : {}),
        ...(nextStage === 'trial_attended' ? { trial_attended_at: now } : {}),
        ...(nextStage === 'joined' ? { converted_at: now } : {}),
        // Promoting past 'trial_booked' MATERIALIZES a provisional lead — it now
        // counts toward the contact cap. See Contact.provisional.
        ...(nextStage === 'trial_attended' || nextStage === 'joined'
          ? { provisional: deleteField(), provisional_expires_at: deleteField() }
          : {}),
        updatedAt: now,
      })
      qc.invalidateQueries({ queryKey: ['contact', contact.id] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      onPromoted()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={promote}
      disabled={busy}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
    >
      <ArrowRightLeft className="h-3.5 w-3.5" />
      {contact.acquisition_stage
        ? t('promoteButton', { stage: t(`stage_${nextStage}` as Parameters<typeof t>[0]) })
        : t('placeOnFunnel')}
    </button>
  )
}

// ─── stage correction menu ────────────────────────────────────────────────────
// The acquisition funnel is one-way by design; this is the escape hatch for a
// mistaken promotion. Stepping back one stage is treated as a CORRECTION
// server-side — it does NOT re-fire outreach automation or inflate conversion
// analytics (see analytics/index.ts + automation/onContactWrite.ts). Milestone
// timestamps that no longer hold are cleared so a later re-promotion re-stamps
// the real date.

function StageCorrectionMenu({
  contact,
  onCorrected,
}: {
  contact: Contact
  onCorrected: () => void
}) {
  const t = useTranslations('Contacts')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()

  const stages = ACQUISITION_STAGES as readonly string[]
  const currentRank = stages.indexOf(contact.acquisition_stage ?? '')
  const prevStage = currentRank > 0 ? ACQUISITION_STAGES[currentRank - 1] : null

  // Nothing to revert to at the first stage.
  if (!prevStage) return null

  const prevStageLabel = t(`stage_${prevStage}` as Parameters<typeof t>[0])

  const revert = async () => {
    setBusy(true)
    try {
      const now = serverTimestamp()
      const newRank = currentRank - 1
      const updates: Record<string, unknown> = {
        acquisition_stage: prevStage,
        acquisition_stage_updated_at: now,
        updatedAt: now,
      }
      if (newRank < stages.indexOf('joined')) updates.converted_at = null
      if (newRank < stages.indexOf('trial_attended')) updates.trial_attended_at = null
      await updateDoc(doc(db, CONTACTS_COLLECTION, contact.id), updates)
      qc.invalidateQueries({ queryKey: ['contact', contact.id] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      onCorrected()
    } finally {
      setBusy(false)
      setConfirmOpen(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t('stageMenuLabel')}
          className="flex items-center justify-center h-8 w-8 rounded-lg border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <MoreVertical className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setConfirmOpen(true)}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('revertMenuItem', { stage: prevStageLabel })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('revertTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('revertConfirm', { stage: prevStageLabel })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={revert} disabled={busy}>
              {t('revertButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </ConfirmDialog>
    </>
  )
}

// ─── acquisition timeline ─────────────────────────────────────────────────────
// Horizontal stepper of the funnel stages with the date each milestone was
// reached. Reached stages show an inline, editable date (deep year range so
// historical join dates can be backdated, e.g. members imported from another
// system); future stages are muted. Dates are part of the profile form and save
// with it — editing a date never moves acquisition_stage, so nothing re-fires.

const MILESTONE_DATE_FIELD: Record<
  AcquisitionStage,
  'trial_booked_at' | 'trial_attended_at' | 'converted_at'
> = {
  trial_booked: 'trial_booked_at',
  trial_attended: 'trial_attended_at',
  joined: 'converted_at',
}

function AcquisitionTimeline({
  contact,
  control,
  orientation = 'horizontal',
}: {
  contact: Contact
  control: Control<ProfileValues>
  orientation?: 'horizontal' | 'vertical'
}) {
  const t = useTranslations('Contacts')
  const currentRank = (ACQUISITION_STAGES as readonly string[]).indexOf(contact.acquisition_stage ?? '')
  const fromYear = new Date().getFullYear() - 50
  const lastIndex = ACQUISITION_STAGES.length - 1

  // Vertical variant — earliest stage on top; the rail (node + connector below)
  // runs down the left, label + editable date to the right. Used in the 2-column
  // acquisition card and whenever the layout stacks on small screens.
  if (orientation === 'vertical') {
    return (
      <ol className="flex flex-col">
        {ACQUISITION_STAGES.map((stage, i) => {
          const reached = i <= currentRank
          const isCurrent = i === currentRank
          const isLast = i === lastIndex
          return (
            <li key={stage} className="flex gap-3">
              {/* rail: node + connector down to the next node */}
              <div className="flex flex-col items-center">
                <span
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition-colors ${
                    reached ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background'
                  } ${isCurrent ? 'ring-4 ring-primary/15' : ''}`}
                >
                  {reached && <Check className="h-3 w-3" />}
                </span>
                {!isLast && (
                  <span className={`my-1 w-0.5 flex-1 ${i < currentRank ? 'bg-primary' : 'bg-border'}`} />
                )}
              </div>
              {/* label + milestone date */}
              <div className={`min-w-0 ${isLast ? '' : 'pb-4'}`}>
                <p
                  className={`text-[0.8125rem] font-medium leading-5 ${reached ? 'text-foreground' : 'text-muted-foreground'}`}
                >
                  {t(`stage_${stage}` as Parameters<typeof t>[0])}
                </p>
                {reached ? (
                  <Controller
                    control={control}
                    name={MILESTONE_DATE_FIELD[stage]}
                    render={({ field }) => (
                      <DatePicker
                        variant="ghost"
                        value={field.value}
                        onChange={field.onChange}
                        fromYear={fromYear}
                        placeholder="—"
                        className="-ml-1.5 mt-0.5 text-xs"
                      />
                    )}
                  />
                ) : (
                  <p className="mt-0.5 text-xs text-muted-foreground">—</p>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    )
  }

  return (
    <div className="flex">
      {ACQUISITION_STAGES.map((stage, i) => {
        const reached = i <= currentRank
        const isCurrent = i === currentRank
        return (
          <div key={stage} className="flex min-w-0 flex-1 flex-col items-center">
            {/* connector line + node */}
            <div className="flex w-full items-center">
              <span
                className={`h-0.5 flex-1 ${i === 0 ? 'opacity-0' : i <= currentRank ? 'bg-primary' : 'bg-border'}`}
              />
              <span
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition-colors ${
                  reached ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background'
                } ${isCurrent ? 'ring-4 ring-primary/15' : ''}`}
              >
                {reached && <Check className="h-3 w-3" />}
              </span>
              <span
                className={`h-0.5 flex-1 ${i === lastIndex ? 'opacity-0' : i < currentRank ? 'bg-primary' : 'bg-border'}`}
              />
            </div>
            {/* stage label */}
            <p
              className={`mt-1.5 text-center text-xs font-medium leading-tight ${reached ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              {t(`stage_${stage}` as Parameters<typeof t>[0])}
            </p>
            {/* milestone date — centered under its step; editable for reached stages */}
            <div className="mt-1 flex justify-center px-0.5">
              {reached ? (
                <Controller
                  control={control}
                  name={MILESTONE_DATE_FIELD[stage]}
                  render={({ field }) => (
                    <DatePicker
                      variant="ghost"
                      value={field.value}
                      onChange={field.onChange}
                      fromYear={fromYear}
                      placeholder="—"
                      className="text-xs"
                    />
                  )}
                />
              ) : (
                <p className="py-2 text-center text-xs text-muted-foreground">—</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── notes side panel ─────────────────────────────────────────────────────────
// Notes live off the tab strip: a sticky-note button with a live count badge in
// the header opens a right-side sheet hosting the full notes editor. Keeps the
// tab strip lean and notes one click away from whatever tab you're on.

// Round icon button for the header action cluster (notes + alerts), with an
// optional count badge. Kept generic so both surfaces share one look.
/** One held membership as a chip (`heldMemberships`, the plan list): green
 *  while it runs, amber when it is past due or winding down (with the end
 *  date), muted while paused. A grant with an end of its own shows it too. */
function PlanChip({ plan }: { plan: HeldPlan }) {
  const fmt = useTeamFormat()
  const t = useTranslations('Contacts')
  const winding = plan.status === 'cancelling'
  const tone =
    winding || plan.status === 'past_due'
      ? 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800'
      : plan.status === 'paused'
        ? 'bg-muted text-muted-foreground border-border'
        : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'
  const ends = plan.ends_at_ms ? fmt.dayMonth(plan.ends_at_ms) : null
  return (
    <Badge className={`gap-1 ${tone}`}>
      <BookOpen className="h-3 w-3" />
      {plan.subscription_type_name ?? t('subscriptionHeadingCard')}
      {ends && (winding || plan.source === 'grant') && (
        <span className="font-normal opacity-80">· {t('planChipEnds', { date: ends })}</span>
      )}
    </Badge>
  )
}

function HeaderActionButton({
  icon: Icon,
  label,
  shortLabel,
  count = 0,
  disabled = false,
  onClick,
}: {
  icon: React.ElementType
  label: string
  /** A caption under the icon. The long `label` stays the tooltip and the
   *  accessible name; this is the two-word version that fits a tile. */
  shortLabel?: string
  count?: number
  /** Greyed out; the `label` tooltip says why. */
  disabled?: boolean
  onClick: () => void
}) {
  // The count badge is a NUMBER, not a label: it says how many notes there are,
  // never what pressing this does. Icon-only in the sense that matters.
  return (
    <Tip label={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={`${
          shortLabel
            ? 'relative flex w-full flex-col items-center gap-1 rounded-xl border px-1 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
            : 'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors'
        } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground`}
      >
        <Icon className="h-4 w-4" />
        {shortLabel && (
          <span className="max-w-full truncate text-xs leading-tight">{shortLabel}</span>
        )}
        {count > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground">
            {count}
          </span>
        )}
      </button>
    </Tip>
  )
}

/**
 * Roster ↔ external (Contact.external), for every place that offers the switch:
 * the card's "More actions" menu and the Profile tab's roster row. Marking
 * external asks first — it silences every reminder and invitation for this
 * person; bringing them back does not. `external` is present only when true,
 * so the way back DELETES the fields rather than writing false. Nothing else
 * moves. Returns the confirm dialog for the caller to render.
 */
function useRosterToggle(contact: Contact | null | undefined, onChanged: () => void) {
  const t = useTranslations('Contacts')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const isExternal = contact?.external === true

  const write = async (external: boolean) => {
    if (!contact) return
    setBusy(true)
    try {
      await updateDoc(
        doc(db, CONTACTS_COLLECTION, contact.id),
        external
          ? { external: true, external_since: serverTimestamp(), updatedAt: serverTimestamp() }
          : { external: deleteField(), external_since: deleteField(), updatedAt: serverTimestamp() }
      )
      onChanged()
      setConfirmOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const toggle = () => (isExternal ? void write(false) : setConfirmOpen(true))

  const dialog = (
    <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('markExternalTitle', { count: 1 })}</AlertDialogTitle>
          <AlertDialogDescription>{t('markExternalDesc')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void write(true)} disabled={busy}>
            {t('bulkMarkExternal')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </ConfirmDialog>
  )

  return { isExternal, toggle, busy, dialog }
}

// The notes editor lives in a single right-side sheet, opened from the header
// icon and from the profile-column glance cards — one canonical add/edit/delete
// surface on every screen size (see the profile-column glance below).
function NotesSheet({
  contact,
  open,
  onOpenChange,
}: {
  contact: Contact
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const t = useTranslations('Contacts')
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md!">
        <SheetHeader>
          <SheetTitle>{t('tabNotes')}</SheetTitle>
          {/* Notes vs alerts is genuinely ambiguous, so it is worth saying —
              but HERE, not on the page. The contact page is already dense, and
              a caption under a glance heading spends permanent page weight on
              something you need once. In the panel it reaches the reader at the
              moment they are choosing, and costs the page nothing. It doubles
              as the sheet's accessible description, so there is still exactly
              one string. */}
          <SheetDescription>{t('notesPanelDesc')}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-6">
          <NotesTab contact={contact} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * The alerts panel — the same right-hand Sheet the notes use.
 *
 * Alerts lived inside the Follow-ups tab, two clicks and a tab away from the
 * person they are about, while notes — the other thing a coach jots down about
 * somebody — sat in the profile column with an editor a click away. They are the
 * same kind of thing and now they behave the same way (Franco, 2026-08-28).
 *
 * It takes `teamId` where NotesSheet needed nothing: the alert presets live on
 * the team.
 */
function AlertsSheet({
  contact,
  teamId,
  open,
  onOpenChange,
}: {
  contact: Contact
  teamId: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const t = useTranslations('Contacts')
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md!">
        <SheetHeader>
          <SheetTitle>{t('tabAlerts')}</SheetTitle>
          {/* Visible, for the reason given on the notes sheet above. */}
          <SheetDescription>{t('alertsPanelDesc')}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-6">
          <AlertsTab contact={contact} teamId={teamId} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ─── profile tab ──────────────────────────────────────────────────────────────

/**
 * THE PROFILE SAVES THROUGH THE PAGE'S SAVE BAR, like every settings page: one
 * "Unsaved changes · Discard · Save" pill that is there only while something
 * is. It used to be a floating "Save changes" button of its own, a second
 * vocabulary for the same act.
 */
function ProfileSaveBridge({
  dirty,
  valid,
  save,
  reset,
}: {
  dirty: boolean
  valid: boolean
  save: () => Promise<boolean>
  reset: () => void
}) {
  useSaveBarSection('contact-profile', { dirty, valid, save, reset })
  return null
}

function ProfileTab({
  contact,
  teamId,
  orgId,
  onSaved,
}: {
  contact: Contact
  teamId: string | null
  orgId?: string | null
  onSaved: () => void
}) {
  const fmt = useTeamFormat()
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const { team } = useAuth()
  const { isInstalled } = useInstalledPlugins()
  const { data: rankingSystems = [] } = useTeamRankingSystems(teamId, orgId)
  const { can } = useCapabilities()
  const roster = useRosterToggle(contact, onSaved)

  const GENDERS: ContactGender[] = ['M', 'F', 'other']

  const {
    register,
    handleSubmit,
    control,
    reset,
    getValues,
    formState: { errors, isDirty },
  } = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      firstname: contact.firstname,
      lastname: contact.lastname,
      email: contact.email ?? '',
      phone: contact.phone ?? '',
      login_emails: (contact.login_emails ?? []).map((e) => ({ value: e })),
      gender: contact.gender,
      birthdate: tsToDate(contact.birthdate),
      birthplace: contact.birthplace ?? '',
      // "" rather than undefined when unset: an empty number box reads back as
      // "", so an undefined default made every contact without a weight look
      // edited on load (and again after Discard), and the save bar came up
      // before anyone had typed. The schema coerces it, and the write turns
      // an empty one into null.
      weight: (contact.weight ?? '') as unknown as number,
      address_route: contact.address?.route ?? '',
      address_street_number: contact.address?.street_number ?? '',
      address_postal_code: contact.address?.postal_code ?? '',
      address_locality: contact.address?.locality ?? '',
      entry: contact.entry,
      source: contact.source,
      source_detail: contact.source_detail ?? '',
      trial_booked_at: tsToDate(contact.trial_booked_at) ?? tsToDate(contact.created_at),
      trial_attended_at: tsToDate(contact.trial_attended_at),
      converted_at: tsToDate(contact.converted_at),
      ranks: contact.ranks ?? {},
      custom_fields: contact.custom_fields ?? {},
      emergency_contacts: contact.emergency_contacts ?? [],
    },
  })

  const { fields: ecFields, append: ecAppend, remove: ecRemove } = useFieldArray({
    control,
    name: 'emergency_contacts',
  })

  const { fields: leFields, append: leAppend, remove: leRemove } = useFieldArray({
    control,
    name: 'login_emails',
  })

  const onSubmit = async (values: ProfileValues) => {
    await updateDoc(doc(db, CONTACTS_COLLECTION, contact.id), {
      firstname: values.firstname,
      lastname: values.lastname,
      email: values.email || null,
      phone: values.phone || null,
      // Allow-list: normalize (lowercase, dedupe, drop the primary + blanks), cap 5.
      login_emails: Array.from(
        new Set(
          (values.login_emails ?? [])
            .map((e) => e.value.toLowerCase().trim())
            .filter((e) => e && e !== (values.email || '').toLowerCase().trim())
        )
      ).slice(0, MAX_CONTACT_LOGIN_EMAILS),
      gender: values.gender || null,
      birthdate: values.birthdate ? Timestamp.fromDate(values.birthdate) : null,
      birthplace: values.birthplace || null,
      weight: values.weight || null,
      address: {
        route: values.address_route || null,
        street_number: values.address_street_number || null,
        postal_code: values.address_postal_code || null,
        locality: values.address_locality || null,
      },
      // Entry is editable as a correction but does NOT move acquisition_stage
      entry: values.entry || null,
      source: values.source || null,
      source_detail: values.source_detail || null,
      // Milestone dates — editing these does NOT change acquisition_stage, so no
      // automation/analytics fires (safe to backdate an imported member's join).
      trial_booked_at: values.trial_booked_at ? Timestamp.fromDate(values.trial_booked_at) : null,
      trial_attended_at: values.trial_attended_at
        ? Timestamp.fromDate(values.trial_attended_at)
        : null,
      converted_at: values.converted_at ? Timestamp.fromDate(values.converted_at) : null,
      ranks: values.ranks ?? {},
      custom_fields: values.custom_fields ?? {},
      emergency_contacts: (values.emergency_contacts ?? []).filter((ec) => ec.name.trim() !== ''),
      updatedAt: serverTimestamp(),
    })
    // What was saved is the new baseline, or the bar would stay up after a
    // successful save (the defaults are read once, at mount). The RAW form
    // values, not the parsed ones: parsing coerces an empty weight to 0, and
    // the box would show "0" straight after saving.
    reset(getValues())
    onSaved()
  }

  async function saveFromBar(): Promise<boolean> {
    let ok = false
    try {
      await handleSubmit(async (values) => {
        await onSubmit(values)
        ok = true
      })()
    } catch (err) {
      console.error('[contact-profile] save failed:', err)
      toast.error(tCommon('saveFailed'))
    }
    return ok
  }

  return (
    <SaveBarProvider>
    <ProfileSaveBridge
      dirty={isDirty}
      valid={Object.keys(errors).length === 0}
      save={saveFromBar}
      reset={() => reset()}
    />
    {/* One column, capped: the Notes / Alerts column that sat beside it
        repeated the header's Notes and Alerts tiles, which open the same
        sheets from every tab. */}
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void saveFromBar()
      }}
      className="max-w-4xl space-y-4 pb-24"
    >
      {/* Single-column section blocks; fields flow into rows within each block on wider screens */}
      <div className="space-y-6">
        {/* Personal information */}
        <FormBlock title={t('sectionPersonalInfo')}>
          <div className="flex flex-wrap gap-4">
            <Field
              className="flex-1 min-w-[160px]"
              label={t('fieldFirstname')}
              required
              error={errors.firstname?.message}
            >
              <Input {...register('firstname')} autoCapitalize="words" />
            </Field>
            <Field
              className="flex-1 min-w-[160px]"
              label={t('fieldLastname')}
              required
              error={errors.lastname?.message}
            >
              <Input {...register('lastname')} autoCapitalize="words" />
            </Field>
            <Field className="flex-1 min-w-[140px]" label={t('fieldGender')}>
              <Controller
                control={control}
                name="gender"
                render={({ field }) => (
                  <Select
                    value={field.value ?? ''}
                    onValueChange={(val) => field.onChange(val || undefined)}
                  >
                    <SelectTrigger className="w-full">
                      <span className="flex flex-1 text-left text-sm truncate">
                        {field.value ? (
                          t(`gender_${field.value}`)
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">—</SelectItem>
                      {GENDERS.map((g) => (
                        <SelectItem key={g} value={g}>
                          {t(`gender_${g}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-4">
            <Field className="flex-1 min-w-[160px]" label={t('fieldBirthdate')}>
              <Controller
                control={control}
                name="birthdate"
                render={({ field }) => <DatePicker value={field.value} onChange={field.onChange} />}
              />
            </Field>
            <Field className="flex-1 min-w-[160px]" label={t('fieldBirthplace')}>
              <Input {...register('birthplace')} />
            </Field>
            <Field className="flex-1 min-w-[120px]" label={t('fieldWeight')}>
              <Input
                type="number"
                step="0.1"
                min="0"
                max="500"
                inputMode="decimal"
                {...register('weight')}
              />
            </Field>
          </div>
        </FormBlock>

        {/* Contact */}
        <FormBlock title={t('sectionContact')}>
          <div className="flex flex-wrap gap-4">
            <Field className="flex-1 min-w-[200px]" label={t('colEmail')}>
              <Input type="email" {...register('email')} inputMode="email" />
            </Field>
            <Field className="flex-1 min-w-[180px]" label={t('fieldPhone')}>
              <Input type="tel" {...register('phone')} inputMode="tel" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-4">
            <Field className="flex-[2] min-w-[200px]" label={t('fieldStreet')}>
              <Input {...register('address_route')} />
            </Field>
            <Field className="flex-1 min-w-[90px]" label={t('fieldStreetNumber')}>
              <Input {...register('address_street_number')} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-4">
            <Field className="flex-1 min-w-[110px]" label={t('fieldPostalCode')}>
              <Input {...register('address_postal_code')} />
            </Field>
            <Field className="flex-[2] min-w-[180px]" label={t('fieldLocality')}>
              <Input {...register('address_locality')} />
            </Field>
          </div>
          {/* WhatsApp — not a form field (it writes through setContactWhatsAppConsent,
              never the profile save above), so it renders its own row rather
              than registering into this form. */}
          <WhatsAppConsentRow teamId={teamId} contact={contact} />
        </FormBlock>

        {/* Passwordless-login allow-list — extra emails that may sign in as this contact */}
        <FormBlock
          title={
            <>
              {t('sectionLoginEmails')}
              <HintTip>{t('loginEmailsDesc')}</HintTip>
            </>
          }
        >
          <div className="space-y-2">
            {leFields.map((field, index) => (
              <div key={field.id} className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input
                      type="email"
                      inputMode="email"
                      placeholder={t('loginEmailPlaceholder')}
                      {...register(`login_emails.${index}.value`)}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => leRemove(index)}
                    className="p-2 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors"
                    aria-label={t('loginEmailRemove')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {errors.login_emails?.[index]?.value?.message && (
                  <p className="text-xs text-destructive">{t('loginEmailInvalid')}</p>
                )}
              </div>
            ))}
            {leFields.length < MAX_CONTACT_LOGIN_EMAILS && (
              <button
                type="button"
                onClick={() => leAppend({ value: '' })}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <Plus className="h-4 w-4" />
                {t('loginEmailAdd')}
              </button>
            )}
          </div>
        </FormBlock>

        {/* Emergency contacts */}
        <FormBlock title={t('sectionEmergencyContacts')}>
          <div className="space-y-4">
            {ecFields.map((field, index) => (
              <div key={field.id} className="rounded-lg border p-3 space-y-2 relative">
                <button
                  type="button"
                  onClick={() => ecRemove(index)}
                  className="absolute top-2 right-2 p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors"
                  aria-label={t('emergencyContactRemove')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                <Field
                  label={t('emergencyContactName')}
                  required
                  error={errors.emergency_contacts?.[index]?.name?.message}
                >
                  <Input {...register(`emergency_contacts.${index}.name`)} autoCapitalize="words" />
                </Field>
                <Field label={t('emergencyContactPhone')}>
                  <Input type="tel" inputMode="tel" {...register(`emergency_contacts.${index}.phone`)} />
                </Field>
                <Field
                  label={t('emergencyContactEmail')}
                  error={errors.emergency_contacts?.[index]?.email?.message}
                >
                  <Input type="email" inputMode="email" {...register(`emergency_contacts.${index}.email`)} />
                </Field>
              </div>
            ))}
            {ecFields.length < 2 && (
              <button
                type="button"
                onClick={() => ecAppend({ name: '', phone: '', email: '' })}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors w-full justify-center"
              >
                <Plus className="h-4 w-4" />
                {t('emergencyContactAdd')}
              </button>
            )}
          </div>
        </FormBlock>

        {/* Ranks — rendered only where a studio actually awards them (UX-39).
            This block used to render for everyone: a studio with no ranking
            system met an empty panel, an icon and a link inviting it to go set
            one up, on the page it opens most often in the product. Ranks are a
            martial-arts / grading-school feature, not a general one, and this
            was the loudest of the places the product taxed every studio that
            will never award one. It is demoted, not gated — the manager
            lives at Settings → Team → Ranking, and the moment a system exists
            this panel comes back on every contact with nothing to migrate. */}
        {rankingSystems.length > 0 && (
          <FormBlock title={t('sectionRanks')}>
            <Controller
              control={control}
              name="ranks"
              render={({ field }) => (
                <div className="space-y-3">
                  {rankingSystems.map((system) => {
                    const currentValue = field.value?.[system.id]
                    const useButtons = system.levels.length <= 6
                    return (
                      <div key={system.id} className="space-y-1.5">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          {system.name}
                          {system.is_primary && <span className="ml-1.5 text-primary">·</span>}
                        </p>
                        {useButtons ? (
                          <div className="flex flex-wrap gap-1.5">
                            {system.levels.map((level) => {
                              // Selected when the STORED ref resolves to this level —
                              // an id, or a legacy number still on the record.
                              const selected = findRankLevel(system.levels, currentValue) === level
                              return (
                                <button
                                  key={level.id}
                                  type="button"
                                  onClick={() => {
                                    const next = { ...field.value }
                                    if (selected) {
                                      delete next[system.id]
                                    } else {
                                      next[system.id] = rankLevelKey(level)
                                    }
                                    field.onChange(next)
                                  }}
                                  className={`flex items-center gap-1.5 py-1 px-2.5 rounded-lg border text-sm font-medium transition-colors ${
                                    selected
                                      ? 'bg-primary text-primary-foreground border-primary'
                                      : 'bg-background text-muted-foreground hover:text-foreground'
                                  }`}
                                >
                                  <RankBadge level={level} size="sm" />
                                  {level.label}
                                </button>
                              )
                            })}
                          </div>
                        ) : (
                          <Select
                            value={currentValue !== undefined ? (findRankLevel(system.levels, currentValue)?.id ?? '') : ''}
                            onValueChange={(val) => {
                              const next = { ...field.value }
                              // Item values are the levels' keys as strings; map back
                              // to the level so an id-less level still writes its value.
                              const picked = system.levels.find((l) => String(rankLevelKey(l)) === val)
                              if (val === '' || !picked) {
                                delete next[system.id]
                              } else {
                                next[system.id] = rankLevelKey(picked)
                              }
                              field.onChange(next)
                            }}
                          >
                            <SelectTrigger className="w-full">
                              <span className="flex flex-1 text-left text-sm truncate">
                                {currentValue !== undefined ? (
                                  (() => {
                                    const lvl = findRankLevel(system.levels, currentValue)
                                    return lvl ? (
                                      <span className="flex items-center gap-2">
                                        {lvl.color && (
                                          <span
                                            className="inline-block h-2.5 w-2.5 rounded-full shrink-0 border border-border"
                                            style={{ background: lvl.color }}
                                          />
                                        )}
                                        {lvl.label}
                                      </span>
                                    ) : (
                                      String(currentValue)
                                    )
                                  })()
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </span>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="">—</SelectItem>
                              {system.levels.map((level) => (
                                <SelectItem key={level.id} value={level.id} textValue={level.label}>
                                  <span className="flex items-center gap-2">
                                    {level.color && (
                                      <span
                                        className="inline-block h-2.5 w-2.5 rounded-full shrink-0 border border-border"
                                        style={{ background: level.color }}
                                      />
                                    )}
                                    {level.label}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            />
          </FormBlock>
        )}

        {/* Acquisition — stage timeline + entry/source */}
        <div className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('sectionAcquisition')}
            </p>
            {/* Forward promote + correction escape hatch (revert a mistaken promotion) */}
            <div className="flex items-center gap-2">
              {contact.acquisition_stage !== 'joined' && (
                <PromoteStageButton contact={contact} onPromoted={onSaved} />
              )}
              <StageCorrectionMenu contact={contact} onCorrected={onSaved} />
            </div>
          </div>
          {/* On the roster, or external — a lifecycle fact, so it sits with the
              journey. The card's "More actions" menu offers the same switch. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="text-sm">
                <span className="text-muted-foreground">{t('rosterLabel')}: </span>
                <span className="font-medium">
                  {roster.isExternal ? t('externalBadge') : t('rosterActive')}
                </span>
                {roster.isExternal && contact.external_since && (
                  <span className="text-muted-foreground">
                    {' '}
                    · {t('externalSince')} {formatDate(fmt, contact.external_since)}
                  </span>
                )}
              </p>
              <HintTip>{roster.isExternal ? t('externalHint') : t('rosterActiveHint')}</HintTip>
            </div>
            {can('contacts.manage') && (
              <Button size="sm" variant="outline" onClick={roster.toggle} disabled={roster.busy}>
                {roster.isExternal ? (
                  <UserCheck className="mr-1.5 h-4 w-4" />
                ) : (
                  <DoorOpen className="mr-1.5 h-4 w-4" />
                )}
                {roster.isExternal ? t('headerMarkActive') : t('headerMarkExternal')}
              </Button>
            )}
          </div>
          {roster.dialog}
          {/* Two columns on desktop: inputs left, vertical stage timeline right, with
              a light divider between. Stacks on mobile — inputs first, timeline below. */}
          <div className="grid gap-x-6 gap-y-5 md:grid-cols-[minmax(0,1fr)_1px_minmax(190px,240px)]">
            {/* Left — entry / source / source detail, stacked */}
            <div className="space-y-4">
              {/* Entry — editable correction, does NOT move stage */}
              <Field label={t('fieldAcquisitionEntry')} hint={t('fieldAcquisitionEntryHelp')}>
                <Controller
                  control={control}
                  name="entry"
                  render={({ field }) => (
                    <Select value={field.value ?? ''} onValueChange={(v) => field.onChange(v || undefined)}>
                      <SelectTrigger className="w-full">
                        <span className="flex flex-1 text-left text-sm truncate">
                          {field.value
                            ? t(`entry_${field.value}` as Parameters<typeof t>[0])
                            : <span className="text-muted-foreground">—</span>}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">—</SelectItem>
                        {(CONTACT_ENTRIES as readonly ContactEntry[]).map((e) => (
                          <SelectItem key={e} value={e}>{t(`entry_${e}` as Parameters<typeof t>[0])}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              {/* Source */}
              <Field label={t('fieldAcquisitionSource')}>
                <Controller
                  control={control}
                  name="source"
                  render={({ field }) => (
                    <Select value={field.value ?? ''} onValueChange={(v) => field.onChange(v || undefined)}>
                      <SelectTrigger className="w-full">
                        <span className="flex flex-1 text-left text-sm truncate">
                          {field.value
                            ? t(`source_${field.value}` as Parameters<typeof t>[0])
                            : <span className="text-muted-foreground">—</span>}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">—</SelectItem>
                        {(CONTACT_SOURCES as readonly ContactSource[]).map((s) => (
                          <SelectItem key={s} value={s}>{t(`source_${s}` as Parameters<typeof t>[0])}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              <Field label={t('fieldAcquisitionSourceDetail')}>
                <Input {...register('source_detail')} />
              </Field>
            </div>
            {/* Divider — vertical on desktop, hidden when stacked */}
            <div className="hidden md:block bg-border" />
            {/* Right — vertical stage timeline (earliest on top) */}
            <div className="md:pt-0.5">
              {!contact.acquisition_stage && (
                <p className="mb-2.5 text-xs text-muted-foreground">{t('offFunnelNote')}</p>
              )}
              <AcquisitionTimeline contact={contact} control={control} orientation="vertical" />
            </div>
          </div>
        </div>

        {/* Custom Fields plugin — the last card, and ONLY when installed. It
            used to render an upsell card on every contact of every studio
            without it; the plugin catalogue is where a plugin is found. */}
        {isInstalled('custom-fields') && (
        <FormBlock title={t('sectionCustomFields')}>
          <Controller
            control={control}
            name="custom_fields"
            render={({ field }) => (
              <CustomFieldsCardBody
                installed={isInstalled('custom-fields')}
                definitions={team?.custom_field_definitions ?? []}
                value={field.value ?? {}}
                onChange={field.onChange}
              />
            )}
          />
        </FormBlock>
        )}
      </div>

    </form>
    </SaveBarProvider>
  )
}

// ─── notes tab ────────────────────────────────────────────────────────────────

// ─── bookings tab ─────────────────────────────────────────────────────────────
// Reuses the general bookings list's row and its action menu (`BookingRow`,
// `@/hooks/useBookingActions`) — a card list with no filters and no actions
// used to sit here, a second, poorer implementation of the same list. The
// status vocabulary is `BookingRow`'s shared `STATUS_VARIANT` now, not a local
// `BOOKING_STATUS_KEY` (deleted): both already styled `no_show` `destructive`
// here, but the BOOKINGS PAGE used to style it `secondary` — sharing a row
// settles that in favour of red on both surfaces (a no-show is a seat held
// and wasted), so /bookings' no-show colour changes, not this tab's
// (Franco, 2026-08-29).
//
// Status tabs + text search are ported from the bookings page — purely
// presentational filters over rows already loaded by `useContactBookings`.
// Deliberately NOT ported: the bookings page's date-AXIS toggle and date
// window. Those aren't a filter, they ARE the query (`useBookingsWindow`), and
// there is no contact-scoped equivalent to build — the class date lives on the
// SESSION doc, not the booking, so a "bookings for this contact within this
// class-date range" query isn't a filter over what's already loaded, it would
// need its own fan-out. Don't add one here; if a manager needs that, it
// belongs on /bookings with a contact filter, not here.

type ContactBookingStatusFilter = BookingStatus | 'all'

function BookingsTab({ contact, teamId }: { contact: Contact; teamId: string | null }) {
  const t = useTranslations('Contacts')
  const tBookings = useTranslations('Bookings')
  const { data, isLoading } = useContactBookings(contact.id, teamId)
  // Memoized (matching the bookings page's `windowData?.bookings ?? []`
  // pattern) so `searchFiltered` below doesn't see a fresh array identity on
  // every render while `data` is genuinely unchanged.
  const bookings = useMemo(() => data?.bookings ?? [], [data])
  const sessions = useMemo(() => data?.sessions ?? {}, [data])
  const truncated = data?.truncated ?? false

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<ContactBookingStatusFilter>('all')
  // null = not chosen yet: open on Upcoming when there is anything coming up,
  // on Past otherwise, so a lapsed member does not open on an empty list.
  const [timeTab, setTimeTab] = useState<'upcoming' | 'past' | null>(null)
  const [rebookTarget, setRebookTarget] = useState<Booking | null>(null)

  const { mutate: doAction } = useBookingAction(teamId)
  const { mutate: doRebook, isPending: rebooking } = useRebookAction(teamId)
  const { data: futureSessions = [], isLoading: futureLoading } = useFutureSessions(
    teamId,
    !!rebookTarget
  )
  const { data: bookedSessionIds, isLoading: bookedLoading } = useContactBookedSessions(
    teamId,
    rebookTarget?.contact ?? null
  )

  const statusLabel = buildBookingStatusLabels(tBookings)

  const handleAction = useCallback(
    (booking: Booking, action: BookingAction) => doAction({ booking, action }),
    [doAction]
  )
  const handleRebookConfirm = useCallback(
    (newSessionId: string) => {
      if (!rebookTarget?.booking_token) return
      doRebook(
        { token: rebookTarget.booking_token, newSessionId },
        { onSuccess: () => setRebookTarget(null) }
      )
    },
    [rebookTarget, doRebook]
  )

  // Search on the CLASS name — not the contact's own name, which would just be
  // redundant with being on their page already.
  const searchFiltered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return bookings
    return bookings.filter((b) => {
      const activityName = (b.session ? sessions[b.session]?.activityName : undefined) ?? ''
      return activityName.toLowerCase().includes(q)
    })
  }, [bookings, sessions, search])

  // UPCOMING / PAST, BY THE CLASS'S DATE (Franco, 2026-09-25). The rows came
  // in the order they were BOOKED (the query's `joinedAt desc`), so a member
  // who booked a block of classes in one go read "23 Sep, 5 Oct, 28 Sep, 25
  // Sep, 27 Oct". The question asked here is "what is coming up, what have
  // they done", which is the class date, split at now. A booking whose
  // session is gone has no date and sorts with the past.
  const startMs = useCallback(
    (b: Booking) => {
      const iso = b.session ? sessions[b.session]?.start : undefined
      return iso ? new Date(iso).getTime() : null
    },
    [sessions]
  )
  const nowMs = useMemo(() => Date.now(), [])
  const upcoming = useMemo(
    () =>
      searchFiltered
        .filter((b) => (startMs(b) ?? -Infinity) >= nowMs)
        .sort((a, b) => (startMs(a) ?? 0) - (startMs(b) ?? 0)),
    [searchFiltered, startMs, nowMs]
  )
  const past = useMemo(
    () =>
      searchFiltered
        .filter((b) => (startMs(b) ?? -Infinity) < nowMs)
        .sort((a, b) => (startMs(b) ?? 0) - (startMs(a) ?? 0)),
    [searchFiltered, startMs, nowMs]
  )
  const activeTime = timeTab ?? (upcoming.length > 0 ? 'upcoming' : 'past')
  const inTime = activeTime === 'upcoming' ? upcoming : past

  const filtered = useMemo(
    () =>
      statusFilter === 'all'
        ? inTime
        : inTime.filter((b) => (b.status ?? 'pending') === statusFilter),
    [inTime, statusFilter]
  )

  const STATUS_OPTIONS: { key: ContactBookingStatusFilter; label: string }[] = [
    { key: 'all', label: tBookings('tabAll') },
    { key: 'pending', label: tBookings('statusPending') },
    { key: 'confirmed', label: tBookings('statusConfirmed') },
    { key: 'no_show', label: tBookings('statusNoShow') },
    { key: 'cancelled', label: tBookings('statusCancelled') },
  ]

  if (isLoading)
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    )
  if (bookings.length === 0)
    return <div className="py-12 text-center text-muted-foreground text-sm">{t('noBookings')}</div>

  return (
    <div className="space-y-3">
      {/* A capped list must not look like a complete one. */}
      {truncated && (
        <p className="text-xs text-muted-foreground">
          {t('bookingsTruncated', { count: bookings.length })}
        </p>
      )}

      {/* ONE ROW of controls: when (the question), then which status and
          which class (the narrowing). They were a search box and a strip of
          five status tabs, two rows above a list that is usually short. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex w-fit gap-1 rounded-lg bg-muted p-1">
          {(
            [
              { key: 'upcoming', label: tBookings('rangeGroup_upcoming'), count: upcoming.length },
              { key: 'past', label: tBookings('rangeGroup_past'), count: past.length },
            ] as const
          ).map(({ key, label, count }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTimeTab(key)}
              className={`flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${
                activeTime === key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
              <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
            </button>
          ))}
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter((v || 'all') as ContactBookingStatusFilter)}
        >
          <SelectTrigger className="h-9 w-auto gap-2">
            <span className="text-sm">
              <span className="text-muted-foreground">{t('filterStatus')}: </span>
              {STATUS_OPTIONS.find((o) => o.key === statusFilter)?.label}
            </span>
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.key} value={o.key}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder={t('bookingsSearchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-9"
          />
        </div>
      </div>

      <div className="rounded-xl border overflow-hidden bg-card">
        {filtered.length === 0 ? (
          <div className="px-4 py-12 text-center text-muted-foreground text-sm">
            {search ? tBookings('emptySearch') : t('noBookingsFilter')}
          </div>
        ) : (
          filtered.map((b) => (
            <BookingRow
              key={b.session ? `${b.session}_${b.id}` : b.id}
              booking={b}
              sessionInfo={b.session ? sessions[b.session] : undefined}
              statusLabel={statusLabel}
              showContact={false}
              onAction={handleAction}
              onRebook={setRebookTarget}
            />
          ))
        )}
      </div>

      {rebookTarget && (
        <RebookDialog
          booking={rebookTarget}
          futureSessions={futureSessions}
          bookedSessionIds={bookedSessionIds ?? EMPTY_SESSION_IDS}
          loadingOptions={futureLoading || bookedLoading}
          onConfirm={handleRebookConfirm}
          onClose={() => setRebookTarget(null)}
          loading={rebooking}
        />
      )}
    </div>
  )
}

// ─── "Plans & Payments" tab ───────────────────────────────────────────────────
// THE QUESTION THIS TAB EXISTS TO ANSWER: "in period X, what did this contact pay
// for, and what plan or allowance did they hold?" It used to require switching
// between a Plans tab and a Payments tab and searching by hand — the two overlap
// in a coach's mental model, and often a payment IS a plan's payment.
//
// Three segments:
//   overview — a period-scoped LEDGER: plan starts/ends, payments, credit grants
//              and expiries in one dated stream. Read-only; it answers.
//   plans    — the assigned plan, lesson credits, recurring billing, plan history.
//   payments — the full payment list, all time, with its dialogs. They act.
//
// Affiliation is NOT here: belonging to a club or federation is a different
// concept whose fee is paid to the issuer and never processed by Linyup. It has
// its own tab now, and only ever shared this one by accident of history.
//
// `seg` is owned by the page (in `?seg=`) so the header summary chip can
// deep-link a segment and the choice survives a refresh.

function MembershipTab({
  contact,
  teamId,
  seg,
  onSegChange,
}: {
  contact: Contact
  teamId: string | null
  seg: MembershipSeg
  onSegChange: (s: MembershipSeg) => void
}) {
  const t = useTranslations('Contacts')
  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()
  const tarif595Installed = isInstalled('tarif-595')
  // How the Payments segment shows its rows. Component state, not the URL: it
  // is a way of looking at one segment, not a place anybody links to.
  const [paymentsView, setPaymentsView] = useState<'list' | 'statement'>('list')
  // A payment row's plan chip opens Current on that plan's card.
  const [focusPlan, setFocusPlan] = useState<string | null>(null)
  const SEGMENTS = [
    { id: 'current' as const, label: t('segCurrent') },
    { id: 'history' as const, label: t('segHistory') },
    { id: 'payments' as const, label: t('segPayments') },
    ...(tarif595Installed ? [{ id: 'receipts' as const, label: t('segReceipts') }] : []),
  ]

  // A stale `?seg=receipts` (the plugin was uninstalled, or the link is
  // shared with someone on a team that never installed it) falls back to
  // Current — the same "unknown/gated value" rule `useTabParam` applies to
  // `?tab=`, one level down. Held off until the plugin list has actually
  // loaded, so a fast reload never bounces a real install back to Current.
  useEffect(() => {
    if (!pluginsLoading && seg === 'receipts' && !tarif595Installed) onSegChange('current')
  }, [pluginsLoading, seg, tarif595Installed, onSegChange])
  // THE SHAPE OF THIS TAB, since 2026-09-13. It used to open on a ribbon of plan
  // periods, affiliation periods and funnel milestones, above an "Overview" that
  // was a ledger: several views of the same facts, and none of them answered the
  // question the tab is opened for — what are they on, and what happens next.
  // Current answers it and holds every action on what they hold; History lists
  // the plan periods; Payments is the money, as the list or as the statement.
  // The ribbon went rather than moved: plan periods live in History, and
  // affiliations are the Affiliations tab's.
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          options={SEGMENTS.map((s) => ({ value: s.id, label: s.label }))}
          value={seg}
          onChange={(next) => {
            // A card is focused only on the way from a payment, not every
            // time Current is opened after.
            setFocusPlan(null)
            onSegChange(next)
          }}
        />
        {seg === 'payments' && (
          <Segmented
            size="sm"
            options={[
              { value: 'list' as const, label: t('paymentsViewList') },
              { value: 'statement' as const, label: t('paymentsViewStatement') },
            ]}
            value={paymentsView}
            onChange={setPaymentsView}
          />
        )}
      </div>
      {/* Each segment body mounts only while it is showing, the same way the tabs
          themselves do — so standing on History never loads payments. */}
      {seg === 'current' && (
        <CurrentSegment contact={contact} teamId={teamId} focusPlanRef={focusPlan} />
      )}
      {seg === 'history' && (
        <PlanGate feature="subscriptions">
          <PlanHistorySegment contact={contact} teamId={teamId} />
        </PlanGate>
      )}
      {seg === 'payments' &&
        (paymentsView === 'statement' ? (
          <LedgerSegment contact={contact} teamId={teamId} />
        ) : (
          <PaymentsTab
            contact={contact}
            teamId={teamId}
            onOpenPlan={(ref) => {
              setFocusPlan(ref)
              onSegChange('current')
            }}
          />
        ))}
      {seg === 'receipts' && tarif595Installed && <ReceiptsSegment contact={contact} teamId={teamId} />}
    </div>
  )
}

/**
 * CURRENT — what this person holds right now and what happens next, with every
 * action on it. The figures come first; then the assigned plan, the lesson
 * credits and the Stripe billing, each the one copy of its section and its
 * controls. The figures sit OUTSIDE the plan gate on purpose: a payment was
 * received whether or not the studio's tier sells plans.
 */
function CurrentSegment({
  contact,
  teamId,
  focusPlanRef,
}: {
  contact: Contact
  teamId: string | null
  focusPlanRef?: string | null
}) {
  return (
    <div className="space-y-6 pb-16">
      <CurrentFigures contact={contact} teamId={teamId} />
      <PlanGate feature="subscriptions">
        <CurrentPlans contact={contact} teamId={teamId} focusPlanRef={focusPlanRef} />
      </PlanGate>
    </div>
  )
}

function FigureCell({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: React.ElementType
  label: string
  value: string
  detail?: string | null
}) {
  return (
    <div className="min-w-0 px-2 py-3 text-center sm:px-3">
      {/* Wraps rather than truncating: on a phone each cell is about a third of
          the screen, and a clipped amount is worse than one on two lines. */}
      <p className="break-words text-base font-bold leading-tight tabular-nums sm:text-xl">{value}</p>
      <p className="mt-0.5 flex items-center justify-center gap-1 text-xs leading-tight text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </p>
      {detail && <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>}
    </div>
  )
}

/**
 * What a manager opens this tab to learn, as figures. Each one is read from a
 * query something on the tab already makes under the same key: the Stripe
 * subscriptions (the billing section below), the payments (the Payments segment,
 * and the Overview this replaced), and the credit summary on the contact.
 *
 * "Next charge" is the soonest period end of a subscription Stripe will actually
 * bill — live, not paused, not winding down. "Last payment" is the newest money
 * received on either rail: a voided manual row and a failed charge are not
 * payments, and a fully refunded one is left to the Payments list to explain.
 */
function CurrentFigures({ contact, teamId }: { contact: Contact; teamId: string | null }) {
  const t = useTranslations('Contacts')
  const { data: subs = [] } = useContactMemberSubscriptions(teamId, contact.id)
  const { data: payments } = useContactPayments(teamId, contact.id)
  const teamFmt = useTeamFormat()
  const fmt = (d: Date) => teamFmt.custom(d, DATE_OPTS)

  const next = subs
    .filter(
      (s) =>
        !!s.subscriptionId &&
        !s.duplicate &&
        ['active', 'trialing', 'past_due'].includes(s.status as string) &&
        !s.pause_collection &&
        !subscriptionIsCancelling(s) &&
        !!tsToDate(s.current_period_end)
    )
    .sort(
      (a, b) =>
        (tsToDate(a.current_period_end)?.getTime() ?? 0) -
        (tsToDate(b.current_period_end)?.getTime() ?? 0)
    )[0]
  const nextDate = next ? tsToDate(next.current_period_end) : undefined

  const lastPayment = useMemo(
    () =>
      mergePaymentRows(
        connectToUnified(payments?.payments ?? []),
        byoToUnified(payments?.events ?? [])
      ).find((r) => !r.voided && ['succeeded', 'partially_refunded', 'paid'].includes(r.status)),
    [payments]
  )
  const lastDate = lastPayment?.createdAt?.toDate?.()

  const credits = contact.credit_summary ?? []
  const lessonsLeft = credits.reduce((n, c) => n + c.remaining, 0)
  const nextExpiry = credits
    .map((c) => tsToDate(c.next_expires_at))
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime())[0]

  // Nothing billed, nothing paid, no pack: a row of dashes says less than no
  // row, and the plan cards below already say what they hold.
  if (!next && !lastPayment && credits.length === 0) return null

  return (
    // Lessons left only for someone who has ever held a pack: "—" as a headline
    // figure for every member on a plain membership read as a missing number.
    <div
      className={`grid divide-x rounded-xl border bg-card ${credits.length ? 'grid-cols-3' : 'grid-cols-2'}`}
    >
      <FigureCell
        icon={CalendarCheck}
        label={t('currentNextCharge')}
        value={next ? formatMoneyMinor(next.amount, next.currency) : '—'}
        detail={nextDate ? fmt(nextDate) : null}
      />
      <FigureCell
        icon={CreditCard}
        label={t('currentLastPayment')}
        value={lastPayment ? formatMoneyMinor(lastPayment.amount, lastPayment.currency) : '—'}
        detail={lastDate ? fmt(lastDate) : null}
      />
      {credits.length > 0 && (
        <FigureCell
          icon={Ticket}
          label={t('currentCreditsLeft')}
          value={String(lessonsLeft)}
          detail={nextExpiry ? t('creditsExpiresOn', { date: fmt(nextExpiry) }) : null}
        />
      )}
    </div>
  )
}

/**
 * The assigned plan, the lesson credits and the Stripe billing, with their
 * dialogs. They moved here from the old Plans segment on 2026-09-13, which kept
 * only the history — moved, not copied, so each control still has one home.
 */
function CurrentPlans({
  contact,
  teamId,
  focusPlanRef,
}: {
  contact: Contact
  teamId: string | null
  focusPlanRef?: string | null
}) {
  const qc = useQueryClient()
  const { data: subTypes = [] } = useSubscriptionTypes(teamId)
  // null = closed; 'add' = a new plan; a HeldPlan = changing that grant.
  const [planDialog, setPlanDialog] = useState<'add' | HeldPlan | null>(null)
  const [grantOpen, setGrantOpen] = useState(false)
  const { team } = useAuth()
  const currency = (team?.default_currency ?? 'CHF').toUpperCase()

  // The plan list is rebuilt by a trigger after the write lands, and the
  // contact is read once, so read it again now and once more shortly after.
  const refreshSoon = () => {
    const run = () => {
      qc.invalidateQueries({ queryKey: ['contact', contact.id] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      qc.invalidateQueries({ queryKey: ['subscription-history', contact.id] })
    }
    run()
    setTimeout(run, 2500)
    setTimeout(run, 6000)
  }

  if (!teamId) return null
  const changing = planDialog && planDialog !== 'add' ? planDialog : null

  return (
    <>
      <PlansList
        contact={contact}
        teamId={teamId}
        currency={currency}
        onAddPlan={() => setPlanDialog('add')}
        onChangePlan={(plan) => setPlanDialog(plan)}
        onGrantCredits={() => setGrantOpen(true)}
        focusRef={focusPlanRef}
      />

      <PlanDialog
        key={changing ? `change-${changing.ref}` : 'add'}
        open={planDialog !== null}
        onOpenChange={(v) => !v && setPlanDialog(null)}
        contactId={contact.id}
        changing={changing}
        subTypes={subTypes}
        currency={currency}
        onSaved={refreshSoon}
      />

      <GrantCreditsDialog
        open={grantOpen}
        onOpenChange={setGrantOpen}
        contact={contact}
        subTypes={subTypes}
        onGranted={refreshSoon}
      />
    </>
  )
}

/**
 * HISTORY — the plan periods from `subscription_history`, newest first, each
 * deletable as a record.
 */
function PlanHistorySegment({ contact, teamId }: { contact: Contact; teamId: string | null }) {
  const fmt = useTeamFormat()
  // Styled confirmation — this delete had none at all before.
  const { confirm, confirmDialog } = useConfirm()
  const tCommon = useTranslations('Common')
  const t = useTranslations('Contacts')
  const qc = useQueryClient()
  const { data: history = [], isLoading } = useSubscriptionHistory(contact.id)
  const { data: subTypes = [] } = useSubscriptionTypes(teamId)
  const invalidateHistory = () =>
    qc.invalidateQueries({ queryKey: ['subscription-history', contact.id] })

  if (isLoading)
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    )

  return (
    <div className="space-y-2 pb-16">
      {history.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground text-sm">
          {t('noSubscriptions')}
        </div>
      ) : (
        <div className="space-y-2">
          {history.map((entry) => {
            const isActive = !entry.end_date
            const typeName =
              subTypes.find((s) => s.id === entry.subscription_type_id)?.name ??
              entry.subscription_type_name ??
              '—'
            return (
              <div key={entry.id} className="flex items-start gap-3 p-3 rounded-lg border">
                <div
                  className={`h-2 w-2 rounded-full mt-2 shrink-0 ${isActive ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{typeName}</p>
                    {isActive && (
                      <Badge variant="default" className="text-xs">
                        {t('subscriptionActiveLabel')}
                      </Badge>
                    )}
                  </div>
                  {entry.recurrence && (
                    <p className="text-xs text-muted-foreground">
                      {t(`recurrence_${entry.recurrence}`)}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {formatDate(fmt, entry.start_date)} –{' '}
                    {entry.end_date ? formatDate(fmt, entry.end_date) : t('subscriptionEndNone')}
                  </p>
                  {entry.termination_reason && (
                    <p className="text-xs text-muted-foreground italic">
                      {entry.termination_reason}
                    </p>
                  )}
                </div>
                <button
                  onClick={async () => {
                    // A history row is the evidence that somebody held a
                    // plan. Deleting it refunds nothing and changes nothing
                    // they hold now — it just removes the record, which is
                    // why the body says exactly that rather than "are you
                    // sure".
                    const ok = await confirm({
                      title: t('subHistoryDeleteTitle'),
                      description: t('subHistoryDeleteBody', {
                        name: `${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim(),
                      }),
                      confirmLabel: tCommon('delete'),
                    })
                    if (!ok) return
                    await deleteDoc(
                      doc(
                        db,
                        CONTACTS_COLLECTION,
                        contact.id,
                        CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION,
                        entry.id
                      )
                    )
                    invalidateHistory()
                  }}
                  className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {confirmDialog}
    </div>
  )
}

// ─── grant credits dialog (manual lesson-credit pack grant) ──────────────────
//
// TWO THINGS UX-80 ADDED. "Let them know" defaults ON: the whole payload of a
// credit grant is a NUMBER, and until the contact is told it, the only place ten
// classes exist is a member area nobody has mentioned to them. The mail says the
// studio ADDED the credits — it never thanks them for a purchase, because on
// this rail they made none.
//
// The idempotency key is minted once per opening for a blunter reason: every
// click of Grant used to mint a NEW grant document, so a double-click handed out
// twice the credits, silently. One key per opening, `.create()` on the server,
// and the second click is refused rather than doubled.

function GrantCreditsDialog({
  open,
  onOpenChange,
  contact,
  subTypes,
  onGranted,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  contact: Contact
  subTypes: SubscriptionType[]
  onGranted: () => void
}) {
  const t = useTranslations('Contacts')
  const [typeId, setTypeId] = useState('')
  const [priceId, setPriceId] = useState('')
  const [customCredits, setCustomCredits] = useState('')
  const [customMonths, setCustomMonths] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sendReceipt, setSendReceipt] = useState(true)
  const [attemptKey, setAttemptKey] = useState('')

  // Only types with at least one credit-bearing price are grantable.
  const creditTypes = subTypes.filter((st) =>
    (st.prices ?? []).some((p) => p.recurrence === 'one_time' && !!p.credits)
  )
  const selectedType = creditTypes.find((st) => st.id === typeId)
  const creditPrices = (selectedType?.prices ?? []).filter(
    (p) => p.recurrence === 'one_time' && !!p.credits
  )
  const selectedPrice = creditPrices.find((p) => p.id === priceId)

  useEffect(() => {
    if (!open) return
    setTypeId('')
    setPriceId('')
    setCustomCredits('')
    setCustomMonths('')
    setError(null)
    setSendReceipt(true)
    setAttemptKey(
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    )
  }, [open])

  const canSave =
    !!typeId && (!!priceId || (Number(customCredits) >= 1 && Number(customCredits) <= 100))

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const fn = callFunction<
        {
          contactId: string
          subscriptionTypeId: string
          priceId?: string
          credits?: number
          validityMonths?: number
          idempotencyKey?: string
          sendReceipt?: boolean
        },
        { success: boolean; credits: number; duplicate?: boolean }
      >('grantCredits')
      await fn({
        contactId: contact.id,
        subscriptionTypeId: typeId,
        idempotencyKey: attemptKey,
        // No contact email ⇒ nothing to send to; the server logs and skips, but
        // offering the switch at all would be a promise the data cannot keep.
        sendReceipt: sendReceipt && !!contact.email,
        ...(priceId
          ? { priceId }
          : {
              credits: Number(customCredits),
              ...(customMonths ? { validityMonths: Number(customMonths) } : {}),
            }),
      })
      // The rollup on the contact doc is recomputed by a Cloud Function trigger,
      // so it may lag a moment behind this optimistic success state.
      toast.success(t('creditsGranted'))
      onGranted()
      onOpenChange(false)
    } catch (err) {
      console.error('[contact] grant credits failed:', err)
      setError(t('creditsGrantError'))
    } finally {
      setSaving(false)
    }
  }

  const priceLabel = (p: SubscriptionPrice) =>
    `${p.label ? `${p.label} · ` : ''}${t('creditsCountLabel', { count: p.credits ?? 0 })}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('grantCredits')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Field label={t('subscriptionTypeName')} required>
            <Select
              value={typeId}
              onValueChange={(v) => {
                setTypeId(v ?? '')
                setPriceId('')
              }}
            >
              <SelectTrigger>
                <span className="flex flex-1 text-left text-sm truncate">
                  {selectedType ? selectedType.name : <span className="text-muted-foreground">—</span>}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">—</SelectItem>
                {creditTypes.map((st) => (
                  <SelectItem key={st.id} value={st.id}>
                    {st.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {creditTypes.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('creditsNoTypesHelp')}</p>
            )}
          </Field>

          {typeId && creditPrices.length > 0 && (
            <Field label={t('creditsPackLabel')}>
              <Select value={priceId} onValueChange={(v) => setPriceId(v ?? '')}>
                <SelectTrigger>
                  <span className="flex flex-1 text-left text-sm truncate">
                    {selectedPrice ? priceLabel(selectedPrice) : <span className="text-muted-foreground">—</span>}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t('creditsCustomOption')}</SelectItem>
                  {creditPrices.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {priceLabel(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {typeId && !priceId && (
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('creditsCustomAmount')} required>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={customCredits}
                  onChange={(e) => setCustomCredits(e.target.value)}
                />
              </Field>
              <Field label={t('creditsCustomValidity')}>
                <Input
                  type="number"
                  min={0}
                  value={customMonths}
                  onChange={(e) => setCustomMonths(e.target.value)}
                />
              </Field>
            </div>
          )}

          {typeId && contact.email && (
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">{t('creditsNotifyLabel')}</p>
                <p className="text-xs text-muted-foreground">{t('creditsNotifyHint')}</p>
              </div>
              <Switch checked={sendReceipt} onCheckedChange={setSendReceipt} />
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            onClick={save}
            disabled={saving || !canSave}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? t('saveChanges') : t('grantCredits')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── plan dialog: add a plan, or change one staff-given plan ─────────────────
//
// It ADDS by default (docs/multi-plan-holdings.md: a member may hold several
// plans), or CHANGES the one grant it was opened from. It used to REPLACE:
// saving ended every plan the contact held and, unless told otherwise, also
// cancelled every live Stripe subscription. Stopping billing is now the Stripe
// card's own action, naming the one subscription it stops, and ending a plan
// is the plan card's — so this dialog never touches a holding it was not
// opened for.

function PlanDialog({
  open,
  onOpenChange,
  contactId,
  changing,
  subTypes,
  currency,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  contactId: string
  /** The staff-given plan being changed; null to add a new one. */
  changing: HeldPlan | null
  subTypes: SubscriptionType[]
  currency: string
  onSaved: () => void
}) {
  const t = useTranslations('Contacts')
  const [typeId, setTypeId] = useState(changing?.subscription_type_id ?? '')
  const [priceId, setPriceId] = useState(changing?.price_id ?? '')
  const [recurrence, setRecurrence] = useState(changing?.recurrence ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const RECURRENCES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annual']

  const selectedType = subTypes.find((st) => st.id === typeId)
  const activePrices = (selectedType?.prices ?? []).filter((p) => p.active !== false)
  const selectedPrice = activePrices.find((p) => p.id === priceId)

  const priceLabel = (p: (typeof activePrices)[number]) =>
    `${p.label ? `${p.label} · ` : ''}${formatCurrency(p.amount, currency)} · ${t(`recurrence_${p.recurrence}`)}`

  const save = async () => {
    if (!typeId) return
    setSaving(true)
    setError(null)
    try {
      const plan = {
        contactId,
        subscriptionTypeId: typeId,
        priceId: selectedPrice ? selectedPrice.id : null,
        recurrence: selectedPrice ? null : recurrence || null,
      }
      if (changing) {
        const fn = callFunction<typeof plan & { grantId: string }, { grantId: string }>(
          'changePlan'
        )
        await fn({ ...plan, grantId: changing.ref })
      } else {
        const fn = callFunction<typeof plan & { replace: false }, { grantId: string }>(
          'assignPlan'
        )
        await fn({ ...plan, replace: false })
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      console.error('[contact] plan save failed:', err)
      setError(t('cancelError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{changing ? t('changePlanTitle') : t('addPlanTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Field label={t('subscriptionTypeName')} required>
            <Select
              value={typeId}
              onValueChange={(v) => {
                setTypeId(v ?? '')
                setPriceId('')
                setRecurrence('')
              }}
            >
              <SelectTrigger>
                <span className="flex flex-1 text-left text-sm truncate">
                  {selectedType ? selectedType.name : <span className="text-muted-foreground">—</span>}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">—</SelectItem>
                {subTypes
                  .filter((st) => st.active !== false)
                  .map((st) => (
                    <SelectItem key={st.id} value={st.id}>
                      {st.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>

          {activePrices.length > 0 ? (
            <Field label={t('subscriptionPrice')}>
              <Select value={priceId} onValueChange={(v) => setPriceId(v ?? '')}>
                <SelectTrigger>
                  <span className="flex flex-1 text-left text-sm truncate">
                    {selectedPrice ? priceLabel(selectedPrice) : <span className="text-muted-foreground">—</span>}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">—</SelectItem>
                  {activePrices.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {priceLabel(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : typeId ? (
            <Field label={t('subscriptionRecurrence')}>
              <Select value={recurrence} onValueChange={(v) => setRecurrence(v ?? '')}>
                <SelectTrigger>
                  <span className="flex flex-1 text-left text-sm truncate">
                    {recurrence ? t(`recurrence_${recurrence}`) : <span className="text-muted-foreground">—</span>}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">—</SelectItem>
                  {RECURRENCES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`recurrence_${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            onClick={save}
            disabled={saving || !typeId}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {changing ? t('saveChanges') : t('addPlan')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── gamification tab ─────────────────────────────────────────────────────────

function GamificationTab({ contact, teamId }: { contact: Contact; teamId: string | null }) {
  const t = useTranslations('Contacts')
  const tG = useTranslations('Gamification')
  const qc = useQueryClient()

  // Load coach badges from team settings
  const { data: team } = useQuery({
    queryKey: ['team', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return null
      const d = await getDoc(doc(db, TEAMS_COLLECTION, teamId))
      return d.exists() ? d.data() : null
    },
  })

  const coachBadges: Array<{ key: string; label: string }> =
    team?.settings?.gamification?.coach_badges ?? []

  const assignedBadges: string[] = contact.custom_badges ?? []

  const toggleBadge = async (key: string) => {
    const next = assignedBadges.includes(key)
      ? assignedBadges.filter((b) => b !== key)
      : [...assignedBadges, key]
    await updateDoc(doc(db, CONTACTS_COLLECTION, contact.id), { custom_badges: next })
    qc.invalidateQueries({ queryKey: ['contact', contact.id] })
  }

  return (
    <div className="space-y-6">
      {/* Score summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold">{contact.current_month_score ?? 0}</p>
          <p className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
            <Star className="h-3 w-3 text-yellow-500" />
            {tG('sortPoints')}
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold">{contact.current_streak ?? 0}w</p>
          <p className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
            <Flame className="h-3 w-3 text-orange-500" />
            {tG('sortStreak')}
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold">{contact.total_sessions ?? 0}</p>
          {/* `total_sessions` counts ATTENDANCE (the participants trigger), not
              bookings — it was labelled "Bookings" here, which is the same
              number answering the wrong question (UX-89). */}
          <p className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
            <Trophy className="h-3 w-3 text-primary" />
            {t('statTotalSessions')}
          </p>
        </div>
      </div>

      {/* Coach badges */}
      <div>
        <p className="text-sm font-medium mb-3">{tG('coachBadgesSection')}</p>
        {coachBadges.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('badgeNone')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {coachBadges.map((badge) => {
              const assigned = assignedBadges.includes(badge.key)
              return (
                <button
                  key={badge.key}
                  onClick={() => toggleBadge(badge.key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-medium transition-colors ${
                    assigned
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Award className="h-3.5 w-3.5" />
                  {badge.label}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── activity tab ─────────────────────────────────────────────────────────────

const ACTIVITY_PERIODS = [
  { key: '30d', days: 30, label: '30d' },
  { key: '3m', days: 90, label: '3M' },
  { key: '6m', days: 180, label: '6M' },
  { key: 'all', days: null, label: 'All' },
] as const
type ActivityPeriodKey = (typeof ACTIVITY_PERIODS)[number]['key']

type ActivityCategory = 'all' | 'sessions' | 'bookings' | 'profile' | 'outreach' | 'consent' | 'coaching'

const CATEGORY_EVENTS = {
  sessions: ['session_participant_add', 'session_participant_delete'],
  bookings: [
    'booking_created',
    'booking_confirmed',
    'booking_cancelled',
    'booking_rebooked',
    'booking_no_show',
  ],
  profile: [
    'contact_add',
    'contact_type_change',
    'acquisition_stage_change',
    'acquisition_stage_correction',
    'rank_change',
    'subscription_change',
    'contact_archive',
    'contact_unarchive',
    'contact_mark_external',
    'contact_unmark_external',
    'contact_delete',
    'contact_login',
    'contact_anonymized',
  ],
  outreach: ['outreach_email_sent'],
  // Consent gets its own chip rather than joining `profile`: "when did they
  // accept this, and did anybody withdraw it" is the question a dispute starts
  // with, and it is not a profile edit.
  consent: ['waiver_accepted', 'waiver_revoked'],
  // Coaching gets its own chip rather than joining `profile`: "how is their
  // practice going" is the question this tab opens to ask, and a goal reached,
  // a step ticked off or a check-in filed is progress on that practice, not a
  // change to who the contact is.
  coaching: ['goal_achieved', 'goal_abandoned', 'goal_step_completed', 'performance_checkin'],
} as const satisfies Record<Exclude<ActivityCategory, 'all'>, readonly ActivityEventType[]>

// Compile-time guard for the gap that let the four coaching events go
// missing from every filter chip above. `EVENT_META` below is a
// `Record<ActivityEventType, …>`, so the compiler forces it closed — leaving
// an event out fails the build on its own. `CATEGORY_EVENTS` is keyed by
// CATEGORY, not event, so it has no such shape to force closed, and a
// forgotten event type-checks fine while silently only ever showing under
// "All". This line recovers the same guarantee without reshaping the data:
// if any `ActivityEventType` is absent from every array above, the
// `extends never` constraint fails and `turbo run typecheck` breaks. (No
// test file — `apps/web` has no test runner to run one.)
type _EventsMissingFromCategoryEvents = Exclude<
  ActivityEventType,
  (typeof CATEGORY_EVENTS)[keyof typeof CATEGORY_EVENTS][number]
>
type _AssertNever<T extends never> = T
// Type-only; nothing references this by design — a constraint violation here
// fails the build on its own, which is the whole point.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AllActivityEventsAreCategorized = _AssertNever<_EventsMissingFromCategoryEvents>

type EventMeta = { Icon: React.ElementType; bg: string; fg: string }

const EVENT_META: Record<ActivityEventType, EventMeta> = {
  contact_add: { Icon: UserPlus, bg: 'bg-green-500/10', fg: 'text-green-600' },
  contact_archive: { Icon: Archive, bg: 'bg-yellow-500/10', fg: 'text-yellow-600' },
  contact_unarchive: { Icon: RotateCcw, bg: 'bg-green-500/10', fg: 'text-green-600' },
  contact_mark_external: { Icon: DoorOpen, bg: 'bg-yellow-500/10', fg: 'text-yellow-600' },
  contact_unmark_external: { Icon: RotateCcw, bg: 'bg-green-500/10', fg: 'text-green-600' },
  contact_delete: { Icon: Trash2, bg: 'bg-red-500/10', fg: 'text-red-600' },
  contact_type_change: { Icon: ArrowRightLeft, bg: 'bg-yellow-500/10', fg: 'text-yellow-600' },
  acquisition_stage_change: { Icon: ArrowRightLeft, bg: 'bg-yellow-500/10', fg: 'text-yellow-600' },
  acquisition_stage_correction: { Icon: RotateCcw, bg: 'bg-orange-500/10', fg: 'text-orange-600' },
  rank_change: { Icon: Award, bg: 'bg-yellow-500/10', fg: 'text-yellow-600' },
  subscription_change: { Icon: CreditCard, bg: 'bg-yellow-500/10', fg: 'text-yellow-600' },
  session_participant_add: { Icon: CalendarCheck, bg: 'bg-green-500/10', fg: 'text-green-600' },
  session_participant_delete: { Icon: CalendarX, bg: 'bg-red-500/10', fg: 'text-red-600' },
  booking_created: { Icon: CalendarDays, bg: 'bg-blue-500/10', fg: 'text-blue-600' },
  booking_confirmed: { Icon: CheckCircle, bg: 'bg-blue-500/10', fg: 'text-blue-600' },
  booking_cancelled: { Icon: XCircle, bg: 'bg-red-500/10', fg: 'text-red-600' },
  booking_rebooked: { Icon: CalendarDays, bg: 'bg-blue-500/10', fg: 'text-blue-600' },
  booking_no_show: { Icon: UserX, bg: 'bg-red-500/10', fg: 'text-red-600' },
  contact_login: { Icon: Activity, bg: 'bg-green-500/10', fg: 'text-green-600' },
  outreach_email_sent: { Icon: Mail, bg: 'bg-blue-500/10', fg: 'text-blue-600' },
  contact_anonymized: { Icon: Trash2, bg: 'bg-muted', fg: 'text-muted-foreground' },
  waiver_accepted: { Icon: ShieldCheck, bg: 'bg-emerald-500/10', fg: 'text-emerald-600' },
  waiver_revoked: { Icon: ShieldOff, bg: 'bg-red-500/10', fg: 'text-red-600' },
  // Coaching — see the ActivityEventType header for why goals/check-ins share
  // this feed with bookings and signatures.
  goal_achieved: { Icon: Flag, bg: 'bg-green-500/10', fg: 'text-green-600' },
  goal_abandoned: { Icon: Flag, bg: 'bg-muted', fg: 'text-muted-foreground' },
  goal_step_completed: { Icon: CheckSquare, bg: 'bg-violet-500/10', fg: 'text-violet-600' },
  performance_checkin: { Icon: BarChart2, bg: 'bg-indigo-500/10', fg: 'text-indigo-600' },
}

function formatActivityTimestamp(
  fmt: RegionalFormatter,
  ts: { toDate(): Date } | null | undefined
): string {
  if (!ts) return '—'
  const d = ts.toDate()
  const diffMs = Date.now() - d.getTime()
  const diffHrs = diffMs / 3_600_000
  // Relative for the last two days, in the studio's language ("5 min ago",
  // "vor 3 Std.", "hier") — these were English literals on every locale.
  const rtf = new Intl.RelativeTimeFormat(fmt.locale, { numeric: 'auto', style: 'short' })
  if (diffHrs < 1) return rtf.format(-Math.max(1, Math.round(diffMs / 60_000)), 'minute')
  if (diffHrs < 24) return rtf.format(-Math.round(diffHrs), 'hour')
  if (diffHrs < 48) return `${rtf.format(-1, 'day')} · ${fmt.time(d)}`
  return fmt.custom(d, DATE_OPTS)
}

function dateDayLabel(
  fmt: RegionalFormatter,
  ts: { toDate(): Date } | null | undefined,
  tCommon: (k: string) => string
): string {
  if (!ts) return ''
  const d = ts.toDate()
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = (today.getTime() - day.getTime()) / 86_400_000
  if (diffDays < 1) return tCommon('today')
  if (diffDays < 2) return tCommon('yesterday')
  return fmt.custom(d, { weekday: 'long', ...DATE_OPTS })
}

function formatEventType(event: ActivityEventType): string {
  return event.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function ActivityDetailDialog({
  entry,
  onClose,
}: {
  entry: ActivityLogEntry | null
  onClose: () => void
}) {
  const fmt = useTeamFormat()
  if (!entry) return null

  const meta = EVENT_META[entry.event] ?? {
    Icon: Activity,
    bg: 'bg-muted',
    fg: 'text-muted-foreground',
  }
  const { Icon, bg, fg } = meta

  // Parameters: description first, then all other keys
  const { description, ...rest } = entry.parameters
  const extraParams = Object.entries(rest).filter(([, v]) => v !== null && v !== undefined)

  const fullTimestamp = (() => {
    const ts = entry.created_at as { toDate(): Date } | null | undefined
    if (!ts) return '—'
    return fmt.custom(ts, { ...DATE_OPTS, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  })()

  const formatValue = (v: unknown): string => {
    if (v === null || v === undefined) return '—'
    if (typeof v === 'object') {
      if ('toDate' in (v as object)) return fmt.dateTime(v as { toDate(): Date })
      return JSON.stringify(v, null, 2)
    }
    return String(v)
  }

  return (
    <Dialog
      open={!!entry}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className={`h-9 w-9 rounded-lg ${bg} flex items-center justify-center shrink-0`}>
              <Icon className={`h-4 w-4 ${fg}`} />
            </div>
            <div>
              <DialogTitle className="text-base">{formatEventType(entry.event)}</DialogTitle>
              <p className="text-xs text-muted-foreground mt-0.5">{fullTimestamp}</p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Description */}
          <p className="text-sm leading-relaxed">{description as string}</p>

          {/* Extra parameters */}
          {extraParams.length > 0 && (
            <div className="rounded-lg border divide-y text-sm">
              {extraParams.map(([key, val]) => (
                <div key={key} className="grid grid-cols-[140px_1fr] gap-2 px-3 py-2">
                  <span className="text-xs text-muted-foreground font-medium self-start pt-px">
                    {key.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs break-all font-mono">{formatValue(val)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Refs */}
          {(entry.refs.session || entry.refs.contact) && (
            <div className="rounded-lg border divide-y text-sm">
              {entry.refs.session && (
                <div className="grid grid-cols-[140px_1fr] gap-2 px-3 py-2">
                  <span className="text-xs text-muted-foreground font-medium">session ref</span>
                  <span className="text-xs break-all font-mono text-muted-foreground">
                    {entry.refs.session}
                  </span>
                </div>
              )}
              {entry.refs.contact && (
                <div className="grid grid-cols-[140px_1fr] gap-2 px-3 py-2">
                  <span className="text-xs text-muted-foreground font-medium">contact ref</span>
                  <span className="text-xs break-all font-mono text-muted-foreground">
                    {entry.refs.contact}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ActivityTab({
  contact,
  teamId,
  initialCategory = 'all',
}: {
  contact: Contact
  teamId: string | null
  initialCategory?: ActivityCategory
}) {
  const fmt = useTeamFormat()
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const { can } = useCapabilities()
  // Arriving from an old Emails-tab link: every email, as that tab listed them.
  const [period, setPeriod] = useState<ActivityPeriodKey>(
    initialCategory === 'outreach' ? 'all' : '30d'
  )
  const [category, setCategory] = useState<ActivityCategory>(initialCategory)
  // Sending an email lives where the emails are listed: the Outreach chip. It
  // was the Emails tab's one button; the header's Email tile does the same.
  const [composeOpen, setComposeOpen] = useState(false)
  const canSend = can('contacts.manage')
  const [selectedEntry, setSelectedEntry] = useState<ActivityLogEntry | null>(null)

  const selectedPeriod = ACTIVITY_PERIODS.find((p) => p.key === period)!
  const { data: entries = [], isLoading } = useContactActivityLog(
    contact.id,
    teamId,
    selectedPeriod.days
  )

  const filtered =
    category === 'all'
      ? entries
      : entries.filter((e) =>
          (CATEGORY_EVENTS[category] as readonly ActivityEventType[]).includes(e.event)
        )

  // Group filtered entries by calendar day
  const groups: { label: string; items: ActivityLogEntry[] }[] = []
  let currentLabel = ''
  for (const entry of filtered) {
    const label = dateDayLabel(fmt, entry.created_at as { toDate(): Date } | null | undefined, tCommon)
    if (label !== currentLabel) {
      groups.push({ label, items: [] })
      currentLabel = label
    }
    groups[groups.length - 1].items.push(entry)
  }

  const CATEGORIES: { key: ActivityCategory; label: string }[] = [
    { key: 'all', label: t('activityFilterAll') },
    { key: 'sessions', label: t('activityFilterSessions') },
    { key: 'bookings', label: t('activityFilterBookings') },
    { key: 'profile', label: t('activityFilterProfile') },
    { key: 'outreach', label: t('activityFilterOutreach') },
    { key: 'consent', label: t('activityFilterConsent') },
    { key: 'coaching', label: t('activityFilterCoaching') },
  ]

  return (
    <div className="space-y-4 pb-16">
      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        {/* Category chips */}
        <div className="flex flex-wrap gap-1.5 flex-1">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategory(c.key)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                category === c.key
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {category === 'outreach' && canSend && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setComposeOpen(true)}
            disabled={!contact.email}
            title={contact.email ? undefined : t('outreachNoEmail')}
          >
            <Mail className="mr-1.5 h-4 w-4" /> {t('outreachSend')}
          </Button>
        )}
        {/* Period selector */}
        <Segmented
          size="sm"
          options={ACTIVITY_PERIODS.map((p) => ({ value: p.key, label: p.label }))}
          value={period}
          onChange={setPeriod}
        />
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground text-sm">
          {entries.length === 0 ? t('noActivity') : t('activityNoResults')}
        </div>
      ) : (
        <>
          {/* Timeline feed — vertical connector line, no per-row borders */}
          <div className="space-y-6">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="text-xs font-semibold text-muted-foreground mb-3 sticky top-0 bg-background py-1">
                  {group.label}
                </p>
                <div className="relative pl-6">
                  {/* Vertical connector */}
                  <div className="absolute left-[9px] top-0 bottom-0 w-px bg-border" />
                  <div className="space-y-0">
                    {group.items.map((entry, idx) => {
                      const meta = EVENT_META[entry.event] ?? {
                        Icon: Activity,
                        bg: 'bg-muted',
                        fg: 'text-muted-foreground',
                      }
                      const { Icon, fg } = meta
                      const isLast = idx === group.items.length - 1
                      return (
                        <div
                          key={entry.id}
                          className={`relative flex items-start gap-3 py-2.5 ${isLast ? '' : 'border-b border-border/40'}`}
                        >
                          {/* Dot on the line */}
                          <div className="absolute -left-6 flex items-center justify-center w-[18px] h-[18px] rounded-full bg-background border-2 border-border mt-0.5 shrink-0">
                            <Icon className={`h-2.5 w-2.5 ${fg}`} />
                          </div>
                          <div className="flex-1 min-w-0 flex items-start justify-between gap-4">
                            <p className="text-sm leading-snug">
                              {entry.parameters.description as string}
                            </p>
                            <div className="flex flex-col items-end gap-0.5 shrink-0">
                              <span className="text-xs text-muted-foreground whitespace-nowrap">
                                {formatActivityTimestamp(
                                  fmt,
                                  entry.created_at as { toDate(): Date } | null | undefined
                                )}
                              </span>
                              <button
                                type="button"
                                onClick={() => setSelectedEntry(entry)}
                                className="text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-2 transition-colors"
                              >
                                details
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {entries.length === PAGE_SIZE && (
            <p className="text-center text-xs text-muted-foreground py-2">
              {t('activityLoadMore')}
            </p>
          )}
        </>
      )}

      <ActivityDetailDialog entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
      <SendOutreachDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        contact={contact}
        teamId={teamId}
      />
    </div>
  )
}

// ─── alerts tab ───────────────────────────────────────────────────────────────

const alertSchema = z.object({
  schedule_type: z.enum(['sessions_countdown', 'datetime', 'always']),
  schedule_value_sessions: z.coerce.number().min(1).optional(),
  schedule_value_date: z.date().optional(),
  message: z.string().min(1).max(500),
  show_in_app: z.boolean().optional(),
})
type AlertFormValues = z.infer<typeof alertSchema>

/** Icon + i18n key for a schedule type — one place, read by the dialog, the
 *  list and the preset picker so all three render a trigger type the same way. */
function alertTypeIcon(type: AlertScheduleType, className = 'h-4 w-4') {
  switch (type) {
    case 'sessions_countdown':
      return <Timer className={className} />
    case 'datetime':
      return <CalendarDays className={className} />
    case 'always':
      return <Zap className={className} />
  }
}

function alertTypeLabelKey(
  type: AlertScheduleType
): 'alertTypeSessionsCountdown' | 'alertTypeDatetime' | 'alertTypeAlways' {
  switch (type) {
    case 'sessions_countdown':
      return 'alertTypeSessionsCountdown'
    case 'datetime':
      return 'alertTypeDatetime'
    case 'always':
      return 'alertTypeAlways'
  }
}

function AlertDialog({
  open,
  onOpenChange,
  contactId,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  contactId: string
  onSaved: () => void
}) {
  const t = useTranslations('Contacts')

  const {
    register,
    handleSubmit,
    watch,
    control,
    reset,
    formState: { isSubmitting },
  } = useForm<AlertFormValues>({
    resolver: zodResolver(alertSchema),
    defaultValues: {
      schedule_type: 'sessions_countdown',
      schedule_value_sessions: 10,
      show_in_app: false,
    },
  })

  const scheduleType = watch('schedule_type')

  async function onSubmit(data: AlertFormValues) {
    const payload: Record<string, unknown> = {
      schedule_type: data.schedule_type,
      message: data.message,
      show_in_app: data.show_in_app ?? false,
      archived_at: null,
      created_at: serverTimestamp(),
    }
    if (data.schedule_type === 'sessions_countdown') {
      payload.schedule_value = Number(data.schedule_value_sessions)
    } else if (data.schedule_type === 'datetime') {
      payload.schedule_value = data.schedule_value_date
        ? Timestamp.fromDate(data.schedule_value_date)
        : null
    } else {
      // 'always' — nothing to collect; it fires on creation (see alertIsFired).
      payload.schedule_value = null
    }
    await addDoc(
      collection(db, CONTACTS_COLLECTION, contactId, CONTACT_ALERTS_SUBCOLLECTION),
      payload
    )
    onSaved()
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('addAlert')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 py-1">
          {/* Trigger type — "Active now" sits alongside the other two because
              this row asks WHEN, not what kind of value to collect. It exists
              so "active from the moment I wrote it" doesn't have to be faked
              as today's date or a 0-session countdown (see alertTypeIcon /
              alertTypeLabel). */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('alertScheduleType')}</label>
            <div className="flex gap-2">
              {(['sessions_countdown', 'datetime', 'always'] as AlertScheduleType[]).map((type) => (
                <label key={type} className="flex-1 cursor-pointer">
                  <input
                    type="radio"
                    value={type}
                    {...register('schedule_type')}
                    className="sr-only"
                  />
                  <div
                    className={`flex items-center gap-1.5 justify-center py-1.5 px-2 rounded-lg border text-xs font-medium transition-colors ${
                      scheduleType === type
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {alertTypeIcon(type, 'h-3.5 w-3.5')}
                    {t(alertTypeLabelKey(type))}
                  </div>
                </label>
              ))}
            </div>
          </div>

          {scheduleType === 'sessions_countdown' ? (
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('alertSessionCount')}</label>
              <Input type="number" min="1" {...register('schedule_value_sessions')} />
            </div>
          ) : scheduleType === 'datetime' ? (
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('alertDate')}</label>
              <Controller
                control={control}
                name="schedule_value_date"
                render={({ field }) => <DatePicker value={field.value} onChange={field.onChange} />}
              />
            </div>
          ) : null}

          <div className="space-y-1">
            <label className="text-sm font-medium">{t('alertMessage')}</label>
            <Textarea {...register('message')} rows={2} placeholder="e.g. Give welcome gift" />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" {...register('show_in_app')} className="rounded border-input" />
            {t('alertShowInApp')}
          </label>

          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors"
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {t('addAlert')}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AlertPresetPicker({
  open,
  onOpenChange,
  presets,
  onSelect,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  presets: AlertPresetRecord[]
  onSelect: (p: AlertPresetRecord, date?: Date) => void
}) {
  const t = useTranslations('Contacts')
  const [dateStep, setDateStep] = useState<AlertPresetRecord | null>(null)
  const [pickedDate, setPickedDate] = useState<Date | undefined>()

  const handleSelect = (p: AlertPresetRecord) => {
    if (p.schedule_type === 'datetime') {
      setDateStep(p)
    } else {
      onSelect(p)
      onOpenChange(false)
    }
  }

  return (
    <>
      <Dialog open={open && !dateStep} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('applyPresetTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => handleSelect(p)}
                className="w-full flex items-center gap-3 p-3 rounded-lg border text-left hover:bg-muted transition-colors"
              >
                <div className="shrink-0 text-muted-foreground">
                  {alertTypeIcon(p.schedule_type)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground line-clamp-1">{p.message}</p>
                </div>
                {p.schedule_type === 'sessions_countdown' && (
                  <Badge variant="outline" className="text-xs shrink-0">
                    {t('presetSessionsCount', { count: p.schedule_value as number })}
                  </Badge>
                )}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Date picker for date-based presets */}
      <Dialog
        open={!!dateStep}
        onOpenChange={() => {
          setDateStep(null)
          setPickedDate(undefined)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('selectDateForPreset', { name: dateStep?.name ?? '' })}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <DatePicker value={pickedDate} onChange={setPickedDate} />
          </div>
          <DialogFooter>
            <button
              onClick={() => {
                setDateStep(null)
                setPickedDate(undefined)
              }}
              className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors"
            >
              {t('cancel')}
            </button>
            <button
              disabled={!pickedDate}
              onClick={() => {
                if (dateStep && pickedDate) {
                  onSelect(dateStep, pickedDate)
                  setDateStep(null)
                  setPickedDate(undefined)
                  onOpenChange(false)
                }
              }}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {t('applyDateButton')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * The three-way dismissal, restored from the original product.
 *
 * A two-button confirm cannot express this choice, because "dismiss" and
 * "delete" are genuinely different intentions here and the destructive one is
 * not recoverable. So the dialog names both outcomes rather than making the
 * coach infer them from a single "Remove this alert?".
 *
 * An ALREADY-dismissed alert drops to two buttons: dismissing it again would do
 * nothing, and a control that does nothing reads as a broken one.
 */
function AlertDismissDialog({
  alert,
  contactName,
  onCancel,
  onDismissOnly,
  onDelete,
}: {
  alert: ContactAlert | null
  contactName: string
  onCancel: () => void
  onDismissOnly: (alert: ContactAlert) => void
  onDelete: (alert: ContactAlert) => void
}) {
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const dismissed = !!alert?.archived_at

  return (
    <Dialog open={!!alert} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {dismissed ? t('alertDeleteConfirm') : t('alertDismissTitle')}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {dismissed
            ? t('alertDeleteBody', { message: alert?.message ?? '' })
            : t('alertDismissBody', { message: alert?.message ?? '', name: contactName })}
        </p>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {tCommon('cancel')}
          </Button>
          {!dismissed && (
            <Button variant="outline" onClick={() => alert && onDismissOnly(alert)}>
              {t('alertDismissOnly')}
            </Button>
          )}
          <Button variant="destructive" onClick={() => alert && onDelete(alert)}>
            {dismissed ? tCommon('delete') : t('alertDismissAndDelete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AlertsTab({ contact, teamId }: { contact: Contact; teamId: string | null }) {
  const fmt = useTeamFormat()
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const qc = useQueryClient()
  const { data: alerts = [], isLoading } = useContactAlerts(contact.id)
  const { data: presets = [] } = useAlertPresets(teamId)
  const [addOpen, setAddOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  // The alert awaiting a dismissal decision. See AlertDismissDialog.
  const [dismissing, setDismissing] = useState<ContactAlert | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['contact-alerts', contact.id] })

  // DISMISSING IS NOT DELETING, and a single confirm cannot say which one you
  // meant. An alert is two things at once: a notification, and a note the coach
  // wrote on this person's record. Clearing the first must not silently destroy
  // the second — so the choice is explicit, as it was in the original product.
  //
  //   Dismiss only    -> archived_at. The record stays; it stops counting
  //                      towards alerts_count (trackContactAlerts counts
  //                      non-archived rows), so the contacts-list badge and the
  //                      dashboard queue row clear.
  //   Dismiss & delete-> the document goes.
  //
  // This is the only writer of `archived_at` for a contact alert. Every reader
  // already honoured the field — the mobile query filters on it and the counter
  // respects it — but nothing had ever set it, so "dismiss" was unreachable and
  // permanent deletion was the only way out of a fired alert.
  const dismissOnly = async (alert: ContactAlert) => {
    setDismissing(null)
    await updateDoc(
      doc(db, CONTACTS_COLLECTION, contact.id, CONTACT_ALERTS_SUBCOLLECTION, alert.id),
      { archived_at: serverTimestamp() }
    )
    invalidate()
  }

  const dismissAndDelete = async (alert: ContactAlert) => {
    setDismissing(null)
    await deleteDoc(doc(db, CONTACTS_COLLECTION, contact.id, CONTACT_ALERTS_SUBCOLLECTION, alert.id))
    invalidate()
  }

  // Live alerts first, dismissed ones after. Dismissed alerts stay VISIBLE —
  // this page is the record, and hiding them would make "dismiss only" look
  // identical to a delete — but they must not push live ones down the list.
  const orderedAlerts = useMemo(
    () => [...alerts].sort((a, b) => Number(!!a.archived_at) - Number(!!b.archived_at)),
    [alerts]
  )

  const applyPreset = async (preset: AlertPresetRecord, date?: Date) => {
    const payload: Record<string, unknown> = {
      schedule_type: preset.schedule_type,
      message: preset.message,
      show_in_app: preset.show_in_app ?? false,
      archived_at: null,
      created_at: serverTimestamp(),
    }
    if (preset.schedule_type === 'sessions_countdown') {
      payload.schedule_value = preset.schedule_value ?? 10
    } else if (preset.schedule_type === 'datetime') {
      payload.schedule_value = date ? Timestamp.fromDate(date) : null
    } else {
      // 'always' — nothing to collect; it fires on creation (see alertIsFired).
      payload.schedule_value = null
    }
    await addDoc(
      collection(db, CONTACTS_COLLECTION, contact.id, CONTACT_ALERTS_SUBCOLLECTION),
      payload
    )
    invalidate()
  }

  if (isLoading)
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    )

  return (
    <div className="space-y-4 pb-24">
      <div className="flex gap-2 justify-end">
        {presets.length > 0 && (
          <button
            onClick={() => setPresetOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm hover:bg-muted transition-colors"
          >
            <BookOpen className="h-4 w-4" />
            {t('fromPresetButton')}
          </button>
        )}
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm hover:bg-muted transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t('addAlert')}
        </button>
      </div>

      {alerts.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground text-sm">{t('noAlerts')}</div>
      ) : (
        <div className="space-y-2">
          {orderedAlerts.map((alert) => {
            const dismissed = !!alert.archived_at
            // A dismissed alert is never "fired" — it has been dealt with, and
            // showing it in alarm colours would undo the dismissal visually.
            const fired = !dismissed && alertIsFired(alert, { totalSessions: contact.total_sessions })
            return (
              <div
                key={alert.id}
                className={`flex items-start gap-3 p-3 rounded-lg border ${fired ? 'border-orange-300 bg-orange-50 dark:bg-orange-950/20' : ''} ${dismissed ? 'opacity-60' : ''}`}
              >
                <div
                  className={`mt-0.5 shrink-0 ${fired ? 'text-orange-500' : 'text-muted-foreground'}`}
                >
                  {alertTypeIcon(alert.schedule_type)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {alert.schedule_type === 'sessions_countdown' ? (
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('alertTypeSessionsCountdown')}: {alert.schedule_value as number}
                      </span>
                    ) : alert.schedule_type === 'datetime' ? (
                      <span className="text-xs font-medium text-muted-foreground">
                        {formatDate(fmt, alert.schedule_value as { toDate(): Date } | null)}
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('alertTypeAlways')}
                      </span>
                    )}
                    <Badge
                      variant={fired ? 'default' : 'outline'}
                      className={`text-xs ${fired ? 'bg-orange-500 border-orange-500' : ''}`}
                    >
                      {dismissed
                        ? t('alertDismissed')
                        : fired
                          ? t('alertFired')
                          : t('alertPending')}
                    </Badge>
                    {alert.show_in_app && (
                      <Badge variant="outline" className="text-xs">
                        App
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm mt-0.5">{alert.message}</p>
                </div>
                <button
                  onClick={() => setDismissing(alert)}
                  aria-label={dismissed ? tCommon('delete') : t('alertDismissTitle')}
                  className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <AlertDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        contactId={contact.id}
        onSaved={invalidate}
      />
      <AlertPresetPicker
        open={presetOpen}
        onOpenChange={setPresetOpen}
        presets={presets}
        onSelect={applyPreset}
      />
      <AlertDismissDialog
        alert={dismissing}
        contactName={`${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim()}
        onCancel={() => setDismissing(null)}
        onDismissOnly={dismissOnly}
        onDelete={dismissAndDelete}
      />
    </div>
  )
}

// ─── send an email (outreach) ────────────────────────────────────────────────
// Opened from the header's Email tile and from Activity's Outreach chip, where
// the sent emails are listed. (There was an Emails tab; see TABS.)

function SendOutreachDialog({
  open,
  onOpenChange,
  contact,
  teamId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  contact: Contact
  teamId: string | null
}) {
  const t = useTranslations('Contacts')
  const qc = useQueryClient()
  const [templateId, setTemplateId] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: templates = [] } = useQuery({
    queryKey: ['outreach-templates', teamId],
    enabled: open && !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(collection(db, TEAMS_COLLECTION, teamId!, OUTREACH_TEMPLATES_SUBCOLLECTION), orderBy('name', 'asc')),
      )
      return snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as { name?: string; active?: boolean }) }))
        .filter((tpl) => tpl.active !== false)
    },
  })

  async function send() {
    if (!templateId || !teamId) return
    setSending(true)
    setError(null)
    try {
      const fn = callFunction('sendOutreachEmail')
      await fn({ contactIds: [contact.id], templateId, teamId })
      await qc.invalidateQueries({ queryKey: ['contact-activity-log', contact.id] })
      onOpenChange(false)
      setTemplateId('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('outreachSendTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('outreachSendDesc', { name: `${contact.firstname} ${contact.lastname}` })}
          </p>
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('outreachNoTemplates')}</p>
          ) : (
            <Select value={templateId} onValueChange={(v) => setTemplateId(v ?? '')}>
              <SelectTrigger>
                <SelectValue placeholder={t('outreachPickTemplate')} />
              </SelectTrigger>
              <SelectContent>
                {templates.map((tpl) => (
                  <SelectItem key={tpl.id} value={tpl.id}>
                    {tpl.name || tpl.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={send} disabled={!templateId || sending}>
            {sending ? t('outreachSending') : t('outreachSend')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── archived / deleted read-only view ───────────────────────────────────────

function ArchivedContactView({
  contact,
  onAction,
}: {
  contact: Contact
  onAction: () => void
}) {
  const fmt = useTeamFormat()
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [acting, setActing] = useState(false)

  const isDeleted = !!contact.deleted_at

  const daysLeft = useMemo(() => {
    if (!isDeleted) return null
    const deletedDate = tsToDate(contact.deleted_at)
    if (!deletedDate) return null
    const anonymiseDate = new Date(deletedDate.getTime() + 30 * 24 * 60 * 60 * 1000)
    return Math.max(0, Math.ceil((anonymiseDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
  }, [contact.deleted_at, isDeleted])

  const handleRestore = async () => {
    setActing(true)
    try {
      await updateDoc(doc(db, CONTACTS_COLLECTION, contact.id), {
        archived_at: null,
        deleted_at: null,
        updatedAt: serverTimestamp(),
      })
      qc.invalidateQueries({ queryKey: ['contact', contact.id] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      onAction()
    } finally {
      setActing(false)
    }
  }

  const handleDelete = async () => {
    setActing(true)
    try {
      await updateDoc(doc(db, CONTACTS_COLLECTION, contact.id), {
        deleted_at: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      qc.invalidateQueries({ queryKey: ['contact', contact.id] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      setConfirmDelete(false)
      onAction()
    } finally {
      setActing(false)
    }
  }

  const address = contact.address
  const hasAddress = address && Object.values(address).some(Boolean)
  const hasAcquisition = contact.source || contact.source_detail

  return (
    <div className="space-y-4">
      {/* Deletion countdown warning */}
      {isDeleted && daysLeft !== null && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive font-medium">
            {t('deletedDaysLeft', { days: daysLeft })}
          </p>
        </div>
      )}

      {/* Action bar + notice */}
      <div className="rounded-xl border bg-card p-4 flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <p className="flex-1 text-sm text-muted-foreground">{t('archivedNotice')}</p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleRestore}
            disabled={acting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            <ArchiveRestore className="h-4 w-4" />
            {isDeleted ? t('bulkRestore') : t('actionUnarchive')}
          </button>
          {!isDeleted && (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-destructive/30 text-sm font-medium text-destructive hover:bg-destructive/5 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
              {t('bulkDelete')}
            </button>
          )}
        </div>
      </div>

      {/* Core fields */}
      <div className="rounded-xl border bg-card p-5">
        <SectionHeader>{t('sectionBasicInfo')}</SectionHeader>
        <DetailRow label={t('fieldAcquisitionStage')} value={contact.acquisition_stage ? t(`stage_${contact.acquisition_stage}` as Parameters<typeof t>[0]) : null} />
        {contact.entry && (
          <DetailRow label={t('fieldAcquisitionEntry')} value={t(`entry_${contact.entry}` as Parameters<typeof t>[0])} />
        )}
        <DetailRow
          label={t('fieldGender')}
          value={contact.gender ? t(`gender_${contact.gender}`) : null}
        />

        <SectionHeader>{t('sectionContactInfo')}</SectionHeader>
        <DetailRow label={t('colEmail')} value={contact.email} />
        <DetailRow label={t('fieldPhone')} value={contact.phone} />

        <SectionHeader>{t('sectionPersonalInfo')}</SectionHeader>
        <DetailRow label={t('fieldBirthdate')} value={formatDate(fmt, contact.birthdate)} />
        <DetailRow label={t('fieldBirthplace')} value={contact.birthplace} />
        {(contact.weight ?? 0) > 0 && (
          <DetailRow label={t('fieldWeight')} value={`${contact.weight} kg`} />
        )}
      </div>

      {/* Address */}
      {hasAddress && (
        <div className="rounded-xl border bg-card p-5">
          <SectionHeader>{t('sectionAddress')}</SectionHeader>
          {(address.route || address.street_number) && (
            <DetailRow
              label={t('fieldStreet')}
              value={[address.route, address.street_number].filter(Boolean).join(' ')}
            />
          )}
          {address.postal_code && (
            <DetailRow label={t('fieldPostalCode')} value={address.postal_code} />
          )}
          {address.locality && <DetailRow label={t('fieldLocality')} value={address.locality} />}
        </div>
      )}

      {/* Source / Acquisition detail */}
      {hasAcquisition && (
        <div className="rounded-xl border bg-card p-5">
          <SectionHeader>{t('sectionAcquisition')}</SectionHeader>
          {contact.source && (
            <DetailRow label={t('fieldAcquisitionSource')} value={t(`source_${contact.source}` as Parameters<typeof t>[0])} />
          )}
          {contact.source_detail && (
            <DetailRow label={t('fieldAcquisitionSourceDetail')} value={contact.source_detail} />
          )}
        </div>
      )}

      {/* Statistics */}
      <div className="rounded-xl border bg-card p-5">
        <SectionHeader>{t('sectionStats')}</SectionHeader>
        <DetailRow label={t('statTotalSessions')} value={String(contact.total_sessions ?? 0)} />
        {contact.created_at && (
          <DetailRow label={t('memberSince')} value={formatDate(fmt, contact.created_at)} />
        )}
        {contact.external_since && (
          <DetailRow label={t('externalSince')} value={formatDate(fmt, contact.external_since)} />
        )}
        {contact.archived_at && (
          <DetailRow label={t('archivedSince')} value={formatDate(fmt, contact.archived_at)} />
        )}
      </div>

      {/* Notes */}
      {contact.notes && (
        <div className="rounded-xl border bg-card p-5">
          <SectionHeader>{t('fieldNotes')}</SectionHeader>
          <p className="text-sm whitespace-pre-wrap">{contact.notes}</p>
        </div>
      )}

      {/* Delete confirmation */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteContactTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('deleteContactDesc', { name: `${contact.firstname} ${contact.lastname}` })}
          </p>
          <DialogFooter>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors"
            >
              {t('cancel')}
            </button>
            <button
              onClick={handleDelete}
              disabled={acting}
              className="px-4 py-2 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-50 transition-colors"
            >
              {acting ? tCommon('loading') : t('bulkDelete')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── header stats bar ────────────────────────────────────────────────────────

// ─── affiliation status badge (reuses OrgAffiliationStatusDef color system) ────

const AFFIL_COLOR_CLASSES: Record<string, { bg: string; text: string; border: string }> = {
  green: {
    bg: 'bg-green-50 dark:bg-green-900/20',
    text: 'text-green-700 dark:text-green-300',
    border: 'border-green-200 dark:border-green-800',
  },
  blue: {
    bg: 'bg-blue-50 dark:bg-blue-900/20',
    text: 'text-blue-700 dark:text-blue-300',
    border: 'border-blue-200 dark:border-blue-800',
  },
  yellow: {
    bg: 'bg-yellow-50 dark:bg-yellow-900/20',
    text: 'text-yellow-700 dark:text-yellow-300',
    border: 'border-yellow-200 dark:border-yellow-800',
  },
  red: {
    bg: 'bg-red-50 dark:bg-red-900/20',
    text: 'text-red-700 dark:text-red-300',
    border: 'border-red-200 dark:border-red-800',
  },
  gray: {
    bg: 'bg-gray-50 dark:bg-gray-900/20',
    text: 'text-gray-600 dark:text-gray-400',
    border: 'border-gray-200 dark:border-gray-700',
  },
}

function AffilStatusBadge({
  statusId,
  statuses,
}: {
  statusId: string
  statuses: OrgAffiliationStatusDef[]
}) {
  const def = statuses.find((s) => s.id === statusId) ?? statuses[0]
  const color = AFFIL_COLOR_CLASSES[def?.color ?? 'gray'] ?? AFFIL_COLOR_CLASSES.gray
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${color.bg} ${color.text} ${color.border}`}
    >
      {def?.label ?? statusId}
    </span>
  )
}

// ─── affiliations tab ─────────────────────────────────────────────────────────

function AffiliationsTab({
  contact,
  teamId,
  orgId,
  membershipFieldLocked,
}: {
  contact: Contact
  teamId: string | null
  orgId?: string | null
  membershipFieldLocked?: boolean
}) {
  const fmt = useTeamFormat()
  // Styled confirmation, replacing nothing — this action had none.
  const { confirm, confirmDialog } = useConfirm()
  const tCommonAff = useTranslations('Common')
  const t = useTranslations('Affiliations')
  // The removal confirmation's copy lives in `Contacts` — it is written about
  // this PERSON ("remove {name}'s affiliation"), not about affiliations in
  // general. Called through `t` it rendered its own key id into the dialog.
  const tContacts = useTranslations('Contacts')
  const qc = useQueryClient()

  const { data: affiliations = [], isLoading } = useContactAffiliations(contact.id)
  const { data: affiliationTypes = [] } = useAffiliationTypes(teamId, orgId)
  const { data: statuses = DEFAULT_ORG_AFFILIATION_STATUSES } = useOrgAffiliationStatuses(orgId)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Affiliation | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [approving, setApproving] = useState<string | null>(null)
  const [renewTarget, setRenewTarget] = useState<Affiliation | null>(null)
  const [renewBusy, setRenewBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['contact-affiliations', contact.id] })

  const handleRemove = async (affiliationId: string) => {
    // Not a record-keeping delete like the subscription history above: this one
    // takes away access, member pricing and any renewal that was due, so the
    // body names those rather than the row.
    const ok = await confirm({
      title: tContacts('affiliationRemoveTitle'),
      description: tContacts('affiliationRemoveBody', {
        name: `${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim(),
      }),
      confirmLabel: tCommonAff('remove'),
    })
    if (!ok) return
    setRemoving(affiliationId)
    try {
      const fn = callFunction('removeAffiliation')
      await fn({ teamId: contact.teamId, contactId: contact.id, affiliationId })
      invalidate()
    } finally {
      setRemoving(null)
    }
  }

  const handleRenew = async (feePaid: boolean) => {
    if (!renewTarget || !contact.teamId) return
    setRenewBusy(true)
    try {
      const res = await renewAffiliationCall({
        teamId: contact.teamId,
        contactId: contact.id,
        affiliationId: renewTarget.id,
        ...(feePaid ? { fee_paid: true } : {}),
      })
      invalidate()
      setRenewTarget(null)
      const until = fmt.custom(new Date(res.valid_until), DATE_OPTS)
      setToast(t('renewedToast', { date: until }))
      setTimeout(() => setToast(null), 3000)
    } finally {
      setRenewBusy(false)
    }
  }

  // The active status the "approve" action promotes a requested affiliation to.
  const activeStatusId =
    (statuses.find((s) => s.countsAsActive && !s.isFinal) ??
      statuses.find((s) => s.id === 'active'))?.id ?? 'active'

  const handleApprove = async (affiliationId: string) => {
    setApproving(affiliationId)
    try {
      const fn = callFunction('approveAffiliation')
      await fn({
        teamId: contact.teamId,
        contactId: contact.id,
        affiliationId,
        status_id: activeStatusId,
      })
      invalidate()
    } finally {
      setApproving(null)
    }
  }

  if (isLoading)
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    )

  return (
    <div className="space-y-4 pb-16">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('title')}
        </p>
        {!membershipFieldLocked && (
          <button
            onClick={() => { setEditing(null); setDialogOpen(true) }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm hover:bg-muted transition-colors"
          >
            <Plus className="h-4 w-4" />
            {t('addButton')}
          </button>
        )}
      </div>

      {affiliations.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground text-sm">
          {t('noAffiliations')}
        </div>
      ) : (
        <div className="space-y-2">
          {affiliations.map((aff) => {
            const typeDef = affiliationTypes.find((at) => at.id === aff.affiliation_type_id)
            const label = typeDef?.label ?? aff.label ?? aff.type_key ?? aff.affiliation_type_id ?? '—'
            const issuerLabel =
              aff.issuer === 'team'
                ? t('issuer_team')
                : aff.issuer === 'org'
                  ? (aff.issuer_name ?? t('issuer_org'))
                  : (aff.issuer_name ?? t('issuer_external'))
            const isRemoving = removing === aff.id
            const isApproving = approving === aff.id
            const requestedStatus = statuses.find((s) => s.id === 'requested')
            const isRequested = requestedStatus && aff.status_id === requestedStatus.id
            const statusDef = statuses.find((s) => s.id === aff.status_id)
            const isExpiredStatus = !!statusDef?.isFinal && !statusDef?.countsAsActive
            // Renew makes sense for an affiliation that has been activated at least once:
            // extend an active one, or reactivate an expired one.
            const canRenew = !membershipFieldLocked && (aff.active || isExpiredStatus)

            return (
              <div key={aff.id} className="flex items-start gap-3 p-3 rounded-lg border bg-card">
                <div
                  className={`h-2 w-2 rounded-full mt-2 shrink-0 ${aff.active ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium">{label}</p>
                    <AffilStatusBadge statusId={aff.status_id} statuses={statuses} />
                    <span className="text-xs text-muted-foreground">{issuerLabel}</span>
                  </div>
                  {(aff.valid_from || aff.valid_until) && (
                    <p className="text-xs text-muted-foreground">
                      {formatDate(fmt, aff.valid_from)} – {aff.valid_until ? formatDate(fmt, aff.valid_until) : t('ongoingLabel')}
                    </p>
                  )}
                  {aff.reference && (
                    <p className="text-xs text-muted-foreground">{t('colReference')}: {aff.reference}</p>
                  )}
                  {typeDef?.fee_amount != null && (
                    <p className="text-xs text-muted-foreground">
                      {t('feeLabel')}: {typeDef.fee_amount}
                      {aff.fee_paid && (
                        <span className="ml-1.5 inline-flex items-center rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900 dark:text-green-300">
                          {t('feePaidBadge')}
                        </span>
                      )}
                      {typeDef.issuer_url && (
                        <a
                          href={typeDef.issuer_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-1.5 underline hover:text-foreground"
                        >
                          {t('feePayLink')}
                        </a>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* Approve action for pending/requested affiliations */}
                  {!membershipFieldLocked && isRequested && (
                    <Tip label={t('approveButton')}>
                      <button
                        onClick={() => handleApprove(aff.id)}
                        disabled={isApproving}
                        className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-green-600 disabled:opacity-50"
                        aria-label={t('approveButton')}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  )}
                  {canRenew && (
                    <Tip label={t('renewButton')}>
                      <button
                        onClick={() => setRenewTarget(aff)}
                        className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-primary"
                        aria-label={t('renewButton')}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  )}
                  {!membershipFieldLocked && (
                    <Tip label={t('colType')}>
                      <button
                        onClick={() => { setEditing(aff); setDialogOpen(true) }}
                        className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                        aria-label={t('colType')}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  )}
                  {!membershipFieldLocked && (
                    <Tip label={t('removeTitle')}>
                      <button
                        onClick={() => handleRemove(aff.id)}
                        disabled={isRemoving}
                        className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-destructive disabled:opacity-50"
                        aria-label={t('removeTitle')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <UpsertAffiliationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        contact={contact}
        existing={editing}
        affiliationTypes={affiliationTypes}
        statuses={statuses}
        orgId={orgId}
        onSaved={() => { invalidate(); setEditing(null) }}
      />

      {renewTarget && (() => {
        const typeDef = affiliationTypes.find((at) => at.id === renewTarget.affiliation_type_id)
        const currentUntil = renewTarget.valid_until ? tsToDate(renewTarget.valid_until) : null
        // The TYPE, not just its month count — a fixed-date type has no month count.
        const newUntil = previewRenewedUntil(currentUntil, typeDef)
        const newUntilStr = fmt.custom(newUntil, DATE_OPTS)
        const label = typeDef?.label ?? renewTarget.label ?? renewTarget.type_key ?? ''
        return (
          <RenewConfirmDialog
            open
            onOpenChange={(v) => { if (!v) setRenewTarget(null) }}
            title={t('renewTitle')}
            description={t('renewDesc', { label, date: newUntilStr })}
            confirmLabel={t('renewButton')}
            cancelLabel={t('cancel')}
            feeCheckboxLabel={
              typeDef?.fee_amount != null
                ? t('feeReceivedLabel', { amount: typeDef.fee_amount })
                : null
            }
            onConfirm={handleRenew}
            busy={renewBusy}
          />
        )
      })()}

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 rounded-lg bg-green-600 px-4 py-2.5 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
      {confirmDialog}
    </div>
  )
}

// ─── upsert affiliation dialog ────────────────────────────────────────────────

function UpsertAffiliationDialog({
  open,
  onOpenChange,
  contact,
  existing,
  affiliationTypes,
  statuses,
  orgId,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  contact: Contact
  existing: Affiliation | null
  affiliationTypes: AffiliationType[]
  statuses: OrgAffiliationStatusDef[]
  orgId?: string | null
  onSaved: () => void
}) {
  const t = useTranslations('Affiliations')
  const [typeId, setTypeId] = useState(existing?.affiliation_type_id ?? '')
  const [statusId, setStatusId] = useState(existing?.status_id ?? (statuses[0]?.id ?? ''))
  const [reference, setReference] = useState(existing?.reference ?? '')
  const [validFrom, setValidFrom] = useState<Date | undefined>(
    existing?.valid_from ? tsToDate(existing.valid_from) : undefined
  )
  const [validUntil, setValidUntil] = useState<Date | undefined>(
    existing?.valid_until ? tsToDate(existing.valid_until) : undefined
  )
  const [saving, setSaving] = useState(false)

  // Reset when dialog opens with a different affiliation
  useEffect(() => {
    if (open) {
      setTypeId(existing?.affiliation_type_id ?? '')
      setStatusId(existing?.status_id ?? (statuses[0]?.id ?? ''))
      setReference(existing?.reference ?? '')
      setValidFrom(existing?.valid_from ? tsToDate(existing.valid_from) : undefined)
      setValidUntil(existing?.valid_until ? tsToDate(existing.valid_until) : undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id])

  const save = async () => {
    if (!typeId) return
    setSaving(true)
    try {
      const typeDef = affiliationTypes.find((at) => at.id === typeId)
      const fn = callFunction('upsertAffiliation')
      await fn({
        teamId: contact.teamId,
        contactId: contact.id,
        affiliationId: existing?.id ?? null,
        affiliation_type_id: typeId,
        type_key: typeDef?.key ?? null,
        label: typeDef?.label ?? null,
        issuer: typeDef?.default_issuer ?? 'team',
        org_id: orgId ?? null,
        issuer_name: typeDef?.issuer_name ?? null,
        status_id: statusId,
        reference: reference.trim() || null,
        valid_from: validFrom ? Timestamp.fromDate(validFrom) : null,
        valid_until: validUntil ? Timestamp.fromDate(validUntil) : null,
      })
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{existing ? t('editTitle') : t('addTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Field label={t('fieldType')} required>
            <Select value={typeId} onValueChange={(v) => setTypeId(v ?? '')}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {affiliationTypes.map((at) => (
                  <SelectItem key={at.id} value={at.id}>
                    {at.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('fieldStatus')}>
            <Select value={statusId} onValueChange={(v) => setStatusId(v ?? '')}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('fieldReference')}>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
          <Field label={t('fieldValidFrom')}>
            <DatePicker value={validFrom} onChange={setValidFrom} />
          </Field>
          <Field label={t('fieldValidUntil')}>
            <DatePicker
              value={validUntil}
              onChange={setValidUntil}
              placeholder={t('ongoingLabel')}
            />
          </Field>
        </div>
        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            onClick={save}
            disabled={saving || !typeId}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? t('saving') : t('save')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

// 'stats' is deliberately absent. Its one remaining card — the attendance trend
// — moved to Coaching, where the question it answers is actually asked, and a
// tab that exists to be empty is worse than one destination fewer. A bookmarked
// `?tab=stats` is safe: `useTabParam` falls back rather than opening an empty
// pane on an id it does not recognise.
// BOTH `payments` and `affiliation` SURVIVE AS IDS, and each keeps the meaning it
// already had — which is what makes the 2026-08 restructure free:
//   `payments`    is now "Plans & Payments" (plans, credits, billing AND payments,
//                 one tab with three segments). `?tab=payments` still means "this
//                 person's money", so the live link from the payments table and
//                 every stored open-tab keeps working.
//   `affiliation` is now "Affiliations" alone — belonging to a club or federation,
//                 whose fee is paid to the issuer and never processed by Linyup.
//                 It was only ever sharing a tab with plans.
// An id must not track its label — same rule as `followups` below, and the reason
// is the same: a saved `linyup_contact_tab_order` array names ids. Minting a NEW
// id for the merged tab would rank it +Infinity in `applyTabOrder` for everyone
// who has ever reordered their strip, silently moving it to the end.
const TAB_IDS = [
  'profile',
  'activity',
  'followups',
  'bookings',
  'affiliation',
  'payments',
  'documents',
  'goals',
  'gamification',
] as const
type TabId = (typeof TAB_IDS)[number]

// The segments of the "Plans & Payments" tab, carried in `?seg=` so a refresh, a
// shared link and a reopened tab all land where the reader was — the same UX-22
// argument `useTabParam` was written for, one level down. Until 2026-09-13 they
// were overview / plans / payments: an old `?seg=overview` or `?seg=plans` link is
// an unknown value now and falls back to Current, where the plan card went.
// 'receipts' is always in the URL vocabulary (so a direct `?seg=receipts` link
// is read on mount) even though the tab strip only offers it once the plugin
// is installed — MembershipTab's own effect bounces a stale value back to
// Current. Keeping the plugin's gate out of this array would instead make a
// still-loading `isInstalled()` swallow a legitimate deep link on first paint.
const MEMBERSHIP_SEGMENTS = ['current', 'history', 'payments', 'receipts'] as const
type MembershipSeg = (typeof MEMBERSHIP_SEGMENTS)[number]

export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const fmt = useTeamFormat()
  const { id } = use(params)
  const { currentTeamId, team, isOrgAdmin } = useAuth()
  const { data: contact, isLoading } = useContact(id)

  const { data: orgMembershipLocked = false } = useQuery({
    queryKey: ['org-membership-lock', team?.org_id],
    enabled: !!team?.org_id,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDoc(doc(db, ORGANIZATIONS_COLLECTION, team!.org_id!))
      return snap.data()?.lock_affiliation === true
    },
  })
  const membershipFieldLocked = orgMembershipLocked && !isOrgAdmin
  // Deep-link support: /contacts/{id}?tab=payments opens that tab (e.g. from the
  // payments table), and the active tab survives a refresh, a shared URL and a
  // reopened tab. Falls back to profile for a missing/unknown value.
  const [tab, setTab] = useTabParam(TAB_IDS, 'profile')
  // The Emails tab folded into Activity: an old link to it opens Activity on
  // the Outreach chip. `outreachHint` keys ActivityTab so it opens there.
  const [outreachHint, setOutreachHint] = useState(0)
  useEffect(() => {
    if (tab === 'followups') {
      setOutreachHint((n) => n + 1)
      setTab('activity')
    }
  }, [tab, setTab])
  // User-reorderable tab strip (opt-in edit mode; order persisted per-browser).
  const [tabOrder, setTabOrder] = useContactTabOrder()
  const [editingTabs, setEditingTabs] = useState(false)
  // Which segment of "Plans & Payments" is showing. In the URL (`?seg=`) rather
  // than component state: the header chip below deep-links a segment, and that
  // choice used to die on refresh — a live instance of the bug useTabParam
  // exists to remove. `enabled` keeps `?seg=` off the URL of every other tab.
  const [membershipSeg, setMembershipSeg] = useTabParam(
    MEMBERSHIP_SEGMENTS,
    'current',
    'seg',
    { enabled: tab === 'payments' }
  )
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const { goBack, isHistoryBack } = useBack('/contacts' as Route)
  const qc = useQueryClient()
  const { hasFeature } = usePlan()
  const { openUpgradeModal } = useUpgradeModal()
  const { isInstalled } = useInstalledPlugins()

  const [emailCopied, setEmailCopied] = useState(false)
  // Notes editor sheet — opened from the header icon and the profile-column glance.
  const [notesOpen, setNotesOpen] = useState(false)
  const [updateLinkOpen, setUpdateLinkOpen] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(false)
  // The card's four quick actions (which ones: quickActions.tsx, per browser)
  // and the dialogs they open, plus the "More actions" menu's archive.
  const [quickActions, setQuickActions] = useContactQuickActions()
  const [customiseOpen, setCustomiseOpen] = useState(false)
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false)
  const [sendEmailOpen, setSendEmailOpen] = useState(false)
  const [addPlanOpen, setAddPlanOpen] = useState(false)
  const [grantCreditsOpen, setGrantCreditsOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const { can } = useCapabilities()
  const canManage = can('contacts.manage')
  // Only fetched once a plan or credits dialog is opened from the card.
  const { data: subTypes = [] } = useSubscriptionTypes(
    addPlanOpen || grantCreditsOpen ? currentTeamId : null
  )
  const { data: notesCount = 0 } = useContactNotesCount(id)
  const { data: contactAlerts = [] } = useContactAlerts(id)

  // Register this contact as an open tab (label upgraded once the contact loads).
  // The stored href carries the active sub-tab so reopening lands where you left.
  useRegisterTab({
    href:
      tab === 'payments'
        ? `/contacts/${id}?tab=${tab}&seg=${membershipSeg}`
        : `/contacts/${id}?tab=${tab}`,
    label: contact ? `${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim() : '',
    entityKind: 'contact',
    enabled: !!contact,
  })

  // Record the visit for "recently viewed contacts" in the sidebar search panel
  // (see the nav-memory census in contexts/NavPinsContext.tsx — this is a
  // different mechanism from the tab above, deliberately).
  //
  // ON LOAD, NOT ON ROUTE: it fires once the document has actually come back, so
  // a mistyped, deleted or forbidden id never enters the list; and it carries
  // the contact's OWN teamId, so an org admin reading another team's contact
  // records it there rather than into the team they are currently in.
  const { recordContactVisit } = useRecentContacts()
  useEffect(() => {
    if (contact?.id && contact.teamId) recordContactVisit(contact.id, contact.teamId)
  }, [contact?.id, contact?.teamId, recordContactVisit])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['contact', id] })
    qc.invalidateQueries({ queryKey: ['contacts'] })
  }
  const roster = useRosterToggle(contact, invalidate)

  const archiveContact = async () => {
    setArchiving(true)
    try {
      await updateDoc(doc(db, CONTACTS_COLLECTION, id), {
        archived_at: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      invalidate()
      setArchiveOpen(false)
    } finally {
      setArchiving(false)
    }
  }

  const handleCopyEmail = () => {
    if (!contact?.email) return
    navigator.clipboard.writeText(contact.email).then(() => {
      setEmailCopied(true)
      setTimeout(() => setEmailCopied(false), 2000)
    })
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="flex items-center gap-4">
          <Skeleton className="h-16 w-16 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  if (!contact) {
    return <div className="py-16 text-center text-muted-foreground">{t('notFound')}</div>
  }

  // WHAT each quick action does. Which four the card shows is the viewer's
  // choice (quickActions.tsx); an action this viewer cannot use is left off the
  // card and out of the choices.
  const quickActionDefs: Record<
    QuickActionId,
    {
      icon: React.ElementType
      /** The action's name — the choice list and, unless `tip` says otherwise, the tooltip. */
      name: string
      tip?: string
      shortLabel: string
      count?: number
      disabled?: boolean
      available: boolean
      onClick: () => void
    }
  > = {
    alerts: {
      icon: Bell,
      name: t('tabAlerts'),
      shortLabel: t('tabAlerts'),
      count: contactAlerts.length,
      available: true,
      onClick: () => setAlertsOpen(true),
    },
    notes: {
      icon: StickyNote,
      name: t('tabNotes'),
      shortLabel: t('tabNotes'),
      count: notesCount,
      available: true,
      onClick: () => setNotesOpen(true),
    },
    record_payment: {
      icon: Banknote,
      name: t('actionRecordPaymentTip'),
      shortLabel: t('actionRecordPayment'),
      // As the Payments tab's own Record button: the callable decides.
      available: !!currentTeamId,
      onClick: () => setRecordPaymentOpen(true),
    },
    send_email: {
      icon: Mail,
      name: t('outreachSendTitle'),
      tip: contact.email ? undefined : t('outreachNoEmail'),
      shortLabel: t('actionSendEmail'),
      disabled: !contact.email,
      available: canManage,
      onClick: () => setSendEmailOpen(true),
    },
    add_plan: {
      icon: BookOpen,
      name: t('addSubscription'),
      shortLabel: t('actionAddPlan'),
      available: canManage,
      onClick: () => setAddPlanOpen(true),
    },
    grant_credits: {
      icon: Ticket,
      name: t('grantCredits'),
      shortLabel: t('actionGrantCredits'),
      available: canManage,
      onClick: () => setGrantCreditsOpen(true),
    },
    update_details: {
      icon: UserPen,
      name: t('menuUpdateDetails'),
      shortLabel: t('actionUpdateDetails'),
      available: true,
      onClick: () => setUpdateLinkOpen(true),
    },
  }
  const quickActionOptions: QuickActionOption[] = (Object.keys(quickActionDefs) as QuickActionId[])
    .filter((qa) => quickActionDefs[qa].available)
    .map((qa) => ({ id: qa, label: quickActionDefs[qa].name, icon: quickActionDefs[qa].icon }))

  const TABS: { id: TabId; label: string; icon: React.ElementType; feature?: PlanFeature }[] = [
    { id: 'profile', label: t('tabProfile'), icon: User },
    { id: 'goals', label: t('tabGoals'), icon: Flag, feature: 'goals' },
    { id: 'bookings', label: t('tabBookings'), icon: CalendarDays },
    // Plans, credits, recurring billing AND payments — one tab, three segments,
    // because a coach asking "what did they pay for in March, and what did they
    // hold then" was being made to switch tabs and search by hand. `Wallet`
    // rather than `CreditCard`: the tab is not only about card charges.
    { id: 'payments', label: t('tabPlansPayments'), icon: Wallet },
    // Affiliations kept the `affiliation` id and lost the plans: belonging to a
    // club or federation is a different concept, and its fee is paid to the
    // issuer, never processed by Linyup. It was only sharing a tab with plans.
    { id: 'affiliation', label: t('tabAffiliations'), icon: IdCard },
    { id: 'activity', label: t('tabActivity'), icon: Activity },
    // No Emails tab (Franco, 2026-09-25). What it listed was the activity log
    // filtered to `outreach_email_sent`, which is exactly Activity's Outreach
    // chip, and its one button is the header's Email tile. `followups` stays in
    // TAB_IDS so an old `?tab=followups` link (and a saved tab order) still
    // lands: on Activity, with Outreach selected (see the effect below).
    // What this person has been asked to accept — at signup, before booking, or
    // both — and whether they did. Its own tab: buried under the profile form it
    // was a screen nobody reached, and it rendered nothing at all for a studio
    // whose consent is signup-only.
    { id: 'documents', label: t('tabDocuments'), icon: FileSignature },
    // Gamification is a plugin — the tab appears only when it's installed (filtered below).
    { id: 'gamification', label: t('tabGamification'), icon: Star },
  ]

  return (
    <div className="space-y-6">
      {/* Back — steps back through history so opening a contact FROM the groups
          page (or a session, or search) returns you there rather than dumping
          you in the contacts list. Falls back to the list only when there's no
          in-app history, and labels itself accordingly. */}
      <button
        onClick={goBack}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {isHistoryBack ? tCommon('back') : t('title')}
      </button>

      {/* Header — TWO cards. Left, the profile: who they are, in the shape a
          contact card is expected to take — a round picture overlapping the
          card's top edge, the name under it, everything centered. Right, the
          insights card: what the studio reads about them (InsightsCard.tsx).
          Two fifths and three fifths at `lg` (Franco, 2026-09-25): a contact
          card is naturally narrow, and the summary with the figures and chart
          gets the room. The summary's text scrolls inside a capped height so
          it never stretches the row. A horizontal compact card was tried the
          same day and read like a list row, not a person.
          The content is centered vertically, so whatever height the row has
          lands evenly above and below it rather than as a gap. The grid
          carries top padding so the avatar clears the back button. */}
      <div className="grid gap-5 pt-12 lg:grid-cols-5 lg:items-stretch">
        <div className="relative flex flex-col justify-center rounded-2xl border border-border/60 bg-card px-6 pb-6 pt-16 text-center shadow-xl shadow-black/[0.06] dark:shadow-black/40 lg:col-span-2">
          {/* The card's only decoration: a tinted band along the top and a
              soft glow behind the avatar. Both sit behind everything else and
              take no clicks. */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-2xl bg-gradient-to-b from-primary/10 to-transparent"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute left-1/2 -top-14 h-36 w-36 -translate-x-1/2 rounded-full bg-primary/25 blur-2xl"
            aria-hidden
          />
          <div
            className="absolute left-1/2 -top-12 flex h-24 w-24 -translate-x-1/2 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/70 text-3xl font-bold text-primary-foreground shadow-lg shadow-primary/30 ring-4 ring-card"
            aria-hidden
          >
            {personInitials(contact)}
          </div>
          {/* The rare actions — the ones that do not earn a tile: asking the
              person to update their details, the roster switch, archiving, and
              choosing the tiles themselves. */}
          {!contact.archived_at && !contact.deleted_at && (
            <div className="absolute right-3 top-3">
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t('cardMoreActions')}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Ellipsis className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setUpdateLinkOpen(true)}>
                    <UserPen className="h-3.5 w-3.5" />
                    {t('menuUpdateDetails')}
                  </DropdownMenuItem>
                  {canManage && (
                    <>
                      <DropdownMenuItem onClick={roster.toggle}>
                        {roster.isExternal ? (
                          <UserCheck className="h-3.5 w-3.5" />
                        ) : (
                          <DoorOpen className="h-3.5 w-3.5" />
                        )}
                        {roster.isExternal ? t('headerMarkActive') : t('headerMarkExternal')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setArchiveOpen(true)}>
                        <Archive className="h-3.5 w-3.5" />
                        {t('bulkArchive')}
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuItem onClick={() => setCustomiseOpen(true)}>
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    {t('menuCustomiseActions')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          <div className="relative min-w-0">
            <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight">
              {contact.firstname} {contact.lastname}
            </h1>
          </div>
          <div className="relative mt-3 min-w-0">
            <div className="flex flex-wrap items-center justify-center gap-2">
              {/* A member has asked to close their own account. It sits with
                  the lifecycle badges because that is what it is — but ABOVE
                  the stage chips, because it outranks anything about chasing
                  them. The studio can do nothing about it and should not try;
                  it is here so the roster stops being a surprise. */}
              {contactDeletionState(contact, Date.now()) === 'scheduled' && (
                <Badge className="bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800">
                  {t('deletionScheduledBadge', {
                    date: formatDate(fmt, contact.deletion_scheduled_for) ?? '',
                  })}
                </Badge>
              )}
              {contact.deleted_at ? (
                <Badge variant="destructive">{t('deletedBadge')}</Badge>
              ) : contact.archived_at ? (
                <Badge variant="secondary">{t('archivedBadge')}</Badge>
              ) : (
                <>
                  {/* Off the roster (Contact.external): trains here, not
                      looked after. Read with the stage chip beside it —
                      "External · Trial attended" is exactly the ClassPass
                      visitor this bucket was made for. */}
                  {contact.external === true && (
                    <Badge variant="outline" className="gap-1" title={t('externalHint')}>
                      <DoorOpen className="h-3 w-3" />
                      {t('externalBadge')}
                    </Badge>
                  )}
                  {/* Only the IN-PROGRESS stages get a chip. "Joined" is the
                      settled, expected state — badging it says nothing, and
                      "Joined on {date}" below already carries it. Absence of a
                      chip is the signal that nothing needs chasing. */}
                  {contact.acquisition_stage && contact.acquisition_stage !== 'joined' && (
                    <Badge variant="outline">{t(`stage_${contact.acquisition_stage}` as Parameters<typeof t>[0])}</Badge>
                  )}
                  {contact.pending_signup && (
                    <Badge className="bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800">
                      {t('pendingSignup')}
                    </Badge>
                  )}
                  {contact.lead_acknowledged === false && (
                    <Badge className="bg-blue-500 text-white border-blue-500">
                      {t('newBadge')}
                    </Badge>
                  )}
                  {/* LAST in the row on purpose: what they HOLD. Every chip
                      before it is something the studio might have to act on;
                      a plan is a standing fact, so it reads as "and what are
                      they on" rather than competing with the to-dos. One chip
                      per live plan, coloured by its billing state; a plan that
                      is winding down says when it ends. Affiliation left this
                      row on 2026-09-13: it is the secondary fact, and the
                      panel below still links to it. */}
                  {heldMemberships(contact).map((plan) => (
                    <PlanChip key={`${plan.source}-${plan.ref}`} plan={plan} />
                  ))}
                </>
              )}
            </div>
            {/* The facts as a list: left-aligned inside a quiet panel so the
                icons line up and a long email has room, centered as a block and
                capped in width so the wide card does not stretch it. */}
            <div className="mx-auto mt-4 flex w-full max-w-md flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-left">
              {contact.email && (
                <span className="group/email flex max-w-full items-center gap-1.5 text-xs text-muted-foreground">
                  <Mail className="h-3 w-3 shrink-0" />
                  <span className="truncate">{contact.email}</span>
                  <Tip label={emailCopied ? t('emailCopied') : t('copyEmail')}>
                    <button
                      type="button"
                      onClick={handleCopyEmail}
                      aria-label={emailCopied ? t('emailCopied') : t('copyEmail')}
                      className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
   >
                      {emailCopied ? (
                        <Check className="h-3 w-3 text-green-600" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </Tip>
                </span>
              )}
              {contact.phone && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Phone className="h-3 w-3 shrink-0" /> {contact.phone}
                </span>
              )}
              {/* Off the roster since — a fact line like "Joined on", because
                  the date matters: it is where this person's reminders and
                  invitations stopped. */}
              {contact.external === true && contact.external_since && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <DoorOpen className="h-3 w-3 shrink-0" />
                  <span>
                    {t('externalSince')} {formatDate(fmt, contact.external_since)}
                  </span>
                </span>
              )}
              {contact.created_at && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CalendarDays className="h-3 w-3 shrink-0" />
                  <span>
                    {t('joinedOn')} {formatDate(fmt, contact.created_at)}
                    {(() => {
                      const joined = tsToDate(contact.created_at)
                      if (!joined) return ''
                      const days = daysSince(joined)
                      let span: string
                      if (days < 1) span = t('timespanToday')
                      else if (days >= 365) span = t('timespanYears', { count: Math.floor(days / 365) })
                      else if (days >= 30) span = t('timespanMonths', { count: Math.floor(days / 30) })
                      else if (days >= 7) span = t('timespanWeeks', { count: Math.floor(days / 7) })
                      else span = t('timespanDays', { count: days })
                      return ` · ${span}`
                    })()}
                  </span>
                </span>
              )}
              {/* What they hold, read as part of the same factual list as the
                  email / phone / joined-on lines rather than as status badges
                  up top — they describe the relationship, not its state.
                  Both jump to the Membership tab's matching segment. */}
              {!contact.archived_at && !contact.deleted_at && (
                <>
                  {/* The first held membership + "+N" when there are several
                      (the full list is the Plans list on Current). */}
                  {(() => {
                    const held = heldMemberships(contact)
                    if (held.length === 0) return null
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          setMembershipSeg('current')
                          setTab('payments')
                        }}
                        className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <BookOpen className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {t('subscriptionHeadingCard')}:{' '}
                          {held[0].subscription_type_name ?? t('subscriptionHeadingCard')}
                          {held.length > 1 ? ` +${held.length - 1}` : ''}
                        </span>
                      </button>
                    )
                  })()}
                  {contact.affiliation_summary?.has_active && (
                    <button
                      type="button"
                      // Affiliations is its own tab now — no segment to pick.
                      onClick={() => setTab('affiliation')}
                      className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 hover:opacity-80 transition-colors"
                    >
                      <CheckCircle className="h-3 w-3 shrink-0" />
                      <span>{t('affiliationHeadingCard')}</span>
                    </button>
                  )}
                </>
              )}
            </div>
            {/* Contact Groups plugin — membership chips */}
            {isInstalled('contact-groups') && !contact.archived_at && !contact.deleted_at && (
              <div className="flex justify-center">
                <ContactGroupsChips contact={contact} onChanged={invalidate} />
              </div>
            )}
          </div>
          {/* The quick actions: four tiles, chosen per browser from the
              "More actions" menu. Margin so they don't crowd the detail lines
              above them. */}
          {!contact.archived_at && !contact.deleted_at && (
            <div className="relative mx-auto grid w-full max-w-md grid-cols-4 gap-1.5 pt-5">
              {quickActions.map((qa) => {
                const action = quickActionDefs[qa]
                if (!action.available) return null
                return (
                  <HeaderActionButton
                    key={qa}
                    icon={action.icon}
                    label={action.tip ?? action.name}
                    shortLabel={action.shortLabel}
                    count={action.count}
                    disabled={action.disabled}
                    onClick={action.onClick}
                  />
                )
              })}
            </div>
          )}
        </div>

        <InsightsCard
          contact={contact}
          thresholds={team?.engagement_thresholds}
          className="lg:col-span-3"
        />
      </div>

      {/* Archived / deleted → read-only summary; active → full tabbed view */}
      {contact.archived_at || contact.deleted_at ? (
        <ArchivedContactView
          contact={contact}
          onAction={invalidate}
        />
      ) : (
        <>
          {/* Tabs — horizontally scrollable; buttons keep their width (shrink-0)
              so labels never get squeezed/overlapped on mobile. An opt-in edit
              mode makes the strip drag-reorderable (order saved per-browser). */}
          {(() => {
            const visibleTabs = applyTabOrder(
              TABS.filter((tb) => tb.id !== 'gamification' || isInstalled('gamification')),
              tabOrder
            )
            const visibleIds = visibleTabs.map((tb) => tb.id)

            const tabClass = (tb: (typeof TABS)[number], locked: boolean) =>
              `flex shrink-0 flex-col items-center gap-1 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                locked
                  ? 'border-transparent text-muted-foreground/50 hover:text-muted-foreground/70'
                  : tab === tb.id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
              }`

            const tabInner = (tb: (typeof TABS)[number], locked: boolean) => {
              const Icon = tb.icon
              return (
                <>
                  <Icon className="h-5 w-5" />
                  <span className="flex items-center gap-1">
                    {tb.label}
                    {locked && <Lock className="h-3 w-3 text-muted-foreground/30" />}
                  </span>
                </>
              )
            }

            return (
              <div className="mt-2 flex items-stretch gap-1 border-b">
                <div className="flex flex-1 gap-1 overflow-x-auto overflow-y-hidden no-scrollbar">
                  {editingTabs ? (
                    <SortableList
                      horizontal
                      ids={visibleIds}
                      onReorder={(from, to) => setTabOrder(moveItem(visibleIds, from, to))}
                    >
                      {visibleTabs.map((tb) => {
                        const locked = tb.feature ? !hasFeature(tb.feature) : false
                        return (
                          <SortableItem key={tb.id} id={tb.id}>
                            {({ setNodeRef, style, attributes, listeners, isDragging }) => (
                              <button
                                ref={setNodeRef}
                                style={style}
                                {...attributes}
                                {...listeners}
                                type="button"
                                className={`${tabClass(tb, locked)} cursor-grab rounded-t-md bg-muted/40 active:cursor-grabbing ${isDragging ? 'opacity-60' : ''}`}
                              >
                                {tabInner(tb, locked)}
                              </button>
                            )}
                          </SortableItem>
                        )
                      })}
                    </SortableList>
                  ) : (
                    visibleTabs.map((tb) => {
                      const locked = tb.feature ? !hasFeature(tb.feature) : false
                      return (
                        <button
                          key={tb.id}
                          onClick={() =>
                            locked ? openUpgradeModal({ feature: tb.feature }) : setTab(tb.id)
                          }
                          className={tabClass(tb, locked)}
                        >
                          {tabInner(tb, locked)}
                        </button>
                      )
                    })
                  )}
                </div>
                {/* Edit-mode toggle — secondary action */}
                <Tip label={editingTabs ? t('tabReorderDone') : t('tabReorder')}>
                  <button
                    type="button"
                    onClick={() => setEditingTabs((v) => !v)}
                    aria-label={editingTabs ? t('tabReorderDone') : t('tabReorder')}
                    className={`mb-1 flex h-8 w-8 shrink-0 items-center justify-center self-center rounded-lg border transition-colors ${
                      editingTabs
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
   >
                    {editingTabs ? <Check className="h-4 w-4" /> : <ArrowRightLeft className="h-4 w-4" />}
                  </button>
                </Tip>
              </div>
            )
          })()}

          {/* Tab content */}
          <div>
            {tab === 'profile' && (
              <ProfileTab
                contact={contact}
                teamId={currentTeamId}
                orgId={team?.org_id}
                onSaved={invalidate}
              />
            )}
            {/* The operator's copy of this person's consent — every document the
                studio asks for, on either surface, with state, version, role and
                date. Its own tab, with an honest empty state. */}
            {tab === 'documents' && (
              <ConsentHistoryPanel
                contactId={contact.id}
                teamId={currentTeamId}
                contactName={`${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim()}
              />
            )}
            {tab === 'activity' && (
              <ActivityTab
                key={outreachHint}
                contact={contact}
                teamId={currentTeamId}
                initialCategory={outreachHint > 0 ? 'outreach' : 'all'}
              />
            )}
            {tab === 'bookings' && <BookingsTab contact={contact} teamId={currentTeamId} />}
            {tab === 'payments' && (
              <MembershipTab
                contact={contact}
                teamId={currentTeamId}
                seg={membershipSeg}
                onSegChange={setMembershipSeg}
              />
            )}
            {tab === 'affiliation' && (
              <AffiliationsTab
                contact={contact}
                teamId={currentTeamId}
                orgId={team?.org_id}
                membershipFieldLocked={membershipFieldLocked}
              />
            )}
            {tab === 'goals' && <GoalsTab contact={contact} teamId={currentTeamId} team={team} />}
            {tab === 'gamification' && <GamificationTab contact={contact} teamId={currentTeamId} />}
          </div>

          {/* Single notes editor sheet — shared by the header icon + profile glance. */}
          <NotesSheet contact={contact} open={notesOpen} onOpenChange={setNotesOpen} />
          <ContactUpdateLinkDialog
            open={updateLinkOpen}
            onClose={() => setUpdateLinkOpen(false)}
            teamId={contact.teamId}
            teamSlug={team?.slug ?? null}
            contactId={contact.id}
            contactName={`${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim()}
            contactEmail={contact.email ?? null}
          />
          {roster.dialog}
          {/* The quick actions' dialogs, mounted only while open: each one
              fetches (templates, billing, plans) and resets on its next opening. */}
          {recordPaymentOpen && currentTeamId && (
            <RecordPaymentDialog
              teamId={currentTeamId}
              open
              onClose={() => setRecordPaymentOpen(false)}
              contactId={contact.id}
            />
          )}
          {sendEmailOpen && (
            <SendOutreachDialog
              open
              onOpenChange={setSendEmailOpen}
              contact={contact}
              teamId={currentTeamId}
            />
          )}
          {addPlanOpen && (
            <PlanDialog
              open
              onOpenChange={setAddPlanOpen}
              contactId={contact.id}
              changing={null}
              subTypes={subTypes}
              currency={(team?.default_currency ?? 'CHF').toUpperCase()}
              onSaved={() => {
                // The plan list is rebuilt by a trigger after the write lands.
                const run = () => {
                  invalidate()
                  qc.invalidateQueries({ queryKey: ['subscription-history', contact.id] })
                }
                run()
                setTimeout(run, 2500)
                setTimeout(run, 6000)
              }}
            />
          )}
          {grantCreditsOpen && (
            <GrantCreditsDialog
              open
              onOpenChange={setGrantCreditsOpen}
              contact={contact}
              subTypes={subTypes}
              onGranted={invalidate}
            />
          )}
          <CustomiseQuickActionsDialog
            open={customiseOpen}
            onOpenChange={setCustomiseOpen}
            value={quickActions}
            options={quickActionOptions}
            onSave={setQuickActions}
          />
          <ConfirmDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('archiveContactTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('archiveContactDesc', {
                    name: `${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim(),
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void archiveContact()} disabled={archiving}>
                  {t('bulkArchive')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </ConfirmDialog>
          {/* Outside the tab content, like the notes sheet, so the header bell
              opens it from whichever tab you are standing on. */}
          <AlertsSheet
            contact={contact}
            teamId={currentTeamId}
            open={alertsOpen}
            onOpenChange={setAlertsOpen}
          />
        </>
      )}
    </div>
  )
}
