'use client'

// The WORDS the Space hands the shared coaching components
// (`@/components/coaching/*` — GoalDialog, EvaluationDialog, GoalStateChips).
// Those own the behaviour and take their copy from whichever surface mounts
// them; this is the SpaceCoaching-namespace rendering of it. The admin tab
// builds the same label objects from its own `Contacts` namespace
// (contacts/[id]/GoalsTab.tsx's `useCoachingLabels`). A hook, so the accessors
// are bound HERE and `i18n:check` resolves each key against its namespace.

import { useTranslations } from 'next-intl'
import type { GoalStatus } from '@linyup/shared'
import type { GoalDialogLabels } from '@/components/coaching/GoalDialog'
import type { EvaluationDialogLabels } from '@/components/coaching/EvaluationDialog'
import type { GoalStateChipLabels } from '@/components/coaching/GoalStateChips'
import { usePublicFormat } from '../../usePublicFormat'

const STATUS_KEYS: Record<GoalStatus, string> = {
  open: 'statusOpen',
  in_progress: 'statusInProgress',
  achieved: 'statusAchieved',
  abandoned: 'statusAbandoned',
}

export function useSpaceCoachingLabels() {
  const t = useTranslations('SpaceCoaching')
  const tCommon = useTranslations('Common')
  const fmt = usePublicFormat()
  return {
    goalDialog: (dialogTitle: string): GoalDialogLabels => ({
      dialogTitle,
      title: t('fieldTitle'),
      description: t('fieldDescription'),
      categories: t('fieldCategories'),
      targetDate: t('fieldTargetDate'),
      noTargetDate: t('fieldNoTargetDate'),
      cancel: tCommon('cancel'),
      save: tCommon('save'),
      saving: tCommon('saving'),
      saveFailed: t('goalSaveFailed'),
    }),
    evaluationDialog: {
      title: t('evaluationFormTitle'),
      score: t('evaluationScoreLabel'),
      notes: t('evaluationNotesLabel'),
      notesPlaceholder: t('evaluationNotesPlaceholder'),
      statusAfter: t('evaluationStatusLabel'),
      status: (s) => t(STATUS_KEYS[s]),
      cancel: tCommon('cancel'),
      save: t('evaluationSubmit'),
      saving: tCommon('saving'),
      saveFailed: t('evaluationSaveFailed'),
    } satisfies EvaluationDialogLabels,
    goalStateChips: {
      latestScore: (score) => t('latestScoreLabel', { score }),
      lastEvaluated: (date) => t('lastEvaluatedOn', { date: fmt.date(date) }),
      overdue: t('overdueBadge'),
    } satisfies GoalStateChipLabels,
  }
}
