'use client'

import { useState, useMemo } from 'react'
import { useTabParam } from '@/hooks/useTabParam'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, updateDoc, limit,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useForm, useFieldArray, Controller } from 'react-hook-form'
import { Badge } from '@/components/ui/badge'
import { FloatingSlot } from '@/components/layout/FloatingDock'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CONTACTS_COLLECTION, ACTIVITIES_COLLECTION, TEAMS_COLLECTION, DEFAULT_BADGE_THRESHOLDS, DEFAULT_GAMIFICATION_SCORING, mergeBadgeThresholds, personInitials } from '@linyup/shared'
import type { Contact, Activity, Team, StoredGamificationSettings } from '@linyup/shared'
import { avatarColor } from '@/lib/colors'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { Link } from '@/i18n/navigation'
import { buttonVariants } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Trophy, Flame, Star, Plus, Trash2, Save, ChevronDown, ChevronRight, Info,
} from 'lucide-react'

// ─── types ────────────────────────────────────────────────────────────────────
// The stored bag is `StoredGamificationSettings` (@linyup/shared, the ONE
// owner — this page used to declare its own `GamificationSettings`, same name
// as shared's and a different shape). The FORM holds every field, so it is
// the required rendering of it.

type GamificationSettings = Required<StoredGamificationSettings>

/** Lets the floating Save submit the settings form from its FloatingSlot portal. */
const GAMIFICATION_FORM_ID = 'gamification-settings-form'

const DEFAULTS: GamificationSettings = {
  ...DEFAULT_GAMIFICATION_SCORING,
  badge_thresholds: DEFAULT_BADGE_THRESHOLDS,
  coach_badges: [],
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function currentMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}


// ─── data hooks ───────────────────────────────────────────────────────────────

function useTeam(teamId: string | null) {
  return useQuery<Team | null>({
    queryKey: ['team', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return null
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId))
      if (!snap.exists()) return null
      return { id: snap.id, ...snap.data() } as Team
    },
  })
}

/** How deep the board goes — the copy (`leaderboardMonth`, "top 50") states
 *  the same number, so the two must move together. */
const LEADERBOARD_LIMIT = 50

type RankField = 'current_month_score' | 'current_streak' | 'max_streak'

/** The top of the board BY THE FIELD BEING RANKED. This read every contact the
 *  studio had, ordered by points, and sorted the streak boards from that in
 *  memory — a roster read for a fifty-row answer (docs/scalability-2026-09.md
 *  §17 A8). Each field has its own (`deleted_at`, `teamId`, field DESC) index;
 *  a contact without the field is not on that board, which is what a board of
 *  zeros would have said anyway. */
function useLeaderboardContacts(teamId: string | null, field: RankField) {
  return useQuery<Contact[]>({
    queryKey: ['leaderboard-contacts', teamId, field],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const q = query(
        collection(db, CONTACTS_COLLECTION),
        where('teamId', '==', teamId),
        where('deleted_at', '==', null),
        orderBy(field, 'desc'),
        limit(LEADERBOARD_LIMIT),
      )
      const snap = await getDocs(q)
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Contact)
    },
  })
}

function useActivities(teamId: string | null) {
  return useQuery<Activity[]>({
    queryKey: ['activities', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const q = query(
        collection(db, ACTIVITIES_COLLECTION),
        where('teamId', '==', teamId),
        where('isActive', '==', true),
        orderBy('name', 'asc'),
      )
      const snap = await getDocs(q)
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Activity)
    },
  })
}

// ─── leaderboard tab ──────────────────────────────────────────────────────────

type SortField = 'points' | 'streak' | 'best_streak'

