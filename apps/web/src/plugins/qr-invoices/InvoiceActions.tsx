'use client'

// Shared row actions for a QR-bill invoice — the plugin's own invoices list AND
// a contact's Payments segment mount the exact same menu (pattern:
// plugins/tarif-595/ReceiptActions.tsx).
//
// A `pending` row (a crashed create attempt — the counter/number were never
// allocated, or the PDF never rendered) offers no retry: unlike a Tarif 595
// receipt, the invoice does not store its own `requestKey`, so there is
// nothing here to resume it with. It shows the status and a hint instead —
// the manager re-opens Create QR-bill invoice for the same sale.

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { CheckCircle2, Download, Loader2, Mail, MoreHorizontal, XCircle } from 'lucide-react'
import { DEFAULT_PAYMENT_MODES, deskReceiptDefaultOn, deskReceiptKindFor } from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  callEmailInvoice,
  callMarkInvoicePaid,
  callVoidInvoice,
  downloadInvoice,
  useInvalidateInvoices,
  type InvoiceRow,
} from './hooks'
import { qrInvoiceErrorMessage } from './errors'

/** ONE status chip, so the plugin's list and a contact's Payments segment never
 *  learn two different colour codes for the same status. */
export function InvoiceStatusBadge({ status }: { status: InvoiceRow['status'] }) {
  const t = useTranslations('QrInvoices')
  const className =
    status === 'paid'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
      : status === 'open'
        ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
        : status === 'void'
          ? 'bg-muted text-muted-foreground line-through'
          : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
  return (
    <Badge variant="secondary" className={className}>
      {t(`status.${status}`)}
    </Badge>
  )
}

