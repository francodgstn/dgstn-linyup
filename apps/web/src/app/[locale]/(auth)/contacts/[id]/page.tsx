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
import { db, functions } from '@/lib/firebase'
import { httpsCallable } from 'firebase/functions'
import { formatCurrency } from '@/lib/format'
import { ConsentHistoryPanel } from '@/components/contacts/ConsentHistoryPanel'
import { useAuth } from '@/contexts/AuthContext'
import { RankBadge } from '@/components/ranking/RankBadge'
import { useCapabilities } from '@/hooks/useCapabilities'
import { Badge } from '@/components/ui/badge'
import { FloatingSlot } from '@/components/layout/FloatingDock'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Segmented } from '@/components/ui/segmented'
import { useSubscriptionHistory } from '@/hooks/useSubscriptionHistory'
import { LedgerSegment } from './LedgerSegment'
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
  planGrantExpiryMs,
  planGrantIsCurrent,
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
  SUBSCRIPTION_ROLLUP_STATUSES,
  type SubscriptionRollupStatus,
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
  Link2,
  Info,
  Pencil,
  ShieldCheck,
  ShieldOff,
  MoreVertical,
  DoorOpen,
  UserCheck,
  QrCode,
  User,
  Check,
  IdCard,
  RefreshCw,
  Ticket,
  FileSignature,
  CheckSquare,
  Search,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Tooltip as UITooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip'

import { XAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts'
import { GoalsTab } from './GoalsTab'
import { NotesTab, useContactNotesCount, useContactNotes, noteColorClasses, type ContactNote } from './NotesTab'
import { PaymentsTab } from './PaymentsTab'
import {
  MemberSubscriptionsSection,
  RollupBadge,
  useContactMemberSubscriptions,
} from '@/components/contacts/MemberSubscriptionsSection'
import { isoWeekLabel, useContactWeeklyReports } from './AttendanceTrendCard'
import { PlanGate } from '@/components/plan/PlanGate'
import {
  RelationshipTimeline,
  type TimelineMilestone,
  type TimelineSpan,
} from '@/components/contacts/RelationshipTimeline'
import { SortableList, SortableItem } from '@/components/ui/sortable'
import { RenewConfirmDialog } from '@/components/affiliations/RenewUI'
import { AffiliationTypeMark } from '@/components/affiliations/AffiliationTypePicker'
import { ContactUpdateLinkDialog } from '@/components/contacts/ContactUpdateLinkDialog'
import { renewAffiliationCall, previewRenewedUntil } from '@/components/affiliations/renew'
import { ContactGroupsChips } from '@/plugins/contact-groups/ContactGroupsChips'
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

// ─── helpers ──────────────────────────────────────────────────────────────────



function formatDate(ts: { toDate(): Date } | null | undefined, opts?: Intl.DateTimeFormatOptions) {
  if (!ts) return '—'
  return ts
    .toDate()
    .toLocaleDateString([], opts ?? { day: '2-digit', month: 'short', year: 'numeric' })
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
const ENGAGEMENT_BAR: Record<EngagementBand, string> = {
  active: 'bg-emerald-500',
  low: 'bg-amber-500',
  at_risk: 'bg-red-500',
  inactive: 'bg-muted-foreground/40',
}
const ENGAGEMENT_TEXT: Record<EngagementBand, string> = {
  active: 'text-emerald-600 dark:text-emerald-400',
  low: 'text-amber-600 dark:text-amber-500',
  at_risk: 'text-red-600 dark:text-red-400',
  inactive: 'text-muted-foreground',
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

function EngagementIndicator({
  contact,
  thresholds,
}: {
  contact: Contact
  thresholds?: EngagementThresholds
}) {
  const t = useTranslations('Contacts')
  const lastMs = tsToDate(contact.last_session_at)?.getTime() ?? null
  const refMs = lastMs ?? tsToDate(contact.created_at)?.getTime() ?? null
  const band = computeEngagementBand(refMs, thresholds)
  const daysAgo = lastMs != null ? Math.floor((Date.now() - lastMs) / 86_400_000) : null
  const tip = `${t('engagementLabel')} · ${
    daysAgo == null ? t('engagementNoSessions') : t('engagementLastSession', { days: daysAgo })
  }`
  const fill: Record<EngagementBand, string> = { active: '100%', low: '75%', at_risk: '50%', inactive: '25%' }
  return (
    <div
      title={tip}
      className="flex flex-col items-center justify-end gap-1.5 px-3 py-3 shrink-0 cursor-default"
    >
      <div className="relative w-2 flex-1 min-h-[40px] rounded-full bg-muted overflow-hidden">
        <div
          className={`absolute bottom-0 left-0 right-0 rounded-full transition-all ${ENGAGEMENT_BAR[band]}`}
          style={{ height: fill[band] }}
        />
      </div>
      <span className={`hidden sm:block text-[10px] font-medium whitespace-nowrap ${ENGAGEMENT_TEXT[band]}`}>
        {t(`engagement_${band}` as Parameters<typeof t>[0])}
      </span>
    </div>
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
  children,
  error,
  className,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
  error?: string
  className?: string
}) {
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <label className="text-sm font-medium">
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
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
                  className={`text-[13px] font-medium leading-5 ${reached ? 'text-foreground' : 'text-muted-foreground'}`}
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
              className={`mt-1.5 text-center text-[11px] font-medium leading-tight ${reached ? 'text-foreground' : 'text-muted-foreground'}`}
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
function HeaderActionButton({
  icon: Icon,
  label,
  count = 0,
  onClick,
}: {
  icon: React.ElementType
  label: string
  count?: number
  onClick: () => void
}) {
  // The count badge is a NUMBER, not a label: it says how many notes there are,
  // never what pressing this does. Icon-only in the sense that matters.
  return (
    <Tip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <Icon className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
            {count}
          </span>
        )}
      </button>
    </Tip>
  )
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

/**
 * Read-only preview of this contact's alerts, under the notes in the profile
 * column. Tapping anything opens the alerts sheet — same contract as
 * `NotesGlance`, deliberately, so the two halves of the column behave alike.
 */
function AlertsGlance({
  contact,
  onOpen,
}: {
  contact: Contact
  onOpen: () => void
}) {
  const t = useTranslations('Contacts')
  const { data: alerts = [], isLoading } = useContactAlerts(contact.id)
  const GLANCE_LIMIT = 4
  const shown = alerts.slice(0, GLANCE_LIMIT)
  const extra = alerts.length - shown.length

  const fired = (alert: ContactAlert) =>
    alertIsFired(alert, { totalSessions: contact.total_sessions })

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('tabAlerts')}
          </h3>
          {alerts.length > 0 && (
            <span className="text-xs text-muted-foreground">({alerts.length})</span>
          )}
        </div>
        <Tip label={t('addAlert')}>
          <button
            type="button"
            onClick={onOpen}
            aria-label={t('addAlert')}
            className="flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
   >
            <Plus className="h-4 w-4" />
          </button>
        </Tip>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
          {t('addAlert')}
        </button>
      ) : (
        <div className="space-y-2">
          {shown.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={onOpen}
              className={`block w-full rounded-lg border p-2.5 text-left transition-colors hover:border-border ${
                fired(a) ? 'border-orange-300 bg-orange-50 dark:bg-orange-950/20' : ''
              }`}
            >
              <p className="truncate text-sm">{a.message}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {fired(a) ? t('alertFired') : t('alertPending')}
              </p>
            </button>
          ))}
          {extra > 0 && (
            <button
              type="button"
              onClick={onOpen}
              className="w-full rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            >
              {t('alertsViewAll', { count: alerts.length })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// Read-only preview of the most recent notes, shown in the profile tab's empty
// right column on large screens. Each card is truncated with a fade into the
// card background; tapping anything opens the shared notes sheet to read/edit.
function NotesGlance({ contact, onOpen }: { contact: Contact; onOpen: () => void }) {
  const t = useTranslations('Contacts')
  const { data: notes = [], isLoading } = useContactNotes(contact.id)
  const GLANCE_LIMIT = 4
  const shown = notes.slice(0, GLANCE_LIMIT)
  const extra = notes.length - shown.length

  const fmt = (n: ContactNote) =>
    n.updated_at?.toDate().toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) ?? ''

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StickyNote className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('tabNotes')}
          </h3>
          {notes.length > 0 && (
            <span className="text-xs text-muted-foreground">({notes.length})</span>
          )}
        </div>
        <Tip label={t('notesAddNote')}>
          <button
            type="button"
            onClick={onOpen}
            aria-label={t('notesAddNote')}
            className="flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
   >
            <Plus className="h-4 w-4" />
          </button>
        </Tip>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : notes.length === 0 ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground hover:border-border hover:text-foreground transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t('notesAddNote')}
        </button>
      ) : (
        <div className="space-y-2">
          {shown.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={onOpen}
              className={`group relative block w-full overflow-hidden rounded-lg border p-3 text-left transition-colors hover:border-border ${noteColorClasses(n.color).card}`}
            >
              <div className="mb-1 text-[11px] text-muted-foreground">{fmt(n)}</div>
              <div
                className="prose-notes max-h-24 overflow-hidden text-sm"
                dangerouslySetInnerHTML={{ __html: n.content }}
              />
              {/* Fade the truncated content into the card background. Only on
                  an UNCOLOURED card: the gradient is a `from-card` fade, so over
                  a colour tag it would fade to the wrong colour — and a fade
                  that ends in the wrong colour reads as a rendering bug. */}
              {!n.color && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
              )}
            </button>
          ))}
          {extra > 0 && (
            <button
              type="button"
              onClick={onOpen}
              className="w-full rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground hover:border-border hover:text-foreground transition-colors"
            >
              {t('notesViewAll', { count: notes.length })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── profile tab ──────────────────────────────────────────────────────────────

/** Lets the floating Save submit this form from inside its FloatingSlot portal. */
const PROFILE_FORM_ID = 'contact-profile-form'

function ProfileTab({
  contact,
  teamId,
  orgId,
  onSaved,
  onOpenNotes,
  onOpenAlerts,
}: {
  contact: Contact
  teamId: string | null
  orgId?: string | null
  onSaved: () => void
  onOpenNotes: () => void
  onOpenAlerts: () => void
}) {
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const { team } = useAuth()
  const { isInstalled } = useInstalledPlugins()
  const { data: rankingSystems = [] } = useTeamRankingSystems(teamId, orgId)

  const GENDERS: ContactGender[] = ['M', 'F', 'other']

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting, isDirty },
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
      weight: contact.weight,
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
    onSaved()
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
    <form id={PROFILE_FORM_ID} onSubmit={handleSubmit(onSubmit)} className="space-y-4 pb-24 lg:w-8/12 lg:shrink-0">
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
        </FormBlock>

        {/* Passwordless-login allow-list — extra emails that may sign in as this contact */}
        <FormBlock title={t('sectionLoginEmails')}>
          <p className="-mt-1 mb-1 text-xs text-muted-foreground">{t('loginEmailsDesc')}</p>
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
            {ecFields.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-1">
                {t('emergencyContactNone')}
              </p>
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
                                  key={level.id ?? level.value}
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
                            value={currentValue !== undefined ? String(rankLevelKey(findRankLevel(system.levels, currentValue) ?? { value: currentValue as number, label: '' })) : ''}
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
                                <SelectItem key={level.value} value={String(level.value)} textValue={level.label}>
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
          {/* Two columns on desktop: inputs left, vertical stage timeline right, with
              a light divider between. Stacks on mobile — inputs first, timeline below. */}
          <div className="grid gap-x-6 gap-y-5 md:grid-cols-[minmax(0,1fr)_1px_minmax(190px,240px)]">
            {/* Left — entry / source / source detail, stacked */}
            <div className="space-y-4">
              {/* Entry — editable correction, does NOT move stage */}
              <Field label={t('fieldAcquisitionEntry')}>
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
                <p className="text-xs text-muted-foreground">{t('fieldAcquisitionEntryHelp')}</p>
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

        {/* Custom Fields plugin — always the last card; upsell prompt when not installed */}
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
      </div>

      {/* Floating save — the page's primary action, so it owns the 'page-primary'
          lane and nothing the shell mounts can be painted over it. Portalled out
          of this <form>, hence `form={PROFILE_FORM_ID}` rather than a bare
          type="submit". */}
      {isDirty && (
        <FloatingSlot lane="page-primary">
          <button
            type="submit"
            form={PROFILE_FORM_ID}
            disabled={isSubmitting}
            className="flex items-center gap-2 px-5 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold shadow-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {isSubmitting ? tCommon('loading') : t('saveChanges')}
          </button>
        </FloatingSlot>
      )}
    </form>

    {/* Notes and alerts — the two things a coach writes down about a person,
        side by side in what used to be an empty column. On smaller screens both
        live in the header sheets (this column is hidden).

        A DIVIDER, NOT A SUB-TAB. A tab inside a narrow sticky column hides one
        of the only two things the column exists to show. */}
    <aside className="hidden lg:sticky lg:top-4 lg:block lg:flex-1 lg:min-w-0">
      <div className="space-y-5">
        <NotesGlance contact={contact} onOpen={onOpenNotes} />
        <div className="h-px bg-border" />
        <AlertsGlance contact={contact} onOpen={onOpenAlerts} />
      </div>
    </aside>
    </div>
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

  const counts: Record<ContactBookingStatusFilter, number> = {
    all: searchFiltered.length,
    pending: searchFiltered.filter((b) => (b.status ?? 'pending') === 'pending').length,
    confirmed: searchFiltered.filter((b) => b.status === 'confirmed').length,
    cancelled: searchFiltered.filter((b) => b.status === 'cancelled').length,
    no_show: searchFiltered.filter((b) => b.status === 'no_show').length,
    rebooked: searchFiltered.filter((b) => b.status === 'rebooked').length,
  }

  const filtered = useMemo(
    () =>
      statusFilter === 'all'
        ? searchFiltered
        : searchFiltered.filter((b) => (b.status ?? 'pending') === statusFilter),
    [searchFiltered, statusFilter]
  )

  const TABS: { key: ContactBookingStatusFilter; label: string }[] = [
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

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          placeholder={t('bookingsSearchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="flex gap-1 border-b overflow-x-auto">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              statusFilter === key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
            {counts[key] > 0 && (
              <span
                className={`text-xs rounded-full px-1.5 py-0.5 leading-none ${
                  statusFilter === key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {counts[key]}
              </span>
            )}
          </button>
        ))}
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
  const SEGMENTS = [
    { id: 'overview', label: t('segOverview') },
    { id: 'plans', label: t('segPlans') },
    { id: 'payments', label: t('segPayments') },
  ] as const

  // Relationship timeline data — subscription + affiliation periods as spans, and
  // the acquisition milestones as points. Concurrent spans are packed by the ribbon.
  const { data: subHistory = [] } = useSubscriptionHistory(contact.id)
  const { data: affiliations = [] } = useContactAffiliations(contact.id)

  const subscriptionSpans: TimelineSpan[] = subHistory.flatMap((h) => {
    const start = tsToDate(h.start_date)
    if (!start) return []
    return [{ id: h.id, label: h.subscription_type_name ?? '—', start, end: tsToDate(h.end_date) ?? null }]
  })
  const affiliationSpans: TimelineSpan[] = affiliations.flatMap((a) => {
    const start = tsToDate(a.valid_from)
    if (!start) return []
    return [{ id: a.id, label: a.label ?? a.type_key ?? '—', start, end: tsToDate(a.valid_until) ?? null }]
  })
  const milestones: TimelineMilestone[] = [
    { ts: contact.trial_booked_at, label: t('stage_trial_booked'), tone: 'neutral' as const },
    { ts: contact.trial_attended_at, label: t('stage_trial_attended'), tone: 'neutral' as const },
    { ts: contact.converted_at, label: t('stage_joined'), tone: 'positive' as const },
    { ts: contact.external_since, label: t('externalBadge'), tone: 'neutral' as const },
    { ts: contact.archived_at, label: t('archivedBadge'), tone: 'negative' as const },
  ].flatMap(({ ts, label, tone }) => {
    const date = tsToDate(ts)
    return date ? [{ id: label, label, date, tone }] : []
  })

  return (
    <div className="space-y-4">
      {/* Relationship overview — read-only lifeline of acquisition + subs + affiliations */}
      <RelationshipTimeline
        milestones={milestones}
        subscriptions={subscriptionSpans}
        affiliations={affiliationSpans}
      />

      <Segmented
        options={SEGMENTS.map((s) => ({ value: s.id, label: s.label }))}
        value={seg}
        onChange={onSegChange}
      />

      {/* Each segment body mounts only while it is showing, the same way the tabs
          themselves do — so standing on Overview never pays for the payment
          dialogs' journal read, and standing on Plans never loads payments. */}
      {seg === 'overview' && <LedgerSegment contact={contact} teamId={teamId} />}
      {seg === 'plans' && (
        <PlanGate feature="subscriptions">
          <SubscriptionsTab contact={contact} teamId={teamId} />
        </PlanGate>
      )}
      {seg === 'payments' && <PaymentsTab contact={contact} teamId={teamId} />}
    </div>
  )
}

// ─── subscriptions tab ────────────────────────────────────────────────────────

function SubscriptionsTab({ contact, teamId }: { contact: Contact; teamId: string | null }) {
  // Styled confirmation — this delete had none at all before.
  const { confirm, confirmDialog } = useConfirm()
  const tCommon = useTranslations('Common')
  const t = useTranslations('Contacts')
  const tPayments = useTranslations('PaymentsDashboard')
  const qc = useQueryClient()
  const { data: history = [], isLoading } = useSubscriptionHistory(contact.id)
  const { data: subTypes = [] } = useSubscriptionTypes(teamId)
  const [assignOpen, setAssignOpen] = useState(false)
  const [grantOpen, setGrantOpen] = useState(false)
  const { team } = useAuth()
  const currency = (team?.default_currency ?? 'CHF').toUpperCase()
  // The one-word summary of what Stripe is doing, denormalised onto the contact
  // by the rollup trigger. It came with the billing section from the Payments
  // tab — the copy that used to live there was the only one that showed it.
  const rollupStatus = contact.subscription_status as SubscriptionRollupStatus | undefined

  const invalidateContact = () => {
    qc.invalidateQueries({ queryKey: ['contact', contact.id] })
    qc.invalidateQueries({ queryKey: ['contacts'] })
  }
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
    <div className="space-y-6 pb-16">
      {/* ── Current type assignment ── */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              {t('subscriptionHeadingCard')}
              <TooltipProvider delay={200}>
                <UITooltip>
                  <TooltipTrigger className="inline-flex text-muted-foreground/50 cursor-help">
                    <Info className="h-3 w-3 shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-56">
                    {t('tooltipSubscription')}
                  </TooltipContent>
                </UITooltip>
              </TooltipProvider>
            </p>
            {contact.subscription_type_name ? (
              <div className="mt-1 space-y-0.5">
                <p className="text-sm font-medium">{contact.subscription_type_name}</p>
                {contact.subscription_recurrence && (
                  <p className="text-xs text-muted-foreground">
                    {t(`recurrence_${contact.subscription_recurrence}`)}
                    {contact.subscription_amount != null && (
                      <span> · {formatCurrency(contact.subscription_amount, currency)}</span>
                    )}
                  </p>
                )}
                {/* WHEN A ONE-OFF GRANT RUNS OUT ("2 months included"). It ends
                    by comparison and nothing writes when it passes, so this
                    line is the only place the studio can see it coming — and
                    once it has passed, the only explanation of why a member
                    the screen still lists is being turned away at the door. */}
                {contact.subscription_expires_at && (
                  <p
                    className={`text-xs ${
                      planGrantIsCurrent(contact) ? 'text-muted-foreground' : 'text-amber-600'
                    }`}
                  >
                    {t(
                      planGrantIsCurrent(contact)
                        ? 'subscriptionExpiresOn'
                        : 'subscriptionExpired',
                      {
                        date: contact.subscription_expires_at
                          .toDate()
                          .toLocaleDateString(undefined, {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          }),
                      }
                    )}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground mt-1">{t('noSubscriptions')}</p>
            )}
          </div>
          <button
            onClick={() => setAssignOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm hover:bg-muted transition-colors shrink-0"
          >
            <Pencil className="h-4 w-4" />
            {t('addSubscription')}
          </button>
        </div>
      </div>

      {/* ── Lesson credits (packs) ── */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Ticket className="h-3.5 w-3.5" />
            {t('creditsHeadingCard')}
          </p>
          <button
            onClick={() => setGrantOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm hover:bg-muted transition-colors shrink-0"
          >
            <Plus className="h-4 w-4" />
            {t('grantCredits')}
          </button>
        </div>
        {(contact.credit_summary?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noCredits')}</p>
        ) : (
          <ul className="space-y-1.5">
            {contact.credit_summary!.map((entry) => (
              <li key={entry.subscription_type_id} className="text-sm flex items-center gap-1.5">
                <span className="font-medium">
                  {entry.subscription_type_name ?? t('subscriptionHeadingCard')}
                </span>
                <span className="text-muted-foreground">
                  ·{' '}
                  {t('creditsRemaining', { count: entry.remaining })}
                  {entry.next_expires_at && (
                    <> · {t('creditsExpiresOn', { date: formatDate(entry.next_expires_at) })}</>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Stripe billing (freeze / resume / cancel) ──
          The ONLY copy of this section. It was rendered here and on the Payments
          tab at the same time; the badge below came only from that other copy,
          so a plain deletion would have lost it. */}
      {teamId && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {tPayments('stripeSubscriptionsTitle')}
            </p>
            {rollupStatus && SUBSCRIPTION_ROLLUP_STATUSES.includes(rollupStatus) && (
              <RollupBadge status={rollupStatus} />
            )}
          </div>
          <MemberSubscriptionsSection
            teamId={teamId}
            contactId={contact.id}
            assignedTypeId={contact.subscription_type_id ?? null}
          />
        </div>
      )}

      {/* ── History ── */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('subscriptionHistoryTitle')}
        </p>
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
                      {formatDate(entry.start_date)} –{' '}
                      {entry.end_date ? formatDate(entry.end_date) : t('subscriptionEndNone')}
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
      </div>

      <SetSubscriptionDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        contact={contact}
        teamId={teamId}
        subTypes={subTypes}
        currency={currency}
        onSaved={() => { invalidateContact(); invalidateHistory() }}
      />

      <GrantCreditsDialog
        open={grantOpen}
        onOpenChange={setGrantOpen}
        contact={contact}
        subTypes={subTypes}
        onGranted={invalidateContact}
      />
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
      const fn = httpsCallable<
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
      >(functions, 'grantCredits')
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
      <DialogContent className="max-w-sm">
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

// ─── set subscription dialog (price-aware, writes flat contact fields) ────────

function SetSubscriptionDialog({
  open,
  onOpenChange,
  contact,
  teamId,
  subTypes,
  currency,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  contact: Contact
  teamId: string | null
  subTypes: SubscriptionType[]
  currency: string
  onSaved: () => void
}) {
  const t = useTranslations('Contacts')
  const qc = useQueryClient()
  const [typeId, setTypeId] = useState(contact.subscription_type_id ?? '')
  const [priceId, setPriceId] = useState(contact.subscription_price_id ?? '')
  const [recurrence, setRecurrence] = useState(contact.subscription_recurrence ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // true = cancel any live Stripe subscription as part of this reassignment;
  // false = leave it running.
  //
  // DEFAULTS TO STOPPING (2026-08-23). "Non-destructive" was the wrong frame:
  // leaving the old billing running while a new plan is assigned charges the
  // member TWICE, and the studio finds out from the member. The genuinely
  // destructive outcome here is the one that keeps taking money for something
  // that has been replaced — so the safe default is the one that stops it, and
  // "keep it running" is the deliberate choice (a member moving to a second,
  // additional membership).
  const [stopCurrent, setStopCurrent] = useState(true)

  // Live Stripe subscriptions (billing) — distinct from the manual single field. Only
  // these can be "stopped" (the manual field is replaced by the assignment regardless).
  const { data: memberSubs = [] } = useContactMemberSubscriptions(teamId, contact.id)
  const liveStripeSubs = memberSubs.filter(
    (s) =>
      !!s.subscriptionId &&
      !s.duplicate &&
      ['active', 'trialing', 'past_due', 'paused'].includes(s.status as string)
  )
  const hasActive = liveStripeSubs.length > 0 || !!contact.subscription_type_id

  const RECURRENCES = ['per_class', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annual']

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
      // Stop current billing first (if chosen) so a failure aborts before we reassign.
      if (stopCurrent && liveStripeSubs.length > 0 && teamId) {
        const cancelFn = httpsCallable<
          { teamId: string; subscriptionId: string },
          { ok: boolean }
        >(functions, 'cancelMemberSubscription')
        for (const s of liveStripeSubs) {
          await cancelFn({ teamId, subscriptionId: s.subscriptionId })
        }
        qc.invalidateQueries({ queryKey: ['contact-member-subscriptions', teamId, contact.id] })
      }

      const typeName = subTypes.find((s) => s.id === typeId)?.name ?? ''
      const chosenPrice = activePrices.find((p) => p.id === priceId)
      // The grant's own end date, from the chosen price ("2 months included").
      // WRITTEN WHOLE, null included — assigning a monthly plan to someone whose
      // intro lapsed must ERASE that old date, or the plan she was just given is
      // already expired and no screen would explain why.
      const grantExpiryMs = planGrantExpiryMs(chosenPrice)
      await updateDoc(doc(db, CONTACTS_COLLECTION, contact.id), {
        subscription_type_id: typeId,
        subscription_type_name: typeName,
        subscription_price_id: chosenPrice ? chosenPrice.id : null,
        subscription_recurrence: chosenPrice ? chosenPrice.recurrence : recurrence || null,
        subscription_amount: chosenPrice ? chosenPrice.amount : null,
        subscription_expires_at: grantExpiryMs === null ? null : Timestamp.fromMillis(grantExpiryMs),
        subscription_type_updated_at: serverTimestamp(),
        // Assigning a subscription materializes a provisional lead (offline-paid
        // members count toward the cap too). See Contact.provisional.
        provisional: deleteField(),
        provisional_expires_at: deleteField(),
      })
      onSaved()
      onOpenChange(false)
    } catch (err) {
      console.error('[contact] set subscription failed:', err)
      setError(t('cancelError'))
    } finally {
      setSaving(false)
    }
  }

  /**
   * Remove the plan from the contact — and, unless told otherwise, stop the
   * billing behind it.
   *
   * THIS IS THE DIVERGENCE THE CANARY FOUND. Clearing used to null the
   * contact's subscription fields and never touch Stripe, so a studio that
   * froze a membership and then cleared the plan was left with a live (frozen)
   * Stripe subscription, nothing on screen admitting it existed, and an
   * apparent way back that RESUMED the billing. The two systems could diverge
   * in one click and there was no way to reconcile them.
   *
   * The Stripe call goes FIRST, exactly as in `save()`: a failure there aborts
   * before the contact is touched, so the two never end up half-applied in the
   * direction that keeps charging.
   */
  const handleClear = async () => {
    setSaving(true)
    setError(null)
    try {
      if (stopCurrent && liveStripeSubs.length > 0 && teamId) {
        const cancelFn = httpsCallable<
          { teamId: string; subscriptionId: string },
          { ok: boolean }
        >(functions, 'cancelMemberSubscription')
        for (const sub of liveStripeSubs) {
          await cancelFn({ teamId, subscriptionId: sub.subscriptionId })
        }
        qc.invalidateQueries({ queryKey: ['contact-member-subscriptions', teamId, contact.id] })
      }
      await updateDoc(doc(db, CONTACTS_COLLECTION, contact.id), {
        subscription_type_id: null,
        subscription_type_name: null,
        subscription_price_id: null,
        subscription_recurrence: null,
        subscription_amount: null,
        // Goes with the grant it described — see the assign branch above.
        subscription_expires_at: null,
        subscription_type_updated_at: serverTimestamp(),
      })
      onSaved()
      onOpenChange(false)
    } catch (err) {
      console.error('[contact] clear subscription failed:', err)
      setError(t('cancelError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('addSubscription')}</DialogTitle>
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

          {/* Active-subscription awareness: a contact may hold several different plans,
              never two of the same. We surface what's already active (the manual plan +
              any live Stripe billing) and — when there's live billing to act on — let the
              manager keep it running or stop it as part of this reassignment. */}
          {hasActive && (
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t('currentlyActiveTitle')}
              </p>
              <ul className="space-y-1">
                {contact.subscription_type_name && (
                  <li className="flex items-center gap-2 text-sm">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
                    <span className="truncate">{contact.subscription_type_name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {t('currentManualTag')}
                    </span>
                  </li>
                )}
                {liveStripeSubs.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 text-sm">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" />
                    <span className="truncate">
                      {s.subscriptionTypeName || formatCurrency((s.amount ?? 0) / 100, currency)}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {t('currentBillingTag')}
                    </span>
                  </li>
                ))}
              </ul>
              {/* THE ORDER IS THE RECOMMENDATION. Stopping is first and
                  selected: it governs BOTH buttons below — Save and Clear — so
                  whichever way this dialog is left, the live billing does not
                  quietly outlive the plan it was selling. */}
              {liveStripeSubs.length > 0 && (
                <div className="pt-1 space-y-1.5">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="stopCurrent"
                      checked={stopCurrent}
                      onChange={() => setStopCurrent(true)}
                      className="mt-0.5 accent-primary"
                    />
                    <span className="text-sm">{t('stopCurrentOption')}</span>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="stopCurrent"
                      checked={!stopCurrent}
                      onChange={() => setStopCurrent(false)}
                      className="mt-0.5 accent-primary"
                    />
                    <span className="text-sm">{t('keepCurrentOption')}</span>
                  </label>
                </div>
              )}
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter className="flex items-center justify-between">
          {contact.subscription_type_id && (
            <button
              onClick={handleClear}
              disabled={saving}
              className="text-xs text-destructive hover:underline disabled:opacity-50"
            >
              {t('clearSubscription')}
            </button>
          )}
          <div className="flex gap-2 ml-auto">
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
              {t('saveChanges')}
            </button>
          </div>
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

function formatActivityTimestamp(ts: { toDate(): Date } | null | undefined): string {
  if (!ts) return '—'
  const d = ts.toDate()
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffHrs = diffMs / 3_600_000

  if (diffHrs < 1) {
    const mins = Math.max(1, Math.round(diffMs / 60_000))
    return `${mins}m ago`
  }
  if (diffHrs < 24) return `${Math.round(diffHrs)}h ago`
  if (diffHrs < 48)
    return `Yesterday at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
}

function dateDayLabel(
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
  return d.toLocaleDateString([], {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
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
    return ts.toDate().toLocaleString([], {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  })()

  const formatValue = (v: unknown): string => {
    if (v === null || v === undefined) return '—'
    if (typeof v === 'object') {
      if ('toDate' in (v as object)) return (v as { toDate(): Date }).toDate().toLocaleString()
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
      <DialogContent className="max-w-md">
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

function ActivityTab({ contact, teamId }: { contact: Contact; teamId: string | null }) {
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const [period, setPeriod] = useState<ActivityPeriodKey>('30d')
  const [category, setCategory] = useState<ActivityCategory>('all')
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
    const label = dateDayLabel(entry.created_at as { toDate(): Date } | null | undefined, tCommon)
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
                              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                                {formatActivityTimestamp(
                                  entry.created_at as { toDate(): Date } | null | undefined
                                )}
                              </span>
                              <button
                                type="button"
                                onClick={() => setSelectedEntry(entry)}
                                className="text-[10px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2 transition-colors"
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
      <DialogContent className="max-w-sm">
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
        <DialogContent className="max-w-sm">
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
        <DialogContent className="max-w-sm">
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
      <DialogContent className="max-w-sm">
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
                        {(alert.schedule_value as { toDate(): Date } | null)
                          ?.toDate()
                          .toLocaleDateString([], {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric',
                          }) ?? '—'}
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

// ─── follow-ups tab (alerts + outreach) ─────────────────────────────────────────
// Groups the two "staying in touch" surfaces: the alerts manager (scheduled
// reminders about the contact) and outreach (email history + send). Replaces the
// former alerts side-panel bell.

function fmtEntryDate(v: unknown): string {
  const d = v && typeof v === 'object' && 'toDate' in (v as object)
    ? (v as { toDate(): Date }).toDate()
    : null
  return d ? d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : ''
}

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
      const fn = httpsCallable(functions, 'sendOutreachEmail')
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

function FollowUpsTab({ contact, teamId }: { contact: Contact; teamId: string | null }) {
  const t = useTranslations('Contacts')
  const { can } = useCapabilities()
  const [composeOpen, setComposeOpen] = useState(false)
  const { data: activity = [] } = useContactActivityLog(contact.id, teamId)
  const outreach = activity.filter((e) => e.event === 'outreach_email_sent')
  const canSend = can('contacts.manage')

  // ONE SECTION NOW. The alerts half moved to the profile column and its own
  // sheet, beside the notes it is a sibling of; what is left here is email and
  // nothing else, which is why the tab is labelled "Emails" and why the
  // two-column grid — which existed only to hold two sections — is gone. The
  // section heading went with it: it repeated the tab's own name.
  return (
    <div className="pb-24">
      <section className="space-y-3">
        <div className="flex items-center justify-end">
          {canSend && (
            <Button size="sm" onClick={() => setComposeOpen(true)} disabled={!contact.email}>
              <Mail className="mr-1.5 h-4 w-4" /> {t('outreachSend')}
            </Button>
          )}
        </div>
        {canSend && !contact.email && (
          <p className="text-xs text-muted-foreground">{t('outreachNoEmail')}</p>
        )}
        {outreach.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('outreachEmpty')}</p>
        ) : (
          <div className="space-y-2">
            {outreach.map((e) => {
              const p = (e.parameters ?? {}) as { subject?: string; template_name?: string }
              return (
                <div key={e.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {p.subject || p.template_name || t('outreachEmail')}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {fmtEntryDate((e as { created_at?: unknown; date?: unknown }).created_at ?? (e as { date?: unknown }).date)}
                    </span>
                  </div>
                  {p.template_name && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{p.template_name}</p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <SendOutreachDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        contact={contact}
        teamId={teamId}
      />
    </div>
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
        <DetailRow label={t('fieldBirthdate')} value={formatDate(contact.birthdate)} />
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
          <DetailRow label={t('memberSince')} value={formatDate(contact.created_at)} />
        )}
        {contact.external_since && (
          <DetailRow label={t('externalSince')} value={formatDate(contact.external_since)} />
        )}
        {contact.archived_at && (
          <DetailRow label={t('archivedSince')} value={formatDate(contact.archived_at)} />
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
        <DialogContent className="max-w-sm">
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

function ContactHeaderStats({ contact }: { contact: Contact }) {
  const t = useTranslations('Contacts')
  const { data: weeklyReports = [], isLoading } = useContactWeeklyReports(contact.id)

  const chartData = weeklyReports.map((r) => ({
    label: isoWeekLabel(r.iso_week),
    sessions: r.sessions_count,
  }))

  const tooltipStyle = {
    fontSize: 11,
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid hsl(var(--border))',
    backgroundColor: 'hsl(var(--card) / 0.85)',
    backdropFilter: 'blur(4px)',
    color: 'hsl(var(--card-foreground))',
  }

  return (
    <div className="flex-1 min-w-0">
      {/* 3 key stats */}
      <div className="grid grid-cols-3 divide-x">
        <div className="text-center px-4 py-3">
          <p className="text-2xl font-bold tabular-nums">{contact.total_sessions ?? 0}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
            {t('statTotalSessions')}
          </p>
        </div>
        <div className="text-center px-4 py-3">
          <p className="text-2xl font-bold tabular-nums">
            {contact.current_streak ?? 0}
            <span className="text-sm font-normal">w</span>
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
            {t('statStreak')}
          </p>
        </div>
        <div className="text-center px-4 py-3">
          <p className="text-2xl font-bold tabular-nums">{contact.current_month_score ?? 0}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
            {t('statMonthScore')}
          </p>
        </div>
      </div>

      {/* Attendance sparkline — bleeds to card edges, no padding */}
      <div className="h-[52px]">
        {isLoading ? (
          <div className="h-full bg-muted/40 animate-pulse" />
        ) : chartData.length === 0 ? (
          <div className="h-full bg-muted/20" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="hdrSparkGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" hide />
              <Tooltip
                contentStyle={tooltipStyle}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  return (
                    <div style={{ ...tooltipStyle, textAlign: 'center', lineHeight: 1.4 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#6366f1' }}>
                        {payload[0].value}
                      </div>
                      <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
                        {label}
                      </div>
                    </div>
                  )
                }}
              />
              <Area
                type="monotone"
                dataKey="sessions"
                stroke="#6366f1"
                strokeWidth={1.5}
                fill="url(#hdrSparkGrad)"
                dot={false}
                activeDot={{ r: 3, fill: '#6366f1' }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

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

/**
 * THE AFFILIATION, IN THE HEADER — the type's mark, its label, its status.
 *
 * Franco, with the type mini-cards: "we could enhance the affiliation definition
 * with a logo, shown on the mini card and eventually as a badge+status somewhere
 * in the contact detail". This is that badge, and it draws the SAME
 * `AffiliationTypeMark` the picker draws, so a type that gains a logo gains it
 * in both places at once and neither can drift.
 *
 * ── ONE CHIP PER TYPE, THE CURRENT ONE ──
 *
 * A contact accumulates a row per season, so the raw list is a HISTORY, not a
 * state. The header wants the state: the most recent row per type. The query is
 * already ordered `created_at desc`, so the first row seen for a type is that
 * one — no sort here, and no second definition of "current" for a later reader
 * to disagree with. The whole history stays one click away in the tab.
 *
 * ── WHY IT SHOWS AN EXPIRED ONE TOO ──
 *
 * Filtering to `active` rows would hide exactly the fact an org manager opens
 * the record for. "HMD Affiliation · Expired" in red IS the answer; an absent
 * chip reads as "never affiliated", which is a different and wrong thing. The
 * status def's own colour carries the difference.
 *
 * It renders nothing when the contact holds no affiliation, which is the only
 * gate it needs — a studio that does not use the axis never sees it.
 */
function ContactAffiliationBadges({
  contact,
  teamId,
  orgId,
}: {
  contact: Contact
  teamId: string | null
  orgId?: string | null
}) {
  const t = useTranslations('Contacts')
  const { data: affiliations = [] } = useContactAffiliations(contact.id)
  const { data: types = [] } = useAffiliationTypes(teamId, orgId)
  // The BUILT-IN set as the default, exactly as the tab below does it: the query
  // is `enabled: !!orgId`, so for a studio with no organisation it never runs and
  // `[]` would print a raw `status_id` where a label belongs.
  const { data: statuses = DEFAULT_ORG_AFFILIATION_STATUSES } = useOrgAffiliationStatuses(orgId)

  const current = useMemo(() => {
    const seen = new Map<string, Affiliation>()
    for (const a of affiliations)
      if (!seen.has(a.affiliation_type_id)) seen.set(a.affiliation_type_id, a)
    return [...seen.values()]
  }, [affiliations])

  if (current.length === 0) return null

  return (
    <>
      {current.map((a) => {
        const type = types.find((x) => x.id === a.affiliation_type_id)
        const label = type?.label ?? a.label ?? a.type_key ?? a.affiliation_type_id
        const def = statuses.find((x) => x.id === a.status_id)
        const color = AFFIL_COLOR_CLASSES[def?.color ?? 'gray'] ?? AFFIL_COLOR_CLASSES.gray
        const until = formatDate(a.valid_until)
        return (
          <span
            key={a.id}
            title={until ? t('affiliationValidUntil', { date: until }) : undefined}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${color.bg} ${color.text} ${color.border}`}
          >
            <AffiliationTypeMark type={{ label, logo_url: type?.logo_url }} size={14} />
            <span className="max-w-[140px] truncate">{label}</span>
            <span className="opacity-70">{def?.label ?? a.status_id}</span>
          </span>
        )
      })}
    </>
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
      const fn = httpsCallable(functions, 'removeAffiliation')
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
      const until = new Date(res.valid_until).toLocaleDateString([], {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
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
      const fn = httpsCallable(functions, 'approveAffiliation')
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
                      {formatDate(aff.valid_from)} – {aff.valid_until ? formatDate(aff.valid_until) : t('ongoingLabel')}
                    </p>
                  )}
                  {aff.reference && (
                    <p className="text-xs text-muted-foreground">{t('colReference')}: {aff.reference}</p>
                  )}
                  {typeDef?.fee_amount != null && (
                    <p className="text-xs text-muted-foreground">
                      {t('feeLabel')}: {typeDef.fee_amount}
                      {aff.fee_paid && (
                        <span className="ml-1.5 inline-flex items-center rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900 dark:text-green-300">
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
        const newUntilStr = newUntil.toLocaleDateString([], {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
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
      const fn = httpsCallable(functions, 'upsertAffiliation')
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
      <DialogContent className="max-w-sm">
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
// argument `useTabParam` was written for, one level down.
const MEMBERSHIP_SEGMENTS = ['overview', 'plans', 'payments'] as const
type MembershipSeg = (typeof MEMBERSHIP_SEGMENTS)[number]

export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
  // User-reorderable tab strip (opt-in edit mode; order persisted per-browser).
  const [tabOrder, setTabOrder] = useContactTabOrder()
  const [editingTabs, setEditingTabs] = useState(false)
  // Which segment of "Plans & Payments" is showing. In the URL (`?seg=`) rather
  // than component state: the header chip below deep-links a segment, and that
  // choice used to die on refresh — a live instance of the bug useTabParam
  // exists to remove. `enabled` keeps `?seg=` off the URL of every other tab.
  const [membershipSeg, setMembershipSeg] = useTabParam(
    MEMBERSHIP_SEGMENTS,
    'overview',
    'seg',
    { enabled: tab === 'payments' }
  )
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const tLink = useTranslations('ContactLink')
  const { goBack, isHistoryBack } = useBack('/contacts' as Route)
  const qc = useQueryClient()
  const { hasFeature } = usePlan()
  const { openUpgradeModal } = useUpgradeModal()
  const { isInstalled } = useInstalledPlugins()

  const [linkCopied, setLinkCopied] = useState(false)
  const [emailCopied, setEmailCopied] = useState(false)
  // Notes editor sheet — opened from the header icon and the profile-column glance.
  const [notesOpen, setNotesOpen] = useState(false)
  const [updateLinkOpen, setUpdateLinkOpen] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(false)
  // Roster ↔ external (Contact.external). Marking external asks first — it
  // silences every reminder and invitation for this person; bringing them
  // back does not. `external` is present only when true, so the way back
  // DELETES the fields rather than writing false. Nothing else moves.
  const [confirmExternalOpen, setConfirmExternalOpen] = useState(false)
  const [externalBusy, setExternalBusy] = useState(false)
  const setExternal = async (next: boolean) => {
    setExternalBusy(true)
    try {
      await updateDoc(
        doc(db, CONTACTS_COLLECTION, id),
        next
          ? { external: true, external_since: serverTimestamp(), updatedAt: serverTimestamp() }
          : { external: deleteField(), external_since: deleteField(), updatedAt: serverTimestamp() }
      )
      invalidate()
      setConfirmExternalOpen(false)
    } finally {
      setExternalBusy(false)
    }
  }
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

  const handleCopyEmail = () => {
    if (!contact?.email) return
    navigator.clipboard.writeText(contact.email).then(() => {
      setEmailCopied(true)
      setTimeout(() => setEmailCopied(false), 2000)
    })
  }

  const handleCopyUpdateLink = () => {
    if (!team?.slug) return
    const url = `${window.location.origin}/public/${team.slug}/contact-update?contactId=${id}`
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
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
    // The ID STAYS `followups` — a `?tab=followups` deep link and every saved
    // `linyup_contact_tab_order` array in a browser somewhere still name it.
    // Only the label and the icon change, because with the alerts gone what is
    // left is email and nothing else.
    { id: 'followups', label: t('tabEmails'), icon: Mail },
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

      {/* Header card */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex flex-col lg:flex-row">
          {/* Identity — left */}
          <div className="p-5 flex-1 min-w-0">
            {/* Avatar + name share the top row; everything else flows full-width
                below so the avatar never shifts content sideways on mobile. */}
            <div className="flex items-center gap-4">
              <div className="h-16 w-16 rounded-full shrink-0 flex items-center justify-center bg-muted text-muted-foreground text-xl font-bold">
                {personInitials(contact)}
              </div>
              <div className="min-w-0">
                <h1 className="text-xl font-bold min-w-0 break-words">
                  {contact.firstname} {contact.lastname}
                </h1>
                {/* Sits with the name because it acts ON the person — "send this
                    contact a link to update their own details" — rather than
                    describing them like the status and contact lines below. */}
                {team?.slug && !contact.archived_at && !contact.deleted_at && (
                  <Tip label={t('sendLinkTip')}>
                    <button
                      onClick={handleCopyUpdateLink}
                      className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={t('copyUpdateLink')}
                    >
                      <Link2 className="h-3.5 w-3.5 shrink-0" />
                      {linkCopied ? t('updateLinkCopied') : t('copyUpdateLink')}
                    </button>
                  </Tip>
                )}
              </div>
            </div>
            <div className="flex-1 min-w-0 mt-3">
              <div className="flex flex-wrap items-center gap-2">
                {/* A member has asked to close their own account. It sits with
                    the lifecycle badges because that is what it is — but ABOVE
                    the stage chips, because it outranks anything about chasing
                    them. The studio can do nothing about it and should not try;
                    it is here so the roster stops being a surprise. */}
                {contactDeletionState(contact, Date.now()) === 'scheduled' && (
                  <Badge className="bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800">
                    {t('deletionScheduledBadge', {
                      date: formatDate(contact.deletion_scheduled_for) ?? '',
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
                    {/* LAST in the row on purpose. Every chip before it is
                        something the studio might have to ACT on; belonging is a
                        standing fact, so it reads as the answer to "and who are
                        they to us" rather than competing with the to-dos. */}
                    <ContactAffiliationBadges
                      contact={contact}
                      teamId={currentTeamId}
                      orgId={team?.org_id}
                    />
                  </>
                )}
              </div>
              <div className="flex flex-col gap-1 mt-2">
                {contact.email && (
                  <span className="group/email flex items-center gap-1.5 text-xs text-muted-foreground">
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
                      {t('externalSince')} {formatDate(contact.external_since)}
                    </span>
                  </span>
                )}
                {contact.created_at && (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CalendarDays className="h-3 w-3 shrink-0" />
                    <span>
                      {t('joinedOn')} {formatDate(contact.created_at)}
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
                    {/* Primary live subscription + "+N" when the contact holds several
                        types (the full list lives in the Membership tab). */}
                    {((contact.active_subscriptions?.length ?? 0) > 0 ||
                      contact.subscription_type_name) && (
                      <button
                        type="button"
                        onClick={() => {
                          setMembershipSeg('plans')
                          setTab('payments')
                        }}
                        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <BookOpen className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {t('subscriptionHeadingCard')}:{' '}
                          {(contact.active_subscriptions?.length ?? 0) > 0
                            ? `${contact.active_subscriptions![0].subscription_type_name ?? contact.subscription_type_name}${
                                contact.active_subscriptions!.length > 1
                                  ? ` +${contact.active_subscriptions!.length - 1}`
                                  : ''
                              }`
                            : contact.subscription_type_name}
                        </span>
                      </button>
                    )}
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
                <ContactGroupsChips contact={contact} onChanged={invalidate} />
              )}
            </div>
            {/* Header action cluster — alerts jump to the Follow-ups tab; notes
                open the editor sheet (also glanced in the profile column).
                Margin so the buttons don't crowd the detail lines above them. */}
            {!contact.archived_at && !contact.deleted_at && (
              <div className="mt-4 flex items-center gap-2 shrink-0">
                {/* Opens the alerts PANEL, not a tab. It used to jump to
                    Follow-ups, which is where alerts used to live. */}
                <HeaderActionButton
                  icon={Bell}
                  label={t('tabAlerts')}
                  count={contactAlerts.length}
                  onClick={() => setAlertsOpen(true)}
                />
                <HeaderActionButton
                  icon={StickyNote}
                  label={t('tabNotes')}
                  count={notesCount}
                  onClick={() => setNotesOpen(true)}
                />
                {/* Hand the person a QR and let them fill in their own details
                    — the only route in for a contact with no email on file,
                    since every other one authenticates by emailed code. */}
                <HeaderActionButton
                  icon={QrCode}
                  label={tLink('headerTip')}
                  onClick={() => setUpdateLinkOpen(true)}
                />
                {/* Roster ↔ external. One button whose meaning flips with the
                    state: on the roster it offers the door, off it the way
                    back. See Contact.external for what each side excludes. */}
                <HeaderActionButton
                  icon={contact.external === true ? UserCheck : DoorOpen}
                  label={contact.external === true ? t('headerMarkActive') : t('headerMarkExternal')}
                  onClick={() =>
                    contact.external === true ? void setExternal(false) : setConfirmExternalOpen(true)
                  }
                />
              </div>
            )}
          </div>
        </div>

        {/* Stats bar + sparkline — full-width, docked to bottom of header card */}
        <div className="flex border-t">
          <ContactHeaderStats contact={contact} />
          <EngagementIndicator contact={contact} thresholds={team?.engagement_thresholds} />
        </div>
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
              <div className="flex items-stretch gap-1 border-b">
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
                onOpenNotes={() => setNotesOpen(true)}
                onOpenAlerts={() => setAlertsOpen(true)}
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
            {tab === 'activity' && <ActivityTab contact={contact} teamId={currentTeamId} />}
            {tab === 'followups' && <FollowUpsTab contact={contact} teamId={currentTeamId} />}
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
            contactId={contact.id}
            contactName={`${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim()}
          />
          <ConfirmDialog open={confirmExternalOpen} onOpenChange={setConfirmExternalOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('markExternalTitle', { count: 1 })}</AlertDialogTitle>
                <AlertDialogDescription>{t('markExternalDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void setExternal(true)} disabled={externalBusy}>
                  {t('bulkMarkExternal')}
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
