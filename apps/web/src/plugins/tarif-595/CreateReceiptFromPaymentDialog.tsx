'use client'

// "Receipt" on a payment row — the quick way to a Tarif 595 receipt for money
// that has ALREADY moved. The row says what was paid for (its line item) and
// when; the dialog turns that into the receipt's SOURCE and PERIOD, previews
// through the same callable the Receipts segment uses, and issues through the
// same issue path. No line math here, no second implementation: the payment is
// only the starting point, the receipt attests the underlying record.
//
// ── THE ROW NAMES A KIND; IT OFTEN CANNOT NAME THE RECORD ────────────────────
// Two questions, and fusing them is what made this dialog refuse rows it should
// have served (Franco, 2026-09-20):
//
//   • WHICH KIND — a plan or a course. Always answerable, and
//     `PaymentsTable.receiptable` lets nothing else reach here: a drop-in or an
//     appointment names neither a class nor a date a receipt could use
//     (`PaymentLineItem` carries no activity and no session), and a product is
//     not health promotion. Those are issued from the contact's Receipts
//     segment, by hand, or not at all.
//
//   • WHICH RECORD — this plan period, that course. Answerable only when the
//     Connect webhook stamped a `line_item` carrying the id. A legacy row has
//     none (`connectLineItem` synthesises a label-only item), and NO SEEDER
//     WRITES ONE AT ALL — so on the emulator, /try and every lead tenant this
//     is unanswerable for every row, which is exactly where it was found.
//
// So the record is a PICKER over everything of that kind the contact holds,
// pre-selected with the best-ranked candidate — one click when the payment named
// it, one click plus a glance when it did not, and a visible warning in the
// second case rather than a silent guess. Refusing is reserved for a contact
// who holds nothing of the kind at all.
//
// The dialog owns no line math and no second issue path: the same
// preview/issue callables the Receipts segment uses, against the source the
// manager confirmed.
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCourses } from '@/plugins/online-courses/hooks'
import {
  callIssueTarif595Receipt,
  callPreviewTarif595Receipt,
  useContactCoursePurchases,
  useInvalidateTarif595,
} from './hooks'
import { PreviewResultView } from './PreviewResultView'

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function tsToIsoDate(ts: unknown): string | null {
  const v = ts as { toDate?: () => Date } | null
  return v?.toDate ? isoDate(v.toDate()) : null
}

/** One thing this payment could have been for — a plan period or a course. */
interface SourceChoice {
  key: string
  label: string
  source: Tarif595Source
  /** Default receipt period for this source. */
  from: string
  to: string
}

/**
 * The subscription-history row a plan payment most plausibly paid for: the one
 * COVERING the payment date, else the latest that started before it.
 *
 * `typeId` NULL MEANS "RANK ACROSS EVERY PLAN", which is the case that matters.
 * A payment row names a plan type only when the Connect webhook stamped a
 * `line_item` on it; a legacy row, and every row any seeder writes, carries
 * `kind: 'membership'` and a NAME and no id at all. Filtering by a type id that
 * is null used to leave nothing to rank, and the dialog refused outright — so
 * on the emulator, /try and every lead tenant, this shortcut could not work at
 * all. Ranking by date alone is a guess, which is why the caller shows the
 * result in a picker rather than acting on it silently.
 */
