'use client'

/**
 * START FROM A TEMPLATE — the three shapes a studio's plans usually take.
 *
 * Reachable from the Plans rail at all times, not only while the list is empty:
 * a studio adds a pack in its second season as readily as in its first, and a
 * link that vanishes once you have one plan is a link nobody learns.
 *
 * It creates the SHAPE and no prices — see `planTemplates.ts` in shared for why
 * a plausible placeholder amount is worse than an obvious gap. The dialog says
 * so in as many words, so nobody publishes a plan thinking it is priced.
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { addDoc, collection } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  PLAN_TEMPLATES,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  buildPlanFromTemplate,
  type PlanTemplateId,
} from '@linyup/shared'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CreditCard, Ticket, Gift, Check } from 'lucide-react'

const ICON: Record<PlanTemplateId, React.ElementType> = {
  membership: CreditCard,
  class_pack: Ticket,
  complimentary: Gift,
}

export function PlanTemplatesDialog({
  open,
  onOpenChange,
  teamId,
  existingCount,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  /** Where to append — templates never reorder what the studio already has. */
  existingCount: number
  onCreated: () => void
}) {
  const t = useTranslations('PlanTemplates')
  const [picked, setPicked] = useState<Set<PlanTemplateId>>(new Set())
  const [saving, setSaving] = useState(false)

  const toggle = (id: PlanTemplateId) =>
    setPicked((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  async function create() {
    if (picked.size === 0) return
    setSaving(true)
    try {
      // Sequential, in template order, so `order` is deterministic and the rail
      // reads the way the dialog did.
      let order = existingCount
      for (const template of PLAN_TEMPLATES) {
        if (!picked.has(template.id)) continue
        await addDoc(
          collection(db, TEAMS_COLLECTION, teamId, SUBSCRIPTION_TYPES_SUBCOLLECTION),
          buildPlanFromTemplate({
            template,
            name: t(`${template.id}_name` as 'membership_name'),
            description: t(`${template.id}_desc` as 'membership_desc'),
            order: order++,
            newPriceId: () => crypto.randomUUID(),
          }),
        )
      }
      onCreated()
      onOpenChange(false)
      setPicked(new Set())
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) setPicked(new Set())
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
          <div className="space-y-2">
            {PLAN_TEMPLATES.map((tpl) => {
              const Icon = ICON[tpl.id]
              const on = picked.has(tpl.id)
              return (
                <button
                  key={tpl.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(tpl.id)}
                  className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                    on ? 'border-primary bg-primary/5' : 'hover:border-foreground/30'
                  }`}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {t(`${tpl.id}_name` as 'membership_name')}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(`${tpl.id}_desc` as 'membership_desc')}
                    </span>
                  </span>
                  {on && <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
                </button>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">{t('noPricesNote')}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void create()} disabled={saving || picked.size === 0}>
            {saving ? t('creating') : t('create', { count: picked.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
