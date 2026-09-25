'use client'

/**
 * THE ORGANIZATION'S AFFILIATION VOCABULARY — its statuses and its types.
 *
 * These two cards used to sit on the org SETTINGS page, three screens below the
 * organization's name and language, while the roster they describe lived on the
 * Affiliations page. One subject, two places, and the half you had to configure
 * was the half nobody could find (Franco, 2026-08-28).
 *
 * They now render beneath the roster itself, so an administrator adds the status
 * "Suspended" on the same screen where they can see who is suspended. Nothing
 * about the components changed in the move — same queries, same dialogs, same
 * `isAdmin` gate, which each one applies for itself.
 *
 * The gate is COURTESY, not enforcement: `firestore.rules` admits only an
 * org_admin to `organizations/{orgId}/affiliation_statuses` and
 * `affiliation_types`, so a viewer who got past the disabled buttons would still
 * be refused by the database.
 */

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  doc, getDocs, collection, setDoc, deleteDoc,
  serverTimestamp, writeBatch, query,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { IdCard, Pencil, Trash2, Plus, ChevronUp, ChevronDown, RotateCcw, CheckCircle2, Clock } from 'lucide-react'
import {
  ORGANIZATIONS_COLLECTION, ORG_AFFILIATION_STATUSES_SUBCOLLECTION,
  DEFAULT_ORG_AFFILIATION_STATUSES, AFFILIATION_TYPES_SUBCOLLECTION,
} from '@linyup/shared'
import type { OrgAffiliationStatusDef, AffiliationStatusColor, AffiliationType, AffiliationIssuer } from '@linyup/shared'

// ─── color config ────────────────────────────────────────────────────────────

const COLORS: { id: AffiliationStatusColor; bg: string; label: string }[] = [
  { id: 'gray',   bg: 'bg-gray-400',   label: 'Gray' },
  { id: 'yellow', bg: 'bg-yellow-400', label: 'Yellow' },
  { id: 'blue',   bg: 'bg-blue-500',   label: 'Blue' },
  { id: 'purple', bg: 'bg-purple-500', label: 'Purple' },
  { id: 'green',  bg: 'bg-green-500',  label: 'Green' },
  { id: 'red',    bg: 'bg-red-500',    label: 'Red' },
  { id: 'orange', bg: 'bg-orange-400', label: 'Orange' },
]

const COLOR_DOT: Record<string, string> = {
  gray:   'bg-gray-400',
  yellow: 'bg-yellow-400',
  blue:   'bg-blue-500',
  purple: 'bg-purple-500',
  green:  'bg-green-500',
  red:    'bg-red-500',
  orange: 'bg-orange-400',
}

// ─── hook: auto-init defaults on first load ───────────────────────────────────

function useStatusDefs(orgId: string) {
  return useQuery<OrgAffiliationStatusDef[]>({
    queryKey: ['org-membership-statuses', orgId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const snap = await getDocs(
        collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_AFFILIATION_STATUSES_SUBCOLLECTION),
      )
      if (snap.empty) {
        // Auto-initialize with defaults on first visit to this settings page
        const batch = writeBatch(db)
        DEFAULT_ORG_AFFILIATION_STATUSES.forEach((s) => {
          batch.set(
            doc(db, ORGANIZATIONS_COLLECTION, orgId, ORG_AFFILIATION_STATUSES_SUBCOLLECTION, s.id),
            { ...s, updated_at: serverTimestamp() },
          )
        })
        await batch.commit()
        return DEFAULT_ORG_AFFILIATION_STATUSES
      }
      return snap.docs
        .map((d) => ({ ...d.data(), id: d.id } as OrgAffiliationStatusDef))
        .sort((a, b) => a.order - b.order)
    },
  })
}

// ─── status form dialog ───────────────────────────────────────────────────────

