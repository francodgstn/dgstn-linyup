'use client'

/**
 * THE DASHBOARD.
 *
 * This page began as `/dashboard/preview`, a from-scratch alternative sitting
 * beside the incumbent so the two could be compared on the same data rather than
 * described to each other. It won; the incumbent was deleted and this took its
 * route. The comparison note that used to head this file is gone with it, but
 * everything below is the reasoning that survived the comparison and is still
 * load-bearing.
 *
 * ── THE COMPOSITION ──────────────────────────────────────────────────────────
 *
 *      ┌────────────────────────────┐  Snapshot
 *      │  TODAY          (accent)   │  ENGAGED    ·  BOOKINGS
 *      │  7/12 · 280px              │  SUBSCRIBED ·  AFFILIATION
 *      └────────────────────────────┘  REVENUE    ·  UNASSIGNED
 *      ┌────────────────────────────┐  Contacts   [view ▾]
 *      │  WAITING ON YOU (accent)   │   ◕  legend rows
 *      │  7/12 · 232px              │      beside the ring
 *      └────────────────────────────┘
 *                  “ the quote — the working area's sign-off
 *      ──────────────  Trends (cards, Studio+)  ──────────────
 *      ──────────────  Extra (opt-in, off by default)  ───────
 *
 * Row 1: the day beside six figures in two columns. Row 2: the queue beside the
 * contacts donut. Left column framed (work), right column unframed (reference).
 *
 * ── WHAT THIS COST, stated rather than buried ────────────────────────────────
 *
 * **Hierarchy from size is now width-only, and that is a real loss.** The rule
 * was: exactly one primary block, bigger than everything else in BOTH
 * dimensions. The day is still the widest single object (594px against 417px)
 * and still the tallest framed one — but the figure block opposite it is now a
 * six-cell grid, so the top of the page is a PAIR rather than a subject and its
 * margin. The frame is what keeps them apart: it still marks WORK, not
 * importance and not position, which is why six figures and a donut sit
 * opposite two accent panels without acquiring one.
 *
 * **The "add only by replacing" note was a warning, and the warning came
 * true.** It said four facts is a glance and eight is a wall between the day
 * and the people. This is six facts plus a chart, and the queue has moved from
 * beside the day to beneath it — so the wall is now real: the eye reaches the
 * people after crossing six numbers. It is still above the fold, at full width,
 * with one-line rows, which is why this reads as reordering rather than
 * demotion. But the note is no longer a caution about a hypothetical; it is a
 * description of the page, and the honest version of it is: **the right-hand
 * column is full.** Anything further goes below the fold or replaces something.
 *
 * ── WHAT IT DROPS, AND WHERE THE DROPPED THINGS WENT ─────────────────────────
 *
 * Dropped by decision, and deleted with the incumbent:
 *
 *   - **Discover.** Tips and plugin upsells: a shelf you go to, not a thing you
 *     are handed while finding out whether the 09:00 is full.
 *   - **The setup checklist as a band.** On day one it is the whole page (see
 *     `isFirstRun` — it SUBSTITUTES rather than stacking). After day one it is
 *     one row in the queue, because that is what it is: work waiting on a human.
 *   - **Recent payments as a five-row table.** The one thing about payments that
 *     is a MORNING task — money with nobody attached to it — is a figure AND a
 *     queue row, not a table. (The table itself survives in `ExtraSection`.)
 *   - **The demographics half of the contacts card.** The multi-valued roster
 *     views came with it and were bars for a while; since 2026-09-11 they are
 *     rings too — see `RosterDonut` for the partition that made a true
 *     denominator available, and for what it costs.
 *   - **The subscription/affiliation overlap bar**, removed by decision. Its job
 *     passes to the two subtitles, which are now load-bearing copy.
 *
 * Dropped from the PAGE but kept as code, behind the `extra-dashboard`
 * experiment: the finance figures and payments table, the engagement matrix,
 * trial conversion and the correlation explorer. See `ExtraSection` for why they
 * are parked rather than deleted, and for what happens to them next.
 */

