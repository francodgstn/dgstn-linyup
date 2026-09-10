'use client'

// Shared unified-payments table (Connect + BYO/manual rails) used by the general
// /payments page AND the contact detail Payments tab — one component so the two
// views never drift. Columns: date, "what was paid" (line item / comment), an
// optional contact column (hidden on contact-scoped views), source gateway
// (+ manual payment mode), status, amount, and per-row actions (assign/edit +
// an optional refund for Connect rows, an optional void for manual ones).
//
// A VOIDED ROW IS INERT: struck through, counted nowhere, and offering no
// actions at all. Not hidden — it is the audit record of the mistake — and not
// editable either: `updatePaymentRecord` refuses a voided row server-side, so
// leaving the Edit button up would only produce a refusal.

import { useTranslations } from 'next-intl'
import { Pencil, UserPlus } from 'lucide-react'
import type { Route } from 'next'
import { financeSourceRefForPayment } from '@linyup/shared'
import type { PaymentJournal } from '@/plugins/finance/hooks'
import { Link } from '@/i18n/navigation'
import {
  paymentLabel,
  paymentNote,
  formatMoneyMinor,
  formatPaymentDate,
  type UnifiedPaymentRow,
} from '@/lib/payments'
import type { AssignPaymentTarget } from '@/components/payments/AssignPaymentDialog'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from '@/components/ui/hover-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const PAYMENT_STATUS_STYLES: Record<string, string> = {
  succeeded: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  paid: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  partially_refunded: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  refunded: 'bg-muted text-muted-foreground',
  voided: 'bg-muted text-muted-foreground',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  pending: 'bg-muted text-muted-foreground',
}

/**
 * What the books recorded for one payment — the hover card's contents.
 *
 * The whole fee split, which is the thing a studio cannot get anywhere else in
 * the app: `gross` is what the member paid, `net` is what reached the studio's
 * balance, and the fee lines are where the difference went. Until this existed
 * it was visible only by exporting the monthly CSV.
 *
 * ── A REFUND IS AN EXPENSE, AND THE CARD SAYS SO ────────────────────────────
 * Refunds get their own journal row, and the numbers on it are the point:
 * `platform_fee` is POSITIVE (our cut comes back) while `stripe_fee` is ZERO —
 * Stripe keeps its processing fee on a refunded charge. So a studio that
 * refunds CHF 89 is not back where it started; it is out of pocket by Stripe's
 * fee, and that is a real cost nothing in the app was telling them about
 * (Franco, 2026-08-24).
 *
 * `fee_source` is stated when it is NOT authoritative. A row built from our own
 * record knows OUR fee and not Stripe's, so its net is optimistic — and a
 * reconciliation that silently disagrees with a bank statement by a few francs
 * is worse than one that said it was an estimate.
 */
