'use client'

import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import {
  collection, query, orderBy, getDocs, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp, Timestamp, writeBatch,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { CONTACTS_COLLECTION, CONTACT_GOALS_SUBCOLLECTION, resolveGoalCategories, goalCategoryLabel, resolveCoachingDimensions, dimensionLabel, groupGoalsWithSteps, goalIsArchived, sortSteps, CONTACT_GOAL_EVALUATIONS_SUBCOLLECTION, GOAL_STATUS_COLORS, visibleGoals } from '@linyup/shared'
import type { Contact, Team, Goal, GoalEvaluation, GoalStatus, PerformanceIndicator, StepSortMode } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Flag, CheckSquare, Circle, ChevronDown, ChevronUp, ChevronRight, Plus, Trash2,
  Info, CheckCircle2, Archive, ArchiveRestore,
} from 'lucide-react'
import { Segmented } from '@/components/ui/segmented'
import { GoalProgressBar } from '@/components/coaching/GoalProgressBar'
import { RatingStars } from '@/components/coaching/RatingStars'
import { GoalStateChips, type GoalStateChipLabels } from '@/components/coaching/GoalStateChips'
import { GoalDialog, type GoalDialogLabels } from '@/components/coaching/GoalDialog'
import { EvaluationDialog, type EvaluationDialogLabels } from '@/components/coaching/EvaluationDialog'
import { GOAL_STATUS_CLASSES } from '@/components/coaching/goalStatusStyles'
import { SortableTaskList } from './SortableTaskList'
import { CoachAssignment } from './CoachAssignment'
import { PerformanceProfilePanel } from './PerformanceProfilePanel'
import {
  AttendanceTrendCard,
  TREND_PERIODS,
  useContactWeeklyReports,
  type TrendPeriodKey,
} from './AttendanceTrendCard'

// ─── constants ────────────────────────────────────────────────────────────────
// TWO VOCABULARIES, and this file uses both for different jobs:
//
//   • GOAL CATEGORIES (`resolveGoalCategories` / `goalCategoryLabel`) — what a
//     goal is ABOUT. Drives the picker and the chips on a goal card.
//   • CHECK-IN AXES (`resolveCoachingDimensions` / `dimensionLabel`) — what the
//     radar measures. Used here for ONE thing: rendering `goal.from_dimension`,
//     the axis a goal was created from.
//
// They were briefly merged into one list; a goal's subject and a radar axis are
// not the same question, and collapsing them made the picker wrong. See the
// header of `packages/shared/src/types/goal.ts` for the full reasoning.

// The shared coaching dialogs and chips own the behaviour and take their WORDS
// from the surface mounting them (`components/coaching/*` — the Space mounts
// the same components from its own namespace, see its `useSpaceCoachingLabels`).
// This builds the Contacts copy. A hook, so the accessors are bound HERE and
// `i18n:check` resolves each key against its namespace.
function useCoachingLabels() {
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  return {
    goalDialog: (dialogTitle: string): GoalDialogLabels => ({
      dialogTitle,
      title: t('goalFormTitle'),
      description: t('goalFormDescription'),
      categories: t('goalFormCategories'),
      parentGoal: t('goalFormParentGoal'),
      parentGoalNone: t('goalFormParentGoalNone'),
      startDate: t('goalFormStartDate'),
      noStartDate: t('goalFormNoStartDate'),
      targetDate: t('goalFormTargetDate'),
      noTargetDate: t('goalFormNoTargetDate'),
      cancel: t('cancel'),
      save: t('save'),
      saving: tCommon('saving'),
      saveFailed: t('goalSaveFailed'),
    }),
    evaluationDialog: (editing: boolean): EvaluationDialogLabels => ({
      title: editing ? t('goalEditEval') : t('goalAddEval'),
      score: t('goalScore'),
      scoreHint: t('goalScoreHint'),
      notes: t('goalNotes'),
      statusAfter: t('goalStatusAfter'),
      status: (s) => t(`goalStatus_${s}`),
      cancel: t('cancel'),
      save: t('save'),
      saving: tCommon('saving'),
      saveFailed: t('goalEvalSaveFailed'),
    }),
    goalStateChips: {
      lastEvaluated: (date) => t('goalLastEvaluatedOn', { date: formatDate(date) }),
      overdue: t('goalOverdueBadge'),
    } satisfies GoalStateChipLabels,
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function tsToDate(ts: unknown): Date | undefined {
  if (!ts) return undefined
  if (ts instanceof Timestamp) return ts.toDate()
  if (ts instanceof Date) return ts
  if (typeof ts === 'object' && ts !== null && 'toDate' in ts) return (ts as { toDate(): Date }).toDate()
  return undefined
}

function formatDate(ts: unknown): string {
  const d = tsToDate(ts)
  if (!d) return ''
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

// ─── data hooks ───────────────────────────────────────────────────────────────

function useGoals(contactId: string) {
  return useQuery<Goal[]>({
    queryKey: ['contact-goals', contactId],
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, CONTACTS_COLLECTION, contactId, CONTACT_GOALS_SUBCOLLECTION),
          orderBy('created_at', 'desc'),
        ),
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id } as Goal))
    },
  })
}