import { useTranslations, useLocale } from 'next-intl'
import { useAuth } from '@/contexts/AuthContext'
import { useRankingSystems } from '@/hooks/useRankingSystems'
import { usePlan } from '@/hooks/usePlan'
import { useSetupChecklist } from '@/hooks/useSetupChecklist'
import { useExperimentalFeatures } from '@/hooks/useExperimentalFeatures'
import { Skeleton } from '@/components/ui/skeleton'
import { PlanUpgradeNotice } from '@/components/plan/PlanUpgradeNotice'
import { FirstRunCard } from '@/components/dashboard/FirstRunCard'
import { TeamNotificationsBanner } from '@/components/dashboard/TeamNotificationsBanner'
import { TodayPanel } from '@/components/dashboard-preview/TodayPanel'
import { QueuePanel } from '@/components/dashboard-preview/QueuePanel'
import { FiguresBlock } from '@/components/dashboard-preview/FiguresBlock'
import { QuickActionsBar } from '@/components/dashboard/QuickActionsBar'
import { RosterDonut } from '@/components/dashboard-preview/RosterDonut'
import { DailyAside } from '@/components/dashboard-preview/DailyAside'
import { WeekSection } from '@/components/dashboard-preview/WeekSection'
import { ExtraSection } from '@/components/dashboard-preview/ExtraSection'
import { useActiveContacts } from '@/hooks/useActiveContacts'
import { useCapabilities } from '@/hooks/useCapabilities'

/**
 * ONE LINE, and it is the whole header.
 *
 * A greeting, the date, the team, and the two actions a studio actually starts
 * from. It is ~41px because everything it says is context — the first thing
 * with an answer in it should be the first thing below it.
 */
