'use client'

// "Keep going" utilities under the How-to concepts: replay the guided tour,
// the studio's setup progress, a rotating tip, and a nudge to the plugin
// marketplace.
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import {
  ArrowRight,
  Check,
  Puzzle,
  RefreshCw,
  Rocket,
} from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { DynamicIcon } from '@/components/ui/icon-picker'
import { useAuth } from '@/contexts/AuthContext'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useSetupChecklist } from '@/hooks/useSetupChecklist'
import { usePlan } from '@/hooks/usePlan'
import { setSetupDismissed } from '@/lib/onboarding'
import { OPEN_SETUP_GUIDE_EVENT } from '@/components/onboarding/SetupGuide'
import { TIPS } from '@/data/tips'

function UtilityCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {icon}
        </span>
        <p className="text-sm font-semibold">{title}</p>
      </div>
      <div className="mt-3 flex flex-1 flex-col">{children}</div>
    </div>
  )
}

/**
 * Setup PROGRESS — a pointer at the checklist, not a second copy of it (UX-45).
 *
 * This card used to render the open steps itself, which made How-to a third
 * place setup was presented and the only one that could never be dismissed. It
 * shows the same progress (one shared query) and RAISES the one surface that
 * owns the steps — `SetupGuide`, since 2026-08-23 an overlay the shell mounts
 * on every page rather than a card on the dashboard. Because the guide's
 * dismissal is permanent and team-wide, this is also where it can be UNDONE. A
 * hidden checklist with no way back is how "I closed it and now I can't find
 * what I still have to do" happens.
 */
function ChecklistCard() {
  const t = useTranslations('HowTo')
  const tOnb = useTranslations('Onboarding')
  const { currentTeamId, team } = useAuth()
  const { can } = useCapabilities()
  const { plan } = usePlan()
  const { requiredDone, requiredTotal, allRequiredDone } = useSetupChecklist(
    currentTeamId ?? null,
    team,
    plan ?? undefined
  )
  const [restoring, setRestoring] = useState(false)

  const hidden = team?.setup_dismissed === true
  const canRestore = hidden && !!currentTeamId && can('team.settings')

  async function restore() {
    if (!currentTeamId) return
    setRestoring(true)
    try {
      await setSetupDismissed(currentTeamId, false)
    } finally {
      setRestoring(false)
    }
  }

  return (
    <UtilityCard icon={<Rocket className="h-4 w-4" />} title={t('utilities.checklist.title')}>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('utilities.checklist.body')}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${requiredTotal ? (requiredDone / requiredTotal) * 100 : 0}%` }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {tOnb('setup.progress', { done: requiredDone, total: requiredTotal })}
        </span>
      </div>
      {allRequiredDone && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="h-3.5 w-3.5 text-primary" />
          {t('utilities.checklist.allDone')}
        </p>
      )}
      <div className="mt-3 flex flex-1 items-end">
        {canRestore ? (
          <Button variant="outline" size="sm" onClick={restore} disabled={restoring}>
            {t('utilities.checklist.restore')}
          </Button>
        ) : hidden ? (
          /* Hidden by the owner, and this reader cannot write the team doc —
             so do not send them to a dashboard where the card isn't. */
          <p className="text-xs text-muted-foreground">{t('utilities.checklist.hiddenNote')}</p>
        ) : (
          /* OPENS THE GUIDE, rather than linking to the dashboard. The card it
             used to point at is now `SetupGuide`, an overlay the shell mounts
             on every page — including this one — so there is nowhere to send
             anybody. Same event mechanism as the tour button above. */
          <Button
            variant="ghost"
            size="sm"
            className="h-auto p-0 text-xs font-medium text-primary hover:bg-transparent hover:underline"
            onClick={() => window.dispatchEvent(new Event(OPEN_SETUP_GUIDE_EVENT))}
          >
            {t('utilities.checklist.open')} <ArrowRight className="h-3 w-3" />
          </Button>
        )}
      </div>
    </UtilityCard>
  )
}

function TipsCard() {
  const t = useTranslations('HowTo')
  const tDiscover = useTranslations('Discover')
  // Seed from the day so the first tip varies without being random per render.
  const [index, setIndex] = useState(() => new Date().getDate() % TIPS.length)
  const tip = TIPS[index]

  return (
    <UtilityCard
      icon={<DynamicIcon name={tip.icon} className="h-4 w-4" />}
      title={t('utilities.tips.title')}
    >
      <div className="flex-1 space-y-1">
        <p className="text-xs font-medium">
          {tDiscover(`tip_${tip.id}_title` as Parameters<typeof tDiscover>[0])}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {tDiscover(`tip_${tip.id}_body` as Parameters<typeof tDiscover>[0])}
        </p>
        {tip.href && (
          <Link
            href={tip.href as Route}
            className="inline-flex items-center gap-1 pt-1 text-xs text-primary hover:underline"
          >
            {tDiscover('learnMore')} <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {tDiscover('tipCounter', { current: index + 1, total: TIPS.length })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => setIndex((i) => (i + 1) % TIPS.length)}
        >
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          {tDiscover('nextTip')}
        </Button>
      </div>
    </UtilityCard>
  )
}

function PluginsCard() {
  const t = useTranslations('HowTo')
  return (
    <UtilityCard icon={<Puzzle className="h-4 w-4" />} title={t('utilities.plugins.title')}>
      <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
        {t('utilities.plugins.body')}
      </p>
      <Link
        href={'/settings/plugins' as Route}
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {t('utilities.plugins.action')} <ArrowRight className="h-3 w-3" />
      </Link>
    </UtilityCard>
  )
}

export function HowToUtilities() {
  const t = useTranslations('HowTo')
  return (
    <section>
      <h2 className="text-lg font-semibold">{t('utilitiesTitle')}</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ChecklistCard />
        <TipsCard />
        <PluginsCard />
      </div>
    </section>
  )
}
