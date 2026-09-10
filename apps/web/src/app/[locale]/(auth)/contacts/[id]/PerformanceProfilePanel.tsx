'use client'

// The performance check-in radar + named profile badge.
//
// Lives in the Coaching tab (moved from Stats, 2026-08-27): the check-ins feed
// straight into the goals right below them, so splitting the two across tabs
// was the split the coaching story never needed. The plan gate is unchanged —
// still `advanced_dashboard` — only the location moved.
//
// `profile_key` used to be computed and stored (`detectPerformanceProfile`,
// `@linyup/shared`) but never read back into any web UI — a member could be
// told on their phone "you're at burnout risk, talk to your coach" while the
// coach's own screen showed nothing. The badge below is that read-back.
// Colours are ported from `apps/mobile/src/components/profile/
// PerformanceProfileSection.tsx` (`PROFILE_DISPLAY`) so the two surfaces agree
// visually; the labels and message copy are new and DELIBERATELY third-person
// (coach-facing) rather than the mobile copy's second-person member directive.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  CONTACTS_COLLECTION,
  CONTACT_GOALS_SUBCOLLECTION,
  CONTACT_PERFORMANCE_CHECKINS_SUBCOLLECTION,
  resolveCoachingDimensions,
  detectPerformanceProfile,
  dimensionLabel,
  PERFORMANCE_PROFILE_COLORS,
} from '@linyup/shared'
import type { Contact, Team, PerformanceCheckin, ProfileKey, Goal } from '@linyup/shared'
import { usePlan } from '@/hooks/usePlan'
import { useUpgradeModal } from '@/contexts/UpgradeModalContext'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
import { Plus, Lock } from 'lucide-react'
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  Legend,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

// ─── profile display metadata ─────────────────────────────────────────────────
// Colours ONLY are ported from the mobile PROFILE_DISPLAY map — labels/messages
// are new i18n keys (see module header).


function ProfileBadge({
  profileKey,
  primaryLever,
  anchor,
  dimensions,
}: {
  profileKey: ProfileKey
  primaryLever?: string | null
  anchor?: string | null
  dimensions: { key: string; label: string }[]
}) {
  const t = useTranslations('Contacts')
  const color = PERFORMANCE_PROFILE_COLORS[profileKey]
  const labelFor = (key?: string | null) =>
    key ? (dimensions.find((d) => d.key === key)?.label ?? key) : ''
  const message =
    profileKey === 'default'
      ? t('profileBadgeMessage_default', { anchor: labelFor(anchor), lever: labelFor(primaryLever) })
      : t(`profileBadgeMessage_${profileKey}` as Parameters<typeof t>[0])

  return (
    <div
      className="rounded-lg p-3 space-y-1"
      style={{ backgroundColor: `${color}18` }}
    >
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <span className="text-xs font-semibold" style={{ color }}>
          {t(`profileBadgeLabel_${profileKey}` as Parameters<typeof t>[0])}
        </span>
      </div>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  )
}

// ─── create a task for the weakest axis ────────────────────────────────────
// The ONE connection `primary_lever` was missing: naming a weak axis and
// creating work against it. The task it writes carries `from_dimension` — the
// axis it came FROM — and NO categories: provenance is not classification, and
// "work on your Focus" is not a statement about what the work is (see the
// header of packages/shared/src/types/goal.ts). The coach can file it into a
// real category later; guessing one here would be worse than leaving it blank.
//
// Deliberately NOT the full GoalDialog: the title is pre-filled (and
// editable) and the axis is fixed, so there is nothing left to fill in except,
// optionally, which open goal this serves. Choosing none files it under the
// virtual "General" group — no placeholder goal is ever created for it (see
// `Goal.parent_goal_id`).

// Sentinel for the Select's "no parent" option — Radix Select rejects an
// empty-string item value, and `undefined`/`null` aren't valid values either.
const NO_PARENT = '__general__'

