'use client'

// Payments dashboard — Stripe Connect member payments + subscriptions for the
// current team (read-only mirror of Stripe, reconciled by the webhook). Managers
// and owners can refund one-off payments here; dispute status is surfaced inline.

import { useSearchParams } from 'next/navigation'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Loader2, Plus, Copy, Check, Search } from 'lucide-react'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { toast } from 'sonner'
import { httpsCallable } from 'firebase/functions'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db, functions } from '@/lib/firebase'
import {
  DEFAULT_PAYMENT_MODES,
  SESSIONS_COLLECTION,
  contactBillingIsUnlinked,
  subscriptionEndsAtMs,
  subscriptionIsCancelling,
  type MemberSubscription,
  type SubscriptionType,
} from '@linyup/shared'

/**
 * The search field, extracted so all three tabs get the SAME control rather
 * than three hand-rolled ones that drift. The payments tab had the only search
 * on this page; the subscriptions and partner-visit tabs now have it too
 * (Franco, 2026-08-23).
 */
/**
 * The payments behind ONE subscription, loaded when the row is opened.
 *
 * ON DEMAND, and that is the whole design: a roster of 200 memberships must not
 * cost 200 payment queries to render. `useContactPayments` is `enabled` only
 * while this component is mounted, so the read happens on the first open and is
 * cached by React Query for every open after it.
 *
 * It reuses the hook the CONTACT page uses, which reads both rails — Connect
 * `member_payments` and BYO `payment_events` — so a studio recording cash
 * against a membership sees those here too. A subscription-only query would
 * have shown an empty list to exactly the studios this page was merged for.
 *
 * ── IT IS THE SAME TABLE, WITH THE SAME ACTIONS ─────────────────────────────
 * This was a hand-rolled read-only list for one revision, and that was the
 * wrong shape: a studio could FIND the payment it wanted to refund here and
 * then had nowhere to go — the Payments tab has no way to jump to a given row,
 * so identifying the charge and acting on it were two separate hunts (Franco,
 * 2026-08-23).
 *
 * So it renders `PaymentsTable` — literally the component the Payments tab
 * uses — with the page's own `onRefund` / `onVoid` / `onAssign` handlers passed
 * straight through. Refund, void, reassign and edit all work here because they
 * are not reimplemented here; there is one table and one set of actions, so
 * they cannot drift. `showContact` is off: the contact is the row this is
 * nested under.
 */
function SubscriptionPayments({
  teamId,
  contactId,
  contactLabel,
  journal,
  onAssign,
  onRefund,
  onVoid,
  t,
}: {
  teamId: string
  contactId: string
  contactLabel: string
  journal?: Map<string, PaymentJournal>
  onAssign: (target: AssignPaymentTarget) => void
  onRefund: (row: UnifiedPaymentRow) => void
  onVoid: (row: UnifiedPaymentRow) => void
  t: ReturnType<typeof useTranslations<'PaymentsDashboard'>>
}) {
  const { data, isLoading } = useContactPayments(teamId, contactId)

  const rows = useMemo(() => {
    if (!data) return []
    // The same two converters and the same merge the page runs — the hook does
    // not order (no orderBy → no composite index), and `mergePaymentRows` is
    // what puts both rails in one date order.
    return mergePaymentRows(connectToUnified(data.payments), byoToUnified(data.events)).slice(0, 12)
  }, [data])

  if (isLoading) return <Skeleton className="h-24 rounded" />
  if (rows.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">{t('noPaymentsForMember')}</p>
  }

  return (
    <PaymentsTable
      rows={rows}
      journal={journal}
      showContact={false}
      contactName={() => contactLabel}
      onAssign={onAssign}
      onRefund={onRefund}
      onVoid={onVoid}
    />
  )
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="relative w-full sm:w-64">
      <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8"
      />
    </div>
  )
}

/** How far back the payments log is read. `null` = everything. */
const PAYMENT_WINDOW_MONTHS = { '1m': 1, '3m': 3, '12m': 12, all: null } as const
type PaymentWindow = keyof typeof PAYMENT_WINDOW_MONTHS
const PAYMENT_WINDOWS = Object.keys(PAYMENT_WINDOW_MONTHS) as PaymentWindow[]

/** The tabs, in order. Named here so `useTabParam` can validate an inbound
 *  `?tab=` against them and fall back rather than opening an empty pane. */
const PAYMENTS_TABS = ['payments', 'subscriptions', 'partnerVisits', 'giftCards'] as const
type PaymentsTabId = (typeof PAYMENTS_TABS)[number]

/** Anything Stripe can still charge for. Same set the contact page's cancel
 *  control uses; a paused subscription is one resume away from billing. */
