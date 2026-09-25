'use client'

// ─── The contact card's quick actions — which four, per browser ──────────────
//
// The card has four action tiles. WHICH four is the viewer's choice, saved in
// this browser the same way the tab strip's order is (`useContactTabOrder` in
// page.tsx). WHAT each one does is decided in page.tsx, beside the dialogs it
// opens — this module knows ids, defaults and storage, and nothing about a
// contact.
//
// A stored choice is normalized on every read: unknown ids are dropped, repeats
// removed, and the gaps filled from the defaults. An id retired from the list
// therefore falls back quietly instead of leaving a hole in the card.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'

export const QUICK_ACTION_IDS = [
  'alerts',
  'notes',
  'record_payment',
  'send_email',
  'add_plan',
  'grant_credits',
  'update_details',
] as const

export type QuickActionId = (typeof QUICK_ACTION_IDS)[number]

export const QUICK_ACTION_SLOTS = 4

export const DEFAULT_QUICK_ACTIONS: readonly QuickActionId[] = [
  'alerts',
  'notes',
  'record_payment',
  'send_email',
]

const STORAGE_KEY = 'linyup_contact_quick_actions'

/** Exactly QUICK_ACTION_SLOTS known, distinct ids: the stored ones first, then
 *  the defaults, then anything else, in list order. */
export function normaliseQuickActions(raw: unknown): QuickActionId[] {
  const known = new Set<string>(QUICK_ACTION_IDS)
  const picked: QuickActionId[] = []
  const add = (id: string) => {
    if (picked.length < QUICK_ACTION_SLOTS && known.has(id) && !picked.includes(id as QuickActionId)) {
      picked.push(id as QuickActionId)
    }
  }
  if (Array.isArray(raw)) for (const v of raw) if (typeof v === 'string') add(v)
  for (const id of DEFAULT_QUICK_ACTIONS) add(id)
  for (const id of QUICK_ACTION_IDS) add(id)
  return picked
}

export function useContactQuickActions(): [QuickActionId[], (next: QuickActionId[]) => void] {
  const [actions, setActions] = useState<QuickActionId[]>(() => [...DEFAULT_QUICK_ACTIONS])
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) setActions(normaliseQuickActions(JSON.parse(raw)))
    } catch {
      /* unreadable storage: keep the defaults */
    }
  }, [])
  const save = (next: QuickActionId[]) => {
    const clean = normaliseQuickActions(next)
    setActions(clean)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
    } catch {
      /* storage blocked: the choice lasts for this page only */
    }
  }
  return [actions, save]
}

export interface QuickActionOption {
  id: QuickActionId
  label: string
  icon: React.ElementType
}

/**
 * Pick the action in each of the four slots. Choosing an action another slot
 * already holds SWAPS the two, so the card can never show the same one twice
 * and nothing has to be cleared first.
 */
export function CustomiseQuickActionsDialog({
  open,
  onOpenChange,
  value,
  options,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: QuickActionId[]
  /** The actions this viewer can use; a slot holding another one keeps it. */
  options: QuickActionOption[]
  onSave: (next: QuickActionId[]) => void
}) {
  const t = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const [draft, setDraft] = useState<QuickActionId[]>(value)

  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])

  const pick = (slot: number, id: QuickActionId) =>
    setDraft((prev) => {
      const next = [...prev]
      const other = next.indexOf(id)
      if (other !== -1 && other !== slot) next[other] = next[slot]
      next[slot] = id
      return next
    })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('quickActionsTitle')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('quickActionsIntro')}</p>
        <div className="space-y-2">
          {draft.map((id, slot) => {
            const current = options.find((o) => o.id === id)
            const Icon = current?.icon
            return (
              <div key={slot} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {t('quickActionSlot', { number: slot + 1 })}
                </span>
                <Select value={id} onValueChange={(v) => v && pick(slot, v as QuickActionId)}>
                  <SelectTrigger className="flex-1">
                    <span className="flex flex-1 items-center gap-2 truncate text-left text-sm">
                      {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                      {current?.label ?? id}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          })}
        </div>
        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          <Button variant="ghost" onClick={() => setDraft([...DEFAULT_QUICK_ACTIONS])}>
            {t('quickActionsReset')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                onSave(draft)
                onOpenChange(false)
              }}
            >
              {tCommon('save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