function CreateTaskFromLever({
  contactId,
  dimensionKey,
  dimensionLabel: label,
  openGoals,
  onCreated,
}: {
  contactId: string
  dimensionKey: string
  dimensionLabel: string
  openGoals: { id: string; title: string }[]
  onCreated: () => void
}) {
  const t = useTranslations('Contacts')
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [parentGoalId, setParentGoalId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const startOpen = () => {
    setTitle(t('coachingCreateTaskDefaultTitle', { dimension: label }))
    setParentGoalId(null)
    setFailed(false)
    setOpen(true)
  }

  const create = async () => {
    if (!title.trim()) return
    setSaving(true)
    setFailed(false)
    try {
      await addDoc(collection(db, CONTACTS_COLLECTION, contactId, CONTACT_GOALS_SUBCOLLECTION), {
        type: 'task',
        title: title.trim(),
        description: null,
        status: 'open',
        categories: [],
        from_dimension: dimensionKey,
        parent_goal_id: parentGoalId,
        created_by: 'coach',
        created_at: serverTimestamp(),
        target_date: null,
      })
      onCreated()
      setOpen(false)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={startOpen}
        className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
      >
        <Plus className="h-3 w-3" />
        {t('coachingCreateTaskCta', { dimension: label })}
      </button>
    )
  }

  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="h-8 text-sm"
        autoFocus
      />
      {openGoals.length > 0 && (
        <Select
          value={parentGoalId ?? NO_PARENT}
          onValueChange={(v) => setParentGoalId(v === NO_PARENT ? null : v)}
        >
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_PARENT}>{t('goalFormParentGoalNone')}</SelectItem>
            {openGoals.map((g) => (
              <SelectItem key={g.id} value={g.id}>{g.title}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {failed && <p className="text-xs text-destructive">{t('coachingCreateTaskFailed')}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={create}
          disabled={saving || !title.trim()}
          className="px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {saving ? '…' : t('coachingCreateTaskSubmit')}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={saving}
          className="px-3 py-1 rounded-md border text-xs font-medium hover:bg-muted transition-colors"
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  )
}

// ─── chart helpers (CSS vars don't resolve in SVG presentation attrs) ─────────

function RadarAngleTick({
  x,
  y,
  cx,
  payload,
}: {
  x?: number
  y?: number
  cx?: number
  payload?: { value: string }
}) {
  if (!payload?.value) return null
  const textAnchor =
    (x ?? 0) > (cx ?? 0) + 4 ? 'start' : (x ?? 0) < (cx ?? 0) - 4 ? 'end' : 'middle'
  return (
    <text
      fill="currentColor"
      x={x}
      y={y}
      textAnchor={textAnchor}
      dy={4}
      style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))', fontFamily: 'inherit' }}
    >
      {payload.value}
    </text>
  )
}

// ─── data hook ────────────────────────────────────────────────────────────────

function useContactPerformanceCheckins(contactId: string) {
  return useQuery<PerformanceCheckin[]>({
    queryKey: ['contact-performance-checkins', contactId],
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, CONTACTS_COLLECTION, contactId, CONTACT_PERFORMANCE_CHECKINS_SUBCOLLECTION),
          orderBy('taken_at', 'desc'),
          limit(20)
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as PerformanceCheckin)
    },
  })
}

// ─── add check-in dialog ─────────────────────────────────────────────────────
// Every axis starts UNSET — a stray double-click used to write a permanent,
// dated rating of 3/5 across the board, indistinguishable from a deliberate
// neutral. Save stays disabled until every dimension has an explicit score.