function StatusFormDialog({
  open,
  editing,
  nextOrder,
  orgId,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: OrgAffiliationStatusDef | null
  nextOrder: number
  orgId: string
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('OrgAffiliationStatuses')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<AffiliationStatusColor>('gray')
  const [countsAsActive, setCountsAsActive] = useState(false)
  const [isFinal, setIsFinal] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (editing) {
      setLabel(editing.label)
      setDescription(editing.description)
      setColor(editing.color)
      setCountsAsActive(editing.countsAsActive)
      setIsFinal(editing.isFinal)
    } else {
      setLabel(''); setDescription(''); setColor('gray')
      setCountsAsActive(false); setIsFinal(false)
    }
  }, [editing, open])

  async function handleSave() {
    if (!label.trim()) return
    setSaving(true)
    try {
      const id = editing?.id
        ?? label.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') + '_' + Date.now()
      const payload: Omit<OrgAffiliationStatusDef, 'id'> = {
        label: label.trim(),
        description: description.trim(),
        color,
        order: editing?.order ?? nextOrder,
        isBuiltIn: editing?.isBuiltIn ?? false,
        countsAsActive,
        isFinal,
      }
      await setDoc(
        doc(db, ORGANIZATIONS_COLLECTION, orgId, ORG_AFFILIATION_STATUSES_SUBCOLLECTION, id),
        { ...payload, updated_at: serverTimestamp() },
        { merge: true },
      )
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? t('editTitle') : t('addTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t('labelLabel')}</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('labelPlaceholder')}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('descriptionLabel')}</Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('descriptionPlaceholder')}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('colorLabel')}</Label>
            <div className="flex gap-2 flex-wrap">
              {COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setColor(c.id)}
                  title={c.label}
                  className={`h-7 w-7 rounded-full ${c.bg} transition-all ${
                    color === c.id ? 'ring-2 ring-offset-2 ring-foreground scale-110' : 'opacity-70 hover:opacity-100'
                  }`}
                />
              ))}
            </div>
          </div>
          <div className="space-y-2 pt-1 border-t">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={countsAsActive}
                onChange={(e) => setCountsAsActive(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
              />
              <div>
                <p className="text-sm font-medium">{t('countsAsActiveLabel')}</p>
                <p className="text-xs text-muted-foreground">{t('countsAsActiveDesc')}</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={isFinal}
                onChange={(e) => setIsFinal(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
              />
              <div>
                <p className="text-sm font-medium">{t('isFinalLabel')}</p>
                <p className="text-xs text-muted-foreground">{t('isFinalDesc')}</p>
              </div>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('cancel')}</Button>
          <Button onClick={handleSave} disabled={saving || !label.trim()}>
            {saving ? '…' : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── membership statuses card ─────────────────────────────────────────────────

export function MembershipStatusesCard({ orgId, isAdmin }: { orgId: string; isAdmin: boolean }) {
  const t = useTranslations('OrgAffiliationStatuses')
  const qc = useQueryClient()
  const { data: defs = [], isLoading } = useStatusDefs(orgId)
  const [toast, setToast] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<OrgAffiliationStatusDef | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<OrgAffiliationStatusDef | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [working, setWorking] = useState(false)

  function showToast(msg: string) {
    setToast(msg); setTimeout(() => setToast(null), 3000)
  }

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['org-membership-statuses', orgId] })
    qc.invalidateQueries({ queryKey: ['org-membership-statuses'] })
  }

  async function reorder(index: number, direction: 'up' | 'down') {
    const swapIndex = direction === 'up' ? index - 1 : index + 1
    if (swapIndex < 0 || swapIndex >= defs.length) return
    const reordered = [...defs]
    ;[reordered[index], reordered[swapIndex]] = [reordered[swapIndex], reordered[index]]
    setWorking(true)
    try {
      const batch = writeBatch(db)
      reordered.forEach((s, i) => {
        batch.update(
          doc(db, ORGANIZATIONS_COLLECTION, orgId, ORG_AFFILIATION_STATUSES_SUBCOLLECTION, s.id),
          { order: i },
        )
      })
      await batch.commit()
      invalidate()
    } finally {
      setWorking(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setWorking(true)
    try {
      await deleteDoc(
        doc(db, ORGANIZATIONS_COLLECTION, orgId, ORG_AFFILIATION_STATUSES_SUBCOLLECTION, deleteTarget.id),
      )
      // Re-compact order values after deletion
      const remaining = defs.filter((s) => s.id !== deleteTarget.id)
      const batch = writeBatch(db)
      remaining.forEach((s, i) => {
        batch.update(
          doc(db, ORGANIZATIONS_COLLECTION, orgId, ORG_AFFILIATION_STATUSES_SUBCOLLECTION, s.id),
          { order: i },
        )
      })
      await batch.commit()
      invalidate()
      showToast(t('deleted'))
    } finally {
      setWorking(false)
      setDeleteTarget(null)
    }
  }

  async function handleReset() {
    setWorking(true)
    try {
      // Delete all current statuses
      const batch = writeBatch(db)
      defs.forEach((s) => {
        batch.delete(doc(db, ORGANIZATIONS_COLLECTION, orgId, ORG_AFFILIATION_STATUSES_SUBCOLLECTION, s.id))
      })
      // Write all defaults
      DEFAULT_ORG_AFFILIATION_STATUSES.forEach((s) => {
        batch.set(
          doc(db, ORGANIZATIONS_COLLECTION, orgId, ORG_AFFILIATION_STATUSES_SUBCOLLECTION, s.id),
          { ...s, updated_at: serverTimestamp() },
        )
      })
      await batch.commit()
      invalidate()
      showToast(t('saved'))
    } finally {
      setWorking(false)
      setResetOpen(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <IdCard className="h-4 w-4" />
            {t('title')}
          </CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (
            <>
              <div className="divide-y rounded-md border">
                {defs.map((s, index) => (
                  <div key={s.id} className="flex items-center gap-2 px-3 py-2.5">
                    {/* Reorder */}
                    {isAdmin && (
                      <div className="flex flex-col shrink-0">
                        <button
                          onClick={() => reorder(index, 'up')}
                          disabled={index === 0 || working}
                          className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => reorder(index, 'down')}
                          disabled={index === defs.length - 1 || working}
                          className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                    {/* Color dot */}
                    <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${COLOR_DOT[s.color] ?? COLOR_DOT.gray}`} />
                    {/* Label + description */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-tight">{s.label}</p>
                      {s.description && (
                        <p className="text-xs text-muted-foreground truncate">{s.description}</p>
                      )}
                    </div>
                    {/* Actions */}
                    {isAdmin && (
                      <div className="flex items-center gap-0.5 shrink-0">
                        <Button
                          variant="ghost" size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={() => { setEditing(s); setFormOpen(true) }}
                          disabled={working}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost" size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(s)}
                          disabled={working || defs.length <= 1}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {isAdmin && (
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm" variant="outline"
                    onClick={() => { setEditing(null); setFormOpen(true) }}
                    className="gap-1.5" disabled={working}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('addButton')}
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => setResetOpen(true)}
                    className="gap-1.5 text-muted-foreground" disabled={working}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t('resetButton')}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <StatusFormDialog
        open={formOpen}
        editing={editing}
        nextOrder={defs.length}
        orgId={orgId}
        onClose={() => { setFormOpen(false); setEditing(null) }}
        onSaved={() => { invalidate(); showToast(t('saved')) }}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmDeleteMessage')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('deleteButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmResetTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmResetMessage')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleReset}>
              {t('resetButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {toast && (
        <div className="fixed bottom-4 right-4 px-4 py-2.5 rounded-lg shadow-lg text-sm text-white bg-green-600 z-50">
          {toast}
        </div>
      )}
    </>
  )
}

// ─── org affiliation types card ───────────────────────────────────────────────

export function OrgAffiliationTypesCard({ orgId, isAdmin }: { orgId: string; isAdmin: boolean }) {
  const t = useTranslations('OrgAffiliationTypes')
  const qc = useQueryClient()

  const { data: types = [], isLoading } = useQuery<AffiliationType[]>({
    queryKey: ['org-affiliation-types', orgId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const snap = await getDocs(
        collection(db, ORGANIZATIONS_COLLECTION, orgId, AFFILIATION_TYPES_SUBCOLLECTION),
      )
      return snap.docs
        .map((d) => ({ ...d.data(), id: d.id } as AffiliationType))
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    },
  })

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AffiliationType | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AffiliationType | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 3000) }
  function invalidate() { qc.invalidateQueries({ queryKey: ['org-affiliation-types', orgId] }) }

  function AffTypeDialog() {
    const [key, setKey] = useState(editing?.key ?? '')
    const [label, setLabel] = useState(editing?.label ?? '')
    const [defaultIssuer, setDefaultIssuer] = useState<AffiliationIssuer>(editing?.default_issuer ?? 'org')
    const [validityMonths, setValidityMonths] = useState(editing?.default_validity_months?.toString() ?? '')
    const [validityMode, setValidityMode] = useState<'months' | 'fixed_date'>(
      editing?.validity_mode ?? 'months'
    )
    const [resetDay, setResetDay] = useState(editing?.reset_month_day ?? '09-01')
    const [active, setActive] = useState(editing?.active ?? true)
    const [saving, setSaving] = useState(false)

    async function handleSave() {
      if (!key.trim() || !label.trim()) return
      setSaving(true)
      try {
        const id = editing?.id ?? `${key.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}_${Date.now()}`
        const payload: Omit<AffiliationType, 'id'> = {
          key: key.trim(),
          label: label.trim(),
          default_issuer: defaultIssuer,
          validity_mode: validityMode,
          ...(validityMode === 'fixed_date'
            ? { reset_month_day: resetDay }
            : validityMonths
              ? { default_validity_months: Number(validityMonths) }
              : {}),
          active,
          order: editing?.order ?? types.length,
          org_id: orgId,
        }
        await setDoc(
          doc(db, ORGANIZATIONS_COLLECTION, orgId, AFFILIATION_TYPES_SUBCOLLECTION, id),
          payload,
          { merge: true },
        )
        invalidate()
        showToast(t('saved'))
        setFormOpen(false)
        setEditing(null)
      } finally {
        setSaving(false)
      }
    }

    return (
      <Dialog open={formOpen} onOpenChange={(v) => { if (!v) { setFormOpen(false); setEditing(null) } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? t('editTitle') : t('addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>{t('keyLabel')}</Label>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={t('keyPlaceholder')}
                disabled={!!editing}
              />
              <p className="text-xs text-muted-foreground">{t('keyHelp')}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t('labelLabel')}</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('labelPlaceholder')} autoFocus={!editing} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('issuerLabel')}</Label>
              <Select value={defaultIssuer} onValueChange={(v) => setDefaultIssuer(v as AffiliationIssuer)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="team">{t('issuer_team')}</SelectItem>
                  <SelectItem value="org">{t('issuer_org')}</SelectItem>
                  <SelectItem value="external">{t('issuer_external')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('validityModeLabel')}</Label>
              <Select value={validityMode} onValueChange={(v) => setValidityMode(v as 'months' | 'fixed_date')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="months">{t('validityModeMonths')}</SelectItem>
                  <SelectItem value="fixed_date">{t('validityModeFixedDate')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {validityMode === 'months' ? (
              <div className="space-y-1.5">
                <Label>{t('defaultValidityLabel')}</Label>
                <Input type="number" min={0} value={validityMonths} onChange={(e) => setValidityMonths(e.target.value)} placeholder={t('defaultValidityPlaceholder')} />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>{t('resetDayLabel')}</Label>
                {/* A date input for the picker, of which only month and day are
                    kept — the YEAR is meaningless here, so it is never stored.
                    2000 is a leap year, so 29 February stays selectable. */}
                <Input
                  type="date"
                  value={`2000-${resetDay}`}
                  onChange={(e) => setResetDay(e.target.value.slice(5) || '09-01')}
                />
                <p className="text-xs text-muted-foreground">{t('resetDayHint')}</p>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 rounded border-input accent-primary" />
              {t('activeLabel')}
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setFormOpen(false); setEditing(null) }} disabled={saving}>{t('cancel')}</Button>
            <Button onClick={handleSave} disabled={saving || !key.trim() || !label.trim()}>{saving ? '…' : t('save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <IdCard className="h-4 w-4" />
            {t('title')}
          </CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (
            <>
              {types.length === 0 ? (
                <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">{t('noTypes')}</div>
              ) : (
                <div className="divide-y rounded-md border">
                  {types.map((at) => (
                    <div key={at.id} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{at.label}</p>
                        <p className="text-xs text-muted-foreground font-mono">{at.key}</p>
                      </div>
                      <Badge variant="outline" className="text-xs shrink-0">{t(`issuer_${at.default_issuer}` as 'issuer_org')}</Badge>
                      {isAdmin && (
                        <>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditing(at); setFormOpen(true) }}>
                            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDeleteTarget(at)}>
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {isAdmin && (
                <Button size="sm" variant="outline" onClick={() => { setEditing(null); setFormOpen(true) }} className="gap-1.5">
                  <Plus className="h-3.5 w-3.5" />
                  {t('addButton')}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {formOpen && <AffTypeDialog />}

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmDeleteMessage')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteTarget) return
                await deleteDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId, AFFILIATION_TYPES_SUBCOLLECTION, deleteTarget.id))
                invalidate()
                showToast(t('deleted'))
                setDeleteTarget(null)
              }}
            >
              {t('deleteButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {toast && (
        <div className="fixed bottom-4 right-4 px-4 py-2.5 rounded-lg shadow-lg text-sm text-white bg-green-600 z-50">
          {toast}
        </div>
      )}
    </>
  )
}