function JournalDetails({
  entry,
  fallbackCurrency,
  t,
}: {
  entry: PaymentJournal
  fallbackCurrency: string
  t: ReturnType<typeof useTranslations<'PaymentsDashboard'>>
}) {
  const txn = entry.charge
  const ccy = txn?.currency || entry.refunds[0]?.currency || fallbackCurrency
  const line = (label: string, value: string, muted = true) => (
    <div className="flex items-baseline justify-between gap-4">
      <span className={muted ? 'text-muted-foreground' : undefined}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )

  const refundedGross = entry.refunds.reduce((sum, r) => sum + r.gross, 0)
  const feeReturned = entry.refunds.reduce((sum, r) => sum + r.platform_fee, 0)
  // Every row's `net` is signed from the studio's point of view, so the bottom
  // line is simply their sum — no sign juggling here, and no second definition
  // of what a refund costs.
  const netAfter =
    (txn?.net ?? 0) + entry.refunds.reduce((sum, r) => sum + r.net, 0)
  const stripeKept = txn && txn.stripe_fee !== 0 ? Math.abs(txn.stripe_fee) : 0

  return (
    <div className="space-y-2 text-xs">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t('journalHeading')}
      </p>
      {txn && (
        <p className="text-sm font-medium">
          {t(`category_${txn.category}` as 'category_membership')}
        </p>
      )}

      {txn && (
        <div className="space-y-1">
          {line(t('journalGross'), formatMoneyMinor(txn.gross, ccy))}
          {/* Fees are stored SIGNED (negative when a cost), so they print with
              their own sign rather than one this component invents. */}
          {txn.stripe_fee !== 0 && line(t('journalStripeFee'), formatMoneyMinor(txn.stripe_fee, ccy))}
          {txn.platform_fee !== 0 &&
            line(t('journalPlatformFee'), formatMoneyMinor(txn.platform_fee, ccy))}
          {entry.refunds.length === 0 && (
            <div className="flex items-baseline justify-between gap-4 border-t pt-1.5 text-sm font-semibold">
              <span>{t('journalNetLabel')}</span>
              <span className="tabular-nums">{formatMoneyMinor(txn.net, ccy)}</span>
            </div>
          )}
        </div>
      )}

      {entry.refunds.length > 0 && (
        <div className="space-y-1 border-t pt-1.5">
          {line(t('journalRefunded'), formatMoneyMinor(refundedGross, ccy))}
          {feeReturned !== 0 && line(t('journalFeeReturned'), formatMoneyMinor(feeReturned, ccy))}
          {/* "You keep -CHF 2.88" is a contradiction, and a full refund lands
              there every time: Stripe's fee stays gone, so the bottom line is
              NEGATIVE. Below zero the row says what it is — money out — and
              prints the magnitude, so the reader never has to interpret a
              minus sign against a label that promises the opposite. */}
          <div className="flex items-baseline justify-between gap-4 border-t pt-1.5 text-sm font-semibold">
            <span>{t(netAfter < 0 ? 'journalNetAfterRefundCost' : 'journalNetAfterRefund')}</span>
            <span className={`tabular-nums ${netAfter < 0 ? 'text-amber-600' : ''}`}>
              {formatMoneyMinor(Math.abs(netAfter), ccy)}
            </span>
          </div>
        </div>
      )}

      {/* WHY the bottom line is negative — the reason only, never the figure
          again: the line above already states it, and a caveat that repeats an
          amount reads as a second, different charge. */}
      {entry.refunds.length > 0 && stripeKept > 0 && (
        <p className="leading-snug text-muted-foreground">{t('journalStripeFeeKept')}</p>
      )}
      {txn && txn.fee_source !== 'balance_transaction' && (
        <p className="leading-snug text-muted-foreground">{t('journalFeeEstimated')}</p>
      )}
      {txn?.status === 'corrected' && (
        <p className="leading-snug text-amber-600">{t('journalCorrected')}</p>
      )}
    </div>
  )
}

