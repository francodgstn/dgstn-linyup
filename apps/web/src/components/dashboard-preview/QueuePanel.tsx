'use client'

/**
 * THE QUEUE — one block per QUESTION, not one block per collection.
 *
 * This is where this design differs from the incumbent in kind rather than
 * degree. The incumbent has a "needs attention" list of contacts, a figure
 * counting unfiled payments, and a setup checklist band — three blocks, in
 * three places, in two materials, all answering the same question: *what is
 * waiting on a human here?* They are one list on this page.
 *
 * ── WHY IT GREW TABS ─────────────────────────────────────────────────────────
 *
 * One list was right while everything in it was a PERSON. Bookings broke that:
 * a seat nobody has approved is work of a different kind, arrives at a
 * different rate, and is read by a different reflex — and interleaving it with
 * "gone quiet" by an urgency score would have buried whichever the studio cared
 * about that morning. So the question splits three ways, and the ORDER of the
 * split is the old ordering made visible:
 *
 *  - **Bookings** — the fastest-moving, and the only tab whose items arrive
 *    from outside. A seat awaiting approval, plus anything that arrived since
 *    the studio last looked.
 *  - **Contacts** — people, ranked by the SHARED comparator
 *    (`compareContactsByAttention`), so the top rows here are the top of the
 *    contacts page's own Needs-attention view; no second definition of urgency
 *    exists.
 *  - **Other** — housekeeping. Unfiled payments and unfinished setup are real
 *    work and exactly as urgent tomorrow, which is why they were under a
 *    hairline before and are behind a tab now.
 *
 * EVERY ROW SAYS WHY. A name with no reason is a list nobody trusts.
 *
 * ── THE DOT IS NOT THE COUNT ─────────────────────────────────────────────────
 *
 * A tab's number says HOW MANY are waiting. Its dot says SOMETHING HERE IS NEW
 * SINCE YOU LOOKED. They move independently on purpose: a studio that has seen
 * its twelve quiet members does not need twelve to pulse at it every morning,
 * and the thirteenth still has to be able to.
 *
 * "New" is measured against the keys in `teams/{teamId}/queue_seen/current`,
 * NOT against a timestamp — `packages/shared/src/types/dashboardQueue.ts` owns
 * the reasoning, and it is worth reading before touching any of this: half the
 * reasons on the Contacts tab become true because a clock ticked, so there is
 * no write for a stamp to compare against.
 *
 * Acknowledging is EXPLICIT. Merely switching tabs does not clear a dot: a tab
 * you flicked past is not a tab you read, and the one thing a nudge must never
 * do is disappear because you looked at it sideways.
 *
 * ── A ROW IS ONE LINE, and that is what the width bought ─────────────────────
 *
 * This block spent a version in a 332px column, where a name and a reason could
 * not share a line, so the reason went underneath in 11px gray — a two-line row
 * whose second line was the whole point of the row. Moved under the day at
 * ~683px, the row is one line again: avatar, name, reason chip, chevron. That
 * also makes rows CHEAP, so the people cap went from 5 to 8 and the block shows
 * a real queue instead of a column of stubs.
 *
 * Zero extra reads for the people half: `contactAttentionReasons` runs over the
 * contacts the page has already loaded. The bookings half is one capped
 * collection-group query — see `useQueueBookings` for its window and its cost.
 */

