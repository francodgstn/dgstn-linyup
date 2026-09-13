'use client'

// Create a QR-bill invoice for one contact — a numbered document, not a
// payment. "Email it now" only sends the PDF; the money still arrives (or is
// marked as arrived) separately, through InvoiceActions' mark-as-paid dialog.
//
// CONTACT IS OPTIONAL ON THE PROP, not on the submit: the contact page opens
// this already knowing who it's for, but the general /payments page has no
// contact in hand yet, so it shows the same ContactPicker every other payment
// dialog uses (RecordPaymentDialog, AssignPaymentDialog) until one is chosen.
//
// AMOUNT/DESCRIPTION ARE SUGGESTIONS, NEVER OVERWRITES: the moment a manager
// types into either field, picking a different line item must not silently
// replace what they wrote — the same `touched` guard RecordPaymentDialog uses
// for "send a receipt".

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import {
  isSellableCourse,
  resolveInvoiceSettings,
  resolveProductPrice,
  type Course,
  type CreateInvoiceResult,
  type PaymentLineItem,
  type Product,
  type SubscriptionType,
} from '@linyup/shared'
import { Link } from '@/i18n/navigation'
import { useSubscriptionTypes } from '@/hooks/useSubscriptionTypes'
import { useCourses } from '@/plugins/online-courses/hooks'
import { useProducts } from '@/plugins/products/hooks'
import { ContactPicker } from '@/components/payments/ContactPicker'
import { PaymentLineItemPicker } from '@/components/payments/PaymentLineItemPicker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { callCreateInvoice, newInvoiceRequestKey, useInvalidateInvoices, useInvoiceSettings } from './hooks'
import { qrInvoiceErrorReason } from './errors'

