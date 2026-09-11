'use client'

import { PageHeader } from '@/components/layout/PageHeader'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { collection, doc, getDocs, query, updateDoc, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useOrg } from '@/contexts/OrgContext'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, Pencil, Trash2, Shield } from 'lucide-react'
import { ORGANIZATIONS_COLLECTION, ORG_TEAMS_SUBCOLLECTION, newRankLevelId } from '@linyup/shared'
import type { OrgTeam, RankingSystem, RankLevel } from '@linyup/shared'
import { RANK_PRESETS } from '@/lib/rank-presets'
import { useRankHolderCount } from '@/lib/rank-utils'
import { RankLevelFields } from '@/components/ranking/RankLevelFields'
import { RankBadge } from '@/components/ranking/RankBadge'

// ─── helpers ──────────────────────────────────────────────────────────────────

interface RankSystemFormState {
  id: string
  name: string
  levels: RankLevel[]
  is_primary: boolean
}

function emptyForm(): RankSystemFormState {
  return { id: '', name: '', levels: [{ value: 0, label: '', color: '#6b7280' }], is_primary: false }
}

// ─── RankSystemDialog (reused pattern from team settings) ─────────────────────

function RankSystemDialog({
  open,
  onOpenChange,
  initial,
  existingIds,
  onSave,
  storagePath,
  holderTeamIds,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: RankSystemFormState | null
  existingIds: string[]
  onSave: (form: RankSystemFormState) => Promise<void>
  /** Where uploaded badge artwork goes — see the Storage rule for
   *  `organizations/{orgId}/ranking`. */
  storagePath: string
  /** The member studios whose contacts a removed level would orphan; `null`
   *  when that list is not known, which is not the same as none. */
  holderTeamIds: string[] | null
}) {
  const t = useTranslations('OrgRanking')
  const [form, setForm] = useState<RankSystemFormState>(initial ?? emptyForm())
  const [saving, setSaving] = useState(false)
  const [idError, setIdError] = useState('')
  const [pendingRemove, setPendingRemove] = useState<number | null>(null)
  const levelHolders = useRankHolderCount()
  const isEdit = !!initial

  const setField = <K extends keyof RankSystemFormState>(k: K, v: RankSystemFormState[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }))

  const setLevel = (i: number, field: keyof RankLevel, val: string | number | undefined) =>
    setForm((prev) => {
      const lvls = [...prev.levels]
      // `undefined` CLEARS the field — turning a split belt solid, or removing
      // an emoji, has to be expressible, and spreading `undefined` in would
      // otherwise leave the old value standing.
      const next = { ...lvls[i] } as RankLevel
      if (val === undefined) delete next[field as keyof RankLevel]
      else (next as unknown as Record<string, unknown>)[field] = val
      lvls[i] = next
      return { ...prev, levels: lvls }
    })

  const addLevel = () =>
    setForm((prev) => ({
      ...prev,
      levels: [
        ...prev.levels,
        {
          // A stable identity from the first keystroke — see newRankLevelId.
          id: newRankLevelId(),
          // ONE ABOVE THE HIGHEST, not the array length. `prev.levels.length`
          // mints a duplicate as soon as a level has been removed — [0,1,2],
          // remove the middle, add: two levels then share value 2, and the
          // lookup that resolves a contact's rank picks whichever comes first.
          // The team-settings editor already did it this way; this one did not.
          value: prev.levels.length ? Math.max(...prev.levels.map((l) => l.value)) + 1 : 0,
          label: '',
          color: '#6b7280',
        },
      ],
    }))

  const removeLevel = (i: number) =>
    setForm((prev) => ({ ...prev, levels: prev.levels.filter((_, j) => j !== i) }))

  // Removing a level is destructive to CONTACTS, not just to this form: every
  // `Contact.ranks[systemId]` sitting on that value is orphaned and thereafter
  // renders as the nearest level below it (see `primaryRank` in @linyup/shared). So ask — but
  // only where somebody can actually be holding it.
  const requestRemoveLevel = (i: number) => {
    const value = form.levels[i]?.value
    const wasSaved = isEdit && initial?.levels.some((l) => l.value === value)
    // A level added in this dialog has never been written, so no contact can
    // hold it. Confirming that would be pure noise plus a wasted round trip.
    if (value === undefined || !wasSaved) {
      removeLevel(i)
      return
    }
    setPendingRemove(i)
    levelHolders.start(holderTeamIds, form.id, [value])
  }

  const closeRemoveConfirm = () => {
    setPendingRemove(null)
    levelHolders.reset()
  }

  function generateId(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  }

  const applyPreset = (presetName: string) => {
    const preset = RANK_PRESETS.find((p) => p.name === presetName)
    if (preset) setForm({ id: generateId(preset.name), name: preset.name, levels: preset.levels.map((l) => ({ ...l })), is_primary: false })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!isEdit && existingIds.includes(form.id)) {
      setIdError(t('idAlreadyExists'))
      return
    }
    setSaving(true)
    await onSave(form)
    setSaving(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('dialogTitleEdit') : t('dialogTitleAdd')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogBody className="space-y-4 pt-1">
          {!isEdit && (
            <div className="space-y-1.5">
              <Label>{t('labelLoadPreset')}</Label>
              <Select onValueChange={(v) => applyPreset(String(v))}>
                <SelectTrigger><SelectValue placeholder={t('placeholderChoosePreset')} /></SelectTrigger>
                <SelectContent>
                  {RANK_PRESETS.map((p) => (
                    <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('labelName')}</Label>
              <Input value={form.name} onChange={(e) => setField('name', e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>{t('labelId')}</Label>
              <Input
                value={form.id}
                onChange={(e) => { setField('id', e.target.value.replace(/[^a-z0-9-]/g, '')); setIdError('') }}
                disabled={isEdit}
                required
              />
              {idError && <p className="text-xs text-destructive">{idError}</p>}
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('labelLevels')}</Label>
              {/* No cap. There was one at ten, with no reason recorded, and HMD's
                  ladder has fifteen — the list scrolls. */}
              <Button type="button" size="sm" variant="outline" onClick={addLevel}>
                <Plus className="h-3.5 w-3.5 mr-1" />{t('addLevel')}
              </Button>
            </div>
            {form.levels.map((l, i) => (
              <RankLevelFields
                key={l.id ?? i}
                level={l}
                index={i}
                storagePath={storagePath}
                canRemove={form.levels.length > 1}
                onChange={(field, value) => setLevel(i, field, value)}
                onRemove={() => requestRemoveLevel(i)}
              />
            ))}
          </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{t('cancel')}</Button>
            <Button type="submit" disabled={saving || !form.name || !form.id || form.levels.length === 0}>
              {saving ? t('saving') : t('save')}
            </Button>
          </DialogFooter>
        </form>

        {/* Rendered inside the popup so base-ui treats it as a nested dialog,
            and outside the <form> so its buttons are never a stray submit. */}
        <AlertDialog open={pendingRemove !== null} onOpenChange={(v) => { if (!v) closeRemoveConfirm() }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('removeLevelTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {levelHolders.count === undefined
                  ? t('holdersChecking')
                  : levelHolders.count === null
                    ? t('holdersUnknown')
                    : levelHolders.count === 0
                      ? t('holdersNoneLevel')
                      : `${t('holdersLevelCount', { count: levelHolders.count })} ${t('holdersLevelWarning')}`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
              <AlertDialogAction
                type="button"
                variant="destructive"
                onClick={() => {
                  if (pendingRemove !== null) removeLevel(pendingRemove)
                  closeRemoveConfirm()
                }}
              >
                {t('removeLevelConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function OrgRankingPage() {
  const t = useTranslations('OrgRanking')
  const { orgId } = useParams<{ orgId: string }>()
  const { org, loading, isAdmin } = useOrg()
  const qc = useQueryClient()

  const [dialogOpen, setDialogOpen] = useState(false)
  /** Remount token for the dialog — see `openAdd` / `openEdit`. */
  const [dialogKey, setDialogKey] = useState(0)
  const [editing, setEditing] = useState<RankSystemFormState | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const systemHolders = useRankHolderCount()

  const systems: RankingSystem[] = org?.ranking_systems ?? []

  // The contacts an org-level ranking edit touches belong to the member
  // studios, never to the organisation itself, so the scope of "who is
  // affected" is this list. `null` — still loading, or the read failed — is
  // reported as "we do not know", not as an empty organisation.
  const {
    data: memberTeamIds,
    isPending: teamsPending,
    isError: teamsError,
  } = useQuery<string[]>({
    queryKey: ['org-team-ids', orgId],
    enabled: !!orgId && isAdmin,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_TEAMS_SUBCOLLECTION),
          // Active only: an invited studio has not linked its contacts to this
          // organisation's systems yet, so counting it would inflate the answer.
          where('status', '==', 'active'),
        ),
      )
      return snap.docs.map((d) => (d.data() as OrgTeam).teamId).filter(Boolean)
    },
  })
  const holderTeamIds: string[] | null =
    !isAdmin || teamsError || teamsPending ? null : (memberTeamIds ?? null)

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  async function saveToFirestore(next: RankingSystem[]) {
    setSaving(true)
    try {
      await updateDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId), { ranking_systems: next })
      qc.invalidateQueries({ queryKey: ['org', orgId] })
      qc.invalidateQueries({ queryKey: ['org-ranking-systems', orgId] })
      showToast(t('toastSaved'))
    } finally {
      setSaving(false)
    }
  }

  async function handleSave(form: RankSystemFormState) {
    const system: RankingSystem = { id: form.id, name: form.name, levels: form.levels, is_primary: form.is_primary }
    const next = editing
      ? systems.map((s) => s.id === editing.id ? system : s)
      : [...systems, system]
    await saveToFirestore(next)
    setEditing(null)
  }

  async function handleSetPrimary(id: string) {
    await saveToFirestore(systems.map((s) => ({ ...s, is_primary: s.id === id })))
  }

  async function handleDelete(id: string) {
    await saveToFirestore(systems.filter((s) => s.id !== id))
    closeDelete()
  }

  const openDelete = (s: RankingSystem) => {
    setDeleting(s.id)
    // Counted per level and summed. Firestore cannot ask "does this field
    // exist", so a contact orphaned at a value this system no longer carries is
    // outside the count — which is why the copy says "holding one of its
    // levels" rather than "in this system".
    systemHolders.start(holderTeamIds, s.id, s.levels.map((l) => l.value))
  }
  const closeDelete = () => {
    setDeleting(null)
    systemHolders.reset()
  }

  // THE DIALOG IS ALWAYS MOUNTED, so its `useState(initial ?? emptyForm())`
  // runs exactly ONCE — on the page's first render, when nothing is being
  // edited. Without a changing key it therefore showed the EMPTY form under an
  // "Edit" title for the life of the page, and saving from there replaced the
  // real system with a blank one (`handleSave` substitutes by `editing.id`, and
  // the write is a whole-array `updateDoc`), destroying the ladder and orphaning
  // every `Contact.ranks` key that pointed at it.
  //
  // Bumping a counter on every open remounts it, so the form is built from the
  // CURRENT `initial` each time. A counter rather than `editing?.id` because
  // re-opening Add must also start clean: keyed on the id alone, two successive
  // Adds share one mount and the second inherits the first's abandoned input.
  const openAdd = () => { setEditing(null); setDialogKey((n) => n + 1); setDialogOpen(true) }
  const openEdit = (s: RankingSystem) => {
    setEditing({ id: s.id, name: s.name, levels: s.levels.map((l) => ({ ...l })), is_primary: s.is_primary ?? false })
    setDialogKey((n) => n + 1)
    setDialogOpen(true)
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        action={
          isAdmin ? (
            <Button size="sm" onClick={openAdd} disabled={saving}>
              <Plus className="h-4 w-4 mr-1.5" />{t('addSystem')}
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : systems.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <Shield className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-muted-foreground text-sm">{t('emptyState')}</p>
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={openAdd}>
              <Plus className="h-4 w-4 mr-1.5" />{t('addSystem')}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {systems.map((s) => (
            <div key={s.id} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{s.name}</p>
                    {s.is_primary && <Badge variant="default" className="text-xs">{t('primaryBadge')}</Badge>}
                    <span className="text-xs text-muted-foreground font-mono">{s.id}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('levelsCount', { count: s.levels.length })}</p>
                </div>
                {isAdmin && !s.is_primary && (
                  <button
                    onClick={() => handleSetPrimary(s.id)}
                    disabled={saving}
                    className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted disabled:opacity-50"
                  >
                    {t('setPrimary')}
                  </button>
                )}
                {isAdmin && (
                  <>
                    {/* Icon-only, so they need a name spoken aloud. Both
                        strings already exist in all four locales — no new key. */}
                    <button
                      onClick={() => openEdit(s)}
                      aria-label={t('dialogTitleEdit')}
                      className="p-1.5 rounded hover:bg-muted"
                    >
                      <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                    <button
                      onClick={() => openDelete(s)}
                      aria-label={t('delete')}
                      className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
              {/* Sorted by VALUE, which is the scale's own order. Rendering in
                  array order made this strip disagree with the dashboard donut
                  whenever the two differed. */}
              <div className="flex gap-1 flex-wrap">
                {[...s.levels].sort((a, b) => a.value - b.value).map((l) => (
                  <div key={l.id ?? l.value} className="flex items-center gap-1">
                    <RankBadge level={l} size="sm" />
                    <span className="text-xs text-muted-foreground">{l.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <RankSystemDialog
        key={dialogKey}
        open={dialogOpen}
        onOpenChange={(v) => { setDialogOpen(v); if (!v) setEditing(null) }}
        initial={editing}
        existingIds={systems.filter((s) => !editing || s.id !== editing.id).map((s) => s.id)}
        onSave={handleSave}
        storagePath={`organizations/${orgId}/ranking`}
        holderTeamIds={holderTeamIds}
      />

      <Dialog open={!!deleting} onOpenChange={(v) => { if (!v) closeDelete() }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('deleteDialogTitle')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-1">
            {t('deleteDialogBody')}
          </p>
          <p className="text-sm text-muted-foreground py-1">
            {systemHolders.count === undefined
              ? t('holdersChecking')
              : systemHolders.count === null
                ? t('holdersUnknown')
                : systemHolders.count === 0
                  ? t('holdersNoneSystem')
                  : `${t('holdersSystemCount', { count: systemHolders.count })} ${t('holdersSystemWarning')}`}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={closeDelete}>{t('cancel')}</Button>
            <Button variant="destructive" disabled={saving} onClick={() => deleting && handleDelete(deleting)}>
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {toast && (
        <div className="fixed bottom-4 right-4 px-4 py-2.5 rounded-lg shadow-lg text-sm text-white bg-green-600 z-50">
          {toast}
        </div>
      )}
    </div>
  )
}
