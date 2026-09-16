'use client'

/**
 * THE SETUP GUIDE — the checklist that follows you around, minimizable.
 *
 * ── WHY A PERSISTENT OVERLAY AND NOT A CARD ON THE DASHBOARD ───────────────
 * The steps a studio has to complete before it can open its doors span five
 * different areas — activities, the schedule, plans, the public page, contacts
 * — and every one of them takes you AWAY from wherever the list is shown. A
 * checklist that lives on the dashboard can therefore only ever be read once:
 * you click a step, you are somewhere else, and the list is gone. That is
 * exactly what the prod canary reported (2026-08-23): "Finish set up · 2 left"
 * dropped the studio onto one page with no overview of what remained and no
 * modal left to go back to.
 *
 * So the guide is a fixed overlay, mounted by the app shell rather than by any
 * page, and it survives every navigation the steps demand. Stripe's onboarding
 * checklist is the reference and it is the right one for this shape of problem:
 * the work is interconnected, it is worth doing completely, and the guide has to
 * be readable from wherever the work happens (Franco, 2026-08-23).
 *
 * ── THREE STATES, AND THE MIDDLE ONE IS THE POINT ──────────────────────────
 *   EXPANDED   the full list, with what each step is for
 *   MINIMIZED  a pill: "Setup 3/5" — out of the way, still says where you are
 *   HIDDEN     dismissed for the whole team
 *
 * Minimizing is the escape hatch that keeps this from being an obstruction, and
 * it is per-BROWSER (localStorage) because it is a "not right now", not a
 * decision about the studio. Dismissing is per-TEAM (`teams/{id}.setup_dismissed`,
 * the flag that already existed) because it IS a decision about the studio — and
 * it stays undoable from How-to, which is where the restore control lives.
 *
 * ── THE FIRST TIME, IT IS OPEN. AFTER THAT, WHATEVER THEY LEFT IT ──────────
 * Three facts, three homes, and the bug was reading one off another:
 *
 *   never met this panel   per USER  (`users/{uid}.onboarding.seenIntros`)
 *   not right now          per BROWSER (localStorage)
 *   we are done with this  per TEAM  (`teams/{id}.setup_dismissed`)
 *
 * A missing localStorage key used to mean "minimized", so the ONE moment the
 * panel is worth opening — the first time somebody reaches the app — was the one
 * moment it stayed a pill. It now opens once per PERSON, because "the first time
 * the app is accessed" is a fact about a person and not about a device, and a
 * second machine is not a second first time. Everything after that reads the
 * per-browser preference exactly as before, so nothing reopens itself.
 *
 * It is marked seen only when it is actually SHOWN — a studio that is already
 * finished or has dismissed the guide never spends its one intro on a panel it
 * never saw.
 *
 * ── IT DISAPPEARS WHEN IT IS DONE ──────────────────────────────────────────
 * No congratulation card, no "all done!" state to dismiss. The last tick removes
 * it. A guide that has to be dismissed after it has finished being useful is one
 * more thing to close.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Check, ChevronDown, ChevronRight, Minus, Rocket, X } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useSetupChecklist, type SetupSection, type SetupStep } from '@/hooks/useSetupChecklist'
import { usePlan } from '@/hooks/usePlan'
import { usePlanName } from '@/hooks/usePlanName'
import {
  hasSeenIntro,
  markIntroSeen,
  setSetupDismissed,
  setSetupStepAcknowledged,
  SETUP_GUIDE_INTRO,
} from '@/lib/onboarding'
import { FloatingSlot } from '@/components/layout/FloatingDock'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Tip } from '@/components/ui/tip'

/** Ask the guide to open — dispatched from anywhere that would otherwise have
 *  to reproduce the list (the dashboard queue's setup row, How-to). Same
 *  mechanism as `START_TOUR_EVENT`, for the same reason: the sender does not
 *  have to know where the guide is mounted. */
export const OPEN_SETUP_GUIDE_EVENT = 'linyup:open-setup-guide'

const MINIMIZED_KEY = 'linyup.setupGuide.minimized'

const SECTION_KEY = 'linyup.setupGuide.section'

/** Reading order: what you sell, how people reach you, then the extras. */
const SECTIONS: SetupSection[] = ['offer', 'doors', 'extra']

/**
 * One step.
 *
 * THREE CLOSED STATES, DRAWN DIFFERENTLY, because they mean different things:
 *
 *   DONE          a tick. They did it, and we can see that they did.
 *   ACKNOWLEDGED  a dash. They said it does not apply — a cash-only club has
 *                 not set up payments and this does not pretend otherwise.
 *   LOCKED        muted, with the plan that unlocks it. Their plan no longer
 *                 includes this; it is not removed, because deleting steps on a
 *                 downgrade quietly rewrites what the product is while somebody
 *                 is deciding whether to pay for it.
 */