import { useMemo, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { ArrowRight, CalendarCheck, CheckCircle2, ChevronRight, Rocket, Wallet } from 'lucide-react'
import type {
  Contact,
  ContactAttentionReason,
  ContactFilterContext,
  DashboardQueueTab,
  EngagementThresholds,
} from '@linyup/shared'
import {
  compareContactsByAttention,
  contactAttentionReasons,
  contactQueueKey,
  isRosterContact,
  personInitials,
  taskQueueKey,
  unseenQueueKeys,
} from '@linyup/shared'
import type { SetupStep } from '@/hooks/useSetupChecklist'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { usePlan } from '@/hooks/usePlan'
import { useQueueBookings, type QueueBooking } from '@/hooks/useQueueBookings'
import { useQueueSeen } from '@/hooks/useQueueSeen'
import { OPEN_SETUP_GUIDE_EVENT } from '@/components/onboarding/SetupGuide'
import { Panel, PanelBody, PanelHeader } from './Panel'
import { useUnassignedPaymentCount } from './preview-data'

/** How many people show before the list defers to the contacts page. Eight,
 *  not five: a one-line row at full width costs 40px, so the old cap was a
 *  constraint of a shape this block no longer has. */
const PEOPLE_ROWS = 8

/** Bookings get the same ceiling for the same reason. */
const BOOKING_ROWS = 8

/** The contacts page's Needs-attention view, entered directly. */
const ATTENTION_HREF = '/contacts?attention=1' as Route
const BOOKINGS_HREF = '/bookings' as Route

type PersonRow = { contact: Contact; reason: ContactAttentionReason }

export function useQueuePeople(
  contacts: Contact[] | undefined,
  engagementThresholds?: EngagementThresholds
): PersonRow[] {
  const ctx: ContactFilterContext = useMemo(
    () => ({ engagementThresholds }),
    [engagementThresholds]
  )
  return useMemo(() => {
    const rows = (contacts ?? [])
      .filter(isRosterContact)
      .map((c) => ({ contact: c, reason: contactAttentionReasons(c, ctx)[0] }))
      .filter((r): r is PersonRow => !!r.reason)
    rows.sort((a, b) => compareContactsByAttention(a.contact, b.contact, ctx))
    return rows
  }, [contacts, ctx])
}

/** The shared row geometry: one line, a chevron on the right rail. */
const ROW_CLASS =
  'flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/60'

/** The bell's indicator, matched rather than invented: the established "there
 *  is something here" mark on this shell is a small pulsing dot. */
const DOT_CLASS = 'h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500'

function PersonRowView({ contact, reason }: PersonRow) {
  const t = useTranslations('NewDashboard')
  const initials = personInitials(contact)
  return (
    <Link href={`/contacts/${contact.id}` as Route} className={ROW_CLASS}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-xs font-semibold text-amber-600">
        {initials}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {contact.firstname} {contact.lastname}
      </span>
      <Badge variant="outline" className="shrink-0 border-amber-300 text-xs text-amber-600">
        {t(`reason_${reason}` as 'reason_alerts')}
      </Badge>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" />
    </Link>
  )
}

/**
 * A seat. It links to the SESSION, not to the booking: confirming, checking in
 * and seeing who else is coming all happen on the session page, and a booking
 * has no page of its own.
 */
function BookingRowView({ row }: { row: QueueBooking }) {
  const t = useTranslations('NewDashboard')
  const format = useFormatter()
  return (
    <Link href={`/sessions/${row.sessionId}` as Route} className={ROW_CLASS}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-500/10 text-sky-600">
        <CalendarCheck className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
      {row.joinedAt && (
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {format.relativeTime(row.joinedAt)}
        </span>
      )}
      <Badge
        variant="outline"
        className={
          row.pending
            ? 'shrink-0 border-amber-300 text-xs text-amber-600'
            : 'shrink-0 border-sky-300 text-xs text-sky-600'
        }
      >
        {row.pending ? t('queueBookingToConfirm') : t('queueBookingNew')}
      </Badge>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" />
    </Link>
  )
}

function TaskRowView({
  icon: Icon,
  label,
  meta,
  href,
}: {
  icon: React.ElementType
  label: string
  meta: string
  href: Route
}) {
  return (
    <Link href={href} className={ROW_CLASS}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" />
    </Link>
  )
}

/**
 * The setup row — it OPENS THE GUIDE rather than navigating anywhere.
 *
 * It used to be an ordinary task row pointing at `openSetup[0].href`, the first
 * remaining step. A studio with two steps left clicked "Finish setting up · 2
 * left" and landed on, say, the subscriptions tab, with nothing on screen
 * saying why they were there or what the other step was; the first-run modal
 * that had listed them was long gone. Reported on the prod canary, 2026-08-23.
 *
 * The overview it was missing is now `SetupGuide` — a minimizable overlay the
 * shell mounts, which survives every navigation the steps demand. So this row
 * does not reproduce the list and does not lead anywhere: it raises the guide,
 * which is the one place the list lives.
 */
function SetupTaskRow({ count }: { count: number }) {
  const t = useTranslations('NewDashboard')

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_SETUP_GUIDE_EVENT))}
      className={`${ROW_CLASS} w-full`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
        <Rocket className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">
        {t('taskSetup')}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {t('taskSetupMeta', { count })}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" />
    </button>
  )
}

