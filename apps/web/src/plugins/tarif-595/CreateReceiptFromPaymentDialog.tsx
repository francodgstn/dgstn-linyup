'use client'

// "Receipt" on a payment row — the quick way to a Tarif 595 receipt for money
// that has ALREADY moved. The row says what was paid for (its line item) and
// when; the dialog turns that into the receipt's SOURCE and PERIOD, previews
// through the same callable the Receipts segment uses, and issues through the
// same issue path. No line math here, no second implementation: the payment is
// only the starting point, the receipt attests the underlying record.
//
// What the row can and cannot say:
//   • a PLAN payment names a plan TYPE, never a subscription instance (see
//     UnifiedPaymentRow.planTypeId) — so the subscription-history row is
//     resolved here: the row of that type whose period covers the payment
//     date, else the latest one that started before it;
//   • a COURSE payment names the course; the receipt period is the payment day;
//   • a drop-in or appointment payment names neither a class nor a date the
//     receipt can use, and a product is not health promotion — those hand over
//     to the contact's Receipts segment, where the source is picked by hand.
//
// A payment is never marked "receipted": the receipt's own deterministic id
// and the preview's `already_issued` / `overlapping_receipt` answers are what
// stop a second one.

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import type { Route } from 'next'
import { HeartPulse, Loader2 } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import type { SubscriptionHistoryEntry, Tarif595PreviewResult, Tarif595Source } from '@linyup/shared'
import { useSubscriptionHistory } from '@/hooks/useSubscriptionHistory'
import { formatMoneyMinor, type UnifiedPaymentRow } from '@/lib/payments'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { callIssueTarif595Receipt, callPreviewTarif595Receipt, useInvalidateTarif595 } from './hooks'
import { PreviewResultView } from './PreviewResultView'

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function tsToIsoDate(ts: unknown): string | null {
  const v = ts as { toDate?: () => Date } | null
  return v?.toDate ? isoDate(v.toDate()) : null
}

type Resolved =
  | { kind: 'subscription'; source: Tarif595Source; from: string; to: string; label: string }
  | { kind: 'course'; source: Tarif595Source; from: string; to: string; label: string }
  | { kind: 'no_history' }
  | { kind: 'unsupported' }

/** The subscription-history row a plan payment most plausibly paid for. */
function pickHistoryRow(history: SubscriptionHistoryEntry[], typeId: string, paidOn: string): SubscriptionHistoryEntry | null {
  const ofType = history.filter((h) => h.subscription_type_id === typeId)
  if (ofType.length === 0) return null
  const withDates = ofType.map((h) => ({ h, start: tsToIsoDate(h.start_date), end: tsToIsoDate(h.end_date) }))
  const covering = withDates.find((x) => x.start && x.start <= paidOn && (!x.end || x.end >= paidOn))
  if (covering) return covering.h
  const before = withDates.filter((x) => x.start && x.start <= paidOn).sort((a, b) => (a.start! < b.start! ? 1 : -1))
  return before[0]?.h ?? withDates[0].h
}