function StepRow({ step, teamId }: { step: SetupStep; teamId: string }) {
  const t = useTranslations('Onboarding')
  const planName = usePlanName()
  const [busy, setBusy] = useState(false)

  const label = t(`setup.steps.${step.key}.label` as 'setup.steps.activities.label')
  const desc = t(`setup.steps.${step.key}.desc` as 'setup.steps.activities.desc')

  async function toggleAck(next: boolean) {
    setBusy(true)
    try {
      await setSetupStepAcknowledged(teamId, step.key, next)
    } finally {
      setBusy(false)
    }
  }

  const marker = (
    <span
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
        step.acknowledged
          ? 'border-muted-foreground/40 text-muted-foreground'
          : step.done
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-muted-foreground/40'
      }`}
    >
      {step.acknowledged ? (
        <Minus className="h-2.5 w-2.5" />
      ) : step.done ? (
        <Check className="h-2.5 w-2.5" />
      ) : null}
    </span>
  )

  const body = (
    <span className="min-w-0 flex-1">
      <span
        className={`block text-sm leading-tight ${
          step.done ? 'text-muted-foreground line-through' : 'font-medium'
        }`}
      >
        {label}
      </span>
      {step.locked ? (
        <span className="mt-0.5 inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
          {t('setup.requiresPlan', { plan: planName(step.requiresPlan ?? 'studio') })}
        </span>
      ) : step.acknowledged ? (
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
          {step.ack === 'review' ? t('setup.ackNoteReview') : t('setup.ackNoteSkip')}
        </span>
      ) : !step.done ? (
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{desc}</span>
      ) : null}
    </span>
  )

  // A locked step leads nowhere: the page behind it would refuse them, and a
  // link into a refusal is a worse answer than a tag saying why.
  if (step.locked) {
    return (
      <li className="flex items-start gap-2.5 rounded-lg p-2 opacity-60">
        {marker}
        {body}
      </li>
    )
  }

  return (
    <li>
      <div className="group/step flex items-start gap-2.5 rounded-lg p-2 transition-colors hover:bg-accent">
        <Link href={step.href as Route} className="flex min-w-0 flex-1 items-start gap-2.5">
          {marker}
          {body}
          {!step.done && <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/40" />}
        </Link>
      </div>
      {/* The hand-close, deliberately quiet: below the row, small, and only
          where closing by hand is a legitimate answer. Reopening is the same
          control, so a mis-click is one click back.

          THE LABEL IS THE STEP'S OWN, never a generic "Not needed". "No prices
          for now" and "We only take cash" are STATEMENTS about the studio's own
          situation rather than dismissals of the step, and on a core step like
          pricing a shrug would read as permission to ignore it. */}
      {step.ack && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggleAck(!step.acknowledged)}
          className="ml-9 mb-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
        >
          {step.acknowledged
            ? t('setup.ackUndo')
            : t(`setup.steps.${step.key}.ack` as 'setup.steps.pricing.ack')}
        </button>
      )}
    </li>
  )
}

export function SetupGuide() {
  const t = useTranslations('Onboarding')
  const { currentTeamId, team, user, profile } = useAuth()
  // The EFFECTIVE plan, so a lapsed trial mutes its Studio-only steps the moment
  // it lapses rather than when the nightly cron gets to it.
  const { plan } = usePlan()
  const { steps, requiredDone, requiredTotal, allRequiredDone, loading } = useSetupChecklist(
    currentTeamId,
    team,
    plan ?? undefined
  )

  // Starts MINIMIZED, then the first render that would actually SHOW the panel
  // decides: open if this person has never met it, otherwise whatever they left
  // it as. Nothing reopens itself on a navigation — the guide is mounted by the
  // persistent (auth) layout, so it does not remount when a step takes the
  // studio somewhere else, and only a hard reload re-runs the decision at all.
  const [minimized, setMinimized] = useState(true)
  const [hydrated, setHydrated] = useState(false)
  // ── AN ACCORDION: ONE SECTION OPEN AT A TIME ───────────────────────────────
  // Not three independent toggles. This panel is a fixed corner of the screen,
  // and three open sections is nine rows of scrolling inside a box that is
  // already competing with the page behind it. One open section keeps the whole
  // of the current task visible at once, which is the only reading position
  // that does not require scrolling to hold a thought (Franco, 2026-08-23).
  //
  // `null` is a real state — everything folded — so a studio who wants the
  // headings alone can have them.
  const [openSection, setOpenSection] = useState<SetupSection | null>(null)
  /** Has the studio chosen? Until they do, the section with work in it opens. */
  const [sectionTouched, setSectionTouched] = useState(false)

  useEffect(() => {
    // Read AFTER mount so the server and the first client render agree.
    //
    // MINIMIZED is deliberately NOT read here. Its absence cannot be
    // interpreted until the per-USER fact has loaded — "never met this panel"
    // and "folded it away" are two different answers and this key only knows
    // one of them. See the intro effect below.
    try {
      const raw = window.localStorage.getItem(SECTION_KEY)
      if (raw !== null) {
        setOpenSection(raw === '' ? null : (raw as SetupSection))
        setSectionTouched(true)
      }
    } catch {
      /* private mode, or a stored value we can no longer parse — the defaults stand */
    }
  }, [])

  /**
   * WOULD THIS RENDER ACTUALLY PUT THE PANEL ON SCREEN? The intro is spent only
   * when it is really shown: a studio that is already finished, or has dismissed
   * the guide, must not burn its one first-time on a panel nobody saw.
   *
   * `!!team` IS PART OF THE QUESTION, not a null-guard for the line below it.
   * AuthContext exposes no team-loading flag: `team` is null while the
   * `teams/{id}` snapshot is in flight, and null is indistinguishable from "not
   * dismissed". Without this, a checklist query that resolved before the
   * snapshot would latch `introDecided`, unfold the panel and write
   * `markIntroSeen` for a studio that had in fact dismissed the guide — spending
   * the one first-time forever, on nothing.
   */
  const wouldShow =
    !!currentTeamId && !!team && !loading && team.setup_dismissed !== true && !allRequiredDone
  const introDecided = useRef(false)

  useEffect(() => {
    if (introDecided.current || !wouldShow || !profile) return
    introDecided.current = true

    if (!hasSeenIntro(profile, SETUP_GUIDE_INTRO)) {
      // FIRST TIME FOR THIS PERSON — open it, and record that they have met it.
      // Not persisted to localStorage: opening it is not a choice they made, so
      // it must not read back later as one.
      setMinimized(false)
      if (user) {
        void markIntroSeen(user.uid, SETUP_GUIDE_INTRO).catch(() => {
          /* they meet the panel once more, which is the harmless direction */
        })
      }
    } else {
      let stored: string | null = null
      try {
        stored = window.localStorage.getItem(MINIMIZED_KEY)
      } catch {
        /* private mode — the folded default stands */
      }
      setMinimized(stored !== 'false')
    }
    setHydrated(true)
  }, [wouldShow, profile, user])

  const setMinimizedPersisted = useCallback((next: boolean) => {
    setMinimized(next)
    try {
      window.localStorage.setItem(MINIMIZED_KEY, String(next))
    } catch {
      /* nothing to do; the state still holds for this session */
    }
  }, [])

  const toggleSection = useCallback((section: SetupSection, currentlyOpen: boolean) => {
    const next = currentlyOpen ? null : section
    setOpenSection(next)
    setSectionTouched(true)
    try {
      window.localStorage.setItem(SECTION_KEY, next ?? '')
    } catch {
      /* the state still holds for this session */
    }
  }, [])

  useEffect(() => {
    function open() {
      setMinimizedPersisted(false)
      // Asked for by somebody who could not see it — if the team had hidden it,
      // that request outranks the earlier dismissal.
      if (currentTeamId && team?.setup_dismissed === true) {
        void setSetupDismissed(currentTeamId, false)
      }
    }
    window.addEventListener(OPEN_SETUP_GUIDE_EVENT, open)
    return () => window.removeEventListener(OPEN_SETUP_GUIDE_EVENT, open)
  }, [currentTeamId, team?.setup_dismissed, setMinimizedPersisted])

  if (!hydrated || loading || !currentTeamId) return null
  if (team?.setup_dismissed === true) return null
  if (allRequiredDone) return null

  // The next thing to do: counted, unlocked, not done. A locked step would send
  // them to a page their plan refuses.
  const open = steps.filter((s) => !s.done && !s.optional && !s.locked)

  // WHERE THE ACCORDION OPENS BEFORE ANYBODY TOUCHES IT: the first section that
  // still has work in it. A fixed default would open a finished section for
  // half the studios who see this, which is the one thing an accordion must not
  // do — it can only show one, so it has to show the right one.
  const firstUnfinished =
    SECTIONS.find((sec) => steps.some((s) => s.section === sec && !s.done && !s.locked)) ?? null
  const activeSection = sectionTouched ? openSection : firstUnfinished
  const pct = requiredTotal ? (requiredDone / requiredTotal) * 100 : 0

  if (minimized) {
    return (
      <FloatingSlot lane="shell">
        <button
          type="button"
          onClick={() => setMinimizedPersisted(false)}
          className="flex items-center gap-2 rounded-full border bg-card px-3.5 py-2 text-sm shadow-lg transition-colors hover:bg-accent"
        >
          <Rocket className="h-4 w-4 text-primary" />
          <span className="font-medium">{t('setup.title')}</span>
          <span className="tabular-nums text-xs text-muted-foreground">
            {t('setup.progress', { done: requiredDone, total: requiredTotal })}
          </span>
        </button>
      </FloatingSlot>
    )
  }

  return (
    <FloatingSlot lane="shell">
      <div className="w-[min(20rem,calc(100vw-3rem))] overflow-hidden rounded-xl border bg-card shadow-xl">
        <div className="flex items-start gap-2 border-b p-3">
          <Rocket className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight">{t('setup.title')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('setup.subtitle')}</p>
          </div>
          {/* MINIMIZE and DISMISS are two controls because they are two
              different answers — "not now" and "never" — and one control that
              did both would make the reversible one look final. */}
          <Tip label={t('setup.minimize')}>
            <button
              type="button"
              aria-label={t('setup.minimize')}
              onClick={() => setMinimizedPersisted(true)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
          </Tip>
          <Tip label={t('setup.dismiss')}>
            <button
              type="button"
              aria-label={t('setup.dismiss')}
              onClick={() => void setSetupDismissed(currentTeamId, true)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tip>
        </div>

        <div className="flex items-center gap-2 px-3 pt-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {t('setup.progress', { done: requiredDone, total: requiredTotal })}
          </span>
        </div>

        {/* EVERY step, done ones included. A checklist that hides what is
            finished cannot be read as progress — and on a list this short the
            completed rows are most of what makes the remaining ones feel
            finishable.

            THE SECTIONS ARE OUTCOMES, not feature areas: what you sell, then
            how people reach you, then making it yours. The third sits under a
            rule and is NOT counted — real work, but a studio can open its doors
            without it, the same split the dashboard queue makes between people
            and housekeeping. */}
        <div className="max-h-[min(24rem,52vh)] overflow-y-auto p-2">
          {SECTIONS.map((section) => {
            const rows = steps.filter((s) => s.section === section)
            if (rows.length === 0) return null
            const sectionDone = rows.filter((s) => s.done).length
            const isOpen = activeSection === section
            // BRACKETS MEAN "NOT IN THE BAR". Every count here reads like the
            // stepper's own "2 of 7", so the one section that does NOT feed it
            // needs to say so at a glance — otherwise a studio reads 1/3 beside
            // 1/4 and reasonably assumes both are being counted (Franco,
            // 2026-08-23). Keyed on the rows' own `optional`, which is what
            // actually decides the count, rather than on the section name.
            const outsideBar = rows.every((r) => r.optional)
            return (
              <section
                key={section}
                className="border-t pt-2 first:border-t-0 first:pt-0 [&+section]:mt-2"
              >
                {/* COLLAPSIBLE, and the count is why: folded, the header still
                    answers "is there anything left in here?", so closing a
                    section never hides the fact that it is unfinished. */}
                <button
                  type="button"
                  onClick={() => toggleSection(section, isOpen)}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent"
                >
                  <ChevronDown
                    className={`h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform ${
                      isOpen ? '' : '-rotate-90'
                    }`}
                  />
                  <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(`setup.sections.${section}` as 'setup.sections.offer')}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                    {outsideBar
                      ? `(${sectionDone}/${rows.length})`
                      : `${sectionDone}/${rows.length}`}
                  </span>
                </button>
                {isOpen && (
                  <ul className="space-y-0.5">
                    {rows.map((step) => (
                      <StepRow key={step.key} step={step} teamId={currentTeamId} />
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>

        {open.length > 0 && (
          <div className="border-t p-2">
            {/* The NEXT step, as the one primary action. `buttonVariants` on a
                Link rather than `<Button asChild>`: this Button is a base-ui
                wrapper and does not take a child to render as. */}
            <Link
              href={open[0].href as Route}
              className={cn(buttonVariants({ size: 'sm' }), 'w-full')}
            >
              {t(`setup.steps.${open[0].key}.label` as 'setup.steps.activities.label')}
            </Link>
          </div>
        )}
      </div>
    </FloatingSlot>
  )
}
