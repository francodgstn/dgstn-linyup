'use client'

import { useState, useEffect, useCallback, useRef, use, type ReactNode } from 'react'
import type { Route } from 'next'
import { useRegisterTab } from '@/contexts/OpenTabsContext'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
  increment, serverTimestamp, deleteField, writeBatch, addDoc,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useActiveContacts } from '@/hooks/useActiveContacts'
import { Badge } from '@/components/ui/badge'
import { FloatingSlot } from '@/components/layout/FloatingDock'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { SearchInput, useListKeyboardNav } from '@/components/ui/search-input'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { Link, useRouter as useI18nRouter } from '@/i18n/navigation'
import {
  ArrowLeft, ChevronLeft, ChevronRight, Pencil, Copy, Trash2, UserPlus,
  MapPin, Clock, Users, QrCode, BookOpen, CheckCircle2, UserX,
  Share2, X, Check, Ban, AlertTriangle, ListOrdered, Send, Loader2, Gauge,
} from 'lucide-react'
import {
  SESSIONS_COLLECTION, ACTIVITIES_COLLECTION, CONTACTS_COLLECTION,
  PARTICIPANTS_SUBCOLLECTION, WAITLIST_SUBCOLLECTION, resolveActivityAccessRule,
  activityRequiresSubscription, contactHoldsCoveringSubscription,
  bookingHoldsSeat, confirmClearedHoldFields, seatsFree,
  bookingContactId, buildParticipantDoc,
  CONTACT_GOALS_SUBCOLLECTION, resolveCoachingDimensions, CONTACT_GOAL_EVALUATIONS_SUBCOLLECTION,
  personInitials,
} from '@linyup/shared'
import type { Session, Booking, Contact, Activity, WaitlistEntry, PerformanceIndicator } from '@linyup/shared'
import { WaiverChip, WaiverDoorCheckChip } from '@/components/WaiverChip'
import { useWaiverPolicy, useWaiverRoster } from '@/hooks/useWaiverStates'
import { SessionFormDialog } from '@/components/sessions/SessionFormDialog'
import { SessionDeleteDialog } from '@/components/sessions/SessionDeleteDialog'
import { toast } from 'sonner'
import { Tip } from '@/components/ui/tip'

// ─── constants ────────────────────────────────────────────────────────────────

const BOOKINGS_SUB = 'bookings'

// ─── activity color palette (matches SessionsCalendar) ────────────────────────