import { useAuth } from '@/contexts/AuthContext'
import {
  useContactPayments,
  useMemberPayments,
  useMemberSubscriptions,
  usePartnerVisits,
  usePaymentEvents,
  useCreateMembershipPayment,
  LIVE_SUBSCRIPTION_STATUSES,
} from '@/hooks/useConnect'
import { useActiveContacts } from '@/hooks/useActiveContacts'
import { useTabParam } from '@/hooks/useTabParam'
import { useSubscriptionTypes } from '@/hooks/useSubscriptionTypes'
import { useFinanceJournal, type PaymentJournal } from '@/plugins/finance/hooks'
import {
  connectToUnified,
  byoToUnified,
  mergePaymentRows,
  paymentLabel,
  formatMoneyMajor,
  formatMoneyMinor,
  type UnifiedPaymentRow,
} from '@/lib/payments'
import {
  AssignPaymentDialog,
  type AssignPaymentTarget,
} from '@/components/payments/AssignPaymentDialog'
import { ExportFinanceCsvButton } from '@/components/payments/ExportFinanceCsvButton'
import { PageHeader } from '@/components/layout/PageHeader'
import { RecordPaymentDialog } from '@/components/payments/RecordPaymentDialog'
import { RefundPaymentDialog } from '@/components/payments/RefundPaymentDialog'
import { VoidPaymentDialog } from '@/components/payments/VoidPaymentDialog'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { PaymentsTable } from '@/components/payments/PaymentsTable'
import { GiftCardsSection } from '@/components/payments/GiftCardsSection'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { OutstandingFeesCard } from '@/components/payments/OutstandingFeesCard'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { QUICK_ACTION_PARAM } from '@/lib/quickActions'

// The statuses the subscriptions tab lists — ONE definition, on the hook that
// now queries by it, so the query and this page can never disagree.
const LIVE_SUBSCRIPTION_SET = new Set<string>(LIVE_SUBSCRIPTION_STATUSES)

// ─── awaiting-payment appointments ───────────────────────────────────────────
// Manually booked appointments (AppointmentFormDialog → createStaffAppointment)
// whose payment is still open — an offline hold or a Stripe payment link that
// hasn't been paid yet. Distinct from the Connect/BYO payment rails above:
// these are `sessions` docs, not payment records, until they're settled.

interface PendingAppointment {
  id: string
  contact_id?: string | null
  client_name?: string | null
  activityName?: string | null
  providerName?: string | null
  start?: { toDate(): Date } | null
  payment_amount?: number | null
  payment_currency?: string | null
  payment_intent_mode?: 'offline' | 'link' | null
}

function usePendingStaffAppointments(teamId: string | null) {
  return useQuery<PendingAppointment[]>({
    queryKey: ['sessions', 'pending-payment', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, SESSIONS_COLLECTION),
          where('teamId', '==', teamId),
          where('status', '==', 'pending_payment'),
          where('payment_pending', '==', true),
        )
      )
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PendingAppointment)
    },
  })
}