function AddCheckinDialog({
  open,
  onOpenChange,
  contactId,
  dimensions,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  contactId: string
  dimensions: { key: string; label: string }[]
  onSaved: () => void
}) {
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const emptyScores = (): Record<string, number | null> =>
    Object.fromEntries(dimensions.map((d) => [d.key, null]))
  const [scores, setScores] = useState<Record<string, number | null>>(emptyScores)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const allTouched = dimensions.length > 0 && dimensions.every((d) => scores[d.key] != null)

  const save = async () => {
    if (!allTouched) return
    setSaving(true)
    try {
      const finalScores = Object.fromEntries(
        Object.entries(scores).filter((entry): entry is [string, number] => entry[1] != null)
      )
      const profile = detectPerformanceProfile(finalScores)
      await addDoc(
        collection(db, CONTACTS_COLLECTION, contactId, CONTACT_PERFORMANCE_CHECKINS_SUBCOLLECTION),
        {
          scores: finalScores,
          notes: notes.trim() || null,
          filled_by: 'coach',
          context: '1to1',
          taken_at: serverTimestamp(),
          ...profile,
        }
      )
      onSaved()
      onOpenChange(false)
      setScores(emptyScores())
      setNotes('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('performanceCheckinTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {dimensions.map((ind) => (
            <div key={ind.key} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">{ind.label}</label>
                <span className="text-sm font-bold tabular-nums">
                  {scores[ind.key] != null ? `${scores[ind.key]}/5` : t('goalScoreUnset')}
                </span>
              </div>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setScores((prev) => ({ ...prev, [ind.key]: v }))}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                      scores[ind.key] === v
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="space-y-1">
            <label className="text-sm font-medium">{t('performanceCheckinNotes')}</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
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
            disabled={saving || !allTouched}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? tCommon('loading') : t('saveChanges')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── panel ────────────────────────────────────────────────────────────────────

export function PerformanceProfilePanel({
  contact,
  team,
  goals,
}: {
  contact: Contact
  team: Team | null
  /** The contact's goals — same fetch GoalsTab already made (`useGoals`), passed
   *  down rather than re-queried, so the "create a task for the weakest axis"
   *  action below can offer open goals as parents without a second read. */
  goals: Goal[]
}) {
  const t = useTranslations('Contacts')
  const [addCheckinOpen, setAddCheckinOpen] = useState(false)
  const { data: checkins = [], isLoading: checkinsLoading } = useContactPerformanceCheckins(
    contact.id
  )
  const { hasFeature } = usePlan()
  const { openUpgradeModal } = useUpgradeModal()
  const qc = useQueryClient()

  const dimensions = resolveCoachingDimensions(team)

  // Parent options for the quick "create a task" action — real goals only
  // (steps don't nest, see `Goal.parent_goal_id`), still open or in progress.
  const openGoalOptions = goals
    .filter((g) => g.type === 'goal' && (g.status === 'open' || g.status === 'in_progress'))
    .map((g) => ({ id: g.id, title: g.title }))

  const latestCoach = checkins.find((c) => c.filled_by === 'coach') ?? null
  const latestStudent = checkins.find((c) => c.filled_by === 'student') ?? null
  const hasBoth = !!latestCoach && !!latestStudent

  const radarData = dimensions.map((ind) =>
    hasBoth
      ? {
          subject: ind.label,
          coach: latestCoach?.scores?.[ind.key] ?? 0,
          student: latestStudent?.scores?.[ind.key] ?? 0,
        }
      : {
          subject: ind.label,
          value: (latestCoach || latestStudent)?.scores?.[ind.key] ?? 0,
        }
  )

  const performanceUnlocked = hasFeature('advanced_dashboard')

  // Tooltip style — inline style prop resolves CSS vars; SVG attrs do not
  const tooltipStyle = {
    fontSize: 12,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid hsl(var(--border))',
    backgroundColor: 'hsl(var(--card))',
    color: 'hsl(var(--card-foreground))',
  }

  // The badge mirrors the member's own phone (mobile derives it from the
  // latest SELF check-in specifically, not "whoever filled in last") — so the
  // coach sees exactly what the member saw, never a coach-filled substitute.
  const badgeProfileKey = latestStudent?.profile_key ?? null
  // Independent of the named-profile badge above: `primary_lever` is computed
  // for ANY dimension set (see `detectPerformanceProfile`), so a team on
  // custom axes gets no named profile but still gets a weakest axis — and
  // still gets the "create a task for it" action. A check-in with no scores,
  // or one written before this field existed, has neither.
  const badgePrimaryLever = latestStudent?.primary_lever ?? null

  return (
    <div className="rounded-xl border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('statsPanelPerformance')}
        </p>
        {performanceUnlocked && checkins.length > 0 && (
          <button
            type="button"
            onClick={() => setAddCheckinOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium hover:bg-muted transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('addPerformanceCheckin')}
          </button>
        )}
      </div>

      {!performanceUnlocked ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
            <Lock className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">{t('performanceProfileLockedTitle')}</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
              {t('performanceProfileLockedDesc')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => openUpgradeModal({ feature: 'advanced_dashboard' })}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            {t('upgradeToStudio')}
          </button>
        </div>
      ) : checkinsLoading ? (
        <div className="h-[260px] rounded-lg bg-muted animate-pulse" />
      ) : checkins.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center rounded-lg border border-dashed">
          <p className="text-sm text-muted-foreground max-w-xs">{t('noPerformanceCheckins')}</p>
          <button
            type="button"
            onClick={() => setAddCheckinOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors"
          >
            <Plus className="h-4 w-4" />
            {t('addPerformanceCheckin')}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {badgeProfileKey && (
            <ProfileBadge
              profileKey={badgeProfileKey}
              primaryLever={latestStudent?.primary_lever}
              anchor={latestStudent?.anchor}
              dimensions={dimensions}
            />
          )}
          {badgePrimaryLever && (
            <CreateTaskFromLever
              contactId={contact.id}
              dimensionKey={badgePrimaryLever}
              dimensionLabel={dimensionLabel(badgePrimaryLever, dimensions)}
              openGoals={openGoalOptions}
              onCreated={() => qc.invalidateQueries({ queryKey: ['contact-goals', contact.id] })}
            />
          )}
          <div className="h-[260px]">
            <ResponsiveContainer width="99%" height="100%">
              <RadarChart data={radarData} margin={{ top: 16, right: 36, left: 36, bottom: 16 }}>
                {/* stroke as rgba so it works on both themes without CSS vars in SVG attr */}
                <PolarGrid stroke="rgba(128,128,128,0.25)" />
                <PolarAngleAxis dataKey="subject" tick={<RadarAngleTick />} />
                {hasBoth ? (
                  <>
                    <Radar
                      name="Coach"
                      dataKey="coach"
                      stroke="#6366f1"
                      fill="#6366f1"
                      fillOpacity={0.35}
                    />
                    <Radar
                      name="Student"
                      dataKey="student"
                      stroke="#22c55e"
                      fill="#22c55e"
                      fillOpacity={0.25}
                    />
                    <Legend
                      iconSize={10}
                      wrapperStyle={{
                        fontSize: 11,
                        paddingTop: 8,
                        color: 'hsl(var(--foreground))',
                      }}
                    />
                  </>
                ) : (
                  <Radar dataKey="value" stroke="#6366f1" fill="#6366f1" fillOpacity={0.4} />
                )}
                <Tooltip contentStyle={tooltipStyle} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <AddCheckinDialog
        open={addCheckinOpen}
        onOpenChange={setAddCheckinOpen}
        contactId={contact.id}
        dimensions={dimensions}
        onSaved={() =>
          qc.invalidateQueries({ queryKey: ['contact-performance-checkins', contact.id] })
        }
      />
    </div>
  )
}