const PALETTE = [
  { bg: '#EDE9FE', text: '#5B21B6', accent: '#7C3AED' },
  { bg: '#FCE7F3', text: '#9D174D', accent: '#EC4899' },
  { bg: '#DBEAFE', text: '#1D4ED8', accent: '#3B82F6' },
  { bg: '#D1FAE5', text: '#065F46', accent: '#10B981' },
  { bg: '#FEF3C7', text: '#92400E', accent: '#F59E0B' },
  { bg: '#FFE4E6', text: '#9F1239', accent: '#F43F5E' },
  { bg: '#E0F2FE', text: '#075985', accent: '#0EA5E9' },
  { bg: '#F0FDF4', text: '#14532D', accent: '#22C55E' },
]
function activityPalette(activityId?: string | null, customColor?: string | null) {
  if (customColor) return { bg: `${customColor}18`, text: customColor, accent: customColor }
  if (!activityId) return PALETTE[0]
  let h = 0
  for (let i = 0; i < activityId.length; i++) h = (h * 31 + activityId.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** The same 32-byte hex secret every server rail mints (`generateSecureToken`
 *  in functions/utils/crypto.ts), from the Web Crypto API — this is the only
 *  booking written from a browser, and a token that is guessable is a link
 *  anyone can cancel somebody else's seat with. */
function generateBookingToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function formatDate(ts?: { toDate(): Date } | null) {
  if (!ts) return '—'
  return ts.toDate().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}
function formatTime(ts?: { toDate(): Date } | null) {
  if (!ts) return ''
  return ts.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * The reason code a waitlist callable refused with → the SessionDetail key that
 * says it in the coach's language.
 *
 * The callables' own `message` strings are English source, so rendering them —
 * which this page used to do — put "This class has no free seat to offer." in
 * front of a coach working in French or German. Every waitlist throw carries
 * `details.reason` for exactly this reason (see booking/waitlist/admin.ts), and
 * this table is the one place that turns them into copy. Sibling of
 * `claimErrorKey` on the public claim page, which does the same job for the
 * member-facing half of the same vocabulary.
 *
 * Returns null when nothing matched, so the caller can fall back to the server's
 * message rather than swallowing a refusal this table has not learned yet.
 */
function waitlistErrorKey(err: unknown): string | null {
  const e = err as { code?: string; details?: { reason?: string } }
  switch (e.details?.reason) {
    case 'session_full':
      return 'waitlistErrorNoSeat'
    case 'not_waiting':
      return 'waitlistErrorNotWaiting'
    case 'already_offered':
      return 'waitlistErrorAlreadyOffered'
    case 'booking_closed':
      return 'waitlistErrorBookingClosed'
    case 'waitlist_disabled':
      return 'waitlistErrorDisabled'
    case 'claim_window_too_short':
      return 'waitlistErrorWindowTooShort'
    case 'session_unavailable':
      return 'waitlistErrorSessionUnavailable'
    case 'undeliverable':
      return 'waitlistErrorUndeliverable'
    case 'entry_not_found':
      return 'waitlistErrorEntryGone'
    case 'permission_denied':
    case 'unauthenticated':
      return 'waitlistErrorPermission'
    default:
      break
  }
  // `assertManager` is shared with the Connect callables and throws without a
  // reason ("Manager access required"), so the code carries this one.
  const code = e.code?.replace(/^functions\//, '')
  if (code === 'permission-denied' || code === 'unauthenticated') return 'waitlistErrorPermission'
  return null
}
// ─── participant type (Firestore doc shape) ───────────────────────────────────

interface ParticipantDoc {
  id: string
  contact?: string
  firstname: string
  lastname: string
  fullname?: string
  avatar_url?: string | null
  checkedInAt?: { toDate(): Date }
  confirmedFromBooking?: boolean
}

// ─── what bought this seat ────────────────────────────────────────────────────

/**
 * The tender that settled a booking, or the fact that none has yet.
 *
 * The roster's "No subscription" chip was computed from the CONTACT alone — the
 * subscription snapshot against the activity's required types — and never
 * looked at the booking. So a member who paid a drop-in price, redeemed a gift
 * card, spent a class credit or used up a weekly allowance was labelled "holds
 * no valid subscription", which at the door reads as "do not let this person
 * in".
 *
 * FIXED ORDER, evaluated top-down, because a seat can carry more than one
 * marker and the chip names ONE tender. `'awaiting_payment'` is deliberately
 * its own answer rather than folded into either arm: a drop-in sits there until
 * the Connect webhook lands, and it is the state a coach most needs to tell
 * apart from both "paid" and "no subscription".
 *
 * READ STRUCTURALLY, because the `Booking` type is behind its writers:
 * `credit_grant_id` / `credit_spent` / `usage_window_doc_id` are written by
 * `booking/index.ts` and absent from the interface, and `payment_status` there
 * omits the `'gift_card'` that `booking/dropIn.ts` writes. This belongs beside
 * `bookingWasPaidFor` in packages/shared/src/types/session.ts once that type is
 * widened — `cancelBooking` and `getMyBookings` each inline the same question
 * today; another copy is one too many.
 */
type SeatFunding = 'paid' | 'gift_card' | 'credit' | 'usage' | 'awaiting_payment' | 'none'

interface SeatFundingMarkers {
  payment_status?: string | null
  credit_grant_id?: string | null
  credit_spent?: number | null
  usage_window_doc_id?: string | null
}

function seatFunding(b: SeatFundingMarkers | null | undefined): SeatFunding {
  if (!b) return 'none'
  if (b.payment_status === 'gift_card') return 'gift_card'
  if (b.payment_status === 'paid') return 'paid'
  if (b.credit_grant_id && b.credit_spent) return 'credit'
  if (b.usage_window_doc_id) return 'usage'
  if (b.payment_status === 'required') return 'awaiting_payment'
  return 'none'
}

/** What the roster says about one person's seat. `'none'` is the ordinary case
 *  — a covered member on a gated class, or any seat on a class with no gate at
 *  all — and renders nothing. */
type FundedTender = Exclude<SeatFunding, 'none' | 'awaiting_payment'>

type SeatChipState =
  | { kind: 'none' }
  | { kind: 'no_sub' }
  | { kind: 'awaiting_payment' }
  | { kind: 'funded'; funding: FundedTender }

const FUNDING_BADGE_KEY: Record<FundedTender, string> = {
  paid: 'seatPaidBadge',
  gift_card: 'seatGiftCardBadge',
  credit: 'seatCreditBadge',
  usage: 'seatUsageBadge',
}

/** ONE chip, rendered on every roster row — the booking rows and the check-in
 *  rows drifted apart the last time the same fact was written twice. */
function SeatFundingChip({ chip }: { chip: SeatChipState }) {
  const t = useTranslations('SessionDetail')
  const base =
    'inline-flex items-center gap-1 rounded-full text-[10px] font-semibold px-1.5 py-0.5 flex-shrink-0'
  if (chip.kind === 'none') return null
  if (chip.kind === 'no_sub') {
    return (
      <span className={`${base} bg-amber-100 text-amber-700`} title={t('noSubBadgeTitle')}>
        <AlertTriangle className="h-3 w-3" />
        {t('noSubBadge')}
      </span>
    )
  }
  if (chip.kind === 'awaiting_payment') {
    return (
      <span className={`${base} bg-amber-100 text-amber-700`} title={t('seatAwaitingPaymentBadgeTitle')}>
        <Clock className="h-3 w-3" />
        {t('seatAwaitingPaymentBadge')}
      </span>
    )
  }
  const key = FUNDING_BADGE_KEY[chip.funding]
  return (
    <span className={`${base} bg-emerald-100 text-emerald-700`} title={t(`${key}Title`)}>
      {t(key)}
    </span>
  )
}

// ─── roster name ──────────────────────────────────────────────────────────────

/**
 * A person's name on this page's rosters — booked, no-show, waiting, checked in
 * — rendered as a link to their record.
 *
 * UX-63 made the same names links on /bookings; every roster one page over was
 * still plain text, so the most common next step from a roster ("who is this?")
 * cost a detour through /contacts and a search. Rows carrying no contact id — a
 * guest booking that never became a contact — stay plain text rather than
 * linking to nothing.
 */
function RosterName({
  contactId,
  className = '',
  children,
}: {
  contactId?: string | null
  className?: string
  children: ReactNode
}) {
  const base = `block text-sm font-medium truncate ${className}`
  if (!contactId) return <p className={base}>{children}</p>
  return (
    // Deep-links into Coaching, not the bare profile — the roster is the
    // capture moment for a goal/step score, same reasoning as Payments'
    // `?tab=payments` deep link from the payments table.
    <Link href={`/contacts/${contactId}?tab=goals` as Route} className={`${base} hover:underline`}>
      {children}
    </Link>
  )
}

// ─── quick-log sheet ────────────────────────────────────────────────────────
// The capture moment: right after class, a coach can log a dimension score for
// someone on the roster without first creating a goal through the full
// title/description/categories/date dialog (Contacts → Coaching). Reuses the
// Notes-sheet pattern from `contacts/[id]/page.tsx` — a header-triggered
// right-side sheet, the house pattern for "quick capture, always one click
// away" — and, like every other rating widget in this coaching lane, starts
// fully unset so a stray tap on Save can't write a dated score nobody chose.
//
// It still creates a real Goal (auto-titled from the dimension) plus one
// evaluation — there is no "just a number" primitive in the coaching model,
// only goals and their evaluations — but the coach never sees the four-field
// form to get there.
//
// The goal it writes carries `from_dimension` (the axis it was logged against)
// and NO categories: the axis is where this goal CAME FROM, not what it is
// about, and those are two different questions — see the header of
// packages/shared/src/types/goal.ts.
function QuickLogSheet({
  open,
  onOpenChange,
  contactId,
  contactName,
  dimensions,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  contactId: string
  contactName: string
  dimensions: PerformanceIndicator[]
  onSaved: () => void
}) {
  const t = useTranslations('SessionDetail')
  const tCommon = useTranslations('Common')
  const [dimensionKey, setDimensionKey] = useState<string | null>(null)
  const [score, setScore] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setDimensionKey(null)
    setScore(null)
    setNotes('')
  }

  const save = async () => {
    if (!dimensionKey || score == null) return
    setSaving(true)
    try {
      const dim = dimensions.find((d) => d.key === dimensionKey)
      const goalRef = await addDoc(
        collection(db, CONTACTS_COLLECTION, contactId, CONTACT_GOALS_SUBCOLLECTION),
        {
          type: 'goal',
          title: dim?.label ?? dimensionKey,
          description: null,
          status: 'in_progress',
          categories: [],
          from_dimension: dimensionKey,
          parent_goal_id: null,
          created_by: 'coach',
          created_at: serverTimestamp(),
          target_date: null,
        },
      )
      await addDoc(collection(goalRef, CONTACT_GOAL_EVALUATIONS_SUBCOLLECTION), {
        evaluated_at: serverTimestamp(),
        evaluated_by: 'coach',
        score,
        notes: notes.trim() || null,
        status_after: 'in_progress',
      })
      onSaved()
      onOpenChange(false)
      reset()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
    >
      <SheetContent side="right" className="sm:max-w-md!">
        <SheetHeader>
          <SheetTitle>{t('quickLogTitle')}</SheetTitle>
          <SheetDescription>{t('quickLogDesc', { name: contactName })}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('quickLogDimension')}</label>
            <div className="flex flex-wrap gap-1.5">
              {dimensions.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setDimensionKey(d.key)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    dimensionKey === d.key
                      ? 'bg-primary text-primary-foreground border-transparent'
                      : 'border-border text-muted-foreground hover:border-foreground'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('quickLogScore')}</label>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setScore(v)}
                  className={`flex-1 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                    score === v
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            {score == null && <p className="text-xs text-muted-foreground">{t('quickLogScoreHint')}</p>}
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('quickLogNotes')}</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={save} disabled={saving || !dimensionKey || score == null}>
            {saving ? tCommon('loading') : tCommon('save')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ─── QR scanner hook ──────────────────────────────────────────────────────────

function useQrScanner(onScan: (text: string) => void) {
  const t = useTranslations('SessionDetail')
  const videoRef = useRef<HTMLVideoElement>(null)
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number>(0)
  const detectorRef = useRef<{ detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } | null>(null)

  const start = useCallback(async () => {
    setError(null)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!('BarcodeDetector' in window)) { setError(t('qrScanningUnsupported')); return }
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
      streamRef.current = stream
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play() }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detectorRef.current = new (window as any).BarcodeDetector({ formats: ['qr_code'] })
      setActive(true)
    } catch {
      setError(t('cameraAccessDenied'))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setActive(false)
  }, [])

  // Scan loop — runs when active
  useEffect(() => {
    if (!active || !detectorRef.current) return
    let stopped = false
    const onScanRef = onScan
    const loop = async () => {
      if (stopped || !videoRef.current || !detectorRef.current) return
      try {
        if (videoRef.current.readyState >= 2) {
          const barcodes = await detectorRef.current.detect(videoRef.current)
          if (barcodes.length > 0) onScanRef(barcodes[0].rawValue)
        }
      } catch { /* ignore frame errors */ }
      rafRef.current = requestAnimationFrame(loop)
    }
    loop()
    return () => { stopped = true; cancelAnimationFrame(rafRef.current) }
  }, [active, onScan])

  useEffect(() => () => stop(), [stop])

  return { videoRef, active, error, start, stop }
}

// ─── add participants dialog ──────────────────────────────────────────────────

// STAFF CLASS BOOKING IS THE HOLE THE GATE CANNOT CLOSE, and this dialog is it.
// It writes `sessions/{id}/participants/{contactId}` DIRECTLY from the browser,
// permitted by the `schedule.manage` capability, so there is no server seam to
// gate — closing it would need a `bookParticipant` callable and a rules
// narrowing on a path coaches use daily. The posture is therefore SURFACE, DO
// NOT BLOCK: the note below says plainly that nobody is asked to sign, and the
// roster chip carries the state permanently. Stated here rather than left to be
// discovered, because "we have a waiver gate" is not literally true of this path.
function AddParticipantsDialog({
  open, onOpenChange, teamId, sessionId, existingIds, onAdded, requiredSubscriptionTypeIds,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  sessionId: string
  existingIds: Set<string>
  onAdded: () => void
  /** Subscription-type ids the session's activity demands; null/empty = not gated. */
  requiredSubscriptionTypeIds: string[] | null
}) {
  const t = useTranslations('SessionDetail')
  // One cached policy read, shared with the roster chip's own lookup. Absent a
  // required waiver the note never renders — a studio that asks for nothing must
  // not be told about a mechanism it does not use.
  const { data: waiverPolicy = [] } = useWaiverPolicy(open ? teamId : null)
  const teamRequiresWaiver = waiverPolicy.length > 0
  const [search, setSearch] = useState('')
  // ── PICK MANY, COMMIT ONCE ────────────────────────────────────────────────
  // This used to add on click and then CLOSE, so putting six people in a class
  // was: open, search, click, closed — six times over, retyping the filter each
  // round. Selection is now held here and spent by the footer button.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  // ArrowDown out of the search field lands on the first row; ArrowUp off the
  // first row comes back. See useListKeyboardNav.
  const searchRef = useRef<HTMLInputElement>(null)
  const { listRef, focusFirst, onListKeyDown } = useListKeyboardNav<HTMLDivElement>(searchRef)
  const [adding, setAdding] = useState(false)
  // True once the manager has been shown, and accepted, that some of the picked
  // people hold no covering subscription. ONE question about the whole
  // selection — asking per person would restore the drip this change removes.
  const [confirmingUncovered, setConfirmingUncovered] = useState(false)

  const isCovered = (c: Contact) =>
    !requiredSubscriptionTypeIds?.length ||
    contactHoldsCoveringSubscription(c, requiredSubscriptionTypeIds)

  // The roster, through the one hook and on the contacts page's cache entry —
  // fetched only once the dialog is open (a null team is the hook's "not yet").
  const { data: contacts = [], isLoading } = useActiveContacts(open ? teamId : null)

  const filtered = contacts.filter((c) => {
    if (existingIds.has(c.id)) return false
    if (!search.trim()) return true
    const s = search.toLowerCase()
    return (
      c.firstname?.toLowerCase().includes(s) ||
      c.lastname?.toLowerCase().includes(s) ||
      c.email?.toLowerCase().includes(s)
    )
  })

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const pickedContacts = contacts.filter((c) => picked.has(c.id))
  const uncovered = pickedContacts.filter((c) => !isCovered(c))

  /** Firestore caps a batch at 500 writes. This door writes the seat, the
   *  attendance row and — for a person whose seat was pending — one contact
   *  counter, so budget THREE per person plus one session write per chunk.
   *  Chunked well under the ceiling: a roster never approaches it, and the
   *  alternative to chunking is a hard failure at the exact moment somebody is
   *  adding a big group. */
  const CHUNK = 150

  const addPicked = async ({ force = false } = {}) => {
    if (pickedContacts.length === 0) return
    if (!force && uncovered.length > 0) {
      setConfirmingUncovered(true)
      return
    }
    setConfirmingUncovered(false)
    setAdding(true)
    try {
      // ── THE SEAT AND THE ATTENDANCE ARE TWO DOCUMENTS, AND THIS DOOR OWED BOTH
      // This is the only way to put a KNOWN person into a class from the admin
      // (there is no staff class-booking callable — `createStaffAppointment` has
      // no class twin), and it used to write the attendance row alone. A booking
      // is what OCCUPIES a seat: `bookingHoldsSeat` counts bookings,
      // `trackBookings` recounts `bookings_count` from them, and every capacity
      // gate reads that number. So a manager adding six people to a six-seat
      // class left it reading "0 booked" and the public form happily sold all
      // six seats again.
      //
      // Written as a CONFIRMED booking, in the shape `confirmClearedHoldFields`
      // settles every other confirm into, plus `source: 'staff'` so the row says
      // who put it there. `trackBookings` fires on it and rewrites
      // `bookings_count` + `status` absolutely — this batch deliberately writes
      // neither.
      // Read first: this person may already hold a booking (they were on the
      // list and the manager admitted them by hand instead of pressing
      // Confirm). Merging blindly would restamp `created_at` and lose when the
      // seat was actually taken, so an existing row is CONFIRMED rather than
      // rewritten — including the hold markers every other confirm clears.
      //
      // The reads go out together and the writes land in ONE batch per chunk:
      // a seat that half-exists is worse than a slow dialog, and a batch is the
      // only way to be sure the whole group either took its seats or did not.
      for (let i = 0; i < pickedContacts.length; i += CHUNK) {
        const slice = pickedContacts.slice(i, i + CHUNK)
        const existingRows = await Promise.all(
          slice.map((c) => getDoc(doc(db, SESSIONS_COLLECTION, sessionId, BOOKINGS_SUB, c.id)))
        )
        const batch = writeBatch(db)
        let conversions = 0
        slice.forEach((contact, n) => {
          const existing = existingRows[n]
          const priorStatus = existing.exists()
            ? ((existing.data() as Booking).status ?? 'pending')
            : null
          batch.set(
            doc(db, SESSIONS_COLLECTION, sessionId, BOOKINGS_SUB, contact.id),
            {
              contact: contact.id,
              session: sessionId,
              teamId,
              firstname: contact.firstname ?? '',
              lastname: contact.lastname ?? '',
              email: contact.email ?? null,
              status: 'confirmed',
              confirmed_at: serverTimestamp(),
              ...(existing.exists()
                ? confirmClearedHoldFields(existing.data() as Booking, deleteField())
                : {
                    source: 'staff',
                    created_at: serverTimestamp(),
                    // NEW ROW ONLY — an existing booking keeps the instant its
                    // seat was really taken.
                    //
                    // `joinedAt` IS WHAT MAKES THE SEAT VISIBLE. Every list that
                    // shows a booking orders on it (/bookings, the contact's
                    // bookings tab, `getMyBookings`) and the index behind those
                    // queries is SPARSE, so a booking written without it is not
                    // in the index and never appears anywhere but this roster —
                    // which is exactly how a hand-added seat became "the booking
                    // that exists but no page can find".
                    joinedAt: serverTimestamp(),
                    is_new_contact: false,
                    // WITHOUT A TOKEN THE MEMBER CANNOT GET OUT. `cancelBooking`
                    // finds a booking only by token, so a seat entered here
                    // would render in her Space as a class she cannot cancel —
                    // worse than a coach's manual entry becoming
                    // member-cancellable like any other booking (Franco).
                    booking_token: generateBookingToken(),
                  }),
            },
            { merge: true }
          )
          batch.set(
            doc(db, SESSIONS_COLLECTION, sessionId, PARTICIPANTS_SUBCOLLECTION, contact.id),
            buildParticipantDoc({
              contactId: contact.id,
              sessionId,
              who: contact,
              checkedInBy: 'manual',
              checkedInAt: serverTimestamp(),
            })
          )
          // ── THIS DOOR IS A CONFIRM, SO IT OWES THE CONFIRM'S COUNTERS ─────
          // It writes `status: 'confirmed'` directly, which means every
          // compensation that undoes a confirm — `markNoShow`'s
          // `conversions_count: -1`, `performRemoval`'s revert-to-pending pair
          // — reaches a seat this batch created. Writing the status without
          // the counters left those undo paths subtracting a number nobody had
          // added, and `conversions_count` has no absolute writer to correct
          // the drift (unlike `bookings_count`, which `trackBookings`
          // recounts). Same arithmetic as `confirmBooking`, for the same
          // reason; the census of confirm surfaces and what each owes lives in
          // `packages/functions/src/analytics/attendanceWriters.test.ts`.
          //
          // Guarded on the PRIOR status, because a booking that was already
          // 'confirmed' (its attendance row deleted, so the person is pickable
          // here again) was counted when it was confirmed the first time.
          if (priorStatus !== 'confirmed') {
            conversions += 1
            // ONLY from 'pending' — exactly `confirmBooking`'s guard. A
            // 'no_show' row already had its pending count given back when it
            // was marked absent, and a brand-new seat was never pending at all.
            if (priorStatus === 'pending') {
              batch.update(doc(db, CONTACTS_COLLECTION, contact.id), {
                pending_bookings_count: increment(-1),
              })
            }
          }
        })
        // Summed and written ONCE per chunk rather than per person: the session
        // document is one document however many people are added, and a batch
        // counts each update against its 500-write cap.
        if (conversions > 0) {
          batch.update(doc(db, SESSIONS_COLLECTION, sessionId), {
            conversions_count: increment(conversions),
          })
        }
        // `participants_count` is `trackSessionParticipants`' to write — see
        // `confirmBooking`.
        await batch.commit()
      }
      setPicked(new Set())
      setSearch('')
      onAdded()
    } finally {
      setAdding(false)
    }
  }

  // A fresh open starts from nothing chosen. Leaving the previous selection
  // standing would re-add people the manager already committed.
  useEffect(() => {
    if (!open) {
      setConfirmingUncovered(false)
      setPicked(new Set())
      setSearch('')
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
      <DialogContent
        className={cn(
          'max-w-sm p-0 gap-0',
          // ONLY the list state is fixed-height. The uncovered-contacts confirm
          // below replaces the list with three lines of prose, and holding 32rem
          // for it would open a dialog that is mostly empty space.
          !confirmingUncovered && 'h-[calc(100dvh-2rem)] sm:h-[32rem]',
        )}
      >
        <DialogHeader className="px-4 pt-4 pb-3 border-b">
          <DialogTitle className="text-base">{t('addContactToSession')}</DialogTitle>
        </DialogHeader>
        <div className="px-3 pt-3 pb-2 space-y-2">
          <SearchInput
            autoFocus
            value={search}
            onValueChange={setSearch}
            inputRef={searchRef}
            onArrowDown={focusFirst}
            placeholder={t('searchContactsPlaceholder')}
          />
          {/* Adding now takes a SEAT as well as marking attendance, which is a
              change a manager has to be told about once — before, six manual
              adds left a six-seat class advertising six free seats. */}
          <p className="text-xs text-muted-foreground">{t('addContactBooksSeat')}</p>
          {teamRequiresWaiver && (
            <p className="text-xs text-muted-foreground">{t('addParticipantWaiverNote')}</p>
          )}
        </div>

        {confirmingUncovered ? (
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-amber-900">{t('noSubConfirmTitle')}</p>
                {/* NAMED, not counted. "3 people have no subscription" makes the
                    manager cancel and re-check who; the names let them decide
                    without leaving the dialog. */}
                <p className="text-xs text-amber-800">
                  {t('noSubConfirmBodyMany', {
                    count: uncovered.length,
                    names: uncovered.map((c) => `${c.firstname} ${c.lastname}`.trim()).join(', '),
                  })}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmingUncovered(false)}
                className="px-3 py-1.5 rounded-lg border text-sm font-medium hover:bg-muted transition-colors"
              >
                {t('noSubConfirmCancel')}
              </button>
              <button
                onClick={() => addPicked({ force: true })}
                disabled={adding}
                className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 transition-colors disabled:opacity-50"
              >
                {t('noSubConfirmAddAnyway')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <DialogBody ref={listRef} onKeyDown={onListKeyDown} className="p-0">
              {isLoading && (
                <div className="px-4 py-3 space-y-2">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
                </div>
              )}
              {!isLoading && filtered.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {search.trim() ? t('noContactsMatchSearch') : t('noContactsFound')}
                </p>
              )}
              {!isLoading && filtered.map((c) => {
                const isPicked = picked.has(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-list-row
                    onClick={() => toggle(c.id)}
                    aria-pressed={isPicked}
                    className={cn(
                      'w-full flex items-center gap-3 px-4 py-2.5 transition-colors text-left',
                      isPicked ? 'bg-primary/5' : 'hover:bg-muted'
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                        isPicked ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                      )}
                    >
                      {isPicked && <Check className="h-3 w-3" />}
                    </span>
                    <div className="h-8 w-8 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">
                      {personInitials(c)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{c.firstname} {c.lastname}</p>
                      {c.email && <p className="text-xs text-muted-foreground truncate">{c.email}</p>}
                    </div>
                    {!isCovered(c) && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold px-1.5 py-0.5 flex-shrink-0">
                        <AlertTriangle className="h-3 w-3" />
                        {t('noSubBadge')}
                      </span>
                    )}
                  </button>
                )
              })}
            </DialogBody>

            {/* The footer is the whole point of the change: it is where a
                selection becomes seats, and it stays put while the list
                scrolls. Disabled at zero rather than hidden, so the button
                that will finish the job is visible from the start. */}
            {/* mx-0 mb-0 CANCELS the base footer's `-mx-4 -mb-4`. That bleed
                exists to reach the edges of a dialog padded with `p-4`; this
                one is `p-0`, so the negative margins pushed the footer OUTSIDE
                the box, and the `overflow-hidden` that comes with `DialogBody`
                clipped the bottom-right corner of the button. */}
            <DialogFooter className="mx-0 mb-0 border-t px-4 py-3">
              <Button onClick={() => addPicked()} disabled={picked.size === 0 || adding}>
                {adding && <Loader2 className="h-4 w-4 animate-spin" />}
                {picked.size === 0 ? t('addSelected') : t('addSelectedCount', { count: picked.size })}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─── section header ───────────────────────────────────────────────────────────

function SectionHeader({ icon, label, count, color }: { icon: React.ReactNode; label: string; count: number; color: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="h-7 w-7 rounded-lg flex items-center justify-center" style={{ background: `${color}20`, color }}>
        {icon}
      </div>
      <span className="font-semibold text-sm">{label}</span>
      <span className="h-5 min-w-5 px-1.5 rounded-full text-xs font-bold flex items-center justify-center" style={{ background: `${color}20`, color }}>
        {count}
      </span>
    </div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function SessionDetailPage() {
  const t = useTranslations('SessionDetail')
  const tCommon = useTranslations('Common')
  const params = useParams()
  const sessionId = params.id as string
  const router = useRouter()
  const i18nRouter = useI18nRouter()
  const { currentTeamId, user, team } = useAuth()
  const teamSlug = team?.slug ?? ''
  const qc = useQueryClient()
  const [linkCopied, setLinkCopied] = useState(false)

  const [editOpen, setEditOpen] = useState(false)
  // Repeat this session on another date. Opens the create form seeded from this
  // one — nothing is written until it is saved, and the copy carries no people.
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  // QR scanner state — kept for when scanner is re-enabled; prefixed with _ to suppress unused-var lint
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState<{ text: string; ok: boolean } | null>(null)
  // Waitlist row actions: the contactId currently in flight (so one row's
  // spinner doesn't freeze the whole queue), the entry pending a delete
  // confirmation, and the last refusal to surface.
  const [waitlistBusy, setWaitlistBusy] = useState<string | null>(null)
  const [waitlistRemoving, setWaitlistRemoving] = useState<WaitlistEntry | null>(null)
  const [waitlistError, setWaitlistError] = useState<string | null>(null)
  // The quick-log sheet target — see QuickLogSheet above.
  const [quickLogTarget, setQuickLogTarget] = useState<{ contactId: string; name: string } | null>(null)
  const coachingDimensions = resolveCoachingDimensions(
    team as { performance_indicators?: PerformanceIndicator[] | null } | null,
  )

  // Share the public booking link for THIS session. Native share sheet where the
  // platform has one (a coach on a phone sends it straight into WhatsApp), else
  // the clipboard. An ABSOLUTE url either way — a relative path is useless the
  // moment it leaves the app. A cancelled share sheet throws AbortError, which is
  // not a failure and must not surface as one.
  async function shareBookingLink() {
    if (!teamSlug) return
    const url = `${window.location.origin}/public/${teamSlug}/booking?session=${sessionId}`
    if (navigator.share) {
      try {
        await navigator.share({ url })
        return
      } catch {
        /* dismissed, or unavailable in this context — fall through to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 1500)
    } catch {
      /* clipboard blocked (insecure origin, denied permission) — no-op */
    }
  }

  // ── data fetching ────────────────────────────────────────────────────────────

  const sessionQ = useQuery<Session | null>({
    queryKey: ['session', sessionId],
    queryFn: async () => {
      const snap = await getDoc(doc(db, SESSIONS_COLLECTION, sessionId))
      if (!snap.exists()) return null
      return { id: snap.id, ...snap.data() } as Session
    },
  })

  const participantsQ = useQuery<ParticipantDoc[]>({
    queryKey: ['session-participants', sessionId],
    queryFn: async () => {
      const snap = await getDocs(collection(db, SESSIONS_COLLECTION, sessionId, PARTICIPANTS_SUBCOLLECTION))
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as ParticipantDoc)
    },
  })

  const bookingsQ = useQuery<Booking[]>({
    queryKey: ['session-bookings', sessionId],
    queryFn: async () => {
      const snap = await getDocs(collection(db, SESSIONS_COLLECTION, sessionId, BOOKINGS_SUB))
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Booking)
    },
  })

  // The queue for this session. Read directly (team members may list it — see
  // firestore.rules); every WRITE goes through a callable, because the rules
  // deny client writes here and a browser write would bypass the capacity
  // transaction the whole feature rests on.
  const waitlistQ = useQuery<WaitlistEntry[]>({
    queryKey: ['session-waitlist', sessionId],
    queryFn: async () => {
      const snap = await getDocs(collection(db, SESSIONS_COLLECTION, sessionId, WAITLIST_SUBCOLLECTION))
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as WaitlistEntry)
    },
  })

  const activitiesQ = useQuery<Activity[]>({
    queryKey: ['activities', currentTeamId],
    enabled: !!currentTeamId,
    queryFn: async () => {
      if (!currentTeamId) return []
      const q = query(collection(db, ACTIVITIES_COLLECTION), where('teamId', '==', currentTeamId))
      const snap = await getDocs(q)
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Activity)
    },
  })

  // Adjacent sessions for prev/next navigation
  const prevQ = useQuery<Session | null>({
    queryKey: ['session-prev', sessionId, currentTeamId],
    enabled: !!sessionQ.data?.start && !!currentTeamId,
    queryFn: async () => {
      if (!sessionQ.data?.start || !currentTeamId) return null
      const q = query(
        collection(db, SESSIONS_COLLECTION),
        where('teamId', '==', currentTeamId),
        where('start', '<', sessionQ.data.start),
        orderBy('start', 'desc'),
        limit(1),
      )
      const snap = await getDocs(q)
      if (snap.empty) return null
      return { id: snap.docs[0].id, ...snap.docs[0].data() } as Session
    },
  })

  const nextQ = useQuery<Session | null>({
    queryKey: ['session-next', sessionId, currentTeamId],
    enabled: !!sessionQ.data?.start && !!currentTeamId,
    queryFn: async () => {
      if (!sessionQ.data?.start || !currentTeamId) return null
      const q = query(
        collection(db, SESSIONS_COLLECTION),
        where('teamId', '==', currentTeamId),
        where('start', '>', sessionQ.data.start),
        orderBy('start', 'asc'),
        limit(1),
      )
      const snap = await getDocs(q)
      if (snap.empty) return null
      return { id: snap.docs[0].id, ...snap.docs[0].data() } as Session
    },
  })

  // Subscription gate of this session's activity. Mirrors bookSession's resolution
  // order: an appointment session's own denormalised rule is authoritative (per-slot
  // overrides); group classes read the linked activity. null/empty = not gated.
  const gateActivity = (activitiesQ.data ?? []).find((a) => a.id === sessionQ.data?.activityId)
  const sessionRule = (sessionQ.data as { accessRule?: Parameters<typeof resolveActivityAccessRule>[0]['accessRule'] } | null | undefined)?.accessRule
  const isAppointmentSession = sessionQ.data?.activityType === 'appointment'
  const accessRule = isAppointmentSession
    ? sessionQ.data
      ? resolveActivityAccessRule({ accessRule: sessionRule, isFreeTrial: sessionQ.data.isFreeTrial })
      : null
    : gateActivity
      ? resolveActivityAccessRule(gateActivity)
      : null
  const requiredSubIds = activityRequiresSubscription(accessRule)

  // Contact docs (subscription snapshots included) for the roster coverage badges.
  // The one roster hook, on the shared cache entry; only fetched when the
  // activity is gated.
  const rosterContactsQ = useActiveContacts(requiredSubIds?.length ? currentTeamId : null)

  // contactId → covered; contacts we can't see (archived etc.) get no badge.
  const rosterCoverage = new Map<string, boolean>(
    requiredSubIds?.length
      ? (rosterContactsQ.data ?? []).map((c) => [
          c.id,
          contactHoldsCoveringSubscription(c, requiredSubIds),
        ])
      : [],
  )
  // contactId → their booking on this session. Keyed by `bookingContactId` and
  // not by the document id: the two are equal by convention today, and the day
  // they are not is the day one person occupies two roster rows.
  //
  // A CHECK-IN ROW CARRIES NO PAYMENT FIELDS AT ALL (`buildParticipantDoc`
  // writes identity plus who checked them in), so the person who paid and was
  // then checked in resolves their funding through this map or not at all.
  const bookingByContact = new Map<string, Booking>(
    (bookingsQ.data ?? []).map((b) => [bookingContactId(b), b])
  )

  /** THE SEAT FIRST, THE PERSON SECOND. What bought this seat is a fact about
   *  the booking; "no valid subscription" is only the answer when nothing did.
   *  Without the bookings read the coverage arm is withheld rather than
   *  flashed — an amber warning that turns out to be wrong is worse at the door
   *  than a chip that arrives a moment late.
   *
   *  GUARDED ON THE ABSENCE OF DATA, NOT ON `isLoading`. A failed read (a rules
   *  change, a transient error, a missing index) leaves `isLoading` false and
   *  `data` undefined, so `bookingByContact` is empty and every row would fall
   *  through to the contact-only arm — amber "No subscription" on the people
   *  who paid, which is precisely the wrong answer this resolver exists to stop
   *  showing. A read that failed must render as no answer, never as an answer. */
  const seatChipFor = (contactId?: string | null): SeatChipState => {
    if (!contactId || bookingsQ.data === undefined) return { kind: 'none' }
    const funding = seatFunding(bookingByContact.get(contactId))
    if (funding === 'awaiting_payment') return { kind: 'awaiting_payment' }
    if (funding !== 'none') return { kind: 'funded', funding }
    return rosterCoverage.get(contactId) === false ? { kind: 'no_sub' } : { kind: 'none' }
  }

  // ── The waiver chip ───────────────────────────────────────────────────────
  // Read LIVE from the signer rows for exactly the people on this roster, rather
  // than from the denormalised `booking.waiver_state`. That field is a snapshot
  // at booking time — right for the printed sheet, which describes the booking
  // as taken — and wrong here, where a revocation or a `require_resign` publish
  // since then is the thing a coach at the door needs to see. State both, or
  // "why does the sheet say signed and the screen say expired" becomes a support
  // ticket.
  //
  // Deliberately NOT `rosterContactsQ`'s shape: that fetches the whole active
  // contact list and is enabled only for gated activities, while a waiver chip
  // is wanted on every session. This is bounded by the roster.
  const waiverContactIds = [
    ...(bookingsQ.data ?? []).map((b) => b.contact),
    ...(participantsQ.data ?? []).map((p) => p.contact),
  ].filter((id): id is string => !!id)
  const waiverRoster = useWaiverRoster(
    currentTeamId,
    waiverContactIds,
    sessionQ.data?.activityId ?? null
  )
  const waiverStateOf = (contactId?: string | null) =>
    contactId ? waiverRoster.states.get(contactId) : undefined
  const waiverCheckOf = (contactId?: string | null) =>
    contactId ? waiverRoster.checks.get(contactId) : undefined

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['session', sessionId] })
    qc.invalidateQueries({ queryKey: ['session-participants', sessionId] })
    qc.invalidateQueries({ queryKey: ['session-bookings', sessionId] })
    // Freeing a seat can promote the front of the queue within the same
    // request, so the queue is refetched by every booking action, not only by
    // the two that touch it directly.
    qc.invalidateQueries({ queryKey: ['session-waitlist', sessionId] })
    qc.invalidateQueries({ queryKey: ['sessions'] })
  }

  // ── booking actions ───────────────────────────────────────────────────────────

  const confirmBooking = async (booking: Booking) => {
    const bookingRef = doc(db, SESSIONS_COLLECTION, sessionId, BOOKINGS_SUB, booking.id)
    // Confirming settles a waitlist claim, so its hold markers go with the same
    // write — a confirmed seat is an ordinary booking. A leftover
    // `waitlist_claim` would otherwise keep this person out of
    // `sendBookingReminders` forever, and a claim that was mid-payment carries
    // the drop-in hold's `payment_status`/`expires_at` too: leaving those frees
    // the seat again at the deadline and puts a confirmed booking in
    // `releaseExpiredBookingHolds`' delete query. One shared patch, so all four
    // confirm surfaces settle a booking into the same shape.
    const contactId = bookingContactId(booking)
    // ONE confirm, whichever page you are standing on. This surface used to omit
    // `confirmed_at` (so the roster could not say WHEN, and the bookings list
    // could), skip `conversions_count`, and leave the contact's
    // `pending_bookings_count` standing — the same act, three fields lighter
    // than the identical button on /bookings. The two check-in callables write
    // this same set.
    const batch = writeBatch(db)
    batch.update(bookingRef, {
      status: 'confirmed',
      confirmed_at: serverTimestamp(),
      ...confirmClearedHoldFields(booking, deleteField()),
    })
    batch.set(
      doc(db, SESSIONS_COLLECTION, sessionId, PARTICIPANTS_SUBCOLLECTION, contactId),
      buildParticipantDoc({
        contactId,
        sessionId,
        who: booking,
        checkedInBy: 'booking-confirm',
        checkedInAt: serverTimestamp(),
        fromBooking: true,
      })
    )
    // No `participants_count` here: `trackSessionParticipants` owns that number
    // and recounts it absolutely from the subcollection, exactly as
    // `trackBookings` owns `bookings_count`. Three client increments used to
    // race it — and the two check-in callables never incremented at all, so a
    // QR-scanned class silently read zero attendance.
    batch.update(doc(db, SESSIONS_COLLECTION, sessionId), {
      conversions_count: increment(1),
    })
    // ONLY from 'pending'. This surface also confirms a NO-SHOW back into the
    // class (the override button), and that booking's pending count was already
    // given back when it was marked absent — decrementing again drives the
    // contact's counter negative. /bookings never meets this case: it offers
    // Confirm from 'pending' alone.
    if (booking.contact && (!booking.status || booking.status === 'pending')) {
      batch.update(doc(db, CONTACTS_COLLECTION, booking.contact), {
        pending_bookings_count: increment(-1),
      })
    }
    await batch.commit()
    invalidate()
  }

  // ── MARKING SOMEBODY ABSENT ───────────────────────────────────────────────
  //
  // ONE act, reachable from 'pending' and from 'confirmed', and each starting
  // state owes different compensations. Until this branch existed, 'confirmed'
  // was a one-way door: the only exit was /bookings' "Revert to pending" and
  // then a second click, a two-step whose middle state is a lie about the
  // roster.
  //
  // THE ATTENDANCE ROW ALWAYS GOES. Somebody marked absent must not stay in
  // "Check-ins" — that is the divergence this whole branch exists to close —
  // and a batch delete of a document that isn't there is a no-op, so the
  // pending rows (which normally have none) pay nothing for it.
  //
  // The counters, in contrast, are each undone by whoever wrote them:
  // `conversions_count` by the confirm, `pending_bookings_count` by the seat
  // while it was still pending. Touching the pending count on the confirmed
  // path would drive the contact's counter negative — the confirm already gave
  // it back. `bookings_count` is never written from here at all: `trackBookings`
  // recounts it absolutely from the subcollection.
  const markNoShow = async (booking: Booking) => {
    const batch = writeBatch(db)
    batch.update(doc(db, SESSIONS_COLLECTION, sessionId, BOOKINGS_SUB, booking.id), {
      status: 'no_show',
      no_show_at: serverTimestamp(),
    })
    batch.delete(
      doc(db, SESSIONS_COLLECTION, sessionId, PARTICIPANTS_SUBCOLLECTION, bookingContactId(booking))
    )
    if (booking.status === 'confirmed') {
      batch.update(doc(db, SESSIONS_COLLECTION, sessionId), { conversions_count: increment(-1) })
    } else if ((!booking.status || booking.status === 'pending') && booking.contact) {
      // The same compensation /bookings applies — this surface used to skip it,
      // so the same click left the contact's pending counter one too high here
      // and correct one page over.
      batch.update(doc(db, CONTACTS_COLLECTION, booking.contact), {
        pending_bookings_count: increment(-1),
      })
    }
    await batch.commit()
    invalidate()
  }

  // The confirmed → no_show step is the one that asks first. It fires
  // `booking_no_show` automations and `processNoShowStrike` (as the pending
  // path always has), and on top of that it DELETES the attendance row a coach
  // recorded — a misclick there rewrites who was in the room.
  const [pendingNoShow, setPendingNoShow] = useState<Booking | null>(null)
  const [markingNoShow, setMarkingNoShow] = useState(false)

  const confirmNoShow = async () => {
    const booking = pendingNoShow
    if (!booking) return
    setMarkingNoShow(true)
    try {
      await markNoShow(booking)
      setPendingNoShow(null)
    } catch {
      toast.error(t('noShowFailed'))
    } finally {
      setMarkingNoShow(false)
    }
  }

  // ── TAKING SOMEBODY OFF A SESSION ─────────────────────────────────────────
  //
  // Both removals used to be one unguarded `deleteDoc` behind a small icon
  // button: no question asked, no way back, and on a class that already ran no
  // signal that this is a different act from tidying up tomorrow's roster
  // (Franco, 2026-08-21).
  //
  // TWO GUARDS, because they answer different failures:
  //
  //   1. A CONFIRM STEP, which exists mainly for the PAST session. The dialog
  //      says which it is, because removing a booking from a class that has
  //      already happened edits the record of who was there — attendance, the
  //      contact's history, and every count derived from them.
  //
  //   2. AN UNDO, which is the honest answer to a misclick: the document is
  //      read BEFORE it is deleted and written back verbatim under the same id,
  //      so the restored row is the row that was there — same status, same
  //      timestamps, same credit stamps. `bookings_count` and
  //      `participants_count` are recounted by their triggers either way, so a
  //      restore needs no counter arithmetic (and must not attempt any — see
  //      the seat-writer rule).
  //
  // WHAT NEITHER GUARD DOES, stated so nobody assumes otherwise: this is still
  // a raw document delete, not `cancelBooking`. The callable refunds a spent
  // class credit and a usage-limit window unit; this path refunds neither, and
  // never did. That is a real gap, and it is not one a confirm dialog closes.
  const [pendingRemoval, setPendingRemoval] = useState<
    {
      kind: 'booking' | 'participant'
      id: string
      name: string
      /** The person this row is about, carried separately from the document
       *  id. A check-in row is written under the contact id by convention, and
       *  the seat behind it is found through `bookingByContact` — which is
       *  keyed by `bookingContactId`, not by a document id, for the reason
       *  stated where that map is built. */
      contactId?: string | null
    } | null
  >(null)
  const [removing, setRemoving] = useState(false)
  // Read off the END where there is one, so a class still running is not
  // called past. Evaluated at render rather than stored: a dialog opened at
  // 18:59 on a 19:00 session should not still claim the future at 19:05.
  const sessionHasEnded = (() => {
    const s = sessionQ.data
    if (!s) return false
    const endMs = (s.end ?? s.start)?.toMillis?.()
    return typeof endMs === 'number' && endMs < Date.now()
  })()

  const removalSub = (kind: 'booking' | 'participant') =>
    kind === 'booking' ? BOOKINGS_SUB : PARTICIPANTS_SUBCOLLECTION

  const performRemoval = async () => {
    const target = pendingRemoval
    if (!target) return
    setRemoving(true)
    const ref = doc(db, SESSIONS_COLLECTION, sessionId, removalSub(target.kind), target.id)
    // ── THE SEAT BEHIND THE CHECK-IN, RESOLVED BY PERSON ──────────────────
    // Not by document id. `bookings/{contactId}` is what the booking rails
    // write, so id-as-id holds for every seat they made — but a seat carried in
    // from elsewhere (imported, seeded) lives under an id of its own, and
    // deriving the reference from the participant's id there points at a
    // document that does not exist: the revert below silently does nothing and
    // the orphaned confirmed booking this whole branch exists to clear stays
    // exactly where it was. So the seat comes out of `bookingByContact`, the
    // same by-person map every other reader in this change uses, and the
    // id-shaped guess is only the fallback when the roster read has no row for
    // this person.
    const seatContactId = target.contactId ?? target.id
    const seat = target.kind === 'participant' ? bookingByContact.get(seatContactId) : undefined
    const bookingRef = doc(
      db,
      SESSIONS_COLLECTION,
      sessionId,
      BOOKINGS_SUB,
      seat?.id ?? seatContactId
    )
    try {
      // READ BEFORE DELETE — this snapshot IS the undo. Taken inside the same
      // click so nothing can have changed between the two.
      const snap = await getDoc(ref)
      const restore = snap.exists() ? snap.data() : null
      // ── AND THE SEAT BEHIND IT ────────────────────────────────────────────
      // Deleting the attendance row alone left a CONFIRMED booking with no row
      // on any screen: the Portal-bookings block renders pending and no-shows,
      // the person is gone from Check-ins, and `bookingHoldsSeat` still counts
      // their seat. So the removal takes the booking back to 'pending' — the
      // same place /bookings' "Revert to pending" puts it — where it is visible
      // and can be confirmed, no-showed or removed. NOT to 'no_show': taking a
      // check-in back says the record was wrong, not that the person failed to
      // turn up (Franco).
      //
      // Keyed on the booking's STATUS, not on `confirmedFromBooking`: the staff
      // add-contact door writes a confirmed booking and an attendance row with
      // no such flag, and that pairing orphans exactly the same way.
      const bookingSnap = target.kind === 'participant' ? await getDoc(bookingRef) : null
      const revertedBooking =
        bookingSnap?.exists() && bookingSnap.data().status === 'confirmed'
          ? bookingSnap.data()
          : null
      const batch = writeBatch(db)
      batch.delete(ref)
      if (revertedBooking) {
        batch.update(bookingRef, { status: 'pending', confirmed_at: null })
        batch.update(doc(db, SESSIONS_COLLECTION, sessionId), {
          conversions_count: increment(-1),
        })
        if (revertedBooking.contact) {
          batch.update(doc(db, CONTACTS_COLLECTION, revertedBooking.contact as string), {
            pending_bookings_count: increment(1),
          })
        }
      }
      await batch.commit()
      // `participants_count` is recounted by `trackSessionParticipants` and
      // `bookings_count` by `trackBookings` — see `confirmBooking`. A blind
      // decrement here could not tell a double click from two removals, and
      // drove the number negative.
      invalidate()
      setPendingRemoval(null)
      toast(t('removedToast', { name: target.name }), {
        duration: 12000,
        action: restore
          ? {
              label: t('undo'),
              onClick: async () => {
                try {
                  // The undo restores BOTH documents, or it is not an undo: the
                  // booking goes back verbatim (its own `confirmed_at`, not a
                  // fresh one) and the two counters the revert moved go back
                  // with it.
                  const undo = writeBatch(db)
                  undo.set(ref, restore)
                  if (revertedBooking) {
                    undo.set(bookingRef, revertedBooking)
                    undo.update(doc(db, SESSIONS_COLLECTION, sessionId), {
                      conversions_count: increment(1),
                    })
                    if (revertedBooking.contact) {
                      undo.update(doc(db, CONTACTS_COLLECTION, revertedBooking.contact as string), {
                        pending_bookings_count: increment(-1),
                      })
                    }
                  }
                  await undo.commit()
                  invalidate()
                  toast.success(t('restoredToast', { name: target.name }))
                } catch {
                  toast.error(t('restoreFailed'))
                }
              },
            }
          : undefined,
      })
    } catch {
      toast.error(t('removeFailed'))
    } finally {
      setRemoving(false)
    }
  }

  // ── waitlist actions ──────────────────────────────────────────────────────────
  //
  // Both are callables. A client write would be denied by the rules anyway, and
  // that denial is deliberate: offering a seat mints a booking hold and rewrites
  // `bookings_count` inside one transaction, and removing an entry may have to
  // give a held seat back — neither is expressible as a document write.

  const callWaitlist = async (
    name: 'promoteWaitlistEntry' | 'removeWaitlistEntry',
    entry: WaitlistEntry
  ) => {
    if (!currentTeamId) return
    setWaitlistBusy(entry.id)
    setWaitlistError(null)
    try {
      const fn = httpsCallable(functions, name)
      await fn({ teamId: currentTeamId, sessionId, contactId: entry.id })
      invalidate()
    } catch (err: unknown) {
      // The reason code names the guard that refused; the message is English
      // source and is the LAST resort, for a refusal the table above has not
      // learned yet.
      const key = waitlistErrorKey(err)
      setWaitlistError(key ? t(key) : (err as Error).message || t('waitlistActionFailed'))
    } finally {
      setWaitlistBusy(null)
    }
  }

  // ── QR scanner ────────────────────────────────────────────────────────────────

  const handleQrScan = useCallback(async (raw: string) => {
    setScanMsg(null)
    try {
      const { c: contactId, h: hash } = JSON.parse(raw) as { c: string; h: string }
      const fn = httpsCallable(functions, 'checkInContact')
      const result = await fn({ sessionId, contactId, hash, scope: 'sessions' }) as { data: { success: boolean; alreadyCheckedIn?: boolean; contactName?: string } }
      setScanMsg({
        text: result.data.alreadyCheckedIn
          ? t('contactAlreadyCheckedIn', { name: result.data.contactName ?? '' })
          : t('contactCheckedIn', { name: result.data.contactName ?? '' }),
        ok: true,
      })
      invalidate()
    } catch (err: unknown) {
      setScanMsg({ text: (err as Error).message || t('invalidQrCode'), ok: false })
    }
    setTimeout(() => setScanMsg(null), 4000)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const scanner = useQrScanner(handleQrScan)

  useEffect(() => {
    if (scanning) scanner.start()
    else scanner.stop()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning])

  // ── derived ───────────────────────────────────────────────────────────────────

  const session = sessionQ.data
  const participants = participantsQ.data ?? []
  const bookings = bookingsQ.data ?? []
  const activities = activitiesQ.data ?? []

  const pendingBookings = bookings.filter((b) => !b.status || b.status === 'pending')
  const noShowBookings  = bookings.filter((b) => b.status === 'no_show')

  // The live queue, in queue order. 'offered' stays visible — that person's seat
  // is held but unclaimed, which is precisely the state a coach needs to see.
  const waitlist = (waitlistQ.data ?? [])
    .filter((e) => e.status !== 'claimed')
    .sort((a, b) => (a.joined_at?.toMillis() ?? 0) - (b.joined_at?.toMillis() ?? 0))
  const waitingCount = waitlist.filter((e) => e.status === 'waiting').length
  // Same predicate the server's capacity gate uses, so "Offer now" is disabled
  // for exactly the sessions the promoter would refuse. A live offer already
  // holds its seat (bookingHoldsSeat counts the claim hold), so it is correctly
  // subtracted here too.
  const freeSeats = seatsFree(
    session?.max_participants,
    bookings.filter((b) => bookingHoldsSeat(b)).length
  )
  const existingParticipantIds = new Set(participants.map((p) => p.contact).filter(Boolean) as string[])
  // A CONFIRMED booking normally lives in "Check-ins" — the confirm writes the
  // attendance row — so listing every one of them here would show the same
  // person twice. What has no home anywhere is a confirmed booking with NO
  // attendance row: it holds a seat in the recount and appears on no screen.
  // This is that group, and it is empty on a healthy session.
  const confirmedBookings = bookings.filter(
    (b) => b.status === 'confirmed' && !existingParticipantIds.has(bookingContactId(b))
  )
  const activity = activities.find((a) => a.id === session?.activityId)
  const { accent } = activityPalette(session?.activityId, activity?.color)

  // Register this session as an open tab once loaded (mirrors the header title).
  useRegisterTab({
    href: `/sessions/${sessionId}`,
    label: session ? (session.activityName ?? formatDate(session.start)) : '',
    entityKind: 'session',
    enabled: !!session,
  })

  // ── loading / not found ───────────────────────────────────────────────────────

  if (sessionQ.isLoading) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
        <p className="text-lg font-semibold">{t('sessionNotFound')}</p>
        <button onClick={() => router.back()} className="text-sm text-primary hover:underline">{t('goBack')}</button>
      </div>
    )
  }

  const hasBookings =
    pendingBookings.length > 0 || confirmedBookings.length > 0 || noShowBookings.length > 0

  return (
    <div className="space-y-5 max-w-2xl mx-auto pb-20">

      {/* Nav bar */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> {t('backToSessions')}
        </button>
        <div className="flex items-center gap-1">
          <Tip label={t('previousSession')}>
            <button
              onClick={() => prevQ.data && i18nRouter.push(`/sessions/${prevQ.data.id}` as Parameters<typeof i18nRouter.push>[0])}
              disabled={!prevQ.data}
              className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
              aria-label={t('previousSession')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </Tip>
          <Tip label={t('nextSession')}>
            <button
              onClick={() => nextQ.data && i18nRouter.push(`/sessions/${nextQ.data.id}` as Parameters<typeof i18nRouter.push>[0])}
              disabled={!nextQ.data}
              className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
              aria-label={t('nextSession')}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </Tip>
        </div>
      </div>

      {/* Session card */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {/* Accent top bar */}
        <div className="h-1 w-full" style={{ background: accent }} />
        <div className="px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-bold tracking-tight">
                {session.activityName ?? formatDate(session.start)}
              </h1>
              <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  <span>{formatDate(session.start)} · {formatTime(session.start)}{session.end ? ` – ${formatTime(session.end)}` : ''}</span>
                </div>
                {session.location && (
                  <div className="flex items-center gap-2">
                    <MapPin className="h-3.5 w-3.5 shrink-0" />
                    <span>{session.location}</span>
                  </div>
                )}
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" />
                    <span className="font-medium text-foreground">{participants.length}</span>
                    <span>{t('checkInsStat')}</span>
                  </div>
                  {pendingBookings.length > 0 && (
                    <div className="flex items-center gap-1.5 text-amber-600">
                      <BookOpen className="h-3.5 w-3.5" />
                      <span className="font-medium">{pendingBookings.length}</span>
                      <span>{t('pendingBookingsStat')}</span>
                    </div>
                  )}
                  {waitingCount > 0 && (
                    <div className="flex items-center gap-1.5">
                      <ListOrdered className="h-3.5 w-3.5" />
                      <span className="font-medium text-foreground">{waitingCount}</span>
                      <span>{t('waitlistStat')}</span>
                    </div>
                  )}
                  {session.allowBooking && (
                    <Badge variant="secondary" className="text-xs">{t('bookingOpenBadge')}</Badge>
                  )}
                </div>
              </div>
              {session.notes && (
                <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{session.notes}</p>
              )}
            </div>
            {/* The heading's own controls: what to do to THIS session, kept out
                of the action row below, which is what to do with the PEOPLE. */}
            <div className="flex flex-col items-end justify-between gap-2 self-stretch shrink-0">
              <div className="flex items-center gap-1">
                <Tip label={t('editTitle')}>
                  <button onClick={() => setEditOpen(true)} className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground" aria-label={t('editTitle')}>
                    <Pencil className="h-4 w-4" />
                  </button>
                </Tip>
                <Tip label={tCommon('duplicate')}>
                  <button onClick={() => setDuplicateOpen(true)} className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground" aria-label={tCommon('duplicate')}>
                    <Copy className="h-4 w-4" />
                  </button>
                </Tip>
                <Tip label={t('deleteTitle')}>
                  <button onClick={() => setDeleteOpen(true)} className="p-2 rounded-lg hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive" aria-label={t('deleteTitle')}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </Tip>
              </div>
              {/* SHARE the link to THIS session, don't open it — the coach's actual
                  need is sending it to someone, and they can already see the session
                  on the page they are standing on.
                  `?session=` is the booking form's highest-precedence entry point and
                  degrades on its own to the slot list when the session can't be
                  honoured (past, full, unpublished), so a link that has aged in
                  someone's inbox is never a dead end.
                  Slug, not team id: public routes are slug-addressed.
                  An ICON, at the bottom of the heading: sharing is occasional, and
                  as a full-width labelled button in the action row it competed with
                  "Add contact", which is the page's job. The copied state is the
                  only feedback there is, so it stays visible (a green check), not
                  just a title attribute. */}
              {session.allowBooking && teamSlug && (
                <Tip label={linkCopied ? t('bookingLinkCopied') : t('bookingLinkShare')}>
                  <button
                    onClick={shareBookingLink}
                    className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                    aria-label={linkCopied ? t('bookingLinkCopied') : t('bookingLinkShare')}
   >
                    {linkCopied ? (
                      <Check className="h-4 w-4 text-green-600" />
                    ) : (
                      <Share2 className="h-4 w-4" />
                    )}
                  </button>
                </Tip>
              )}
            </div>
          </div>
        </div>

        {/* Action row. "Add contact" LEADS and is the only primary here — putting
            a person in the room is what this page is for, and it used to sit
            third, styled like the scanner and the share link beside it. The
            scanner is the same verb by another route, so it stays an outline
            sibling rather than a second primary. */}
        <div className="px-5 pb-4 flex flex-wrap gap-2">
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <UserPlus className="h-4 w-4" /> {t('addContact')}
          </button>
          <button
            onClick={() => setScanning((v) => !v)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              /* "On" stays filled — but neutral, not the primary accent, which
                 now belongs to "Add contact" alone. */
              scanning ? 'bg-foreground text-background' : 'border hover:bg-muted'
            }`}
          >
            <QrCode className="h-4 w-4" />
            {scanning ? t('stopScannerButton') : t('checkInScannerButton')}
          </button>
        </div>
      </div>

      {/* QR scanner */}
      {scanning && (
        <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
          <div className="relative aspect-square w-full max-w-sm mx-auto bg-black">
            <video
              ref={scanner.videoRef}
              muted
              playsInline
              className="h-full w-full object-cover"
            />
            {scanMsg && (
              <div
                className={`absolute inset-x-2 top-2 rounded-lg px-3 py-2 text-center text-sm font-medium shadow ${
                  scanMsg.ok ? 'bg-green-600 text-white' : 'bg-destructive text-destructive-foreground'
                }`}
              >
                {scanMsg.text}
              </div>
            )}
          </div>
          {scanner.error ? (
            <p className="px-5 py-3 text-sm text-destructive">{scanner.error}</p>
          ) : (
            <p className="px-5 py-3 text-sm text-muted-foreground">{t('qrScannerHint')}</p>
          )}
        </div>
      )}

      {/* Portal bookings */}
      {hasBookings && (
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <SectionHeader icon={<BookOpen className="h-3.5 w-3.5" />} label={t('portalBookingsSection')} count={pendingBookings.length + confirmedBookings.length + noShowBookings.length} color="#D97706" />

          {/* Pending */}
          {pendingBookings.map((b) => (
            <div key={b.id} className="flex items-center gap-3 py-2.5 border-b last:border-0">
              <div className="h-9 w-9 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                {b.firstname?.[0]}{b.lastname?.[0]}
              </div>
              <div className="flex-1 min-w-0">
                <RosterName contactId={b.contact}>{b.lastname} {b.firstname}</RosterName>
                {b.email && <p className="text-xs text-muted-foreground">{b.email}</p>}
              </div>
              <SeatFundingChip chip={seatChipFor(b.contact)} />
              <WaiverChip state={waiverStateOf(b.contact)} />
              <WaiverDoorCheckChip check={waiverCheckOf(b.contact)} />
              <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">{t('pendingBadge')}</Badge>
              <div className="flex items-center gap-1">
                <Tip label={t('confirmAttendanceTitle')}>
                  <button onClick={() => confirmBooking(b)} className="p-1.5 rounded-lg hover:bg-green-50 text-muted-foreground hover:text-green-600 transition-colors" aria-label={t('confirmAttendanceTitle')}>
                    <Check className="h-4 w-4" />
                  </button>
                </Tip>
                {/* No confirm step from 'pending': nothing is being undone, and
                    the way back is the Confirm button beside it. */}
                <Tip label={t('markNoShowTitle')}>
                  <button onClick={() => markNoShow(b)} className="p-1.5 rounded-lg hover:bg-orange-50 text-muted-foreground hover:text-orange-600 transition-colors" aria-label={t('markNoShowTitle')}>
                    <UserX className="h-4 w-4" />
                  </button>
                </Tip>
                <Tip label={t('removeBookingTitle')}>
                  <button onClick={() => setPendingRemoval({ kind: 'booking', id: b.id, name: `${b.firstname ?? ''} ${b.lastname ?? ''}`.trim() })} className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors" aria-label={t('removeBookingTitle')}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </Tip>
              </div>
            </div>
          ))}

          {/* Confirmed, with no check-in row behind them — see `confirmedBookings`. */}
          {confirmedBookings.length > 0 && (
            <>
              <div className="px-1 pt-3 pb-1">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t('confirmedSection')}</p>
              </div>
              {confirmedBookings.map((b) => (
                <div key={b.id} className="flex items-center gap-3 py-2.5 border-b last:border-0">
                  <div className="h-9 w-9 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                    {b.firstname?.[0]}{b.lastname?.[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <RosterName contactId={b.contact}>{b.lastname} {b.firstname}</RosterName>
                    {b.email && <p className="text-xs text-muted-foreground">{b.email}</p>}
                  </div>
                  <SeatFundingChip chip={seatChipFor(b.contact)} />
                  <WaiverChip state={waiverStateOf(b.contact)} />
                  <WaiverDoorCheckChip check={waiverCheckOf(b.contact)} />
                  <Badge variant="outline" className="text-xs text-green-600 border-green-300">{t('confirmedBadge')}</Badge>
                  <div className="flex items-center gap-1">
                    <Tip label={t('markNoShowTitle')}>
                      <button onClick={() => setPendingNoShow(b)} className="p-1.5 rounded-lg hover:bg-orange-50 text-muted-foreground hover:text-orange-600 transition-colors" aria-label={t('markNoShowTitle')}>
                        <UserX className="h-4 w-4" />
                      </button>
                    </Tip>
                    <Tip label={t('removeBookingTitle')}>
                      <button onClick={() => setPendingRemoval({ kind: 'booking', id: b.id, name: `${b.firstname ?? ''} ${b.lastname ?? ''}`.trim() })} className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors" aria-label={t('removeBookingTitle')}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  </div>
                </div>
              ))}
            </>
          )}

          {/* No-shows */}
          {noShowBookings.length > 0 && (
            <>
              {(pendingBookings.length > 0 || confirmedBookings.length > 0) && (
                <div className="px-1 pt-3 pb-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t('noShowsSection')}</p>
                </div>
              )}
              {noShowBookings.map((b) => (
                <div key={b.id} className="flex items-center gap-3 py-2.5 border-b last:border-0 opacity-60">
                  <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center text-xs font-bold flex-shrink-0">
                    {b.firstname?.[0]}{b.lastname?.[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <RosterName contactId={b.contact} className="line-through">{b.lastname} {b.firstname}</RosterName>
                  </div>
                  <Badge variant="outline" className="text-xs text-destructive border-destructive/30">{t('noShowBadge')}</Badge>
                  <div className="flex items-center gap-1">
                    <Tip label={t('overrideConfirmAttendanceTitle')}>
                      <button onClick={() => confirmBooking(b)} className="p-1.5 rounded-lg hover:bg-green-50 text-muted-foreground hover:text-green-600 transition-colors" aria-label={t('overrideConfirmAttendanceTitle')}>
                        <Check className="h-4 w-4" />
                      </button>
                    </Tip>
                    <Tip label={t('removeTitle')}>
                      <button onClick={() => setPendingRemoval({ kind: 'booking', id: b.id, name: `${b.firstname ?? ''} ${b.lastname ?? ''}`.trim() })} className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors" aria-label={t('removeTitle')}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Waitlist — the queue behind a full class.
          Shown when the activity runs one (so a coach can see the door is open
          even on a class nobody has queued for yet) or when entries exist at
          all — never on the sessions that have neither, where it would be noise
          on the great majority of classes that never fill. */}
      {(activity?.waitlistEnabled === true || waitlist.length > 0) && (
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <SectionHeader icon={<ListOrdered className="h-3.5 w-3.5" />} label={t('waitlistSection')} count={waitingCount} color="#7C3AED" />

          {waitlistError && (
            <p className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{waitlistError}</p>
          )}

          {waitlist.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">{t('waitlistEmpty')}</p>
          )}

          {waitlist.map((e, i) => {
            const terminal = e.status === 'expired' || e.status === 'left'
            const offerMsLeft = e.offer_expires_at ? e.offer_expires_at.toMillis() - Date.now() : null
            return (
              <div key={e.id} className={`flex items-center gap-3 py-2.5 border-b last:border-0 ${terminal ? 'opacity-50' : ''}`}>
                <div className="h-9 w-9 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center text-xs font-bold flex-shrink-0 tabular-nums">
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <RosterName contactId={e.contact}>{e.lastname} {e.firstname}</RosterName>
                  <p className="text-xs text-muted-foreground truncate">
                    {[e.email, e.phone].filter(Boolean).join(' · ')}
                  </p>
                  {e.joined_at && (
                    <p className="text-xs text-muted-foreground">
                      {t('waitlistWaitingSince', { date: formatDate(e.joined_at) })}
                    </p>
                  )}
                </div>
                {e.status === 'offered' && offerMsLeft !== null && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {offerMsLeft > 0
                      ? t('waitlistOfferExpiresIn', { time: `${Math.max(1, Math.round(offerMsLeft / 60000))} min` })
                      : t('waitlistOfferLapsed')}
                  </span>
                )}
                <Badge
                  variant="outline"
                  className={`text-xs ${e.status === 'offered' ? 'text-amber-600 border-amber-300' : ''}`}
                >
                  {e.status === 'waiting'
                    ? t('waitlistStatusWaiting')
                    : e.status === 'offered'
                      ? t('waitlistStatusOffered')
                      : e.status === 'expired'
                        ? t('waitlistStatusExpired')
                        : t('waitlistStatusLeft')}
                </Badge>
                <div className="flex items-center gap-1">
                  {/* Only ever offered to somebody still WAITING, and only when
                      a seat is genuinely free — the callable re-checks both, but
                      a button that always fails is not a button. */}
                  {e.status === 'waiting' && (
                    <Tip label={freeSeats <= 0 ? t('waitlistOfferNowDisabled') : t('waitlistOfferNow')}>
                      <button
                        onClick={() => callWaitlist('promoteWaitlistEntry', e)}
                        disabled={waitlistBusy !== null || freeSeats <= 0}
                        className="p-1.5 rounded-lg hover:bg-violet-50 text-muted-foreground hover:text-violet-600 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                        aria-label={freeSeats <= 0 ? t('waitlistOfferNowDisabled') : t('waitlistOfferNow')}
                      >
                        <Send className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  )}
                  {!terminal && (
                    <Tip label={t('waitlistRemove')}>
                      <button
                        onClick={() => setWaitlistRemoving(e)}
                        disabled={waitlistBusy !== null}
                        className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30"
                        aria-label={t('waitlistRemove')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Participants / check-ins */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <SectionHeader icon={<CheckCircle2 className="h-3.5 w-3.5" />} label={t('checkInsSection')} count={participants.length} color="#059669" />

        {participantsQ.isLoading && (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        )}

        {!participantsQ.isLoading && participants.length === 0 && (
          <div className="py-8 text-center">
            <Users className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">{t('noCheckInsYet')}</p>
            <button onClick={() => setAddOpen(true)} className="mt-2 text-xs text-primary hover:underline">{t('addContactManually')}</button>
          </div>
        )}

        {participants.map((p) => {
          // The seat behind this attendance row, where there is one. A kiosk or
          // QR check-in has no booking, and there is nothing to mark absent.
          const seat = p.contact ? bookingByContact.get(p.contact) : undefined
          return (
          <div key={p.id} className="flex items-center gap-3 py-2.5 border-b last:border-0">
            <div className="h-9 w-9 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
              {p.firstname?.[0]}{p.lastname?.[0]}
            </div>
            <div className="flex-1 min-w-0">
              <RosterName contactId={p.contact}>{p.lastname} {p.firstname}</RosterName>
              {p.confirmedFromBooking && (
                <p className="text-xs text-muted-foreground">{t('confirmedFromBooking')}</p>
              )}
            </div>
            <SeatFundingChip chip={seatChipFor(p.contact)} />
            {/* A participant row may have NO booking at all — a staff add, or a
                kiosk/self check-in — which is exactly the person whose waiver
                nobody collected. `booking.waiver_state` cannot reach them, so
                this reads the signer row. */}
            <WaiverChip state={waiverStateOf(p.contact)} />
            <WaiverDoorCheckChip check={waiverCheckOf(p.contact)} />
            {/* The capture moment — log a coaching score right after class,
                without first creating a goal through the full form. Needs a
                real contact (a kiosk/QR check-in with no linked contact has
                nowhere to attach a goal). */}
            {p.contact && (
              <Tip label={t('quickLogButtonTitle')}>
                <button
                  onClick={() => setQuickLogTarget({ contactId: p.contact!, name: `${p.firstname ?? ''} ${p.lastname ?? ''}`.trim() })}
                  className="p-1.5 rounded-lg hover:bg-violet-50 text-muted-foreground hover:text-violet-600 transition-colors"
                  aria-label={t('quickLogButtonTitle')}
                >
                  <Gauge className="h-4 w-4" />
                </button>
              </Tip>
            )}
            {/* THE WAY OUT OF 'confirmed'. Without it, a person recorded as
                present could only be un-recorded by deleting the row, which
                left their booking confirmed and unreachable. */}
            {seat && seat.status !== 'no_show' && (
              <Tip label={t('markNoShowFromCheckInTitle')}>
                <button onClick={() => setPendingNoShow(seat)} className="p-1.5 rounded-lg hover:bg-orange-50 text-muted-foreground hover:text-orange-600 transition-colors" aria-label={t('markNoShowFromCheckInTitle')}>
                  <UserX className="h-4 w-4" />
                </button>
              </Tip>
            )}
            <Tip label={t('removeCheckInTitle')}>
              <button onClick={() => setPendingRemoval({ kind: 'participant', id: p.id, contactId: p.contact ?? null, name: `${p.firstname ?? ''} ${p.lastname ?? ''}`.trim() })} className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors" aria-label={t('removeCheckInTitle')}>
                <X className="h-3.5 w-3.5" />
              </button>
            </Tip>
          </div>
          )
        })}
      </div>

      {quickLogTarget && (
        <QuickLogSheet
          open={!!quickLogTarget}
          onOpenChange={(o) => { if (!o) setQuickLogTarget(null) }}
          contactId={quickLogTarget.contactId}
          contactName={quickLogTarget.name}
          dimensions={coachingDimensions}
          onSaved={() => qc.invalidateQueries({ queryKey: ['contact-goals', quickLogTarget.contactId] })}
        />
      )}

      {/* Mobile FAB — add participant */}
      <FloatingSlot lane="page-primary" className="sm:hidden">
        <button
          onClick={() => setAddOpen(true)}
          className="h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary/90 transition-colors"
          aria-label={t('addContact')}
        >
          <UserPlus className="h-6 w-6" />
        </button>
      </FloatingSlot>

      {/* Dialogs */}
      {currentTeamId && (
        <AddParticipantsDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          teamId={currentTeamId}
          sessionId={sessionId}
          existingIds={existingParticipantIds}
          onAdded={() => { invalidate(); setAddOpen(false) }}
          requiredSubscriptionTypeIds={requiredSubIds}
        />
      )}

      {currentTeamId && user && (
        <SessionFormDialog
          key={editOpen ? 'open' : 'closed'}
          open={editOpen}
          onOpenChange={setEditOpen}
          editing={session}
          activities={activities}
          teamId={currentTeamId}
          userId={user.uid}
          onSaved={invalidate}
        />
      )}

      {currentTeamId && user && (
        <SessionFormDialog
          key={duplicateOpen ? 'copy-open' : 'copy-closed'}
          open={duplicateOpen}
          onOpenChange={setDuplicateOpen}
          editing={null}
          duplicating={session}
          activities={activities}
          teamId={currentTeamId}
          userId={user.uid}
          onSaved={invalidate}
        />
      )}

      {/* Removing someone from a queue is destructive and unrecoverable — they
          would have to join again, at the back. Confirmation dialog, like every
          other destructive action here. */}
      <Dialog open={!!waitlistRemoving} onOpenChange={(open) => !open && setWaitlistRemoving(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">{t('waitlistRemove')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('waitlistRemoveConfirm', {
              name: waitlistRemoving
                ? `${waitlistRemoving.firstname ?? ''} ${waitlistRemoving.lastname ?? ''}`.trim()
                : '',
            })}
          </p>
          <div className="flex gap-2 pt-2">
            <button
              onClick={() => {
                const entry = waitlistRemoving
                setWaitlistRemoving(null)
                if (entry) callWaitlist('removeWaitlistEntry', entry)
              }}
              className="flex-1 rounded-lg bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors"
            >
              {t('waitlistRemove')}
            </button>
            <button
              onClick={() => setWaitlistRemoving(null)}
              className="flex-1 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted transition-colors"
            >
              {t('waitlistRemoveCancel')}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Marking a CONFIRMED seat absent. Asks first, because it deletes the
          attendance row a coach recorded and, like every no-show, fires the
          `booking_no_show` automations and a no-show strike against the member.
          The action is disabled while it is in flight: `conversions_count` is a
          bare increment with no absolute writer, so a double click would
          double-decrement it. */}
      <Dialog open={pendingNoShow !== null} onOpenChange={(o) => !o && setPendingNoShow(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('noShowConfirmTitle')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="text-sm text-muted-foreground">
            <p>
              {t('noShowConfirmBody', {
                name: pendingNoShow
                  ? `${pendingNoShow.firstname ?? ''} ${pendingNoShow.lastname ?? ''}`.trim()
                  : '',
              })}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingNoShow(null)} disabled={markingNoShow}>
              {t('noSubConfirmCancel')}
            </Button>
            <Button onClick={confirmNoShow} disabled={markingNoShow}>
              {markingNoShow ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {t('noShowConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* THE CONFIRM STEP. One dialog for both kinds of removal — a booking and
          a check-in are different records but the same question, and two
          dialogs saying nearly the same thing is how their copy drifts apart. */}
      <Dialog open={pendingRemoval !== null} onOpenChange={(o) => !o && setPendingRemoval(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingRemoval?.kind === 'participant'
                ? t('removeCheckInConfirmTitle')
                : t('removeBookingConfirmTitle')}
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3 text-sm text-muted-foreground">
            <p>{t('removeConfirmBody', { name: pendingRemoval?.name ?? '' })}</p>
            {/* THE PAST IS THE CASE THIS DIALOG EXISTS FOR. Removing somebody
                from tomorrow's class frees a seat; removing them from last
                Tuesday's edits the record of who was there. The warning only
                appears when that is what is happening. */}
            {sessionHasEnded && (
              <p className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t('removePastWarning')}</span>
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            {/* `SessionDetail.noSubConfirmCancel`, not `Common.cancel` — the
                Common namespace has no `cancel`, and next-intl renders a
                missing key as its own id. This page already owns a "Cancel". */}
            <Button variant="ghost" onClick={() => setPendingRemoval(null)} disabled={removing}>
              {t('noSubConfirmCancel')}
            </Button>
            <Button variant="destructive" onClick={performRemoval} disabled={removing}>
              {removing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {t('removeConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SessionDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        session={session}
        label={session.activityName ? `${session.activityName} – ${formatDate(session.start)}` : formatDate(session.start)}
        onDeleted={() => { qc.invalidateQueries({ queryKey: ['sessions'] }); router.back() }}
      />
    </div>
  )
}
