'use client'

// The team's performance CHECK-IN AXES — how someone is doing, the radar's
// dimensions. `teams/{id}.performance_indicators` was read everywhere
// (contacts' Coaching tab, the mobile Space) but written by nothing in the
// repo — every studio silently got the hardcoded default five. This page is
// that writer.
//
// NOT goal categories. Those are a separate list (`teams/{id}.goal_categories`,
// `resolveGoalCategories`) answering a separate question — see the header of
// `packages/shared/src/types/goal.ts` for why the two were split apart again.
// There is deliberately no editor for them yet: every studio is on the defaults
// (technique / attitude / attendance / physical / mental), and a second editor
// is only worth building once a studio asks to change them.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown, AlertTriangle, RotateCcw } from 'lucide-react'
import {
  TEAMS_COLLECTION, resolveCoachingDimensions, DEFAULT_COACHING_DIMENSIONS, CANONICAL_DIMENSION_KEYS,
} from '@linyup/shared'
import type { Team, PerformanceIndicator } from '@linyup/shared'


function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

function uniqueKey(label: string, existing: string[]): string {
  const base = slugify(label) || 'dimension'
  if (!existing.includes(base)) return base
  let n = 2
  while (existing.includes(`${base}_${n}`)) n += 1
  return `${base}_${n}`
}

/** Exactly the canonical five, in any order, no extras — the only shape the
 *  profile heuristic (`detectPerformanceProfile`) can name. */
function isCanonicalSet(dims: PerformanceIndicator[]): boolean {
  if (dims.length !== CANONICAL_DIMENSION_KEYS.length) return false
  const keys = new Set(dims.map((d) => d.key))
  return CANONICAL_DIMENSION_KEYS.every((k) => keys.has(k))
}

function useTeamDoc(teamId: string | null) {
  return useQuery<Team | null>({
    queryKey: ['team', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return null
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId))
      return snap.exists() ? ({ id: snap.id, ...snap.data() } as Team) : null
    },
  })
}

// ─── add / edit dialog ─────────────────────────────────────────────────────────

function DimensionDialog({
  initial,
  existingKeys,
  onSave,
  onClose,
}: {
  initial?: PerformanceIndicator
  existingKeys: string[]
  onSave: (dim: PerformanceIndicator) => Promise<void>
  onClose: () => void
}) {
  const t = useTranslations('CoachingSettings')
  const tCommon = useTranslations('Common')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [busy, setBusy] = useState(false)

  const handleSave = async () => {
    if (!label.trim()) return
    setBusy(true)
    try {
      const key = initial ? initial.key : uniqueKey(label, existingKeys)
      await onSave({ key, label: label.trim() })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{initial ? t('editDimension') : t('addDimension')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>{t('dimensionLabel')}</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
          </div>
          {initial && (
            <p className="text-xs text-muted-foreground">
              {t('dimensionKeyNote', { key: initial.key })}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{tCommon('cancel')}</Button>
          <Button onClick={handleSave} disabled={busy || !label.trim()}>
            {busy ? tCommon('loading') : tCommon('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function CoachingSettingsPage() {
  const t = useTranslations('CoachingSettings')
  const tCommon = useTranslations('Common')
  const { confirm, confirmDialog } = useConfirm()
  const { currentTeamId } = useAuth()
  const { can } = useCapabilities()
  const canEdit = can('team.settings')
  const qc = useQueryClient()
  const { data: team, isLoading } = useTeamDoc(currentTeamId)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<PerformanceIndicator | null>(null)
  const [saving, setSaving] = useState(false)

  const dimensions = resolveCoachingDimensions(team)
  const usingDefaults = isCanonicalSet(dimensions)

  const save = async (next: PerformanceIndicator[]) => {
    if (!currentTeamId || !canEdit) return
    setSaving(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), { performance_indicators: next })
      qc.invalidateQueries({ queryKey: ['team', currentTeamId] })
    } finally {
      setSaving(false)
    }
  }

  const handleSaveDimension = async (dim: PerformanceIndicator) => {
    const next = editing
      ? dimensions.map((d) => (d.key === editing.key ? dim : d))
      : [...dimensions, dim]
    await save(next)
    setEditing(null)
  }

  const handleDelete = async (dim: PerformanceIndicator) => {
    const ok = await confirm({
      title: t('deleteDimensionTitle'),
      description: t('deleteDimensionDesc', { label: dim.label }),
      confirmLabel: tCommon('delete'),
    })
    if (!ok) return
    await save(dimensions.filter((d) => d.key !== dim.key))
  }

  const handleResetDefaults = async () => {
    const ok = await confirm({
      title: t('resetDefaultsTitle'),
      description: t('resetDefaultsDesc'),
      confirmLabel: t('resetDefaultsConfirm'),
    })
    if (!ok) return
    await save([...DEFAULT_COACHING_DIMENSIONS])
  }

  const move = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir
    if (j < 0 || j >= dimensions.length) return
    const next = [...dimensions]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    await save(next)
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        action={
          canEdit ? (
            <Button onClick={() => { setEditing(null); setDialogOpen(true) }} disabled={saving}>
              <Plus className="h-4 w-4 mr-1.5" />
              {t('addDimension')}
            </Button>
          ) : undefined
        }
      />

      {/* Live, not just after the fact — a studio sees this BEFORE it clicks
          delete/edit on one of the default five, not after. */}
      <div
        className={`flex items-start gap-2.5 rounded-lg border p-3 text-sm ${
          usingDefaults
            ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
            : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
        }`}
      >
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">
            {usingDefaults ? t('statusDefaultTitle') : t('statusCustomTitle')}
          </p>
          <p className="mt-0.5 opacity-90">{t('profileWarning')}</p>
        </div>
      </div>

      <div className="rounded-lg border divide-y">
        {dimensions.map((d, idx) => (
          <div key={d.key} className="flex items-center gap-2 p-3">
            <div className="flex flex-col shrink-0">
              <button
                type="button"
                disabled={!canEdit || idx === 0}
                onClick={() => move(idx, -1)}
                className="p-0.5 rounded hover:bg-muted disabled:opacity-30 transition-colors"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={!canEdit || idx === dimensions.length - 1}
                onClick={() => move(idx, 1)}
                className="p-0.5 rounded hover:bg-muted disabled:opacity-30 transition-colors"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{d.label}</p>
              <p className="text-xs text-muted-foreground font-mono">{d.key}</p>
            </div>
            {canEdit && (
              <div className="flex gap-1 shrink-0">
                <Button
                  variant="ghost" size="icon" className="h-7 w-7"
                  onClick={() => { setEditing(d); setDialogOpen(true) }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => handleDelete(d)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {canEdit && !usingDefaults && (
        <Button variant="outline" size="sm" onClick={handleResetDefaults} disabled={saving}>
          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
          {t('resetDefaults')}
        </Button>
      )}

      {dialogOpen && (
        <DimensionDialog
          initial={editing ?? undefined}
          existingKeys={dimensions.map((d) => d.key)}
          onSave={handleSaveDimension}
          onClose={() => { setDialogOpen(false); setEditing(null) }}
        />
      )}
      {confirmDialog}
    </div>
  )
}