async function fetchEvaluations(contactId: string, goalId: string): Promise<GoalEvaluation[]> {
  const snap = await getDocs(
    query(
      collection(db, CONTACTS_COLLECTION, contactId, CONTACT_GOALS_SUBCOLLECTION, goalId, CONTACT_GOAL_EVALUATIONS_SUBCOLLECTION),
      orderBy('evaluated_at', 'desc'),
    ),
  )
  return snap.docs.map((d) => ({ ...d.data(), id: d.id } as GoalEvaluation))
}

// ─── GoalCard ─────────────────────────────────────────────────────────────────

interface GoalCardProps {
  goal: Goal
  contactId: string
  categories: PerformanceIndicator[]
  /** Check-in axes — used ONLY to label `goal.from_dimension`. */
  dimensions: PerformanceIndicator[]
  steps: Goal[]
  onChanged: () => void
  onAddStep: (goalId: string) => void
  onEditStep: (step: Goal) => void
  /** Owned by the tab: one control orders every list on the page. */
  sortMode: StepSortMode
  onReorderSteps: (list: Goal[], from: number, to: number) => void
}

function GoalCard({ goal, contactId, categories, dimensions, steps, onChanged, onAddStep, onEditStep, sortMode, onReorderSteps }: GoalCardProps) {
  const t = useTranslations('Contacts')
  const labels = useCoachingLabels()
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  // NOT the same thing as `expanded` above, which opens the EVALUATIONS panel.
  // This folds the card's own body away so a long list of goals stays readable;
  // the header, its status and the step rail stay visible, because a collapsed
  // goal you cannot read the state of is just a hidden goal.
  const [collapsed, setCollapsed] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [evals, setEvals] = useState<GoalEvaluation[]>([])
  const [loadingEvals, setLoadingEvals] = useState(false)
  const [showEvalDialog, setShowEvalDialog] = useState(false)
  const [editingEval, setEditingEval] = useState<GoalEvaluation | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const goalRef = doc(db, CONTACTS_COLLECTION, contactId, CONTACT_GOALS_SUBCOLLECTION, goal.id)

  const loadEvals = async () => {
    setLoadingEvals(true)
    try { setEvals(await fetchEvaluations(contactId, goal.id)) } finally { setLoadingEvals(false) }
  }

  const handleExpand = () => {
    if (!expanded) loadEvals()
    setExpanded((e) => !e)
  }

  // ONE BATCH, not two awaits. An evaluation and the status it moves the goal to
  // are a single fact: if the second write never lands, the goal keeps a status
  // its own newest evaluation contradicts, and nothing later reconciles them.
  const handleAddEval = async (score: number, notes: string, statusAfter: GoalStatus) => {
    const batch = writeBatch(db)
    batch.set(doc(collection(goalRef, CONTACT_GOAL_EVALUATIONS_SUBCOLLECTION)), {
      evaluated_at: serverTimestamp(),
      evaluated_by: 'coach',
      score,
      notes: notes || null,
      status_after: statusAfter,
    })
    batch.update(goalRef, { status: statusAfter })
    await batch.commit()
    setShowEvalDialog(false)
    await loadEvals()
    qc.invalidateQueries({ queryKey: ['contact-goals', contactId] })
  }

  const handleEditEval = async (score: number, notes: string, statusAfter: GoalStatus) => {
    if (!editingEval) return
    const batch = writeBatch(db)
    batch.update(doc(collection(goalRef, CONTACT_GOAL_EVALUATIONS_SUBCOLLECTION), editingEval.id), {
      score, notes: notes || null, status_after: statusAfter, edited: true,
    })
    batch.update(goalRef, { status: statusAfter })
    await batch.commit()
    setEditingEval(null)
    await loadEvals()
    qc.invalidateQueries({ queryKey: ['contact-goals', contactId] })
  }

  const handleEdit = async (data: { title: string; description: string; categories: string[]; targetDate: Date | null; startDate: Date | null }) => {
    await updateDoc(goalRef, {
      title: data.title,
      description: data.description || null,
      categories: data.categories,
      target_date: data.targetDate ? Timestamp.fromDate(data.targetDate) : null,
      start_date: data.startDate ? Timestamp.fromDate(data.startDate) : null,
    })
    setEditOpen(false)
    onChanged()
  }

  const handleDelete = async () => {
    setDeleting(true)
    try { await deleteDoc(goalRef); onChanged() } finally { setDeleting(false); setConfirmDelete(false) }
  }

  // Filing away, not deleting: the document is untouched but for this stamp, and
  // un-archiving is writing null back. The counters and the overdue job read the
  // same field, so this also stops the goal nagging.
  const toggleArchived = async () => {
    setArchiving(true)
    try {
      await updateDoc(goalRef, { archived_at: archived ? null : serverTimestamp() })
      onChanged()
    } finally { setArchiving(false) }
  }

  const archived = goalIsArchived(goal)
  const canEval = goal.status === 'open' || goal.status === 'in_progress'
  const targetDateStr = formatDate(goal.target_date)
  const startDateStr = formatDate(goal.start_date)
  const doneSteps = steps.filter((s) => s.status === 'achieved').length

  return (
    <>
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className={`p-4 space-y-3 ${archived ? 'opacity-60' : ''}`}>
          {/* Header */}
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <p className="font-semibold leading-snug">{goal.title}</p>
              {goal.description && (
                <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{goal.description}</p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setCollapsed((c) => !c)}
                aria-label={collapsed ? t('goalExpandCard') : t('goalCollapseCard')}
                title={collapsed ? t('goalExpandCard') : t('goalCollapseCard')}
                className="p-1 rounded hover:bg-muted transition-colors"
              >
                {collapsed
                  ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
              {goal.created_by !== 'coach' ? (
                // Visible chip, not a hover-only cue — front-desk iPads have no
                // hover state, so a tooltip here explained nothing to anyone.
                <span
                  title={t('goalCoachInfo')}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                >
                  <Info className="h-3 w-3" />
                  {t('goalMemberAddedBadge')}
                </span>
              ) : (
                <>
                  <button
                    onClick={toggleArchived}
                    disabled={archiving}
                    aria-label={archived ? t('goalUnarchive') : t('goalArchive')}
                    title={archived ? t('goalUnarchive') : t('goalArchive')}
                    className="p-1 rounded hover:bg-muted transition-colors"
                  >
                    {archived
                      ? <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground" />
                      : <Archive className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                  <button onClick={() => setEditOpen(true)} className="p-1 rounded hover:bg-muted transition-colors">
                    <Flag className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                  <button onClick={() => setConfirmDelete(true)} disabled={deleting} className="p-1 rounded hover:bg-muted transition-colors">
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Chips */}
          <div className={`flex flex-wrap gap-1.5 ${collapsed ? 'hidden' : ''}`}>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${GOAL_STATUS_CLASSES[goal.status]}`}>
              {t(`goalStatus_${goal.status}`)}
            </span>
            {goal.categories.map((key) => (
              <span key={key} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">
                {goalCategoryLabel(key, categories)}
              </span>
            ))}
            {/* PROVENANCE, NOT CLASSIFICATION — "this goal came out of a weak
                Focus score". Deliberately styled apart from the category chips
                (dashed, unfilled) so it never reads as one: the coach writes
                categories, the app writes this. */}
            {goal.from_dimension && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-dashed text-xs text-muted-foreground">
                {t('goalFromDimension', { dimension: dimensionLabel(goal.from_dimension, dimensions) })}
              </span>
            )}
            {archived && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">
                {t('goalArchivedBadge')}
              </span>
            )}
            {startDateStr && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">
                {t('goalStartDate')}: {startDateStr}
              </span>
            )}
            {targetDateStr && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">
                {t('goalTargetDate')}: {targetDateStr}
              </span>
            )}
            <span className={`ml-auto text-xs ${goal.created_by === 'coach' ? 'text-violet-500' : 'text-muted-foreground'}`}>
              {t(`goalBy_${goal.created_by}`)}
            </span>
          </div>

          {/* Latest score / last evaluated / overdue — so the one stale goal in
              a list is visible WITHOUT expanding every card. */}
          {!collapsed && <GoalStateChips goal={goal} labels={labels.goalStateChips} />}

          {/* THE RAIL STAYS WHEN COLLAPSED. It is the one thing worth reading
              about a goal you have folded away — "two of five done" answers the
              question the card is there to answer. */}
          <GoalProgressBar
            steps={steps}
            label={t('goalStepsCompleted', { done: doneSteps, total: steps.length })}
          />

          {!collapsed && (
            <>
              {/* Steps nested under their goal — see groupGoalsWithSteps. */}
              <div className="rounded-lg border bg-muted/20 divide-y">
                <div className="flex items-center justify-between px-3 py-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {steps.length > 0
                      ? t('goalStepsCompleted', { done: doneSteps, total: steps.length })
                      : t('goalNoSteps')}
                  </p>
                  <button
                    type="button"
                    onClick={() => onAddStep(goal.id)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    {t('goalsAddTask')}
                  </button>
                </div>
                <SortableTaskList
                  tasks={steps}
                  enabled={sortMode === 'manual' && !archived && steps.length > 1}
                  onReorder={(from, to) => onReorderSteps(steps, from, to)}
                  dragLabel={t('goalReorderTask')}
                >
                  {(step, handle) => (
                    <TaskCard
                      goal={step}
                      contactId={contactId}
                      nested
                      onChanged={onChanged}
                      onEdit={() => onEditStep(step)}
                      handle={handle}
                    />
                  )}
                </SortableTaskList>
              </div>

              {/* Expand toggle */}
              <button
                onClick={handleExpand}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
              >
                {t('goalEvaluations')}
                {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
            </>
          )}
        </div>

        {/* Evaluations panel */}
        {expanded && !collapsed && (
          <div className="border-t px-4 py-3 space-y-2 bg-muted/30">
            {loadingEvals ? (
              <p className="text-xs text-muted-foreground py-2">{t('loading')}</p>
            ) : evals.length === 0 ? (
              <p className="text-xs text-muted-foreground py-1">{t('goalNoEvaluations')}</p>
            ) : (
              evals.map((ev) => (
                <div
                  key={ev.id}
                  className="rounded-lg border-l-4 bg-card px-3 py-2 space-y-1"
                  style={{ borderLeftColor: GOAL_STATUS_COLORS[ev.status_after] }}
                >
                  <div className="flex items-center justify-between">
                    <RatingStars value={ev.score} readOnly size={14} />
                    <div className="flex items-center gap-1.5">
                      {ev.edited && <span className="text-[10px] text-muted-foreground">edited</span>}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${ev.evaluated_by === 'coach' ? 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'}`}>
                        {t(`goalBy_${ev.evaluated_by}`)}
                      </span>
                      {ev.evaluated_by === 'coach' && (
                        <button onClick={() => setEditingEval(ev)} className="text-muted-foreground hover:text-foreground transition-colors">
                          <Flag className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {formatDate(ev.evaluated_at)} · {t(`goalStatus_${ev.status_after}`)}
                  </p>
                  {ev.notes && <p className="text-xs text-foreground">{ev.notes}</p>}
                </div>
              ))
            )}
            {canEval && (
              <Button variant="outline" size="sm" onClick={() => setShowEvalDialog(true)} className="mt-1">
                <Plus className="h-3.5 w-3.5 mr-1" />{t('goalAddEval')}
              </Button>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('goalDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('goalDeleteDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <GoalDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        type="goal"
        categories={categories}
        initial={goal}
        fields={{ description: true, startDate: true, targetDate: true }}
        onSubmit={handleEdit}
        labels={labels.goalDialog(t('goalEditGoal'))}
      />
      <EvaluationDialog
        open={showEvalDialog}
        onOpenChange={setShowEvalDialog}
        goalStatus={goal.status}
        canSetStatus
        onSubmit={(v) => handleAddEval(v.score, v.notes, v.statusAfter)}
        labels={labels.evaluationDialog(false)}
      />
      {editingEval && (
        <EvaluationDialog
          open={true}
          onOpenChange={(o) => { if (!o) setEditingEval(null) }}
          goalStatus={goal.status}
          initial={editingEval}
          canSetStatus
          onSubmit={(v) => handleEditEval(v.score, v.notes, v.statusAfter)}
          labels={labels.evaluationDialog(true)}
        />
      )}
    </>
  )
}

// ─── TaskCard (a "step" — the word "Task" is kept deliberately) ───────────────

interface TaskCardProps {
  goal: Goal
  contactId: string
  onChanged: () => void
  /** Nested inside a GoalCard: tighter, borderless row. Top-level (General):
   *  the fuller standalone card. */
  nested?: boolean
  /** Opens the shared edit dialog (with the parent picker) from the parent —
   *  General-section steps render this inline instead (see GoalsTab). */
  onEdit?: () => void
  /** The drag handle, supplied by SortableTaskList in manual order; null in a
   *  date order, where dragging would be overwritten by the sort. */
  handle?: ReactNode
}

function TaskCard({ goal, contactId, onChanged, nested, onEdit, handle }: TaskCardProps) {
  const t = useTranslations('Contacts')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [acting, setActing] = useState(false)
  const isDone = goal.status === 'achieved'
  const goalRef = doc(db, CONTACTS_COLLECTION, contactId, CONTACT_GOALS_SUBCOLLECTION, goal.id)

  const toggleDone = async () => {
    setActing(true)
    try {
      await updateDoc(goalRef, isDone
        ? { status: 'open', completed_at: null }
        : { status: 'achieved', completed_at: serverTimestamp() })
      onChanged()
    } finally { setActing(false) }
  }

  const handleDelete = async () => {
    await deleteDoc(goalRef)
    onChanged()
    setConfirmDelete(false)
  }

  return (
    <>
      <div className={`flex items-start gap-3 ${nested ? 'px-3 py-2' : 'rounded-xl border bg-card px-4 py-3'} ${isDone ? 'opacity-60' : ''}`}>
        {handle}
        <button onClick={toggleDone} disabled={acting} className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground transition-colors">
          {isDone
            ? <CheckCircle2 className="h-5 w-5 text-green-500" />
            : <Circle className="h-5 w-5" />}
        </button>
        <div className="flex-1 min-w-0">
          <p className={`font-medium text-sm leading-snug ${isDone ? 'line-through text-muted-foreground' : ''}`}>
            {goal.title}
          </p>
          {goal.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{goal.description}</p>
          )}
          {(goal.start_date || goal.target_date) && (
            <p className="text-xs text-muted-foreground mt-1">
              {[
                goal.start_date && `${t('goalStartDate')}: ${formatDate(goal.start_date)}`,
                goal.target_date && `${t('goalTargetDate')}: ${formatDate(goal.target_date)}`,
              ].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onEdit} className="p-1 rounded hover:bg-muted transition-colors">
            <CheckSquare className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <button onClick={() => setConfirmDelete(true)} className="p-1 rounded hover:bg-muted transition-colors">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </button>
        </div>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('taskDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('taskDeleteDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ─── GoalsTab ─────────────────────────────────────────────────────────────────

interface Props {
  contact: Contact
  teamId: string | null
  team: Team | null
}

export function GoalsTab({ contact, teamId, team }: Props) {
  const t = useTranslations('Contacts')
  const labels = useCoachingLabels()
  const qc = useQueryClient()
  const { data: goals = [], isLoading } = useGoals(contact.id)
  const [addGoalOpen, setAddGoalOpen] = useState(false)
  // ONE sort for every task list on the tab (a goal's steps and General alike):
  // a coach thinks "how am I looking at tasks", not "how is this one list".
  // Not persisted — it is a way of reading the page, not a setting.
  const [sortMode, setSortMode] = useState<StepSortMode>('manual')
  const [showArchived, setShowArchived] = useState(false)
  // The attendance trend's own period selector. Default 12 weeks, as it was in
  // the Stats tab it came from.
  const [trendPeriod, setTrendPeriod] = useState<TrendPeriodKey>('12w')
  const trendWeeks = TREND_PERIODS.find((p) => p.key === trendPeriod)!.weeks
  const { data: weeklyReports = [], isLoading: reportsLoading } = useContactWeeklyReports(
    contact.id,
    trendWeeks,
  )
  // ONE shared "add/edit step" dialog for every entry point: a goal card's own
  // "add step" button (parentGoalId pre-filled), the General section's add
  // button (parentGoalId unset) and editing an existing step from either place.
  const [stepDialog, setStepDialog] = useState<{ open: boolean; editing: Goal | null; defaultParentGoalId: string | null }>(
    { open: false, editing: null, defaultParentGoalId: null },
  )

  // Categories drive the picker + chips; axes are resolved only to LABEL a
  // goal's `from_dimension` provenance chip (see the header).
  const categories = resolveGoalCategories(team)
  const dimensions = resolveCoachingDimensions(team)

  // ARCHIVING A GOAL TAKES ITS STEPS WITH IT — the cascade lives ONCE in
  // `visibleGoals` (@linyup/shared); its header says why it is in memory.
  const shownGoals = showArchived ? goals : visibleGoals(goals)
  const hasArchived = goals.some((g) => goalIsArchived(g))

  // Sort AROUND the grouping helper, never inside it: its contract is to
  // preserve input order, and the mobile app mirrors it byte-for-byte.
  const { goals: groupedGoals, generalSteps: ungroupedGeneral } = groupGoalsWithSteps(shownGoals)
  const goalsWithSteps = groupedGoals.map(({ goal, steps }) => ({
    goal,
    steps: sortSteps(steps, sortMode),
  }))
  const generalSteps = sortSteps(ungroupedGeneral, sortMode)
  const goalOptions = goalsWithSteps.map(({ goal }) => ({ id: goal.id, title: goal.title }))

  const invalidate = () => qc.invalidateQueries({ queryKey: ['contact-goals', contact.id] })

  // Renumber the whole list densely from the order it is displayed in, in ONE
  // commit: a reorder is a single fact about a list, and half of it landing
  // would leave two tasks claiming the same position.
  const reorderSteps = async (list: Goal[], from: number, to: number) => {
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    const batch = writeBatch(db)
    next.forEach((task, i) => {
      batch.update(
        doc(db, CONTACTS_COLLECTION, contact.id, CONTACT_GOALS_SUBCOLLECTION, task.id),
        { order: i },
      )
    })
    await batch.commit()
    invalidate()
  }

  const handleAddGoal = async (data: { title: string; description: string; categories: string[]; targetDate: Date | null; startDate: Date | null }) => {
    await addDoc(collection(db, CONTACTS_COLLECTION, contact.id, CONTACT_GOALS_SUBCOLLECTION), {
      type: 'goal',
      title: data.title,
      description: data.description || null,
      status: 'open',
      categories: data.categories,
      parent_goal_id: null,
      created_by: 'coach',
      created_at: serverTimestamp(),
      target_date: data.targetDate ? Timestamp.fromDate(data.targetDate) : null,
      start_date: data.startDate ? Timestamp.fromDate(data.startDate) : null,
    })
    setAddGoalOpen(false)
    invalidate()
  }

  const openAddStep = (goalId: string | null) =>
    setStepDialog({ open: true, editing: null, defaultParentGoalId: goalId })
  const openEditStep = (step: Goal) =>
    setStepDialog({ open: true, editing: step, defaultParentGoalId: step.parent_goal_id ?? null })
  const closeStepDialog = () => setStepDialog({ open: false, editing: null, defaultParentGoalId: null })

  const handleSubmitStep = async (data: { title: string; description: string; targetDate: Date | null; startDate: Date | null; parentGoalId: string | null }) => {
    const payload = {
      title: data.title,
      description: data.description || null,
      target_date: data.targetDate ? Timestamp.fromDate(data.targetDate) : null,
      start_date: data.startDate ? Timestamp.fromDate(data.startDate) : null,
      parent_goal_id: data.parentGoalId,
    }
    if (stepDialog.editing) {
      await updateDoc(
        doc(db, CONTACTS_COLLECTION, contact.id, CONTACT_GOALS_SUBCOLLECTION, stepDialog.editing.id),
        payload,
      )
    } else {
      await addDoc(collection(db, CONTACTS_COLLECTION, contact.id, CONTACT_GOALS_SUBCOLLECTION), {
        ...payload,
        type: 'task',
        status: 'open',
        categories: [],
        created_by: 'coach',
        created_at: serverTimestamp(),
      })
    }
    closeStepDialog()
    invalidate()
  }

  if (isLoading) {
    return <div className="py-12 text-center text-sm text-muted-foreground">{t('loading')}</div>
  }

  return (
    <div className="space-y-6 pb-24">
      <CoachAssignment contact={contact} teamId={teamId} />

      {/* THE TWO READINGS, SIDE BY SIDE ON DESKTOP. Both answer "how is this
          person doing" before you set them anything, and they are read together:
          a strong radar with collapsing attendance is a different conversation
          from a weak radar with perfect attendance. Stacked full-width they
          filled a screen and a half between them and pushed the actual work
          below the fold; each is narrow content in a wide container. One column
          under `lg`, where side-by-side would squeeze both charts. */}
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        {/* The check-in radar feeds straight into the goals below it — see
            PerformanceProfilePanel's header for why it moved out of Stats. */}
        <PerformanceProfilePanel contact={contact} team={team} goals={goals} />

        {/* AND SO DOES ATTENDANCE. Whether somebody is actually turning up is the
            first question anyone asks before setting them a goal, and it was a tab
            away — the last card in Stats, which is why that tab is now gone
            (Franco, 2026-08-28). */}
        <AttendanceTrendCard
          reports={weeklyReports}
          loading={reportsLoading}
          period={trendPeriod}
          onPeriodChange={setTrendPeriod}
        />
      </div>

      {/* GENERAL TASKS ARE A COLUMN, NOT A FOOTER.
          Every goal card carries its own steps inline, and unparented ones fall
          into a virtual "General" group that no document backs. That group used
          to sit BELOW every goal — so the more a coach used goals, the further
          the loose to-dos sank, until a contact with six goals hid them entirely
          below the fold. They are the most immediately actionable thing on the
          tab ("bring a new gi", "call about the missed payment"), so their
          position must not depend on how many goals exist.
          Side by side on `lg`, stacked below it — where a narrow column would
          make both unreadable, and where the page scrolls anyway. */}
      <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
        <div className="space-y-3 lg:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Flag className="h-4 w-4 text-violet-500" />
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t('goalsTitle')}</h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              options={[
                { value: 'manual', label: t('goalSortManual') },
                { value: 'start_date', label: t('goalSortStart') },
                { value: 'target_date', label: t('goalSortTarget') },
              ]}
              value={sortMode}
              onChange={setSortMode}
              size="sm"
              ariaLabel={t('goalSortLabel')}
            />
            {/* Offered only once there IS something filed away — otherwise it is
                a control that does nothing, on the page's busiest row. */}
            {hasArchived && (
              <Button
                variant={showArchived ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setShowArchived((v) => !v)}
              >
                <Archive className="h-3.5 w-3.5 mr-1" />
                {t('goalShowArchived')}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setAddGoalOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" />{t('goalsAddGoal')}
            </Button>
          </div>
        </div>

        {goalsWithSteps.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('goalsEmpty')}
          </div>
        ) : (
          <div className="space-y-3">
            {goalsWithSteps.map(({ goal, steps }) => (
              <GoalCard
                key={goal.id}
                goal={goal}
                contactId={contact.id}
                categories={categories}
                dimensions={dimensions}
                steps={steps}
                onChanged={invalidate}
                onAddStep={openAddStep}
                onEditStep={openEditStep}
                sortMode={sortMode}
                onReorderSteps={reorderSteps}
              />
            ))}
          </div>
        )}

        </div>

        {/* General — steps with no parent goal. Virtual: nothing to create,
            migrate, or clean up when the last one leaves it. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckSquare className="h-4 w-4 text-orange-500" />
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t('goalsGeneralHeading')}</h3>
            </div>
            <Button variant="outline" size="sm" onClick={() => openAddStep(null)}>
              <Plus className="h-3.5 w-3.5 mr-1" />{t('goalsAddTask')}
            </Button>
          </div>

          {generalSteps.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t('tasksEmpty')}
            </div>
          ) : (
            <div className="space-y-2">
              <SortableTaskList
                tasks={generalSteps}
                enabled={sortMode === 'manual' && generalSteps.length > 1}
                onReorder={(from, to) => reorderSteps(generalSteps, from, to)}
                dragLabel={t('goalReorderTask')}
              >
                {(step, handle) => (
                  <TaskCard
                    goal={step}
                    contactId={contact.id}
                    onChanged={invalidate}
                    onEdit={() => openEditStep(step)}
                    handle={handle}
                  />
                )}
              </SortableTaskList>
            </div>
          )}
        </div>
      </div>

      <GoalDialog
        open={addGoalOpen}
        onOpenChange={setAddGoalOpen}
        type="goal"
        categories={categories}
        fields={{ description: true, startDate: true, targetDate: true }}
        onSubmit={handleAddGoal}
        labels={labels.goalDialog(t('goalsAddGoal'))}
      />
      <GoalDialog
        key={stepDialog.editing?.id ?? stepDialog.defaultParentGoalId ?? 'new'}
        open={stepDialog.open}
        onOpenChange={(o) => { if (!o) closeStepDialog() }}
        type="task"
        categories={[]}
        initial={stepDialog.editing ?? undefined}
        defaultParentGoalId={stepDialog.defaultParentGoalId}
        fields={{ description: true, startDate: true, targetDate: true, parentOptions: goalOptions }}
        onSubmit={handleSubmitStep}
        labels={labels.goalDialog(stepDialog.editing ? t('goalEditTask') : t('goalsAddTask'))}
      />
    </div>
  )
}