export function CreateReceiptFromPaymentDialog({
  teamId,
  row,
  contactName,
  onClose,
}: {
  teamId: string
  /** The payment to receipt; null closes the dialog. */
  row: UnifiedPaymentRow | null
  contactName?: string | null
  onClose: () => void
}) {
  const t = useTranslations('Tarif595')
  const contactId = row?.contactId ?? null
  const open = !!row && !!contactId
  const { data: history = [], isLoading: historyLoading } = useSubscriptionHistory(contactId ?? '__none__')
  const invalidate = useInvalidateTarif595(teamId)

  const paidOn = useMemo(() => (row?.createdAt?.toDate ? isoDate(row.createdAt.toDate()) : isoDate(new Date())), [row])

  const resolved = useMemo<Resolved | null>(() => {
    if (!row) return null
    const li = row.lineItem
    const typeId = li?.subscriptionTypeId ?? row.planTypeId ?? null
    if ((li?.kind === 'subscription' || (!li && typeId)) && typeId) {
      if (historyLoading) return null
      const h = pickHistoryRow(history, typeId, paidOn)
      if (!h) return { kind: 'no_history' }
      const from = tsToIsoDate(h.start_date) ?? paidOn
      const to = tsToIsoDate(h.end_date) ?? isoDate(new Date())
      return {
        kind: 'subscription',
        source: { kind: 'subscription', historyId: h.id },
        from,
        to,
        label: `${h.subscription_type_name ?? li?.label ?? ''} · ${from} – ${tsToIsoDate(h.end_date) ?? t('issue.ongoing')}`,
      }
    }
    if (li?.kind === 'course' && li.courseId) {
      return { kind: 'course', source: { kind: 'course', courseId: li.courseId }, from: paidOn, to: paidOn, label: li.label ?? '' }
    }
    return { kind: 'unsupported' }
  }, [row, history, historyLoading, paidOn, t])

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [preview, setPreview] = useState<Tarif595PreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [alsoEmail, setAlsoEmail] = useState(false)

  // The period defaults follow the resolved record; a manager may narrow it
  // (a calendar-year receipt of a longer subscription) before previewing.
  useEffect(() => {
    if (resolved && (resolved.kind === 'subscription' || resolved.kind === 'course')) {
      setFrom(resolved.from)
      setTo(resolved.to)
    } else {
      setFrom('')
      setTo('')
    }
    setPreview(null)
  }, [resolved])

  const source = resolved && (resolved.kind === 'subscription' || resolved.kind === 'course') ? resolved.source : null

  async function runPreview() {
    if (!contactId || !source || !from || !to) return
    setPreviewing(true)
    try {
      const { data } = await callPreviewTarif595Receipt({ teamId, contactId, source, from, to, unitPriceMinor: null })
      setPreview(data)
    } catch (err) {
      console.error('[tarif-595] preview from payment failed:', err)
      toast.error(t('issue.previewError'))
    } finally {
      setPreviewing(false)
    }
  }

  // Preview as soon as the source resolves — the whole point of the shortcut
  // is that the manager reads, not types.
  useEffect(() => {
    if (open && source && from && to && !preview && !previewing) void runPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source, from, to])

  async function issue() {
    if (!contactId || !source || !preview?.ok) return
    setIssuing(true)
    try {
      const { data } = await callIssueTarif595Receipt({ teamId, contactId, source, from, to, unitPriceMinor: null, email: alsoEmail })
      toast.success(data.resumed ? t('issue.resumedSuccess', { number: data.number }) : t('issue.issueSuccess', { number: data.number }))
      invalidate(contactId)
      onClose()
    } catch (err) {
      console.error('[tarif-595] issue from payment failed:', err)
      toast.error(t('issue.issueError'))
    } finally {
      setIssuing(false)
    }
  }

  const segmentHref = contactId ? (`/contacts/${contactId}?seg=receipts` as Route) : null

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-muted-foreground" />
            {t('fromPayment.title')}
          </DialogTitle>
          <DialogDescription>
            {row && (
              <>
                {contactName ? `${contactName} · ` : ''}
                {row.lineItem?.label ?? row.defaultLabel} · {formatMoneyMinor(row.amount, row.currency)} · {paidOn}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!resolved ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('fromPayment.resolving')}
          </div>
        ) : resolved.kind === 'no_history' || resolved.kind === 'unsupported' ? (
          <div className="space-y-3 py-2 text-sm">
            <p className="text-muted-foreground">{resolved.kind === 'no_history' ? t('fromPayment.noHistory') : t('fromPayment.unsupported')}</p>
            {segmentHref && (
              <Link href={segmentHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                {t('fromPayment.openSegment')}
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              <span className="text-muted-foreground">{resolved.kind === 'subscription' ? t('fromPayment.sourceSubscription') : t('fromPayment.sourceCourse')}: </span>
              <span className="font-medium">{resolved.label}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="t595-fp-from">{t('fromPayment.periodFrom')}</Label>
                <Input
                  id="t595-fp-from"
                  type="date"
                  value={from}
                  max={to}
                  onChange={(e) => {
                    setFrom(e.target.value)
                    setPreview(null)
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="t595-fp-to">{t('fromPayment.periodTo')}</Label>
                <Input
                  id="t595-fp-to"
                  type="date"
                  value={to}
                  min={from}
                  onChange={(e) => {
                    setTo(e.target.value)
                    setPreview(null)
                  }}
                />
              </div>
            </div>

            {previewing && !preview ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {t('fromPayment.previewing')}
              </div>
            ) : preview ? (
              <PreviewResultView preview={preview} teamId={teamId} contactId={contactId!} />
            ) : null}

            <label className="flex items-center gap-2 text-sm">
              <Switch checked={alsoEmail} onCheckedChange={setAlsoEmail} />
              {t('fromPayment.alsoEmail')}
            </label>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={issuing}>
            {t('fromPayment.cancel')}
          </Button>
          {resolved && (resolved.kind === 'subscription' || resolved.kind === 'course') && (
            <>
              {!preview || !preview.ok ? (
                <Button variant="outline" onClick={() => void runPreview()} disabled={previewing || !from || !to}>
                  {previewing && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  {t('fromPayment.preview')}
                </Button>
              ) : null}
              <Button onClick={() => void issue()} disabled={!preview?.ok || issuing || previewing}>
                {issuing && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {t('fromPayment.issue')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