function addDaysIso(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Suggests a starting amount (major units) from what the picker just linked —
 *  the subscription price, the course's sale price, or the product/variant
 *  price. `null` when the kind carries no fixed price (drop-in, other, or an
 *  incomplete pick) — the manager types it in that case, same as today. */
function suggestedAmountMajor(
  li: PaymentLineItem | null,
  types: SubscriptionType[],
  courses: Course[],
  products: Product[]
): number | null {
  if (!li) return null
  if (li.kind === 'subscription' && li.subscriptionTypeId && li.priceId) {
    const ty = types.find((t) => t.id === li.subscriptionTypeId)
    const price = ty?.prices?.find((p) => p.id === li.priceId)
    return price ? price.amount : null
  }
  if (li.kind === 'course' && li.courseId) {
    const c = courses.find((x) => x.id === li.courseId)
    return c && isSellableCourse(c) && typeof c.accessRule.priceAmount === 'number' ? c.accessRule.priceAmount : null
  }
  if (li.kind === 'product' && li.productId) {
    const p = products.find((x) => x.id === li.productId)
    return p ? resolveProductPrice(p, li.variantId ?? null) : null
  }
  return null
}

export function CreateInvoiceDialog({
  teamId,
  contactId,
  contactName,
  open,
  onOpenChange,
  onCreated,
}: {
  teamId: string
  /** Absent → the dialog shows its own ContactPicker (the /payments page mount). */
  contactId?: string | null
  contactName?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (result: CreateInvoiceResult) => void
}) {
  const t = useTranslations('QrInvoices')
  const fixedContactId = contactId ?? null

  const { data: settings } = useInvoiceSettings(teamId)
  const { data: types = [] } = useSubscriptionTypes(teamId)
  const { data: courses = [] } = useCourses(teamId)
  const { data: products = [] } = useProducts(teamId)
  const invalidate = useInvalidateInvoices(teamId)

  const [pickedContactId, setPickedContactId] = useState('')
  const [lineItem, setLineItem] = useState<PaymentLineItem | null>(null)
  const [amount, setAmount] = useState('')
  const [amountTouched, setAmountTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [descriptionTouched, setDescriptionTouched] = useState(false)
  const [dueOn, setDueOn] = useState('')
  const [dueOnTouched, setDueOnTouched] = useState(false)
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [legalProfileError, setLegalProfileError] = useState(false)
  const [requestKey, setRequestKey] = useState('')

  // Reset on each open — a stale amount/description from the last invoice must
  // never survive into the next one.
  useEffect(() => {
    if (!open) return
    setPickedContactId('')
    setLineItem(null)
    setAmount('')
    setAmountTouched(false)
    setDescription('')
    setDescriptionTouched(false)
    setDueOnTouched(false)
    setMessage('')
    setEmail(false)
    setError(null)
    setLegalProfileError(false)
    // One key per opening, like RecordPaymentDialog's attemptKey — every submit
    // from this opening is the SAME attempt, so a retry resumes the same invoice.
    setRequestKey(newInvoiceRequestKey())
  }, [open])

  // Due date default (issue + due_days) — recomputed while untouched, so a
  // settings fetch that resolves just after open still lands correctly.
  useEffect(() => {
    if (!open || dueOnTouched) return
    setDueOn(addDaysIso(resolveInvoiceSettings(settings).due_days))
  }, [open, settings, dueOnTouched])

  function pickLineItem(li: PaymentLineItem | null) {
    setLineItem(li)
    if (!descriptionTouched) setDescription(li?.label ?? '')
    if (!amountTouched) {
      const suggested = suggestedAmountMajor(li, types, courses, products)
      if (suggested != null) setAmount(String(suggested))
    }
  }

  async function submit() {
    setError(null)
    setLegalProfileError(false)
    const cid = fixedContactId ?? pickedContactId
    if (!cid) {
      setError(t('contactRequired'))
      return
    }
    const major = parseFloat(amount.replace(',', '.'))
    if (!Number.isFinite(major) || major <= 0) {
      setError(t('amountInvalid'))
      return
    }
    setSubmitting(true)
    try {
      const { data } = await callCreateInvoice({
        teamId,
        contactId: cid,
        requestKey,
        // The request always carries a line item — "nothing picked" is itself
        // a kind (`other`), same as the picker's own default option.
        lineItem: lineItem ?? { kind: 'other' },
        amountMinor: Math.round(major * 100),
        description: description.trim() || null,
        dueOn: dueOn || null,
        message: message.trim() || null,
        email,
      })
      toast.success(t('createSuccess', { number: data.number }))
      invalidate(cid)
      onCreated?.(data)
      onOpenChange(false)
    } catch (err) {
      console.error('[qr-invoices] create failed:', err)
      if (qrInvoiceErrorReason(err) === 'legal_profile_incomplete') {
        setLegalProfileError(true)
      } else {
        toast.error(t('createError'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('createTitle')}</DialogTitle>
          {contactName && <DialogDescription>{t('createSubtitle', { name: contactName })}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-4">
          {!fixedContactId && (
            <div className="space-y-1.5">
              <Label>{t('contactLabel')}</Label>
              <ContactPicker teamId={teamId} value={pickedContactId} onChange={setPickedContactId} allowUnassign={false} />
            </div>
          )}

          <PaymentLineItemPicker teamId={teamId} value={lineItem} onChange={pickLineItem} />

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('amountLabel')}</Label>
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value)
                  setAmountTouched(true)
                  setError(null)
                }}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('dueDateLabel')}</Label>
              <Input
                type="date"
                value={dueOn}
                onChange={(e) => {
                  setDueOn(e.target.value)
                  setDueOnTouched(true)
                }}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t('descriptionLabel')}</Label>
            <Input
              value={description}
              onChange={(e) => {
                setDescription(e.target.value)
                setDescriptionTouched(true)
              }}
              placeholder={t('descriptionPlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('messageLabel')}</Label>
            <Textarea
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('messagePlaceholder')}
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Switch checked={email} onCheckedChange={setEmail} />
            {t('emailNowLabel')}
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}
          {legalProfileError && (
            <p className="text-xs text-destructive">
              {t('error.legalProfileIncomplete')}{' '}
              <Link href={'/settings/team?tab=payments' as Route} className="underline">
                {t('error.legalProfileIncompleteLink')}
              </Link>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {t('createButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