function pickHistoryRow(
  history: SubscriptionHistoryEntry[],
  typeId: string | null,
  paidOn: string
): SubscriptionHistoryEntry | null {
  const ofType = typeId ? history.filter((h) => h.subscription_type_id === typeId) : history
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

  // WHAT KIND the row is, which is a separate question from WHICH record it
  // names — and the two used to be fused. `PaymentsTable.receiptable` lets only
  // these two kinds through; anything else lands on `unsupported` below, which
  // is now reachable only by deep link.
  const rowKind: 'subscription' | 'course' | null = useMemo(() => {
    if (!row) return null
    const k = row.lineItem?.kind ?? (row.planTypeId ? 'subscription' : null)
    return k === 'subscription' || k === 'course' ? k : null
  }, [row])

  const { data: history = [], isLoading: historyLoading } = useSubscriptionHistory(contactId ?? '__none__')
  // Courses cost two extra reads, so they are only fetched for a course row.
  const courseTeamId = rowKind === 'course' ? teamId : null
  const { data: courses = [], isLoading: coursesLoading } = useCourses(courseTeamId)
  const { data: purchasedCourseIds = [], isLoading: purchasesLoading } = useContactCoursePurchases(
    courseTeamId,
    rowKind === 'course' ? contactId : null
  )
  const invalidate = useInvalidateTarif595(teamId)

  const paidOn = useMemo(() => (row?.createdAt?.toDate ? isoDate(row.createdAt.toDate()) : isoDate(new Date())), [row])
  const loading = rowKind === 'course' ? coursesLoading || purchasesLoading : historyLoading

  /**
   * Everything of the row's kind this contact holds, as pickable sources — plus
   * the one to start on, and whether the ROW itself named it.
   *
   * THE ROW NAMES THE KIND; IT OFTEN CANNOT NAME THE RECORD. A plan id reaches a
   * payment only via a webhook-stamped `line_item`; `connectLineItem` synthesises
   * a `{kind, label}` for every older row without one, and no seeder writes one
   * at all. Refusing in that case — which is what this did — made the shortcut
   * useless on every non-production dataset and on every legacy sale.
   *
   * So the fallback is a CHOICE, never a silent assumption: the best-ranked
   * candidate is pre-selected so the common case stays one click, the whole list
   * is on screen to correct it, and `named` drives the warning that says the
   * selection is our guess and not the payment's word.
   */
  const { choices, defaultKey, named } = useMemo(() => {
    const empty = { choices: [] as SourceChoice[], defaultKey: null as string | null, named: false }
    if (!row || !rowKind || loading) return empty

    if (rowKind === 'subscription') {
      const all: SourceChoice[] = history.map((h) => {
        const start = tsToIsoDate(h.start_date)
        const end = tsToIsoDate(h.end_date)
        return {
          key: `subscription:${h.id}`,
          label: `${h.subscription_type_name ?? row.lineItem?.label ?? ''} · ${start ?? '—'} – ${end ?? t('issue.ongoing')}`,
          source: { kind: 'subscription', historyId: h.id },
          from: start ?? paidOn,
          to: end ?? isoDate(new Date()),
        }
      })
      const typeId = row.lineItem?.subscriptionTypeId ?? row.planTypeId ?? null
      const best = pickHistoryRow(history, typeId, paidOn)
      return { choices: all, defaultKey: best ? `subscription:${best.id}` : null, named: !!typeId }
    }

    const owned = new Set(purchasedCourseIds)
    const all: SourceChoice[] = courses
      .filter((c) => owned.has(c.id))
      .map((c) => ({
        key: `course:${c.id}`,
        label: c.title,
        source: { kind: 'course', courseId: c.id },
        from: paidOn,
        to: paidOn,
      }))
    const namedId = row.lineItem?.courseId ?? null
    const best = (namedId && all.find((c) => c.key === `course:${namedId}`)) || (all.length === 1 ? all[0] : null)
    return { choices: all, defaultKey: best?.key ?? null, named: !!namedId }
  }, [row, rowKind, loading, history, courses, purchasedCourseIds, paidOn, t])

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  useEffect(() => {
    setSelectedKey(defaultKey)
  }, [defaultKey])
  const choice = choices.find((c) => c.key === selectedKey) ?? null

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [preview, setPreview] = useState<Tarif595PreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [alsoEmail, setAlsoEmail] = useState(false)

  // The period defaults follow the SELECTED record; a manager may narrow it
  // (a calendar-year receipt of a longer subscription) before previewing, and
  // changing the selection resets both it and any preview taken against the old
  // one — a preview that outlived its source is the wrong document, previewed.
  useEffect(() => {
    setFrom(choice?.from ?? '')
    setTo(choice?.to ?? '')
    setPreview(null)
  }, [choice?.key, choice?.from, choice?.to])

  const source = choice?.source ?? null

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

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('fromPayment.resolving')}
          </div>
        ) : !rowKind || choices.length === 0 ? (
          // TWO DIFFERENT SENTENCES, deliberately. "This kind of payment can
          // never be receipted" and "this contact has nothing of that kind on
          // record" are different facts with different remedies, and one string
          // covering both is what explained drop-ins to somebody looking at a
          // membership.
          <div className="space-y-3 py-2 text-sm">
            <p className="text-muted-foreground">
              {!rowKind
                ? t('fromPayment.unsupported')
                : rowKind === 'course'
                  ? t('fromPayment.noCourses')
                  : t('fromPayment.noHistory')}
            </p>
            {segmentHref && (
              <Link href={segmentHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                {t('fromPayment.openSegment')}
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="t595-fp-source">
                {rowKind === 'subscription' ? t('fromPayment.sourceSubscription') : t('fromPayment.sourceCourse')}
              </Label>
              <Select value={selectedKey ?? ''} onValueChange={(v) => v && setSelectedKey(v)}>
                <SelectTrigger id="t595-fp-source">
                  <SelectValue placeholder={t('fromPayment.pickSource')} />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Only when the PAYMENT did not name the record. A stamped row is
                  the payment's own word and needs no hedge. */}
              {!named && (
                <p className="text-xs text-amber-600 dark:text-amber-500">{t('fromPayment.guessedSource')}</p>
              )}
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
          {choice && (
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