function Header({ children }: { children: React.ReactNode }) {
  const t = useTranslations('NewDashboard')
  const locale = useLocale()
  const { profile, team } = useAuth()

  const hour = new Date().getHours()
  const greeting =
    hour < 12 ? t('greetingMorning') : hour < 17 ? t('greetingAfternoon') : t('greetingEvening')
  const firstName = profile?.firstname ?? profile?.displayName?.split(' ')[0] ?? ''
  const dateStr = new Date().toLocaleDateString(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="font-heading truncate text-xl font-bold leading-tight tracking-tight text-heading">
          {greeting}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="truncate text-xs text-muted-foreground">
          <span className="capitalize">{dateStr}</span>
          {team?.name ? ` · ${team.name}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export default function DashboardPage() {
  const t = useTranslations('NewDashboard')
  const { currentTeamId, team, user } = useAuth()
  const { ownScoped } = useCapabilities()
  // Org-aware: an org-managed tenant keeps its ranking systems on the ORG, and
  // reading `team.ranking_systems` here left the donut's Level view empty.
  const { rankingSystems } = useRankingSystems()
  const { plan, isAtLeast, isLoading: planLoading } = usePlan()
  // The parked panels at the foot of the page. Off unless a studio asked for
  // them; see ExtraSection.
  const { isEnabled } = useExperimentalFeatures()

  // THE roster hook, on the contacts page's cache entry — not a second fetch
  // of its own. Same coach scope as the contacts page: an own-scoped coach's
  // broad query is denied by the rules, so they read their book instead.
  const coachScopeUid = ownScoped ? (user?.uid ?? null) : null
  const { data: contacts, isLoading: contactsLoading } = useActiveContacts(currentTeamId, coachScopeUid)
  const {
    steps: setupSteps,
    hasContacts,
    loading: setupLoading,
  } = useSetupChecklist(currentTeamId, team, plan ?? undefined)

  const stepDone = (key: string) => setupSteps.find((s) => s.key === key)?.done ?? false
  const resolving = setupLoading || contactsLoading
  // Day one: no contacts and no bookable session. Not "the checklist is
  // unfinished" — this decides whether the page has anything to SAY.
  //
  // `hasContacts` rather than a step: adding a contact by hand stopped being a
  // setup step (contacts arrive through booking, signup and the shop), but the
  // dashboard still needs the fact, so the hook keeps the probe and exposes it.
  const isFirstRun = !resolving && !hasContacts && !stepDone('sessions')

  return (
    <div className="space-y-5">
      <TeamNotificationsBanner />

      <Header>
        <QuickActionsBar />
      </Header>

      {resolving && <Skeleton className="h-[264px] w-full rounded-xl" />}

      {/* DAY ONE SUBSTITUTES, it does not stack. A studio with no contacts and
          no sessions has nothing for the day, the queue, the figures or the
          donut to say, and stacking a checklist on top of four empty blocks
          teaches a new studio that this page is mostly empty. */}
      {!resolving && isFirstRun && <FirstRunCard steps={setupSteps} />}

      {!resolving && !isFirstRun && (
        <>
          {/* ── ROW 1 — the day, and the six figures ──
              7:5 of twelve: ~594px against ~417px, which is what puts each
              figure column at ~196px — the width a value-beside-its-subtitle
              cell needs, and the reason six of them fit here at all.
              280px tall (it was 320): the agenda is a bit smaller, by
              instruction, and still shows five sessions before it scrolls.
              The figure block opposite runs ~275px, so it fits the row without
              setting it — the day still owns the height. */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7 lg:h-full lg:min-h-[264px]">
              <TodayPanel teamId={currentTeamId} />
            </div>
            <div className="lg:col-span-5">
              <FiguresBlock
                teamId={currentTeamId}
                contacts={contacts}
                loading={contactsLoading}
              />
            </div>
          </div>

          {/* ── ROW 2 — the queue, and who the contacts are ──
              Same 7:5 columns, so the page has ONE vertical seam rather than
              two: the framed work stacks on the left, the unframed reference
              stacks on the right, and the eye only has to learn the split once.

              296px, and ALL of the growth went to the QUEUE. The quote used to
              be a full-width band under this row costing ~66px plus its 20px
              gap; it has moved into the right column (see below), and rather
              than spreading that 86px across the page it was spent here. The
              queue's body goes 180px -> 256px, which at a 40px one-line row is
              four visible rows -> SIX. Row 1 is deliberately untouched at
              264px: the day must keep setting the first row's height.

              THE FOLD STILL GOVERNS, and the arithmetic here has been wrong
              twice in the same direction. Computed, the bottom of this row is
              24 + 41 + 20 + 264 + 20 + 296 = 665; MEASURED, this page runs a
              consistent ~35px longer, so call it ~700 against a 720 fold. That
              leaves ~20px, and the quote is now the thing sitting on that edge.
              If it clips again, take rows off the QUEUE — never off the
              sign-off, which has been the loser twice already.

              `pt-2.5` — 10px ON TOP of the wrapper's `space-y-5`, so the seam
              between the two rows is 30px rather than 20 (Franco, 2026-08-21).
              It is PADDING rather than a margin because `space-y` already owns
              `margin-top` on this child and would win the specificity contest.

              Applied to the ROW, not to the right-hand column, deliberately.
              The ask was for air between the figures and the donut, but this
              page has ONE vertical seam by design — the queue's top edge and
              the donut's are the same line, and buying the right column 10px
              on its own would bend that line for the sake of one gap. The
              whole row steps down together and the seam stays straight; the
              10px comes off the fold, which is stated rather than hidden. */}
          <div className="grid grid-cols-1 gap-6 pt-2.5 lg:grid-cols-12">
            <div className="lg:col-span-7 lg:h-[296px]">
              <QueuePanel
                teamId={currentTeamId}
                contacts={contacts}
                contactsLoading={contactsLoading}
                engagementThresholds={team?.engagement_thresholds}
                setupSteps={setupSteps}
                setupLoading={setupLoading}
              />
            </div>

            {/* THE REFERENCE COLUMN HOLDS ITS OWN BOTTOM EDGE. `justify-between`
                against the row's height, exactly as the old figure rail did:
                the donut sits at the top, the quote is PUSHED to the foot, and
                the air between them is whatever the row has spare. Positioning
                the quote with a margin instead would leave it floating in the
                middle of the column the moment a donut renders three legend
                rows instead of four. */}
            <div className="flex flex-col justify-between gap-5 lg:col-span-5 lg:h-full">
              <div>
                <RosterDonut
                  contacts={contacts}
                  thresholds={team?.engagement_thresholds}
                  rankingSystems={rankingSystems}
                  loading={contactsLoading}
                />
              </div>
              <DailyAside />
            </div>
          </div>

          {/* Trends are Studio+. The gate is read directly rather than through
              `PlanGate` so the tier's answer can be WAITED FOR: `usePlan`
              reports `false` while the team doc is still loading, and a page
              that flashes an upgrade notice at a paying studio every morning is
              worse than one that waits 200ms. Below Studio the page simply gets
              shorter — one notice, and no hole where four charts were. */}
          {/* `pt-4` ON TOP of the wrapper's `space-y-5`, so the working area
              above and the trends below are 36px apart rather than 20 (Franco,
              2026-08-21). Everything above this line answers "what is happening
              now"; everything below is history. That is the biggest change of
              subject on the page, and it was reading as one more row.

              Padding, because `space-y` owns `margin-top` on these children.
              INSIDE the not-loading branch, so the gap does not sit there on
              its own while the plan resolves. Costs the fold nothing — the
              seam is already below it. */}
          {planLoading ? null : (
            <div className="pt-4">
              {isAtLeast('studio') ? (
                <WeekSection teamId={currentTeamId} />
              ) : (
                <PlanUpgradeNotice
                  minPlan="studio"
                  title={t('trendsTitle')}
                  description={t('trendsUpsell')}
                />
              )}
            </div>
          )}

          {/* The parked shelf. Gated on the EXPERIMENT ONLY, not on the plan:
              every card inside carries its own plan/plugin gate already, and a
              second one here would silently empty the section for a studio that
              had just switched it on — the worst possible answer to "why is
              nothing there?". */}
          {isEnabled('extra-dashboard') && <ExtraSection teamId={currentTeamId} />}
        </>
      )}
    </div>
  )
}