function LeaderboardTab({ teamId }: { teamId: string }) {
  const t = useTranslations('Gamification')
  const [sortBy, setSortBy] = useState<SortField>('points')
  const sortField: RankField =
    sortBy === 'streak' ? 'current_streak' : sortBy === 'best_streak' ? 'max_streak' : 'current_month_score'
  const { data: contacts = [], isLoading } = useLeaderboardContacts(teamId, sortField)

  const month = currentMonth()

  const scored = useMemo(() =>
    contacts.filter((c) => (c.current_month_score ?? 0) > 0 || (c.current_streak ?? 0) > 0),
    [contacts],
  )

  const sorted = useMemo(() => {
    return [...scored].sort((a, b) => {
      if (sortBy === 'streak') return (b.current_streak ?? 0) - (a.current_streak ?? 0)
      if (sortBy === 'best_streak') return (b.max_streak ?? 0) - (a.max_streak ?? 0)
      return (b.current_month_score ?? 0) - (a.current_month_score ?? 0)
    })
  }, [scored, sortBy])

  // Olympic ranking
  const ranks: number[] = []
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) { ranks.push(1); continue }
    const curr = sorted[i]
    const prev = sorted[i - 1]
    const currVal = (curr[sortField as keyof Contact] as number | undefined) ?? 0
    const prevVal = (prev[sortField as keyof Contact] as number | undefined) ?? 0
    ranks.push(currVal < prevVal ? i + 1 : ranks[i - 1])
  }

  const SORT_OPTIONS: { key: SortField; label: string; icon: React.ReactNode }[] = [
    { key: 'points', label: t('sortPoints'), icon: <Star className="h-3.5 w-3.5" /> },
    { key: 'streak', label: t('sortStreak'), icon: <Flame className="h-3.5 w-3.5" /> },
    { key: 'best_streak', label: t('sortBestStreak'), icon: <Trophy className="h-3.5 w-3.5" /> },
  ]

  if (isLoading) return (
    <div className="space-y-2 py-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Sort toggle + month label */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-muted-foreground">{t('leaderboardMonth')} · {month}</p>
        <div className="flex gap-1">
          {SORT_OPTIONS.map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sortBy === key
                  ? 'bg-primary text-primary-foreground'
                  : 'border hover:bg-muted text-muted-foreground'
              }`}
            >
              {icon}
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="rounded-xl border overflow-hidden bg-card">
        {sorted.length === 0 ? (
          <div className="py-16 text-center space-y-2">
            <Trophy className="h-10 w-10 mx-auto text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">{t('leaderboardEmpty')}</p>
            <p className="text-xs text-muted-foreground">{t('leaderboardEmptySub')}</p>
          </div>
        ) : sorted.map((contact, index) => {
          const rank = ranks[index]
          const isTrial = contact.acquisition_stage === 'trial_booked' || contact.acquisition_stage === 'trial_attended'
          const displayName = isTrial
            ? personInitials(contact) + '.'
            : `${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim() || '?'
          const score = contact.current_month_score ?? 0
          const streak = contact.current_streak ?? 0
          const bestStreak = contact.max_streak ?? 0

          const rankBg = rank === 1 ? 'bg-yellow-500' : rank === 2 ? 'bg-gray-400' : rank === 3 ? 'bg-amber-700' : 'bg-muted'
          const rankText = rank <= 3 ? 'text-white' : 'text-muted-foreground'

          return (
            <div key={contact.id} className="flex items-center gap-3 px-4 py-3 border-b last:border-0 hover:bg-muted/30 transition-colors">
              {/* Rank */}
              <div className={`h-8 w-8 rounded-full shrink-0 flex items-center justify-center text-xs font-bold ${rankBg} ${rankText}`}>
                {rank}
              </div>

              {/* Avatar + name */}
              <div className={`h-8 w-8 rounded-full shrink-0 flex items-center justify-center text-white text-xs font-semibold ${avatarColor(contact.id)}`}>
                {personInitials(contact)}
              </div>
              <div className="flex-1 min-w-0">
                {/* The name links to the record — the same fix UX-63 made on
                    /bookings. A trial contact is deliberately shown as initials
                    here, so that row stays plain text: linking it would undo the
                    anonymity the initials are for. */}
                <p className="text-sm font-medium truncate">
                  {isTrial ? (
                    <>
                      {displayName}
                      <span className="ml-1.5 text-xs text-muted-foreground">— {t('trialLabel')}</span>
                    </>
                  ) : (
                    <Link href={`/contacts/${contact.id}` as Route} className="hover:underline">
                      {displayName}
                    </Link>
                  )}
                </p>
                {bestStreak > 0 && (
                  <p className="text-xs text-muted-foreground">{t('bestStreak', { weeks: bestStreak })}</p>
                )}
              </div>

              {/* Streak chip */}
              {streak > 0 && (
                <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${sortBy === 'streak' && rank <= 3 ? 'bg-primary text-primary-foreground border-transparent' : 'text-orange-600 border-orange-200 bg-orange-50'}`}>
                  <Flame className="h-3 w-3" />
                  {t('streakWeeks', { weeks: streak })}
                </div>
              )}

              {/* Score / best streak chip */}
              <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${sortBy !== 'streak' && rank <= 3 ? 'bg-primary text-primary-foreground border-transparent' : 'border-border text-muted-foreground'}`}>
                {sortBy === 'best_streak'
                  ? t('bestStreak', { weeks: bestStreak })
                  : `${score} pts`}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── number field helper ──────────────────────────────────────────────────────

function NumField({ label, help, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      <input
        type="number"
        {...props}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}

// ─── collapsible info box ─────────────────────────────────────────────────────

function InfoBox({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg bg-muted/50 border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <Info className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">{title}</span>
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
      </button>
      {open && <div className="px-4 pb-3 text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

// ─── section header ───────────────────────────────────────────────────────────

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="pt-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
    </div>
  )
}

// ─── scoring tab ──────────────────────────────────────────────────────────────

function ScoringTab({
  register,
  watch,
  setValue,
  control,
  activities,
  pendingBaseScores,
  onBaseScoreChange,
  teamId,
}: {
  register: ReturnType<typeof useForm<GamificationSettings>>['register']
  watch: ReturnType<typeof useForm<GamificationSettings>>['watch']
  setValue: ReturnType<typeof useForm<GamificationSettings>>['setValue']
  control: ReturnType<typeof useForm<GamificationSettings>>['control']
  activities: Activity[]
  pendingBaseScores: Record<string, number | null>
  onBaseScoreChange: (id: string, score: number | null) => void
  teamId: string
}) {
  const t = useTranslations('Gamification')
  const [resetting, setResetting] = useState(false)
  const [recalculating, setRecalculating] = useState(false)
  const [resetDialogOpen, setResetDialogOpen] = useState(false)

  const { fields, append, remove } = useFieldArray({ control, name: 'time_multipliers' })

  const DAY_OPTIONS = [1, 2, 3, 4, 5, 6, 0].map((v) => ({ value: v, label: t(`day${v}` as Parameters<typeof t>[0]) }))

  async function handleRecalculate() {
    setRecalculating(true)
    try {
      const fn = httpsCallable(functions, 'recalculateScores')
      await fn({ teamId, month: currentMonth() })
    } catch (e) {
      console.error(e)
    } finally {
      setRecalculating(false)
    }
  }

  async function handleReset() {
    setResetDialogOpen(false)
    setResetting(true)
    try {
      const fn = httpsCallable(functions, 'resetScores')
      await fn({ teamId, month: currentMonth() })
    } catch (e) {
      console.error(e)
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="space-y-6">
      <InfoBox title={t('howItWorks')}>
        <p>{t('howItWorksBody')}</p>
      </InfoBox>

      <div className="border-t pt-4 space-y-4">
        <SectionHeader title={t('scoringGeneral')} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <NumField
            label={t('defaultBaseScore')}
            help={t('defaultBaseScoreHelp')}
            min={1} max={100} step={1}
            {...register('default_base_score', { valueAsNumber: true })}
          />
          <NumField
            label={t('monthlyCap')}
            help={t('monthlyCapHelp')}
            min={50} max={1000} step={10}
            {...register('monthly_cap', { valueAsNumber: true })}
          />
        </div>
      </div>

      <div className="border-t pt-4 space-y-4">
        <SectionHeader title={t('streakSection')} description={t('streakDesc')} />
        <NumField
          label={t('streakMinSessions')}
          help={t('streakMinSessionsHelp')}
          min={1} max={10} step={1}
          {...register('streak_min_sessions', { valueAsNumber: true })}
        />
      </div>

      <div className="border-t pt-4 space-y-4">
        <SectionHeader title={t('multipliersSection')} description={t('multipliersDesc')} />
        {fields.map((field, index) => (
          <div key={field.id} className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 items-end p-3 rounded-lg bg-muted/40 border">
            <div className="space-y-1">
              <label className="text-xs font-medium">{t('multiplierDay')}</label>
              <Select
                value={String(watch(`time_multipliers.${index}.day`) ?? 5)}
                onValueChange={(v) => setValue(`time_multipliers.${index}.day`, Number(v), { shouldDirty: true })}
              >
                <SelectTrigger className="h-8 w-32">
                  <span className="flex flex-1 text-left text-sm truncate">
                    {DAY_OPTIONS.find((o) => o.value === (watch(`time_multipliers.${index}.day`) ?? 5))?.label ?? '—'}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {DAY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 w-20">
              <label className="text-xs font-medium">{t('multiplierFrom')}</label>
              <input type="number" min={0} max={23} step={1} {...register(`time_multipliers.${index}.start_hour`, { valueAsNumber: true })}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="space-y-1 w-20">
              <label className="text-xs font-medium">{t('multiplierTo')}</label>
              <input type="number" min={0} max={24} step={1} {...register(`time_multipliers.${index}.end_hour`, { valueAsNumber: true })}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="space-y-1 w-24">
              <label className="text-xs font-medium">{t('multiplierValue')}</label>
              <input type="number" min={0.5} max={2} step={0.05} {...register(`time_multipliers.${index}.multiplier`, { valueAsNumber: true })}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="space-y-1 flex-1 min-w-28">
              <label className="text-xs font-medium">{t('multiplierLabel')}</label>
              <input type="text" {...register(`time_multipliers.${index}.label`)} placeholder="e.g., Fri evening"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <button type="button" onClick={() => remove(index)}
              className="self-end p-1.5 text-muted-foreground hover:text-destructive rounded transition-colors">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button type="button"
          onClick={() => append({ day: 5, start_hour: 19, end_hour: 21, multiplier: 1.25, label: '' })}
          className="flex items-center gap-1.5 text-sm text-primary hover:underline">
          <Plus className="h-4 w-4" />{t('addMultiplier')}
        </button>
      </div>

      <div className="border-t pt-4 space-y-4">
        <SectionHeader title={t('activityScoresSection')} description={t('activityScoresDesc')} />
        {activities.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noActivities')}</p>
        ) : (
          <div className="space-y-2">
            {activities.map((a) => {
              const current = a.id in pendingBaseScores ? pendingBaseScores[a.id] : ((a as Activity & { base_score?: number }).base_score ?? null)
              return (
                <div key={a.id} className="flex items-center gap-3">
                  <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: a.color ?? '#e5e7eb' }} />
                  <span className="flex-1 text-sm">{a.name}</span>
                  <input
                    type="number"
                    min={1} max={100} step={1}
                    placeholder={t('activityScorePlaceholder')}
                    value={current ?? ''}
                    onChange={(e) => {
                      const val = e.target.value.trim()
                      onBaseScoreChange(a.id, val ? Number(val) : null)
                    }}
                    className="w-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="border-t pt-4 space-y-4">
        <SectionHeader title={t('actionsSection')} description={t('actionsDesc') + ' ' + currentMonth()} />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={handleRecalculate} disabled={recalculating || resetting}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50">
            {recalculating ? t('recalculating') : t('recalculate')}
          </button>
          <button type="button" onClick={() => setResetDialogOpen(true)} disabled={recalculating || resetting}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-destructive/30 text-destructive text-sm font-medium hover:bg-destructive/10 transition-colors disabled:opacity-50">
            {resetting ? t('resetting') : t('resetScores')}
          </button>
        </div>
      </div>

      <Dialog open={resetDialogOpen} onOpenChange={(o) => { if (!o) setResetDialogOpen(false) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('resetConfirmTitle')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">{t('resetConfirmDesc')}</p>
          <DialogFooter className="gap-2">
            <button type="button" onClick={() => setResetDialogOpen(false)}
              className="px-3 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">
              {t('cancel')}
            </button>
            <button type="button" onClick={handleReset}
              className="px-3 py-2 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-colors">
              {t('resetScores')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── badges tab ───────────────────────────────────────────────────────────────

const BADGE_SECTIONS: {
  key: keyof GamificationSettings['badge_thresholds']
  titleKey: string
  descKey: string
  badges: { field: string; label: string }[]
}[] = [
  {
    key: 'attendance',
    titleKey: 'badgeSectionAttendance',
    descKey: 'badgeSectionAttendanceDesc',
    badges: [
      { field: 'first_class', label: 'First Class' },
      { field: 'dedicated', label: 'Dedicated' },
      { field: 'committed', label: 'Committed' },
      { field: 'centurion', label: 'Centurion' },
      { field: 'veteran', label: 'Veteran' },
    ],
  },
  {
    key: 'streak',
    titleKey: 'badgeSectionStreak',
    descKey: 'badgeSectionStreakDesc',
    badges: [
      { field: 'on_fire', label: 'On Fire' },
      { field: 'unstoppable', label: 'Unstoppable' },
      { field: 'legendary', label: 'Legendary' },
    ],
  },
  {
    key: 'score',
    titleKey: 'badgeSectionScore',
    descKey: 'badgeSectionScoreDesc',
    badges: [
      { field: 'rising_star', label: 'Rising Star' },
      { field: 'monthly_star', label: 'Monthly Star' },
      { field: 'superstar', label: 'Superstar' },
    ],
  },
  {
    key: 'leaderboard',
    titleKey: 'badgeSectionLeaderboard',
    descKey: 'badgeSectionLeaderboardDesc',
    badges: [
      { field: 'top5', label: 'Top 5' },
      { field: 'leader', label: 'Leader' },
      { field: 'hall_of_fame', label: 'Hall of Fame' },
    ],
  },
  {
    key: 'explorer',
    titleKey: 'badgeSectionExplorer',
    descKey: 'badgeSectionExplorerDesc',
    badges: [{ field: 'explorer', label: 'Explorer' }],
  },
]

function BadgesTab({
  register,
  watch,
  control,
  setValue,
}: {
  register: ReturnType<typeof useForm<GamificationSettings>>['register']
  watch: ReturnType<typeof useForm<GamificationSettings>>['watch']
  control: ReturnType<typeof useForm<GamificationSettings>>['control']
  setValue: ReturnType<typeof useForm<GamificationSettings>>['setValue']
}) {
  const t = useTranslations('Gamification')
  const { fields, append, remove } = useFieldArray({ control, name: 'coach_badges' })
  const allValues = watch()

  return (
    <div className="space-y-6">
      <InfoBox title={t('badgesAbout')}>
        <p>{t('badgesAboutDesc')}</p>
      </InfoBox>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {BADGE_SECTIONS.map((section) => {
          const enabledPath = `badge_thresholds.${section.key}.enabled` as const
          const sectionKey = section.key as keyof GamificationSettings['badge_thresholds']
          const isEnabled = allValues.badge_thresholds?.[sectionKey]?.enabled !== false

          return (
            <div key={section.key} className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{t(section.titleKey as Parameters<typeof t>[0])}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t(section.descKey as Parameters<typeof t>[0])}</p>
                </div>
                <Controller
                  name={enabledPath as Parameters<typeof control.register>[0]}
                  control={control}
                  render={({ field }) => (
                    <button
                      type="button"
                      onClick={() => field.onChange(!(field.value !== false))}
                      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
                        field.value !== false ? 'bg-primary' : 'bg-muted-foreground/30'
                      }`}
                    >
                      <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                        field.value !== false ? 'translate-x-4' : 'translate-x-0'
                      }`} />
                    </button>
                  )}
                />
              </div>

              <div className={`space-y-2 transition-opacity ${isEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                {section.badges.map((badge) => (
                  <div key={badge.field} className="flex items-center gap-2">
                    <label className="flex-1 text-xs text-muted-foreground">{badge.label}</label>
                    <input
                      type="number"
                      min={1} max={9999} step={1}
                      disabled={!isEnabled}
                      {...register(`badge_thresholds.${section.key}.${badge.field}` as Parameters<typeof register>[0], { valueAsNumber: true })}
                      className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                    />
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <div className="border-t pt-4 space-y-4">
        <SectionHeader title={t('coachBadgesSection')} description={t('coachBadgesDesc')} />
        <div className="space-y-3">
          {fields.map((field, index) => (
            <div key={field.id} className="rounded-lg border p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium">{t('badgeKey')}</label>
                  <input type="text" placeholder={t('badgeKeyHelp')} {...register(`coach_badges.${index}.key`)}
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">{t('badgeLabel')}</label>
                  <input type="text" placeholder={t('badgeLabelHelp')} {...register(`coach_badges.${index}.label`)}
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
              </div>
              <div className="flex gap-2 items-end">
                <div className="flex-1 space-y-1">
                  <label className="text-xs font-medium">{t('badgeDescField')}</label>
                  <input type="text" placeholder={t('badgeDescHelp')} {...register(`coach_badges.${index}.description`)}
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
                <button type="button" onClick={() => remove(index)}
                  className="shrink-0 p-1.5 text-muted-foreground hover:text-destructive rounded transition-colors">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
        <button type="button"
          onClick={() => append({ key: '', label: '', description: '' })}
          className="flex items-center gap-1.5 text-sm text-primary hover:underline">
          <Plus className="h-4 w-4" />{t('addBadge')}
        </button>
      </div>
    </div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

const TAB_IDS = ['leaderboard', 'scoring', 'badges'] as const
type TabId = (typeof TAB_IDS)[number]

export default function GamificationPage() {
  const { currentTeamId } = useAuth()
  const qc = useQueryClient()
  const t = useTranslations('Gamification')
  const [tab, setTab] = useTabParam(TAB_IDS, 'leaderboard')
  const [pendingBaseScores, setPendingBaseScores] = useState<Record<string, number | null>>({})

  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()
  const { data: team } = useTeam(currentTeamId)
  const { data: activities = [] } = useActivities(currentTeamId)

  const gamSettings = (team?.settings as { gamification?: StoredGamificationSettings } | undefined)?.gamification ?? {}

  const defaultValues: GamificationSettings = {
    ...DEFAULTS,
    ...gamSettings,
    time_multipliers: gamSettings.time_multipliers ?? DEFAULTS.time_multipliers,
    badge_thresholds: mergeBadgeThresholds(gamSettings.badge_thresholds),
    coach_badges: gamSettings.coach_badges ?? DEFAULTS.coach_badges,
  }

  const { register, handleSubmit, watch, control, setValue, formState: { isSubmitting, isDirty } } = useForm<GamificationSettings>({
    defaultValues,
  })

  const hasBaseScoreChanges = Object.keys(pendingBaseScores).length > 0
  const showSave = (tab === 'scoring' || tab === 'badges') && (isDirty || hasBaseScoreChanges)

  async function onSubmit(data: GamificationSettings) {
    if (!currentTeamId) return
    await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), {
      'settings.gamification': data,
    })
    if (hasBaseScoreChanges) {
      await Promise.all(
        Object.entries(pendingBaseScores).map(([id, score]) =>
          updateDoc(doc(db, ACTIVITIES_COLLECTION, id), { base_score: score })
        )
      )
      setPendingBaseScores({})
    }
    await qc.invalidateQueries({ queryKey: ['team', currentTeamId] })
    await qc.invalidateQueries({ queryKey: ['activities', currentTeamId] })
  }

  const TABS: { id: TabId; label: string }[] = [
    { id: 'leaderboard', label: t('tabLeaderboard') },
    { id: 'scoring', label: t('tabScoring') },
    { id: 'badges', label: t('tabBadges') },
  ]

  // Gamification is delivered as a plugin — show an install prompt if it isn't on.
  if (!pluginsLoading && !isInstalled('gamification')) {
    return (
      <div className="max-w-md mx-auto text-center py-16 space-y-3">
        <Trophy className="mx-auto h-10 w-10 text-muted-foreground/40" />
        <h1 className="text-xl font-semibold">{t('notInstalledTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('notInstalledBody')}</p>
        <Link href="/settings/plugins" className={buttonVariants()}>{t('goToPlugins')}</Link>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Leaderboard tab */}
      {tab === 'leaderboard' && currentTeamId && (
        <LeaderboardTab teamId={currentTeamId} />
      )}

      {/* Scoring + Badges share one form */}
      {(tab === 'scoring' || tab === 'badges') && (
        <form id={GAMIFICATION_FORM_ID} onSubmit={handleSubmit(onSubmit)} autoComplete="off">
          {tab === 'scoring' && currentTeamId && (
            <ScoringTab
              register={register}
              watch={watch}
              setValue={setValue}
              control={control}
              activities={activities}
              pendingBaseScores={pendingBaseScores}
              onBaseScoreChange={(id, score) => setPendingBaseScores((prev) => ({ ...prev, [id]: score }))}
              teamId={currentTeamId}
            />
          )}
          {tab === 'badges' && (
            <BadgesTab register={register} watch={watch} control={control} setValue={setValue} />
          )}

          {/* Sticky save — page-primary lane; portalled out of the <form>, hence
              the explicit `form` attribute. */}
          {showSave && (
            <FloatingSlot lane="page-primary">
              <button
                type="submit"
                form={GAMIFICATION_FORM_ID}
                disabled={isSubmitting}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium shadow-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                {isSubmitting ? t('saving') : t('save')}
              </button>
            </FloatingSlot>
          )}
        </form>
      )}
    </div>
  )
}
