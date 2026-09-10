'use client'

// The member's own goals + steps — direct Firestore reads/writes against
// `contacts/{contactId}/goals`, permitted by the `isSelfContact` arm of
// firestore.rules. NOT a callable: the rules already model exactly what a
// member may do here (create her own goals/steps, evaluate any of her goals,
// edit/delete only what she created), so there is nothing left for a callable
// to add — same pattern as the rest of Space (see CLAUDE.md "Public Space").
//
// OWNERSHIP, enforced twice (the rules, and again here so the UI never even
// offers a write the rules would refuse): a member may create a goal or a step
// (`created_by: 'student'`) and may only edit or delete a GOAL she created
// herself — a coach-created goal is read-only to her (title, description,
// status, everything). A STEP is narrower but more permissive in one specific
// way: firestore.rules also let her tick a COACH-created step (`type: 'task'`)
// done or undo that — the core coaching loop is "coach assigns homework,
// member ticks it off" — but ONLY that one transition (`open` ⟷ `achieved`,
// touching only `status` + `completed_at`); she still cannot edit its title or
// delete it. See `setStepDone` below and `StepRow.tsx`.
//
// `latest_score` / `last_evaluated_at` / `overdue_at` are Cloud-Function-owned
// (the `onGoalWrite` trigger described in packages/shared/src/types/goal.ts —
// not shipped yet). This file only ever reads them for display; it never
// writes them, and neither does anything downstream of it.
//
// See `useAddGoalEvaluation` below for the evaluations subcollection, which
// carries a DIFFERENT ownership rule than the goal document itself.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  updateDoc,
  writeBatch,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { CONTACTS_COLLECTION, CONTACT_GOALS_SUBCOLLECTION, CONTACT_GOAL_EVALUATIONS_SUBCOLLECTION, visibleGoals } from '@linyup/shared'
import type { Goal, GoalEvaluation, GoalStatus, GoalType } from '@linyup/shared'
import { reportPublicActionFailure, reportPublicLoadFailure } from '@/lib/publicQueryError'
import { useSpaceAuth } from '../SpaceAuthProvider'

function goalsCol(contactId: string) {
  return collection(db, CONTACTS_COLLECTION, contactId, CONTACT_GOALS_SUBCOLLECTION)
}
function goalDoc(contactId: string, goalId: string) {
  return doc(db, CONTACTS_COLLECTION, contactId, CONTACT_GOALS_SUBCOLLECTION, goalId)
}

export interface NewGoalInput {
  type: GoalType
  title: string
  description?: string | null
  /** What this goal is ABOUT — goal-category keys, see `resolveGoalCategories`. */
  categories?: string[]
  targetDate?: Date | null
  /** Which goal this step serves (`type: 'task'` only). Null/absent = the
   *  virtual "General" bucket — see `groupGoalsWithSteps`. */
  parentGoalId?: string | null
  /** The check-in axis this was created FROM — provenance, never a category
   *  (see `Goal.from_dimension`). Set only by CreateStepFromLever. */
  fromDimension?: string | null
}

export function useSpaceGoals() {
  const { isAuthenticated, contact } = useSpaceAuth()
  const contactId = contact?.id ?? null
  const qc = useQueryClient()

  const goalsQuery = useQuery<Goal[]>({
    queryKey: ['space-goals', contactId],
    enabled: isAuthenticated && !!contactId,
    queryFn: async () => {
      try {
        const snap = await getDocs(query(goalsCol(contactId!), orderBy('created_at', 'desc')))
        const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Goal)
        // A goal the coach filed away is gone from the member's view too —
        // otherwise archiving is only cosmetic for the coach, and the member
        // keeps being shown work nobody is tracking any more. Its steps go with
        // it, or they would surface as loose General tasks.
        // The cascade — and why it is in memory rather than a `where` — lives
        // ONCE in `visibleGoals` (@linyup/shared).
        return visibleGoals(all)
      } catch (err: unknown) {
        reportPublicLoadFailure('space/goals', err)
        throw err
      }
    },
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['space-goals', contactId] })

  const createGoal = useMutation({
    mutationFn: async (input: NewGoalInput) => {
      if (!contactId) throw new Error('Not signed in')
      await addDoc(goalsCol(contactId), {
        type: input.type,
        title: input.title,
        description: input.description || null,
        status: 'open' as GoalStatus,
        categories: input.categories ?? [],
        from_dimension: input.fromDimension ?? null,
        created_by: 'student',
        created_at: Timestamp.now(),
        target_date: input.targetDate ? Timestamp.fromDate(input.targetDate) : null,
        parent_goal_id: input.parentGoalId ?? null,
      })
    },
    onError: (err) => reportPublicActionFailure('space/create-goal', err),
    onSuccess: () => invalidate(),
  })

  // Refused server-side unless `created_by === 'student'` — the UI never shows
  // an edit control on a coach-created goal (see GoalCard), so reaching this
  // for one is not a state the app puts a member in.
  const updateGoal = useMutation({
    mutationFn: async ({
      goalId,
      title,
      description,
      categories,
      targetDate,
    }: {
      goalId: string
      title: string
      description?: string | null
      categories?: string[]
      targetDate?: Date | null
    }) => {
      if (!contactId) throw new Error('Not signed in')
      await updateDoc(goalDoc(contactId, goalId), {
        title,
        description: description || null,
        ...(categories ? { categories } : {}),
        target_date: targetDate ? Timestamp.fromDate(targetDate) : null,
      })
    },
    onError: (err) => reportPublicActionFailure('space/update-goal', err),
    onSuccess: () => invalidate(),
  })

  // Deletes a goal OR a step — same document shape, same collection, same
  // ownership rule. Used directly by GoalCard (for the goal itself) and by
  // StepRow (for a step it owns).
  const deleteGoal = useMutation({
    mutationFn: async (goalId: string) => {
      if (!contactId) throw new Error('Not signed in')
      await deleteDoc(goalDoc(contactId, goalId))
    },
    onError: (err) => reportPublicActionFailure('space/delete-goal', err),
    onSuccess: () => invalidate(),
  })

  // Ticking a STEP done/undone. Status + completed_at only — never
  // latest_score/overdue_at, which belong to the trigger described above. The
  // payload is exactly the shape firestore.rules allow for BOTH ownership
  // arms — a student-created step (any change) and a coach-created one
  // (`open` ⟷ `achieved`, this pair of fields only) — so the same mutation
  // serves both; StepRow decides whether the control is interactive.
  const setStepDone = useMutation({
    mutationFn: async ({ goalId, done }: { goalId: string; done: boolean }) => {
      if (!contactId) throw new Error('Not signed in')
      await updateDoc(goalDoc(contactId, goalId), {
        status: (done ? 'achieved' : 'open') as GoalStatus,
        completed_at: done ? Timestamp.now() : null,
      })
    },
    onError: (err) => reportPublicActionFailure('space/toggle-step', err),
    onSuccess: () => invalidate(),
  })

  return {
    ...goalsQuery,
    goals: goalsQuery.data ?? [],
    createGoal,
    updateGoal,
    deleteGoal,
    setStepDone,
  }
}

