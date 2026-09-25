'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import {
  collection, addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Plus, Pencil, Trash2, GripVertical } from 'lucide-react'
import { EVENTS_COLLECTION, EVENT_CATEGORIES_SUBCOLLECTION } from '@linyup/shared'
import type { EventCategory } from '@linyup/shared'
import { useFightingCupCategories } from './useCategories'

const COLORS = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E',
  '#3B82F6', '#8B5CF6', '#EC4899', '#6B7280',
]

const DEFAULT_CAT: Omit<EventCategory, 'id'> = {
  name: '',
  color: COLORS[0],
  gender: 'both',
}

function CategoryFormDialog({
  initial,
  onSave,
  onClose,
}: {
  initial?: EventCategory
  onSave: (data: Omit<EventCategory, 'id'>) => Promise<void>
  onClose: () => void
}) {
  const [form, setForm] = useState<Omit<EventCategory, 'id'>>(
    initial ? { ...initial } : { ...DEFAULT_CAT },
  )
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }))

  async function handleSave() {
    if (!form.name.trim()) return
    setBusy(true)
    await onSave(form)
    setBusy(false)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit category' : 'New category'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Under 60kg Female" />
          </div>

          <div className="space-y-1.5">
            <Label>Color</Label>
            <div className="flex gap-2 flex-wrap">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => set('color', c)}
                  className={`w-7 h-7 rounded-full transition-transform ${form.color === c ? 'ring-2 ring-offset-2 ring-primary scale-110' : ''}`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Gender</Label>
              <Select value={form.gender ?? 'both'} onValueChange={(v) => set('gender', v as EventCategory['gender'])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="both">Both</SelectItem>
                  <SelectItem value="M">Male</SelectItem>
                  <SelectItem value="F">Female</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Sort order</Label>
              <Input
                type="number"
                min="0"
                value={form.sort_order ?? ''}
                onChange={(e) => set('sort_order', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="0"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Min age</Label>
              <Input type="number" min="0" value={form.min_age ?? ''} onChange={(e) => set('min_age', e.target.value ? Number(e.target.value) : undefined)} placeholder="e.g. 14" />
            </div>
            <div className="space-y-1.5">
              <Label>Max age</Label>
              <Input type="number" min="0" value={form.max_age ?? ''} onChange={(e) => set('max_age', e.target.value ? Number(e.target.value) : undefined)} placeholder="e.g. 17" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Min weight (kg)</Label>
              <Input type="number" min="0" step="0.5" value={form.min_weight ?? ''} onChange={(e) => set('min_weight', e.target.value ? Number(e.target.value) : undefined)} placeholder="e.g. 50" />
            </div>
            <div className="space-y-1.5">
              <Label>Max weight (kg)</Label>
              <Input type="number" min="0" step="0.5" value={form.max_weight ?? ''} onChange={(e) => set('max_weight', e.target.value ? Number(e.target.value) : undefined)} placeholder="e.g. 60" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={handleSave} disabled={busy || !form.name.trim()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CategoryManager({ eventId }: { eventId: string }) {
  const t = useTranslations('Plugins')
  const qc = useQueryClient()
  const { data: categories = [], isLoading } = useFightingCupCategories(eventId)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<EventCategory | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['event-categories', eventId] })

  async function handleSave(data: Omit<EventCategory, 'id'>) {
    if (editing) {
      await updateDoc(doc(db, EVENTS_COLLECTION, eventId, EVENT_CATEGORIES_SUBCOLLECTION, editing.id), {
        ...data,
        updated_at: serverTimestamp(),
      })
    } else {
      await addDoc(collection(db, EVENTS_COLLECTION, eventId, EVENT_CATEGORIES_SUBCOLLECTION), {
        ...data,
        sort_order: categories.length,
        created_at: serverTimestamp(),
      })
    }
    invalidate()
  }

  async function handleDelete(cat: EventCategory) {
    if (!window.confirm(t('hmdFightingCupDeleteCategoryConfirm', { name: cat.name }))) return
    await deleteDoc(doc(db, EVENTS_COLLECTION, eventId, EVENT_CATEGORIES_SUBCOLLECTION, cat.id))
    invalidate()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Define weight/age/gender categories. Competitors are assigned during check-in.
        </p>
        <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true) }}>
          <Plus className="h-4 w-4 mr-1.5" />
          Add category
        </Button>
      </div>

      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
        </div>
      )}

      {!isLoading && categories.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          No categories yet. Add your first weight/age category.
        </div>
      )}

      {!isLoading && categories.length > 0 && (
        <div className="rounded-xl border overflow-hidden">
          {categories.map((cat) => (
            <div key={cat.id} className="flex items-center gap-3 px-4 py-3 border-b last:border-0">
              <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0" />
              <span className="w-3 h-3 rounded-full shrink-0" style={{ background: cat.color ?? '#6B7280' }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{cat.name}</p>
                <p className="text-xs text-muted-foreground">
                  {[
                    cat.gender && cat.gender !== 'both' ? (cat.gender === 'M' ? 'Male' : 'Female') : null,
                    cat.min_age != null && cat.max_age != null ? `Age ${cat.min_age}–${cat.max_age}` : null,
                    cat.min_weight != null || cat.max_weight != null
                      ? `${cat.min_weight ?? '—'}–${cat.max_weight ?? '—'} kg`
                      : null,
                  ].filter(Boolean).join(' · ') || 'No restrictions'}
                </p>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button
                  variant="ghost" size="icon" className="h-7 w-7"
                  onClick={() => { setEditing(cat); setFormOpen(true) }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => handleDelete(cat)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {formOpen && (
        <CategoryFormDialog
          initial={editing ?? undefined}
          onSave={handleSave}
          onClose={() => { setFormOpen(false); setEditing(null) }}
        />
      )}
    </div>
  )
}