export function PaymentsTable({
  rows,
  showContact = true,
  contactName,
  onAssign,
  onRefund,
  onVoid,
  journal,
}: {
  rows: UnifiedPaymentRow[]
  /** Hide the contact column on contact-scoped views (it's redundant there). */
  showContact?: boolean
  /** Resolve a contact id to a display name (general payments page). */
  contactName?: (id: string) => string | undefined
  onAssign: (target: AssignPaymentTarget) => void
  /** When provided, refundable Connect rows get a Refund action. */
  onRefund?: (row: UnifiedPaymentRow) => void
  /** When provided, live MANUAL rows get a Void action ("this record is wrong"). */
  onVoid?: (row: UnifiedPaymentRow) => void
  /**
   * The money JOURNAL for these rows, keyed by `source_ref` — what each payment
   * actually booked. Absent unless the finance plugin is installed, and every
   * row degrades to what it showed before, so this is additive by construction.
   *
   * It answers the question that used to require exporting a CSV: what category
   * did this charge book as, and what actually landed after fees. It is shown
   * INLINE rather than linked because a studio manager wants that answer, not a
   * ledger (Franco, 2026-08-23) — and there is no journal screen to link to.
   */
  journal?: Map<string, PaymentJournal>
}) {
  const t = useTranslations('PaymentsDashboard')

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('colDate')}</TableHead>
              {/* WHO BEFORE WHAT. A studio scans this table for a person far
                  more often than for a line item, and the same order now holds
                  on the Subscriptions tab beside it (Franco, 2026-08-23).
                  Absent entirely on the contact's own Payments tab, where the
                  person is the page. */}
              {showContact && <TableHead>{t('colContact')}</TableHead>}
              <TableHead>{t('colDetails')}</TableHead>
              <TableHead>{t('colSource')}</TableHead>
              <TableHead>{t('colStatus')}</TableHead>
              <TableHead className="text-right">{t('colAmount')}</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              // The journal is keyed by the rail's natural reference, and
              // `financeSourceRefForPayment` is the ONE place that turns a
              // payment row back into it — see its note in @linyup/shared.
              const entry = journal?.get(financeSourceRefForPayment(row.gateway, row.paymentId))
              return (
              <TableRow key={row.key} className={row.voided ? 'text-muted-foreground' : undefined}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatPaymentDate(row.createdAt)}
                </TableCell>
                {showContact && (
                  <TableCell className="max-w-[180px]">
                    {row.assigned ? (
                      row.contactId ? (
                        // Straight to the payments SEGMENT: the reader clicked a
                        // payment row, so land on the list it belongs to rather
                        // than on the tab's Overview. A plain `?tab=payments`
                        // bookmark still works — it just opens the Overview.
                        <Link
                          href={`/contacts/${row.contactId}?tab=payments&seg=payments` as Route}
                          className="block truncate text-primary hover:underline"
                        >
                          {contactName?.(row.contactId) ?? '—'}
                        </Link>
                      ) : (
                        <span className="block truncate">—</span>
                      )
                    ) : (
                      <>
                        <Badge variant="outline" className="text-amber-700 border-amber-300">
                          {t('unassigned')}
                        </Badge>
                        {row.email && (
                          <div className="truncate text-xs text-muted-foreground">{row.email}</div>
                        )}
                      </>
                    )}
                  </TableCell>
                )}
                <TableCell className="max-w-[220px]">
                  <div className={`truncate font-medium ${row.voided ? 'line-through' : ''}`}>
                    {paymentLabel(row)}
                  </div>
                  {paymentNote(row) && (
                    <div className="truncate text-xs text-muted-foreground">{paymentNote(row)}</div>
                  )}
                  {/* The discount's only trace on the money side — a promo writes
                      no journal row, so this chip and the redemptions ledger are
                      the whole answer to "who used this code and what did they
                      pay". See docs/promo-codes.md → "Reporting". */}
                  {row.promoCode && (
                    <Badge variant="outline" className="mt-0.5 font-normal text-muted-foreground">
                      {t('promoCode', { code: row.promoCode })}
                    </Badge>
                  )}
                  {/* A PAID TRIAL, on the money side. Without it the row reads
                      as an ordinary drop-in and the trial it paid for is only
                      visible on the contact — which is the same row, in the
                      contact's Payments tab, so one chip answers both "what is
                      this income" and "did they pay for their trial". */}
                  {row.trial && (
                    <Badge variant="outline" className="mt-0.5 font-normal text-muted-foreground">
                      {t('trialCharge')}
                    </Badge>
                  )}
                  {/* A row a sibling webhook event may have written TWICE. The
                      duplication is the studio's own Stripe endpoint config and
                      cannot be fixed from here (handleTeamStripeWebhook's header
                      explains why), so what it gets instead is the ability to
                      tell which rows are exposed to it. */}
                  {row.refKindFallback && (
                    <Badge
                      variant="outline"
                      className="mt-0.5 font-normal text-amber-700 border-amber-300"
                      title={t('mayDuplicateHelp')}
                    >
                      {t('mayDuplicate')}
                    </Badge>
                  )}
                  {/* THE FALLBACK FEE LINE — shown only when the hover card on
                      the amount cannot answer instead.

                      It said "Fee 2.67" about `application_fee_amount`, which is
                      OUR cut alone, and a studio reading it did the obvious
                      subtraction and got a net that was too high: Stripe's
                      processing fee is gone from the same charge and is not in
                      this number (the row has no field for it — see
                      `PaymentRow.feeAmount`). The hover card gets this right,
                      naming all three lines and calling the bottom one "You
                      receive" — so wherever it exists, this line was a worse
                      answer to the same question standing next to a better one
                      (Franco, 2026-09-09).

                      NOT DELETED OUTRIGHT, because the card is not always
                      there: `journal` is fetched only when the finance plugin is
                      installed, so on every other team this is the one place a
                      fee is visible at all. Kept for those rows and relabelled
                      to the card's own wording, which says whose fee it is. */}
                  {!entry && row.source === 'connect' && row.feeAmount > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {t('journalPlatformFee')} {formatMoneyMinor(row.feeAmount, row.currency)}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-muted-foreground">
                    {t(`gateway_${row.gateway}` as never)}
                  </Badge>
                  {row.paymentMode && (
                    <div className="mt-0.5 text-xs text-muted-foreground">{row.paymentMode}</div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {row.disputed && (
                      <Badge variant="outline" className="text-red-700 border-red-300">
                        {t('disputed')}
                      </Badge>
                    )}
                    <Badge
                      variant="secondary"
                      className={PAYMENT_STATUS_STYLES[row.status] ?? 'bg-muted'}
                    >
                      {t(`status_${row.status}` as never)}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {/* ── THE BOOKS, BEHIND THE AMOUNT ───────────────────────
                      The journal facts were briefly rendered inline — a category
                      chip and a "Net …" line on every row — and that was too
                      much: this table already carries a date, a contact, a
                      label, a note, up to four badges, a source, a status and a
                      figure, and two more permanent marks pushed it from dense
                      to unreadable (Franco, 2026-08-23).
                      
                      So they live in a tooltip on the AMOUNT, which is the thing
                      being asked about. Zero rows, zero columns, and a dotted
                      underline as the only permanent mark — the ordinary
                      convention for "there is more here". Rows with no journal
                      entry get no underline and no trigger, so the affordance
                      appears exactly where it leads somewhere. */}
                  {/* ── THE BOOKS, ON THE AMOUNT ITSELF ────────────────────
                      Tried as a separate receipt icon and reverted (Franco,
                      2026-08-24): the breakdown is ABOUT this figure, so the
                      figure is the thing to point at. An icon beside it is a
                      second target to notice, aim at and learn, for the same
                      information — and the dotted underline already says
                      "there is more here" without adding an element to a row
                      that carries six columns and two buttons.

                      A HOVER CARD, not a tooltip: the breakdown is a small
                      table with a rule and a total, and a tooltip is a one-line
                      LABEL whose inverted colours make tabular figures hard to
                      read. See the note at the top of ui/hover-card.tsx. */}
                  {entry ? (
                    <HoverCard>
                      <HoverCardTrigger
                        aria-label={t('journalHeading')}
                        className={`cursor-help font-medium underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 ${
                          row.voided ? 'line-through' : ''
                        }`}
                      >
                        {formatMoneyMinor(row.amount, row.currency)}
                      </HoverCardTrigger>
                      <HoverCardContent align="end">
                        <JournalDetails entry={entry} fallbackCurrency={row.currency} t={t} />
                      </HoverCardContent>
                    </HoverCard>
                  ) : (
                    <div className={`font-medium ${row.voided ? 'line-through' : ''}`}>
                      {formatMoneyMinor(row.amount, row.currency)}
                    </div>
                  )}
                  {row.amountRefunded > 0 && (
                    <div className="text-xs text-muted-foreground">
                      -{formatMoneyMinor(row.amountRefunded, row.currency)}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {!row.voided && (
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          onAssign({
                            source: row.source,
                            paymentId: row.paymentId,
                            contactId: row.contactId,
                            comment: row.comment,
                            lineItem: row.lineItem,
                          })
                        }
                      >
                        {row.assigned ? (
                          <Pencil className="h-3.5 w-3.5" />
                        ) : (
                          <>
                            <UserPlus className="h-3.5 w-3.5 mr-1" />
                            {t('assign')}
                          </>
                        )}
                      </Button>
                      {onRefund && row.refundable && (
                        <Button size="sm" variant="outline" onClick={() => onRefund(row)}>
                          {t('refund')}
                        </Button>
                      )}
                      {onVoid && row.voidable && (
                        <Button size="sm" variant="outline" onClick={() => onVoid(row)}>
                          {t('void')}
                        </Button>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}
