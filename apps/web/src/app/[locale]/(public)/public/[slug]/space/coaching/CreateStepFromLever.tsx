'use client'

// The ONE connection `primary_lever` was missing — see CheckinSection's
// focus-area line, right above where this renders. The step it writes carries
// `from_dimension` (the axis it came FROM) and NO categories: provenance is
// not classification, and a member working on a low Focus rating has not yet
// said what the work is about — see the header of
// packages/shared/src/types/goal.ts.
//
// Deliberately NOT the full GoalDialog: the title is pre-filled (and
// editable) and the axis is fixed, so there is nothing left to ask except,
// optionally, which open goal this step serves. Picking none files it under
// the virtual "General" group — no placeholder goal is ever created for it
// (see `Goal.parent_goal_id`).
//
// Reuses `useSpaceGoals().createGoal` — the SAME instance CoachingHome already
// holds and hands to GoalsSection, passed down rather than a second
// `useSpaceGoals()` call, so there is only ever one goals query per page.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import type { Goal } from '@linyup/shared'
import { useSpaceTheme } from '../useSpaceTheme'
import type { SpaceGoalsState } from './useSpaceGoals'

export function CreateStepFromLever({
  dimensionKey,
  dimensionLabel,
  openGoals,
  createGoal,
}: {
  dimensionKey: string
  dimensionLabel: string
  openGoals: Pick<Goal, 'id' | 'title'>[]
  createGoal: SpaceGoalsState['createGoal']
}) {
  const t = useTranslations('SpaceCoaching')
  const tCommon = useTranslations('Common')
  const { accent, textMain, textMuted, cardBorder } = useSpaceTheme()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [parentGoalId, setParentGoalId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  function startOpen() {
    setTitle(t('createStepDefaultTitle', { dimension: dimensionLabel }))
    setParentGoalId(null)
    setFailed(false)
    setOpen(true)
  }

  async function submit() {
    if (!title.trim()) return
    setSaving(true)
    setFailed(false)
    try {
      await createGoal.mutateAsync({
        type: 'task',
        title: title.trim(),
        categories: [],
        fromDimension: dimensionKey,
        parentGoalId,
      })
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
        className="mt-2 inline-flex items-center gap-1 text-xs font-medium"
        style={{ color: accent }}
      >
        <Plus className="h-3.5 w-3.5" /> {t('createStepCta', { dimension: dimensionLabel })}
      </button>
    )
  }

  return (
    <div className="mt-2 space-y-2 rounded-xl p-3" style={{ background: `${accent}0d` }}>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
        className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        style={{ borderColor: cardBorder, color: textMain }}
      />
      {openGoals.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setParentGoalId(null)}
            className="rounded-full px-2.5 py-1 text-[11px] font-medium"
            style={
              parentGoalId === null
                ? { background: accent, color: '#fff' }
                : { background: cardBorder, color: textMuted }
            }
          >
            {t('parentGoalNone')}
          </button>
          {openGoals.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => setParentGoalId(g.id)}
              className="rounded-full px-2.5 py-1 text-[11px] font-medium"
              style={
                parentGoalId === g.id
                  ? { background: accent, color: '#fff' }
                  : { background: cardBorder, color: textMuted }
              }
            >
              {g.title}
            </button>
          ))}
        </div>
      )}
      {failed && (
        <p className="text-xs" style={{ color: '#dc2626' }}>
          {t('goalSaveFailed')}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || !title.trim()}
          className="rounded-lg px-3 py-1 text-xs font-medium text-white disabled:opacity-60"
          style={{ background: accent }}
        >
          {saving ? '…' : t('createStepSubmit')}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={saving}
          className="rounded-lg border px-3 py-1 text-xs font-medium disabled:opacity-60"
          style={{ borderColor: cardBorder, color: textMuted }}
        >
          {tCommon('cancel')}
        </button>
      </div>
    </div>
  )
}