function formatSessionStart(ts: { toDate(): Date } | null | undefined): string {
  if (!ts) return ''
  return ts.toDate().toLocaleString([], {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function PaymentsDashboardPage() {
  const t = useTranslations('PaymentsDashboard')
  // Recurrence labels ("Monthly", "Every 3 months", …) are authored once, in the
  // Contacts namespace, and read from there rather than copied into a second
  // one — four locales of the same six words is four ways for them to drift.
  const tRecurrence = useTranslations('Contacts')
  const tNav = useTranslations('Nav')
  const tPlugins = useTranslations('Plugins')
  const { currentTeamId, team } = useAuth()
  const teamId = currentTeamId ?? null
  const connectReady = !!team?.payments?.connectAccountId

  // Progressive page size — "Load more" bumps it and both rails refetch. Real
  // cursor pagination / server-side filtering comes later; this keeps it usable.
  const [pageSize, setPageSize] = useState(50)
  // ── HOW FAR BACK THE PAYMENT LOG IS READ ───────────────────────────────────
  // Payments only accumulate, so at any real volume the question is not "how
  // many rows" but "how far back". Three months is the default because it spans
  // a quarter end, which is the longest thing a studio routinely reconciles;
  // everything shorter is a click away and "All time" is always reachable —
  // without it the search box would go back to lying about what it looked at.
  const [windowKey, setWindowKey] = useState<PaymentWindow>('3m')
  const sinceMs = useMemo(() => {
    const months = PAYMENT_WINDOW_MONTHS[windowKey]
    if (months === null) return null
    const d = new Date()
    d.setMonth(d.getMonth() - months)
    return d.getTime()
  }, [windowKey])

  const {
    data: payments = [],
    isLoading,
    isFetching: fetchingPayments,
  } = useMemberPayments(teamId, pageSize, sinceMs)
  const {
    data: events = [],
    isLoading: loadingEvents,
    isFetching: fetchingEvents,
  } = usePaymentEvents(teamId, pageSize, sinceMs)
  const { data: subscriptions = [] } = useMemberSubscriptions(teamId)
  const { data: contacts = [] } = useActiveContacts(teamId)
  const { data: pendingAppointments = [] } = usePendingStaffAppointments(teamId)
  const { data: subscriptionTypes = [] } = useSubscriptionTypes(teamId)
  const { data: partnerVisits = [] } = usePartnerVisits(teamId)
  const { isInstalled } = useInstalledPlugins()
  // The journal, on the SAME window as the payments it annotates — so the two
  // can never be describing different periods. Not fetched at all without the
  // plugin: a studio that does not keep books pays nothing for this.
  const { data: journal } = useFinanceJournal(teamId, sinceMs, isInstalled('finance'))

  // "Partner visits" card only makes sense once the team has at least one
  // aggregator (FitPass/SportPass-style) subscription type configured.
  const hasAggregatorType = subscriptionTypes.some((ty) => ty.source === 'aggregator')
  const currency = team?.default_currency ?? 'CHF'

  const [tab, setTab] = useTabParam(PAYMENTS_TABS, 'payments')
  // One search box PER TAB, each over its own rows. Deliberately not one shared
  // box: the tabs hold different things, and a query that survives a tab switch
  // silently filters a list the studio has not looked at yet.
  const [subSearch, setSubSearch] = useState('')
  const [subFilter, setSubFilter] = useState<'all' | 'attention'>('all')
  const [visitSearch, setVisitSearch] = useState('')
  /** Which subscription row is expanded — one at a time; see SubscriptionPayments. */
  const [openSubRow, setOpenSubRow] = useState<string | null>(null)

  const [refundTarget, setRefundTarget] = useState<UnifiedPaymentRow | null>(null)
  const [voidTarget, setVoidTarget] = useState<UnifiedPaymentRow | null>(null)
  const [assignTarget, setAssignTarget] = useState<AssignPaymentTarget | null>(null)
  // Opened straight from the dashboard's quick action. Read ONCE, in a lazy
  // initializer, so clearing the param or closing the dialog is not undone by
  // the next render — the same shape as `openOnAttention` on the contacts list.
  const quickActionParams = useSearchParams()
  const [recordOpen, setRecordOpen] = useState(
    () => quickActionParams.get(QUICK_ACTION_PARAM) === '1'
  )
  const [markPaidTarget, setMarkPaidTarget] = useState<PendingAppointment | null>(null)
  const [filter, setFilter] = useState<'all' | 'unassigned'>('all')
  const [search, setSearch] = useState('')

  const contactName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of contacts) {
      m.set(c.id, `${c.firstname ?? ''} ${c.lastname ?? ''}`.trim() || c.email || c.id)
    }
    return m
  }, [contacts])

  /**
   * EVERY MEMBERSHIP, from both sides, keyed by the CONTACT.
   *
   * A contact holding a plan is a row whether or not Stripe is billing them —
   * that is what makes this usable by a cash-only studio. A live Stripe
   * subscription whose contact holds no matching plan is ALSO a row, flagged,
   * because that divergence (`contactBillingIsUnlinked`) is money moving that
   * nobody has accounted for, and this is the one screen where it is visible in
   * aggregate rather than one contact at a time.
   */
  const subscriptionRows = useMemo(() => {
    const byContact = new Map<string, MemberSubscription>()
    for (const sub of subscriptions) {
      if (sub.duplicate || !sub.contactId) continue
      if (!LIVE_SUBSCRIPTION_SET.has(sub.status as string)) continue
      // The most live one wins when a contact somehow holds several.
      if (!byContact.has(sub.contactId)) byContact.set(sub.contactId, sub)
    }

    const rows: Array<{
      key: string
      contactId: string | null
      name: string
      planName: string
      amount: number | null
      recurrence: string | null
      sub: MemberSubscription | null
      unlinked: boolean
      needsAttention: boolean
    }> = []

    /**
     * WHAT "NEEDS ATTENTION" MEANS HERE — three things, each one a decision the
     * studio has to make and none of them visible from the amount:
     *   past_due   an invoice failed; the card needs chasing
     *   cancelling still live, will not renew; the win-back window is open and
     *              has a deadline
     *   unlinked   Stripe is billing for a plan nobody holds (see
     *              `contactBillingIsUnlinked`) — money moving unaccounted for
     * Defined once, read by both the chip's count and the rows it filters.
     */
    const attention = (sub: MemberSubscription | null, unlinked: boolean) =>
      unlinked || sub?.status === 'past_due' || (!!sub && subscriptionIsCancelling(sub))

    for (const c of contacts) {
      const sub = byContact.get(c.id) ?? null
      if (!c.subscription_type_id && !sub) continue
      byContact.delete(c.id)
      rows.push({
        key: c.id,
        contactId: c.id,
        name: contactName.get(c.id) ?? t('unknownMember'),
        planName:
          c.subscription_type_name ?? sub?.subscriptionTypeName ?? t('membership'),
        // The contact stores MAJOR units, the subscription Rappen — normalise to
        // minor here so the one formatter below is right for both.
        amount:
          typeof c.subscription_amount === 'number'
            ? Math.round(c.subscription_amount * 100)
            : (sub?.amount ?? null),
        recurrence: c.subscription_recurrence ?? sub?.recurrence ?? null,
        sub,
        unlinked: contactBillingIsUnlinked(c),
        needsAttention: attention(sub, contactBillingIsUnlinked(c)),
      })
    }

    // Whatever is left is billing with no contact row we could match.
    for (const [contactId, sub] of byContact) {
      rows.push({
        key: contactId,
        contactId,
        name: contactName.get(contactId) ?? t('unknownMember'),
        planName: sub.subscriptionTypeName ?? t('membership'),
        amount: sub.amount ?? null,
        recurrence: sub.recurrence ?? null,
        sub,
        unlinked: true,
        needsAttention: true,
      })
    }

    return rows.sort((a, b) => a.name.localeCompare(b.name))
  }, [contacts, subscriptions, contactName, t])

  // HONEST BY CONSTRUCTION. `subscriptionRows` is the COMPLETE roster (the hook
  // no longer caps it), so filtering it here cannot hide a match the way the
  // payments search can — there is nothing beyond what is loaded.
  const subAttentionCount = useMemo(
    () => subscriptionRows.filter((r) => r.needsAttention).length,
    [subscriptionRows]
  )

  const filteredSubscriptionRows = useMemo(() => {
    const base =
      subFilter === 'attention' ? subscriptionRows.filter((r) => r.needsAttention) : subscriptionRows
    const q = subSearch.trim().toLowerCase()
    if (!q) return base
    return base.filter((r) =>
      [r.name, r.planName, r.recurrence ?? '', r.sub?.status ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [subscriptionRows, subSearch, subFilter])

  const filteredPartnerVisits = useMemo(() => {
    const q = visitSearch.trim().toLowerCase()
    if (!q) return partnerVisits
    return partnerVisits.filter((v) =>
      [
        v.contactId ? (contactName.get(v.contactId) ?? '') : '',
        v.subscription_type_name ?? '',
        v.activity_name ?? '',
        v.status ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [partnerVisits, visitSearch, contactName])

  const rows = useMemo(
    () => mergePaymentRows(connectToUnified(payments), byoToUnified(events)),
    [payments, events]
  )
  const unassignedCount = rows.filter((r) => !r.assigned).length

  // Apply the all/unassigned filter + free-text search (over the loaded rows).
  const filtered = useMemo(() => {
    let list = filter === 'unassigned' ? rows.filter((r) => !r.assigned) : rows
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter((r) =>
        [
          paymentLabel(r),
          r.paymentMode ?? '',
          r.contactId ? (contactName.get(r.contactId) ?? '') : '',
          r.email ?? '',
          r.comment ?? '',
          (r.amount / 100).toString(),
        ]
          .join(' ')
          .toLowerCase()
          .includes(q)
      )
    }
    return list
  }, [rows, filter, search, contactName])

  const loading = isLoading || loadingEvents
  // A full page from either rail hints there may be more to fetch.
  const hasMore = payments.length >= pageSize || events.length >= pageSize
  const fetchingMore = fetchingPayments || fetchingEvents

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* THE SHARED HEADER, like Activities and Subscription plans (Franco,
          2026-08-23). This page hand-rolled its own heading with the Finance
          link as an icon-and-caption underneath — a third heading shape on a
          page that sits beside two that already agree. The Finance pointer is
          exactly what `quickLinks` is for: the page that CONFIRMS what this one
          records, phrased as why you would open it rather than as its name. */}
      {/* "Payments", matching the nav row that opens it. The heading used to
          spell out "Payments & Subscriptions" to explain that the two had been
          merged into one destination; the nav stopped doing that, and a sidebar
          and the page it opens must not call the same place two different
          things. Subscriptions are still here — they are a tab. */}
      <PageHeader
        title={t('title')}
        quickLinks={[
          {
            // The destination's NAME, like every other row in this line — the
            // sentence it used to carry ("View in your books") read as a
            // different kind of thing beside the plain names beside it. The
            // href still falls back to the marketplace when Finance is not
            // installed, so the way in survives.
            href: (isInstalled('finance')
              ? '/plugins/finance'
              : '/settings/plugins?plugin=finance') as Route,
            label: tPlugins('financeNavLabel'),
          },
          // What is being charged FOR, and where the charging is configured —
          // the two questions a payments list sends you to answer.
          { href: '/offer/plans' as Route, label: tNav('subscriptionPlans') },
          { href: '/settings/team?tab=payments' as Route, label: tNav('teamPayments') },
        ]}
        action={
          <>
            {teamId && isInstalled('finance') && <ExportFinanceCsvButton teamId={teamId} />}
            {teamId && (
              <Button size="sm" variant="outline" onClick={() => setRecordOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                {t('recordButton')}
              </Button>
            )}
            {teamId && connectReady && <CreatePaymentLinkDialog teamId={teamId} />}
          </>
        }
      />

      {/* Awaiting payment — manually booked appointments (AppointmentFormDialog)
          with an open offline hold or an unpaid payment link. Empty renders
          nothing — no noise once everything's settled. */}
      {pendingAppointments.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">{t('awaitingPaymentHeading')}</h2>
          <Card>
            <CardContent className="p-0 divide-y">
              {pendingAppointments.map((s) => (
                <div key={s.id} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">
                      {s.client_name || t('unassigned')}
                      {s.activityName && (
                        <span className="font-normal text-muted-foreground"> · {s.activityName}</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {formatSessionStart(s.start)}
                      {s.providerName ? ` · ${s.providerName}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm font-medium">
                      {formatMoneyMinor(s.payment_amount, s.payment_currency ?? 'CHF')}
                    </span>
                    <Badge variant={s.payment_intent_mode === 'link' ? 'secondary' : 'outline'}>
                      {s.payment_intent_mode === 'link'
                        ? t('awaitingPaymentLinkSent')
                        : t('awaitingPaymentOffline')}
                    </Badge>
                    {/* "Mark paid" is offered on BOTH rails (UX-59). A link that
                        was never used is the commonest way an appointment ends
                        up unsettleable: the client pays cash at the door, the
                        webhook never fires, and Stripe's 7-day expiry silently
                        deletes the booking. The callable expires the link before
                        it records the cash, and warns if it could not. */}
                    <Button size="sm" variant="outline" onClick={() => setMarkPaidTarget(s)}>
                      {t('markPaid')}
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      {/* No-show policy fees — pinned with "Awaiting payment" above the tabs:
          both are money still owed, and an action item buried behind a tab is
          an action item nobody sees. Costs nothing when settled — the card
          hides itself once there's nothing outstanding. */}
      <OutstandingFeesCard />

      {/* The record surfaces are tabbed rather than stacked: one-off payments
          and partner visits both grow without bound, so stacking them buried
          gift cards (and each other) under an ever-longer scroll. Tabs stay
          conditional exactly as the sections were — a studio with no
          aggregator deal never sees "Partner visits". Headings are dropped
          inside the tabs: the tab label already names each surface. */}
      {/* THE TAB IS IN THE URL. `/subscriptions` now redirects here with
          `?tab=subscriptions`, so the merge cannot cost anybody their bookmark —
          and the tab a studio is looking at survives a refresh, a Back and a
          pasted link like every other tabbed surface in the app. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as PaymentsTabId)} className="gap-6">
        <TabsList>
          {/* NOT "One-off payments", which is what this said and what the tab
              has never been: a subscription RENEWAL writes a member_payments row
              like any other charge (`kind: 'subscription'`, written by the
              invoice.paid handler), so the label was telling a studio its
              membership income was a one-off sale. The old key is left in the
              locale files rather than rewritten, so nothing that still reads it
              changes meaning under it. */}
          <TabsTrigger value="payments">{t('allPaymentsHeading')}</TabsTrigger>
          {/* ALWAYS SHOWN. It used to appear only when Stripe had billed
              somebody, so a cash-only studio never saw its own members here. */}
          <TabsTrigger value="subscriptions">{t('subscriptionsHeading')}</TabsTrigger>
          {hasAggregatorType && (
            <TabsTrigger value="partnerVisits">{t('partnerVisitsHeading')}</TabsTrigger>
          )}
          {isInstalled('gift-cards') && (
            <TabsTrigger value="giftCards">{t('giftCardsHeading')}</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="payments" className="space-y-6">
          {/* Toolbar: filter + search */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={filter === 'all' ? 'default' : 'outline'}
              onClick={() => setFilter('all')}
            >
              {t('filterAll')}
            </Button>
            <Button
              size="sm"
              variant={filter === 'unassigned' ? 'default' : 'outline'}
              onClick={() => setFilter('unassigned')}
            >
              {t('filterUnassigned')}
              {unassignedCount > 0 && (
                <Badge variant="secondary" className="ml-1.5">
                  {unassignedCount}
                </Badge>
              )}
            </Button>
            {/* THE WINDOW IS NAMED, beside the search it bounds. That pairing
                is the whole point: a search box whose reach is invisible is the
                thing that makes an empty result read as "does not exist". */}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Select value={windowKey} onValueChange={(v) => setWindowKey(v as PaymentWindow)}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_WINDOWS.map((w) => (
                    <SelectItem key={w} value={w}>
                      {t(`window_${w}` as 'window_3m')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <SearchBox value={search} onChange={setSearch} placeholder={t('searchPlaceholder')} />
            </div>
          </div>

          {/* Payments table (Connect + BYO, unified) */}
          <section className="space-y-3">
            {loading ? (
              <Skeleton className="h-40 rounded" />
            ) : filtered.length === 0 ? (
              <div className="space-y-2 py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  {search
                    ? t('noResults')
                    : filter === 'unassigned'
                      ? t('noUnassigned')
                      : t('noPayments')}
                </p>
                {/* THE ONE THING THAT TURNS A LIE INTO A SIGNPOST. A search that
                    found nothing INSIDE the window says so and offers the rest,
                    instead of letting "no results" be read as "no such payment".
                    Only while a window is actually on. */}
                {search && windowKey !== 'all' && (
                  <Button variant="outline" size="sm" onClick={() => setWindowKey('all')}>
                    {t('searchAllTime')}
                  </Button>
                )}
              </div>
            ) : (
              <>
                <PaymentsTable
                  rows={filtered}
                  journal={journal}
                  contactName={(id) => contactName.get(id)}
                  onAssign={setAssignTarget}
                  onRefund={setRefundTarget}
                  onVoid={setVoidTarget}
                />

                {hasMore && (
                  <div className="flex justify-center">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPageSize((p) => p + 50)}
                      disabled={fetchingMore}
                    >
                      {fetchingMore && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                      {t('loadMore')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        </TabsContent>

        {/* ── SUBSCRIPTIONS: ONE LIST, BOTH POPULATIONS ────────────────────
            Two lists used to describe "subscriptions" and neither was the whole
            answer. THIS tab read `member_subscriptions` — Stripe's recurring
            billing — so a studio taking cash saw nothing at all. The separate
            `/subscriptions` page read CONTACTS, so it saw the cash members and
            knew nothing about renewals, freezes or cancellations. A studio with
            both kinds of member had to hold two screens in their head and work
            out which one a given person was on.

            It is one list now, keyed by the CONTACT, because the contact is the
            thing both halves are about. The billing detail rides along on the
            rows that have it.

            IT ALSO SHOWS THE ORPHANS: a live Stripe subscription whose contact
            holds no matching plan gets a row with a warning — the divergence
            `contactBillingIsUnlinked` names, otherwise visible only one contact
            at a time.

            SAME TABLE AS PAYMENTS, deliberately (Franco, 2026-08-23). The two
            tabs are the same studio looking at the same people from two angles,
            and a card-list beside a table read as two different products. Same
            `Table` primitives, same column rhythm — who, what, status, amount —
            so moving between the tabs costs no re-reading. */}
        <TabsContent value="subscriptions" className="space-y-3">
          {/* SAME TOOLBAR SHAPE AS THE PAYMENTS TAB: filter chips left, search
              right. It had the search on the left and nothing else, so the two
              tabs put the same control in two places — the kind of difference a
              studio feels without being able to name it. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={subFilter === 'all' ? 'default' : 'outline'}
              onClick={() => setSubFilter('all')}
            >
              {t('filterAll')}
            </Button>
            <Button
              size="sm"
              variant={subFilter === 'attention' ? 'default' : 'outline'}
              onClick={() => setSubFilter('attention')}
            >
              {t('filterNeedsAttention')}
              {subAttentionCount > 0 && (
                <Badge variant="secondary" className="ml-1.5">
                  {subAttentionCount}
                </Badge>
              )}
            </Button>
            <div className="ml-auto">
              <SearchBox
                value={subSearch}
                onChange={setSubSearch}
                placeholder={t('searchSubscriptions')}
              />
            </div>
          </div>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {/* WHO, then WHAT — the same order the Payments table
                        beside it reads in, so moving between the two tabs costs
                        no re-reading. */}
                    <TableHead>{t('colContact')}</TableHead>
                    <TableHead>{t('colPlan')}</TableHead>
                    <TableHead>{t('colRenewal')}</TableHead>
                    <TableHead>{t('colStatus')}</TableHead>
                    <TableHead className="text-right">{t('colAmount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSubscriptionRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                        {/* EMPTY IS THE GOOD ANSWER under the attention filter,
                            and it has to read as one — "Nobody holds a
                            subscription yet" there would be simply false. */}
                        {subFilter === 'attention' && !subSearch
                          ? t('noSubscriptionsNeedAttention')
                          : t('subscriptionsEmpty')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredSubscriptionRows.map((row) => {
                      const endsAtMs = row.sub ? subscriptionEndsAtMs(row.sub) : null
                      const cancelling = row.sub ? subscriptionIsCancelling(row.sub) : false
                      const paused = !!row.sub?.pause_collection
                      const expanded = openSubRow === row.key
                      return (
                        <Fragment key={row.key}>
                        <TableRow
                          className={row.contactId ? 'cursor-pointer' : undefined}
                          onClick={() =>
                            row.contactId && setOpenSubRow(expanded ? null : row.key)
                          }
                        >
                          <TableCell className="max-w-[220px]">
                            {/* THE CARET IS ITS OWN TARGET, inline with the name
                                and held apart from it. Two different things
                                happen here — expand, and open the contact — and
                                with the caret tight against the link the wrong
                                one was one pixel away. It stays in this cell
                                rather than taking a column of its own: a column
                                would push the money right for a control that is
                                three characters wide. */}
                            <div className="flex items-center gap-2">
                              {row.contactId ? (
                                <button
                                  type="button"
                                  aria-label={t(expanded ? 'collapseRow' : 'expandRow')}
                                  aria-expanded={expanded}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setOpenSubRow(expanded ? null : row.key)
                                  }}
                                  className="-ml-1 shrink-0 rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
                                >
                                  <ChevronDown
                                    className={`h-3.5 w-3.5 transition-transform ${
                                      expanded ? '' : '-rotate-90'
                                    }`}
                                  />
                                </button>
                              ) : (
                                <span className="w-[1.375rem] shrink-0" />
                              )}
                              {row.contactId ? (
                                <Link
                                  href={`/contacts/${row.contactId}` as Route}
                                  onClick={(e) => e.stopPropagation()}
                                  className="min-w-0 truncate font-medium text-primary hover:underline"
                                >
                                  {row.name}
                                </Link>
                              ) : (
                                <span className="min-w-0 truncate">{row.name}</span>
                              )}
                            </div>
                            {row.unlinked && (
                              <Badge
                                variant="outline"
                                className="mt-0.5 border-amber-300 font-normal text-amber-700"
                              >
                                {t('billingUnlinkedTitle')}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[220px]">
                            {/* The plan NAME only. The recurrence used to sit
                                under it and has moved to the amount, where a
                                recurring price is actually read: "CHF 89.00,
                                monthly" is one fact, and it was split across two
                                columns (Franco, 2026-08-23). */}
                            <div className="truncate">{row.planName}</div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {/* WHETHER and WHEN asked separately — a pre-migration
                                doc is plainly cancelling with no date to give. */}
                            {cancelling ? (
                              <span className="text-amber-600">
                                {endsAtMs !== null
                                  ? t('subCancelsOn', {
                                      date: new Date(endsAtMs).toLocaleDateString(),
                                    })
                                  : t('subCancelsAtPeriodEnd')}
                              </span>
                            ) : row.sub?.current_period_end ? (
                              t('subRenewsOn', {
                                date: row.sub.current_period_end.toDate().toLocaleDateString(),
                              })
                            ) : (
                              '—'
                            )}
                          </TableCell>
                          <TableCell>
                            {row.sub ? (
                              <Badge variant="secondary">
                                {paused ? t('subStatus_paused') : row.sub.status}
                              </Badge>
                            ) : (
                              /* No Stripe subscription behind it: assigned by
                                 hand, or paid outside Linyup. Says so rather
                                 than leaving a blank where every other row has
                                 a status. */
                              <Badge variant="outline" className="font-normal text-muted-foreground">
                                {t('subOffline')}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right tabular-nums">
                            <div>
                              {row.amount !== null ? formatMoneyMinor(row.amount, currency) : '—'}
                            </div>
                            {/* Reuses the recurrence labels the rest of the app
                                already has rather than inventing a "/ month"
                                suffix in four locales. Same shape as the
                                payments table's amount cell, which carries the
                                fee on a second muted line. */}
                            {row.recurrence && (
                              <div className="text-xs font-normal text-muted-foreground">
                                {tRecurrence(`recurrence_${row.recurrence}` as 'recurrence_monthly')}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                        {expanded && row.contactId && (
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell colSpan={5} className="p-3">
                              <SubscriptionPayments
                                teamId={teamId!}
                                contactId={row.contactId}
                                contactLabel={row.name}
                                journal={journal}
                                onAssign={setAssignTarget}
                                onRefund={setRefundTarget}
                                onVoid={setVoidTarget}
                                t={t}
                              />
                            </TableCell>
                          </TableRow>
                        )}
                        </Fragment>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        </TabsContent>

        {/* Partner (aggregator) visit payouts — reporting only; the money
            settles between studio and partner off-platform (FitPass/SportPass…).
            Only shown once the team has an aggregator subscription type. */}
        {hasAggregatorType && (
          <TabsContent value="partnerVisits" className="space-y-3">
            {/* No chips here — a partner visit has one axis (booked or
                cancelled) and it is already on every row. The search still sits
                right, so the three tabs agree on where it is. */}
            <div className="flex justify-end">
              <SearchBox
                value={visitSearch}
                onChange={setVisitSearch}
                placeholder={t('searchPartnerVisits')}
              />
            </div>
            <Card>
              <CardContent className="p-0 divide-y">
                {filteredPartnerVisits.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    {t('partnerVisitsEmpty')}
                  </p>
                ) : (
                  filteredPartnerVisits.map((v) => {
                    const cancelled = v.status === 'cancelled'
                    return (
                      <div
                        key={`${v.sessionId}_${v.contactId}`}
                        className={`flex items-center gap-3 p-3 ${cancelled ? 'text-muted-foreground' : ''}`}
                      >
                        <div className={`min-w-0 flex-1 ${cancelled ? 'line-through' : ''}`}>
                          <p className="text-sm font-medium truncate">
                            {v.activity_name || t('unassigned')}
                            {v.subscription_type_name && (
                              <span className="font-normal text-muted-foreground">
                                {' '}
                                · {v.subscription_type_name}
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {formatSessionStart(v.session_start)}
                          </p>
                        </div>
                        <div className={`shrink-0 text-sm font-medium ${cancelled ? 'line-through' : ''}`}>
                          {typeof v.amount === 'number'
                            ? formatMoneyMajor(v.amount, currency)
                            : t('partnerVisitsRateNotSet')}
                        </div>
                      </div>
                    )
                  })
                )}
              </CardContent>
            </Card>
            {partnerVisits.length > 0 && (
              <p className="text-sm text-muted-foreground text-right">
                {t('partnerVisitsTotal', {
                  amount: formatMoneyMajor(
                    partnerVisits.reduce(
                      (sum, v) => sum + (v.status !== 'cancelled' ? (v.amount ?? 0) : 0),
                      0
                    ),
                    currency
                  ),
                })}
              </p>
            )}
          </TabsContent>
        )}

        {/* Gift cards — settings + recent cards, behind the gift-cards plugin
            (Wave 3.5). Being ungated was the point: every new studio met a
            gift-card tab before it had a member. Discovery moved to the plugin
            marketplace card, which is a better place to explain it anyway.

            Uninstalling hides SELLING, never redeeming: an outstanding card is
            money already taken (see utils/plugins.ts). */}
        {isInstalled('gift-cards') && (
          <TabsContent value="giftCards">
            <GiftCardsSection showHeading={false} />
          </TabsContent>
        )}
      </Tabs>

      {teamId && (
        <AssignPaymentDialog
          teamId={teamId}
          target={assignTarget}
          onClose={() => setAssignTarget(null)}
        />
      )}

      {teamId && (
        <RecordPaymentDialog
          teamId={teamId}
          open={recordOpen}
          onClose={() => setRecordOpen(false)}
        />
      )}

      {teamId && (
        <MarkPaidDialog
          teamId={teamId}
          target={markPaidTarget}
          onClose={() => setMarkPaidTarget(null)}
        />
      )}

      {teamId && (
        <RefundPaymentDialog
          teamId={teamId}
          target={refundTarget}
          memberName={refundTarget?.contactId ? contactName.get(refundTarget.contactId) : null}
          onClose={() => setRefundTarget(null)}
        />
      )}

      {teamId && (
        <VoidPaymentDialog
          teamId={teamId}
          target={voidTarget}
          memberName={voidTarget?.contactId ? contactName.get(voidTarget.contactId) : null}
          onClose={() => setVoidTarget(null)}
        />
      )}
    </div>
  )
}

// ─── create payment link dialog ──────────────────────────────────────────────────
// Pick one of the team's subscription types + a price and a member email; the
// returned Checkout URL is shared with the member to pay.
function CreatePaymentLinkDialog({ teamId }: { teamId: string }) {
  const t = useTranslations('PaymentsDashboard')
  const tc = useTranslations('Contacts')
  const locale = useLocale()
  const { team } = useAuth()
  const currency = team?.default_currency ?? 'CHF'

  const { data: types = [] } = useSubscriptionTypes(teamId)
  const create = useCreateMembershipPayment()

  const [open, setOpen] = useState(false)
  const [typeId, setTypeId] = useState('')
  const [priceId, setPriceId] = useState('')
  const [email, setEmail] = useState('')
  const [url, setUrl] = useState('')
  const [copied, setCopied] = useState(false)

  const sellableTypes = useMemo(
    () =>
      types.filter(
        (ty) => ty.active !== false && (ty.prices ?? []).some((p) => p.active !== false)
      ),
    [types]
  )
  const selectedType: SubscriptionType | undefined = sellableTypes.find((ty) => ty.id === typeId)
  const prices = (selectedType?.prices ?? []).filter((p) => p.active !== false)

  function fmt(amount: number) {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount)
  }

  function reset() {
    setTypeId('')
    setPriceId('')
    setEmail('')
    setUrl('')
    setCopied(false)
  }

  async function generate() {
    if (!typeId || !priceId) return
    const res = await create.mutateAsync({
      teamId,
      subscriptionTypeId: typeId,
      priceId,
      customerEmail: email.trim() || undefined,
      locale,
    })
    setUrl(res.url)
  }

  async function copy() {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-1" />
        {t('createLink')}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('createLinkTitle')}</DialogTitle>
        </DialogHeader>

        {url ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('linkReady')}</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={url} className="flex-1 text-xs" />
              <Button size="sm" variant="outline" onClick={copy}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('selectType')}</Label>
              <Select
                value={typeId}
                onValueChange={(v) => {
                  setTypeId(v ?? '')
                  setPriceId('')
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('selectType')} />
                </SelectTrigger>
                <SelectContent>
                  {sellableTypes.map((ty) => (
                    <SelectItem key={ty.id} value={ty.id}>
                      {ty.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t('selectPrice')}</Label>
              <Select
                value={priceId}
                onValueChange={(v) => setPriceId(v ?? '')}
                disabled={!selectedType}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('selectPrice')} />
                </SelectTrigger>
                <SelectContent>
                  {prices.map((p) => (
                    <SelectItem
                      key={p.id}
                      value={p.id}
                      label={
                        `${fmt(p.amount)} · ${tc(`recurrence_${p.recurrence}` as never)}` +
                        (p.included_months ? ` (${p.included_months} ${t('monthsShort')})` : '') +
                        (p.label ? ` — ${p.label}` : '')
                      }
                    />
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t('memberEmail')}</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="member@example.com"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {url ? (
            <Button onClick={() => setOpen(false)}>{t('done')}</Button>
          ) : (
            <Button onClick={generate} disabled={!typeId || !priceId || create.isPending}>
              {create.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {t('generate')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── mark an awaiting-payment appointment as paid (offline) ─────────────────
// Small confirm: pick the studio-configured method the client actually paid
// with, then call markAppointmentPaid.
//
// IT COVERS PAYMENT-LINK ROWS TOO (UX-59). They used to be excluded on the
// theory that "the Connect webhook settles those on its own" — true only if the
// client actually uses the link. Pay cash at the door instead and nothing
// settled it: the row sat there until Stripe's 7-day expiry cancelled the
// appointment, and the money was never recorded at all. The callable expires the
// link before it records the cash; the three outcomes it can report are all
// surfaced below, because "recorded, but the link may still be live" is not the
// same message as "recorded".
function MarkPaidDialog({
  teamId,
  target,
  onClose,
}: {
  teamId: string
  target: PendingAppointment | null
  onClose: () => void
}) {
  const t = useTranslations('PaymentsDashboard')
  const { team } = useAuth()
  const qc = useQueryClient()
  const modes = useMemo(
    () =>
      team?.payment_modes && team.payment_modes.length > 0
        ? team.payment_modes
        : [...DEFAULT_PAYMENT_MODES],
    [team?.payment_modes]
  )
  const [method, setMethod] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (target) setMethod(modes[0] ?? '')
    // modes is derived from team config; intentionally not a reset trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id])

  async function confirm() {
    if (!target || !method) return
    setSubmitting(true)
    try {
      const fn = httpsCallable<
        { teamId: string; sessionId: string; method: string },
        { ok: boolean; recorded: boolean; reason?: string; linkStillOpen?: boolean }
      >(functions, 'markAppointmentPaid')
      const res = await fn({ teamId, sessionId: target.id, method })
      if (res.data?.recorded === false) {
        // The client paid the link in the seconds before this call. Nothing was
        // recorded on purpose — the webhook owns that money — and saying
        // "recorded" here would send the manager looking for a row that must
        // never exist.
        toast.success(t('markPaidAlreadyOnline'))
      } else if (res.data?.linkStillOpen) {
        toast.warning(t('markPaidLinkStillOpen'), { duration: 10_000 })
      } else {
        toast.success(t('markPaidSuccess'))
      }
      qc.invalidateQueries({ queryKey: ['sessions'] })
      onClose()
    } catch (err) {
      toast.error(t('markPaidError', { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('markPaidTitle')}</DialogTitle>
        </DialogHeader>
        {/* Said BEFORE the click, because it is a side effect on something the
            client already has in their inbox. */}
        {target?.payment_intent_mode === 'link' && (
          <p className="text-xs text-muted-foreground">{t('markPaidClosesLink')}</p>
        )}
        <div className="space-y-1.5">
          <Label>{t('markPaidMethodLabel')}</Label>
          <Select value={method} onValueChange={(v) => setMethod(v ?? '')}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('methodPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {modes.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={confirm} disabled={submitting || !method}>
            {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {t('markPaidConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