export type SpaceGoalsState = ReturnType<typeof useSpaceGoals>

// ── Per-goal evaluation history + the one write that adds to it ────────────

export function useGoalEvaluations(goalId: string, enabled: boolean) {
  const { contact } = useSpaceAuth()
  const contactId = contact?.id ?? null
  return useQuery<GoalEvaluation[]>({
    queryKey: ['space-goal-evaluations', contactId, goalId],
    enabled: enabled && !!contactId,
    queryFn: async () => {
      try {
        const snap = await getDocs(
          query(
            collection(db, CONTACTS_COLLECTION, contactId!, CONTACT_GOALS_SUBCOLLECTION, goalId, CONTACT_GOAL_EVALUATIONS_SUBCOLLECTION),
            orderBy('evaluated_at', 'desc')
          )
        )
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as GoalEvaluation)
      } catch (err: unknown) {
        reportPublicLoadFailure('space/goal-evaluations', err)
        throw err
      }
    },
  })
}

export function useAddGoalEvaluation() {
  const { contact } = useSpaceAuth()
  const contactId = contact?.id ?? null
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({
      goal,
      score,
      notes,
      statusAfter,
    }: {
      goal: Goal
      score: number
      notes: string | null
      /** Present only when the goal is student-owned AND the form offered (and
       *  changed) the control — see EvaluationFormDialog. */
      statusAfter?: GoalStatus
    }) => {
      if (!contactId) throw new Error('Not signed in')
      // ONE BATCH. The evaluation and the status it moves the goal to are a
      // single fact; landing one without the other leaves a goal whose status
      // its own newest evaluation contradicts, with nothing to reconcile them.
      const batch = writeBatch(db)
      batch.set(
        doc(collection(db, CONTACTS_COLLECTION, contactId, CONTACT_GOALS_SUBCOLLECTION, goal.id, CONTACT_GOAL_EVALUATIONS_SUBCOLLECTION)),
        {
          evaluated_at: Timestamp.now(),
          evaluated_by: 'student',
          score,
          notes: notes || null,
          status_after: statusAfter ?? goal.status,
        }
      )
      // THE CASCADE, DELIBERATELY NARROW. firestore.rules let a contact CREATE
      // an evaluation on ANY of her goals — coach's or her own — but only
      // UPDATE a goal document she created herself. The mobile app calls
      // updateDoc() on the parent goal unconditionally after every evaluation,
      // which throws permission-denied on a coach-created goal AFTER the
      // evaluation has already landed: a written evaluation and a failed
      // status change. We only ever attempt the parent write when it can
      // succeed — the goal is hers — and only when the form actually offered
      // and changed a status.
      if (goal.created_by === 'student' && statusAfter && statusAfter !== goal.status) {
        batch.update(goalDoc(contactId, goal.id), { status: statusAfter })
      }
      await batch.commit()
    },
    onError: (err) => reportPublicActionFailure('space/add-evaluation', err),
    onSuccess: (_result, vars) => {
      qc.invalidateQueries({ queryKey: ['space-goal-evaluations', contactId, vars.goal.id] })
      qc.invalidateQueries({ queryKey: ['space-goals', contactId] })
    },
  })
}
