'use client'

// THE STUDIO'S USUAL DROP-IN PRICE — edited in ONE place (decision 29,
// docs/class-access-derived.md stage 4).
//
// It used to be edited in two: a card on the Pricing page (set, change, turn
// off) and a pencil inside a class's pricing tab (set or change, never off).
// Two editors of one number, with different powers, on a page that otherwise
// only reads. Now both entry points — the Offerings header and the class
// pricing tab — open THIS dialog, and the Pricing page shows the number.
//
// It writes `bookingSettings.dropIn` REPLACED WHOLE under `mergeFields`, so a
// stale price can never survive under a switched-off default, and
// `syncStudioDropIn` fans the change out to every following class's mirror.
//
// WHY IT SAYS HOW MANY CLASSES FOLLOW IT: under derived access
// (`classAccessFacts`) the usual price is not only a price — a class that
// follows it and lists a plan is open to paying visitors while it is set, and
// plan-holders-only while it is not. The count is how a studio sees the reach
// of the switch before pressing Save.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { setDoc } from 'firebase/firestore'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dropInModeOf, isAppointmentActivity, studioDropInOf, type Activity } from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { bookingSettingsRef, useBookingSettings } from '@/hooks/useBookingSettings'
import { useActivities } from '@/hooks/useActivities'
import { formatCurrency } from '@/lib/format'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

export function StudioDropInDialog({
  open,
  onOpenChange,
  currency,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currency: string
}) {
  const t = useTranslations('OfferPricing')
  const { currentTeamId } = useAuth()
  // The studio's activities, from the shared (cached) query — both hosts
  // already hold it, so opening this costs no extra read.
  const { data: classes = [] } = useActivities(currentTeamId)
  const qc = useQueryClient()
  const { data: bookingSettings } = useBookingSettings()
  const stored = studioDropInOf(bookingSettings)
  const storedPrice = stored?.priceAmount ?? null

  const [enabled, setEnabled] = useState(storedPrice !== null)
  const [price, setPrice] = useState(storedPrice !== null ? String(storedPrice) : '')
  const [saving, setSaving] = useState(false)
  // Re-seed on every open, and when the store changes under an open dialog.
  useEffect(() => {
    if (!open) return
    setEnabled(storedPrice !== null)
    setPrice(storedPrice !== null ? String(storedPrice) : '')
  }, [open, storedPrice])

  const parsed = parseFloat(price.replace(',', '.'))
  const invalid = enabled && !(price.trim() !== '' && parsed >= 0.5)
  const dirty = enabled !== (storedPrice !== null) || (enabled && parsed !== storedPrice)
  // Read off each class's OWN answer, not the resolved price, so "follows the
  // usual price" counts even while there is none.
  const counts = classes
    .filter((a: Activity) => !isAppointmentActivity(a))
    .reduce(
      (acc, a) => {
        acc[dropInModeOf(a.dropIn)] += 1
        return acc
      },
      { studio: 0, custom: 0, off: 0 }
    )

  async function save() {
    if (!currentTeamId || invalid || !dirty || saving) return
    setSaving(true)
    try {
      await setDoc(
        bookingSettingsRef(currentTeamId),
        {
          bookingSettings: {
            dropIn: enabled ? { enabled: true, priceAmount: parsed } : { enabled: false },
          },
        },
        { mergeFields: ['bookingSettings.dropIn'] }
      )
      await qc.invalidateQueries({ queryKey: ['booking-settings', currentTeamId] })
      toast.success(t('dropInDefaultSaved'))
      onOpenChange(false)
    } catch (err) {
      console.error('[drop-in default save] failed:', err)
      toast.error(err instanceof Error ? err.message : t('dropInDefaultSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dropInDefaultTitle')}</DialogTitle>
          <DialogDescription>{t('dropInDefaultSubtitle')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <label className="flex cursor-pointer items-center gap-3">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              <span className="text-sm font-medium">{t('dropInDefaultToggle')}</span>
            </label>
            {enabled && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{currency}</span>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void save()
                    }
                  }}
                  className="h-8 w-28 text-sm"
                  aria-label={t('dropInDefaultToggle')}
                  autoFocus
                />
              </div>
            )}
          </div>
          {invalid && price.trim() !== '' && (
            <p className="text-xs text-destructive">{t('dropInDefaultValidation')}</p>
          )}
          <p className="text-xs text-muted-foreground">{t('dropInDefaultSummary', counts)}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('dropInDefaultCancel')}
          </Button>
          <Button onClick={() => void save()} disabled={!dirty || invalid || saving}>
            {t('dropInDefaultSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * THE ENTRY POINT: a small button that names the current usual price and opens
 * the dialog. The Offerings header and a class's pricing tab both mount it, so
 * "change the usual price" is the same click wherever the question comes up.
 */
export function StudioDropInButton({
  currency,
  variant = 'outline',
}: {
  currency: string
  /** 'link' inside a form row, 'outline' in a page header. */
  variant?: 'outline' | 'link'
}) {
  const t = useTranslations('OfferPricing')
  const { data: bookingSettings } = useBookingSettings()
  const current = studioDropInOf(bookingSettings)
  const [open, setOpen] = useState(false)
  const label =
    current?.priceAmount != null
      ? t('dropInDefaultButton', { price: formatCurrency(current.priceAmount, currency) })
      : t('dropInDefaultButtonNone')
  return (
    <>
      {variant === 'link' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-primary underline-offset-2 hover:underline"
        >
          {current ? t('dropInDefaultChange') : t('dropInDefaultSetOne')}
        </button>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {label}
        </Button>
      )}
      <StudioDropInDialog open={open} onOpenChange={setOpen} currency={currency} />
    </>
  )
}