function MarkInvoicePaidDialog({
  teamId,
  invoice,
  onClose,
  onDone,
}: {
  teamId: string
  invoice: InvoiceRow
  onClose: () => void
  onDone: () => void
}) {
  const t = useTranslations('QrInvoices')
  const { team } = useAuth()
  const modes = useMemo(
    () => (team?.payment_modes && team.payment_modes.length > 0 ? team.payment_modes : [...DEFAULT_PAYMENT_MODES]),
    [team?.payment_modes]
  )
  // Only when the invoice's own line item grants something worth telling the
  // buyer about — the same rule RecordPaymentDialog / AssignPaymentDialog use.
  const receiptKind = deskReceiptKindFor(invoice.line_item)

  const [mode, setMode] = useState(modes[0] ?? '')
  const [datePaid, setDatePaid] = useState(() => new Date().toISOString().slice(0, 10))
  const [sendReceipt, setSendReceipt] = useState(() => deskReceiptDefaultOn(invoice.line_item))
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    setSubmitting(true)
    try {
      await callMarkInvoicePaid({
        teamId,
        invoiceId: invoice.id,
        paymentMode: mode.trim() || null,
        paidAtMs: datePaid ? new Date(`${datePaid}T12:00:00`).getTime() : undefined,
        sendReceipt: !!receiptKind && sendReceipt,
      })
      toast.success(t('actions.markPaidSuccess'))
      onDone()
      onClose()
    } catch (err) {
      console.error('[qr-invoices] mark paid failed:', err)
      toast.error(qrInvoiceErrorMessage(err, t))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('actions.markPaidTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('actions.markPaidModeLabel')}</Label>
            <Select value={mode} onValueChange={(m) => m && setMode(m)}>
              <SelectTrigger>
                <SelectValue placeholder={t('actions.markPaidModePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {modes.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('actions.markPaidDateLabel')}</Label>
            <Input type="date" value={datePaid} onChange={(e) => setDatePaid(e.target.value)} />
          </div>
          {receiptKind && (
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Switch checked={sendReceipt} onCheckedChange={setSendReceipt} />
              {t('actions.markPaidSendReceiptLabel')}
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {t('actions.markPaidConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function InvoiceActions({
  teamId,
  invoice,
  canManage,
}: {
  teamId: string
  invoice: InvoiceRow
  /** Manager/owner only — a coach/viewer sees the row with no menu. */
  canManage: boolean
}) {
  const t = useTranslations('QrInvoices')
  const invalidate = useInvalidateInvoices(teamId)

  const [downloading, setDownloading] = useState(false)
  const [emailing, setEmailing] = useState(false)
  const [voiding, setVoiding] = useState(false)
  const [emailConfirmOpen, setEmailConfirmOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [voidReason, setVoidReason] = useState('')
  const [markPaidOpen, setMarkPaidOpen] = useState(false)

  const hasFiles = !!invoice.files
  const isOpen = invoice.status === 'open'
  const isPaid = invoice.status === 'paid'
  const isPending = invoice.status === 'pending'

  async function handleDownload() {
    setDownloading(true)
    try {
      await downloadInvoice(teamId, invoice.id)
    } catch (err) {
      console.error('[qr-invoices] download failed:', err)
      toast.error(t('actions.downloadError'))
    } finally {
      setDownloading(false)
    }
  }

  async function handleEmail() {
    setEmailing(true)
    try {
      const { data } = await callEmailInvoice({ teamId, invoiceId: invoice.id })
      if (data.sent) toast.success(t('actions.emailSuccess'))
      else toast.error(t('actions.emailError'))
      invalidate(invoice.contact_id)
      setEmailConfirmOpen(false)
    } catch (err) {
      console.error('[qr-invoices] email failed:', err)
      toast.error(qrInvoiceErrorMessage(err, t))
    } finally {
      setEmailing(false)
    }
  }

  async function handleVoid() {
    setVoiding(true)
    try {
      await callVoidInvoice({ teamId, invoiceId: invoice.id, reason: voidReason.trim() || null })
      toast.success(t('actions.voidSuccess'))
      invalidate(invoice.contact_id)
      setVoidOpen(false)
      setVoidReason('')
    } catch (err) {
      console.error('[qr-invoices] void failed:', err)
      toast.error(qrInvoiceErrorMessage(err, t))
    } finally {
      setVoiding(false)
    }
  }

  // A pending row (crashed create) has no files, no requestKey to resume with,
  // and nothing to void or mark paid — see the module header.
  if (isPending) {
    return <span className="text-xs text-muted-foreground">{t('actions.pendingHint')}</span>
  }

  const hasAnyAction = hasFiles || (canManage && (isOpen || isPaid))
  if (!hasAnyAction) return null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t('actions.menuLabel')}
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {hasFiles && (
            <DropdownMenuItem onClick={() => void handleDownload()} disabled={downloading}>
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {t('actions.download')}
            </DropdownMenuItem>
          )}
          {canManage && (isOpen || isPaid) && (
            <DropdownMenuItem onClick={() => setEmailConfirmOpen(true)}>
              <Mail className="h-4 w-4" />
              {t('actions.email')}
            </DropdownMenuItem>
          )}
          {canManage && isOpen && (
            <DropdownMenuItem onClick={() => setMarkPaidOpen(true)}>
              <CheckCircle2 className="h-4 w-4" />
              {t('actions.markPaid')}
            </DropdownMenuItem>
          )}
          {canManage && isOpen && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setVoidOpen(true)}>
                <XCircle className="h-4 w-4" />
                {t('actions.void')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Email confirm — no reason needed, just "are you sure". */}
      <AlertDialog open={emailConfirmOpen} onOpenChange={setEmailConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('actions.emailConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('actions.emailConfirmBody', { number: invoice.number })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleEmail()} disabled={emailing}>
              {emailing && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {t('actions.email')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Void — a one-way "this document is withdrawn", never a refund; the
          reason is asked because the question comes up months later, from
          someone who was not in the room. */}
      <AlertDialog
        open={voidOpen}
        onOpenChange={(o) => {
          if (!o) {
            setVoidOpen(false)
            setVoidReason('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('actions.voidConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('actions.voidConfirmBody', { number: invoice.number })}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="qr-invoice-void-reason">{t('actions.voidReasonLabel')}</Label>
            <Textarea
              id="qr-invoice-void-reason"
              rows={2}
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder={t('actions.voidReasonPlaceholder')}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleVoid()} disabled={voiding}>
              {voiding && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {t('actions.void')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {markPaidOpen && (
        <MarkInvoicePaidDialog
          teamId={teamId}
          invoice={invoice}
          onClose={() => setMarkPaidOpen(false)}
          onDone={() => invalidate(invoice.contact_id)}
        />
      )}
    </>
  )
}