function TabButton({
  label,
  count,
  unseen,
  active,
  onSelect,
  newLabel,
}: {
  label: string
  count: number
  unseen: number
  active: boolean
  onSelect: () => void
  newLabel: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={`flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
    >
      <span>{label}</span>
      {/* The count is always rendered, zero included: a tab that drops its
          number when it empties makes the strip jump, and "0" is an answer. */}
      <span className={active ? 'tabular-nums' : 'tabular-nums opacity-70'}>{count}</span>
      {unseen > 0 && <span className={DOT_CLASS} role="img" aria-label={newLabel} />}
    </button>
  )
}

export function QueuePanel({
  teamId,
  contacts,
  contactsLoading,
  engagementThresholds,
  setupSteps,
  setupLoading,
}: {
  teamId: string | null
  contacts: Contact[] | undefined
  contactsLoading: boolean
  engagementThresholds?: EngagementThresholds
  setupSteps: SetupStep[]
  setupLoading: boolean
}) {
  const t = useTranslations('NewDashboard')
  const { isAtLeast } = usePlan()

  const people = useQueuePeople(contacts, engagementThresholds)
  const { rows: allBookings, isLoading: bookingsLoading } = useQueueBookings(teamId)
  const { seen, canAck, markSeen, isSaving } = useQueueSeen()

  // Unfiled money is a Studio-tier surface, so the query only runs there —
  // passing null keeps the hook mounted and the request unsent.
  const seesMoney = isAtLeast('studio')
  const { count: unassigned } = useUnassignedPaymentCount(seesMoney ? teamId : null)

  const openSetup = setupLoading ? [] : setupSteps.filter((s) => !s.done && !s.optional)

  const tasks: {
    key: string
    icon: React.ElementType
    label: string
    meta: string
    href: Route
  }[] = []
  if (unassigned > 0) {
    tasks.push({
      key: taskQueueKey('payments'),
      icon: Wallet,
      label: t('taskPayments'),
      meta: t('taskPaymentsMeta', { count: unassigned }),
      href: '/payments' as Route,
    })
  }
  // NOT pushed into `tasks`: it is the one row that opens instead of leading
  // somewhere, so it renders itself below.
  const showSetup = openSetup.length > 0

  // ── What each tab is holding ───────────────────────────────────────────────
  // A booking is on the tab when it needs approving OR when the studio has not
  // seen it yet — both halves of the question, and it drains: once
  // acknowledged, only the seats that still need a decision stay.
  const seenBookings = seen.bookings
  const bookings = useMemo(() => {
    const known = new Set(seenBookings ?? [])
    return allBookings.filter((b) => b.pending || !known.has(b.key))
  }, [allBookings, seenBookings])

  const peopleKeys = useMemo(
    () => people.map((r) => contactQueueKey(r.contact.id, r.reason)),
    [people]
  )
  const bookingKeys = useMemo(() => bookings.map((b) => b.key), [bookings])
  const otherKeys = useMemo(
    () => [
      ...(unassigned > 0 ? [taskQueueKey('payments')] : []),
      ...(showSetup ? [taskQueueKey('setup')] : []),
    ],
    [unassigned, showSetup]
  )

  const counts: Record<DashboardQueueTab, number> = {
    bookings: bookings.length,
    contacts: people.length,
    other: otherKeys.length,
  }
  const unseen: Record<DashboardQueueTab, number> = {
    bookings: unseenQueueKeys(bookingKeys, seen.bookings).length,
    contacts: unseenQueueKeys(peopleKeys, seen.contacts).length,
    other: unseenQueueKeys(otherKeys, seen.other).length,
  }
  const keysFor: Record<DashboardQueueTab, string[]> = {
    bookings: bookingKeys,
    contacts: peopleKeys,
    other: otherKeys,
  }

  // The tab follows the data UNTIL somebody picks one, and then it stops
  // moving: a panel that re-chose its own tab while you were reading it would
  // be the worst of both.
  const [picked, setPicked] = useState<DashboardQueueTab | null>(null)
  const auto: DashboardQueueTab =
    unseen.bookings > 0
      ? 'bookings'
      : unseen.contacts > 0
        ? 'contacts'
        : unseen.other > 0
          ? 'other'
          : counts.bookings > 0
            ? 'bookings'
            : counts.contacts > 0
              ? 'contacts'
              : 'other'
  const tab = picked ?? auto

  const total = counts.bookings + counts.contacts + counts.other
  const isLoading = contactsLoading || bookingsLoading

  const seeAllHref = tab === 'bookings' ? BOOKINGS_HREF : ATTENTION_HREF
  const seeAllLabel = tab === 'bookings' ? t('queueOpenBookings') : t('queueOpenContacts')
  const showSeeAll = tab === 'bookings' ? counts.bookings > 0 : counts.contacts > 0

  const shownPeople = people.slice(0, PEOPLE_ROWS)
  const hiddenPeople = people.length - shownPeople.length
  const shownBookings = bookings.slice(0, BOOKING_ROWS)
  const hiddenBookings = bookings.length - shownBookings.length

  return (
    <Panel>
      <PanelHeader
        title={t('queueTitle')}
        meta={total > 0 ? t('queueCount', { count: total }) : undefined}
        action={
          showSeeAll ? (
            <Link
              href={seeAllHref}
              className="flex shrink-0 items-center gap-0.5 text-xs text-primary hover:underline"
            >
              {seeAllLabel}
              <ArrowRight className="h-3 w-3" />
            </Link>
          ) : undefined
        }
      />
      {/* The tab strip sits BELOW the header rather than inside it: that bar is
          h-10 and already carries a title, a count and a link. */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5">
        <TabButton
          label={t('queueTabBookings')}
          count={counts.bookings}
          unseen={unseen.bookings}
          active={tab === 'bookings'}
          onSelect={() => setPicked('bookings')}
          newLabel={t('queueNew')}
        />
        <TabButton
          label={t('queueTabContacts')}
          count={counts.contacts}
          unseen={unseen.contacts}
          active={tab === 'contacts'}
          onSelect={() => setPicked('contacts')}
          newLabel={t('queueNew')}
        />
        <TabButton
          label={t('queueTabOther')}
          count={counts.other}
          unseen={unseen.other}
          active={tab === 'other'}
          onSelect={() => setPicked('other')}
          newLabel={t('queueNew')}
        />
        <div className="flex-1" />
        {/* Deliberate, and manager-only: see the header on why switching tabs
            is not an acknowledgement, and `useQueueSeen` on who may write. */}
        {canAck && unseen[tab] > 0 && (
          <button
            type="button"
            disabled={isSaving}
            onClick={() => {
              // PIN THE TAB BEFORE ACKNOWLEDGING. Found by clicking it: the
              // tab was still following the data, so clearing the Bookings dot
              // dropped its unseen count to zero and the panel immediately
              // jumped to Contacts — the panel re-choosing its own tab under
              // the reader, which is the thing `picked` exists to prevent.
              setPicked(tab)
              markSeen(tab, keysFor[tab])
            }}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
          >
            {t('queueMarkSeen')}
          </button>
        )}
      </div>
      <PanelBody>
        {isLoading ? (
          <div className="space-y-2.5 p-1">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-7 w-7 rounded-full" />
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-4 w-24 rounded-full" />
              </div>
            ))}
          </div>
        ) : total === 0 ? (
          /* EMPTY IS THE GOOD ANSWER, and it has to read as one — a grayed
             placeholder here would look like a load that failed. */
          <div className="flex h-full items-center justify-center gap-3 py-6 text-center">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
            <div className="text-left">
              <p className="text-sm font-medium">{t('queueEmptyTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('queueEmptyBody')}</p>
            </div>
          </div>
        ) : counts[tab] === 0 ? (
          /* One tab is empty while others are not — a quieter answer than the
             all-clear above, which here would claim more than it knows. */
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t('queueTabEmpty')}
          </p>
        ) : (
          <div className="space-y-0.5">
            {tab === 'bookings' && (
              <>
                {shownBookings.map((row) => (
                  <BookingRowView key={row.key} row={row} />
                ))}
                {hiddenBookings > 0 && (
                  <Link
                    href={BOOKINGS_HREF}
                    className="block px-2 py-1 text-xs text-muted-foreground hover:text-primary hover:underline"
                  >
                    {t('queueMoreBookings', { count: hiddenBookings })}
                  </Link>
                )}
              </>
            )}
            {tab === 'contacts' && (
              <>
                {shownPeople.map((row) => (
                  <PersonRowView key={row.contact.id} {...row} />
                ))}
                {hiddenPeople > 0 && (
                  <Link
                    href={ATTENTION_HREF}
                    className="block px-2 py-1 text-xs text-muted-foreground hover:text-primary hover:underline"
                  >
                    {t('queueMorePeople', { count: hiddenPeople })}
                  </Link>
                )}
              </>
            )}
            {tab === 'other' && (
              <>
                {tasks.map(({ key, ...task }) => (
                  <TaskRowView key={key} {...task} />
                ))}
                {showSetup && <SetupTaskRow count={openSetup.length} />}
              </>
            )}
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
