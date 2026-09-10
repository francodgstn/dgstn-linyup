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
 * The ordering is deliberate and is not urgency-by-score alone:
 *
 *  - **PEOPLE FIRST**, because people go cold. An unacknowledged lead, a booked
 *    trial nobody has confirmed, a member who has quietly stopped coming — every
 *    one of those decays if it waits a day. Ranked by the SHARED comparator
 *    (`compareContactsByAttention`), so "the top rows here" are the top of the
 *    contacts page's own Needs-attention view; no second definition of urgency
 *    exists.
 *  - **HOUSEKEEPING BELOW A RULE.** Unfiled payments and unfinished setup are
 *    real work, but they are exactly as urgent tomorrow. They sit under a
 *    hairline so they can be skipped by eye.
 *
 * EVERY ROW SAYS WHY. A name with no reason is a list nobody trusts.
 *
 * ── A ROW IS ONE LINE, and that is what the width bought ─────────────────────
 *
 * This block spent a version in a 332px column, where a name and a reason could
 * not share a line, so the reason went underneath in 11px grey — a two-line row
 * whose second line was the whole point of the row. Moved under the day at
 * ~683px, the row is one line again: avatar, name, reason chip, chevron. That
 * also makes rows CHEAP, so the people cap went from 5 to 8 and the block shows
 * a real queue instead of a column of stubs.
 *
 * Zero extra reads for the people half: `contactAttentionReasons` runs over the
 * contacts the page has already loaded.
 */

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { ArrowRight, CheckCircle2, ChevronRight, Rocket, Wallet } from 'lucide-react'
import type {
  Contact,
  ContactAttentionReason,
  ContactFilterContext,
  EngagementThresholds,
} from '@linyup/shared'
import { compareContactsByAttention, contactAttentionReasons, isRosterContact } from '@linyup/shared'
import type { SetupStep } from '@/hooks/useSetupChecklist'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { usePlan } from '@/hooks/usePlan'
import { OPEN_SETUP_GUIDE_EVENT } from '@/components/onboarding/SetupGuide'
import { Panel, PanelBody, PanelHeader } from './Panel'
import { useUnassignedPaymentCount } from './preview-data'

/** How many people show before the list defers to the contacts page. Eight,
 *  not five: a one-line row at full width costs 40px, so the old cap was a
 *  constraint of a shape this block no longer has. */
const PEOPLE_ROWS = 8

/** The contacts page's Needs-attention view, entered directly. */
const ATTENTION_HREF = '/contacts?attention=1' as Route

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

function PersonRowView({ contact, reason }: PersonRow) {
  const t = useTranslations('NewDashboard')
  const initials =
    `${contact.firstname?.[0] ?? ''}${contact.lastname?.[0] ?? ''}`.toUpperCase() || '?'
  return (
    <Link href={`/contacts/${contact.id}` as Route} className={ROW_CLASS}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-[11px] font-semibold text-amber-600">
        {initials}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {contact.firstname} {contact.lastname}
      </span>
      <Badge variant="outline" className="shrink-0 border-amber-300 text-[11px] text-amber-600">
        {t(`reason_${reason}` as 'reason_alerts')}
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

  // Unfiled money is a Studio-tier surface, so the query only runs there —
  // passing null keeps the hook mounted and the request unsent.
  const seesMoney = isAtLeast('studio')
  const { count: unassigned } = useUnassignedPaymentCount(seesMoney ? teamId : null)

  const openSetup = setupLoading ? [] : setupSteps.filter((s) => !s.done && !s.optional)

  const tasks: { key: string; icon: React.ElementType; label: string; meta: string; href: Route }[] =
    []
  if (unassigned > 0) {
    tasks.push({
      key: 'payments',
      icon: Wallet,
      label: t('taskPayments'),
      meta: t('taskPaymentsMeta', { count: unassigned }),
      href: '/payments' as Route,
    })
  }
  // NOT pushed into `tasks`: it is the one row that opens instead of leading
  // somewhere, so it renders itself below.
  const showSetup = openSetup.length > 0

  const total = people.length + tasks.length + (showSetup ? 1 : 0)
  const shown = people.slice(0, PEOPLE_ROWS)
  const hidden = people.length - shown.length

  return (
    <Panel>
      <PanelHeader
        title={t('queueTitle')}
        meta={total > 0 ? t('queueCount', { count: total }) : undefined}
        action={
          people.length > 0 ? (
            <Link
              href={ATTENTION_HREF}
              className="flex shrink-0 items-center gap-0.5 text-xs text-primary hover:underline"
            >
              {t('queueOpenContacts')}
              <ArrowRight className="h-3 w-3" />
            </Link>
          ) : undefined
        }
      />
      <PanelBody>
        {contactsLoading ? (
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
          /* EMPTY IS THE GOOD ANSWER, and it has to read as one — a greyed
             placeholder here would look like a load that failed. */
          <div className="flex h-full items-center justify-center gap-3 py-6 text-center">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
            <div className="text-left">
              <p className="text-sm font-medium">{t('queueEmptyTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('queueEmptyBody')}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {shown.map((row) => (
              <PersonRowView key={row.contact.id} {...row} />
            ))}
            {hidden > 0 && (
              <Link
                href={ATTENTION_HREF}
                className="block px-2 py-1 text-[11px] text-muted-foreground hover:text-primary hover:underline"
              >
                {t('queueMorePeople', { count: hidden })}
              </Link>
            )}
            {(tasks.length > 0 || showSetup) && (
              <div className={shown.length > 0 ? 'mt-1.5 border-t pt-1.5' : ''}>
                {tasks.map(({ key, ...task }) => (
                  <TaskRowView key={key} {...task} />
                ))}
                {showSetup && <SetupTaskRow count={openSetup.length} />}
              </div>
            )}
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
