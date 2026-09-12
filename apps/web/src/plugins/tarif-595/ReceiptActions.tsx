'use client'

// Shared row actions for a Tarif 595 receipt — the plugin's own receipts list
// AND the contact's "Receipts" segment mount the exact same menu, so a studio
// never learns two different action sets for the same document.
//
// Downloads (PDF/XML) only exist once the server has written `files` — a
// `pending` row (a crashed issue attempt) has none yet, which is also why its
// only offered action is Retry. Email and Void act on an already-`issued`
// receipt; a `voided` one keeps its downloads (the paper trail) but drops
// every action that would change it further.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Download, FileText, Loader2, Mail, MoreHorizontal, RefreshCw, XCircle } from 'lucide-react'
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  callEmailTarif595Receipt,
  callIssueTarif595Receipt,
  callVoidTarif595Receipt,
  downloadTarif595Receipt,
  useInvalidateTarif595,
  type Tarif595ReceiptRow,
} from './hooks'

/** ONE status chip, so the plugin's receipts list and a contact's Receipts
 *  segment never learn two different colour codes for the same status. */
export function ReceiptStatusBadge({ status }: { status: Tarif595ReceiptRow['status'] }) {
  const t = useTranslations('Tarif595')
  const className =
    status === 'issued'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
      : status === 'voided'
        ? 'bg-muted text-muted-foreground line-through'
        : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
  return (
    <Badge variant="secondary" className={className}>
      {t(`status.${status}`)}
    </Badge>
  )
}

export function ReceiptActions({
  teamId,
  receipt,
  canManage,
}: {
  teamId: string
  receipt: Tarif595ReceiptRow
  /** Manager/owner only — a coach/viewer sees the row with no menu. */
  canManage: boolean
}) {
  const t = useTranslations('Tarif595')
  const invalidate = useInvalidateTarif595(teamId)

  const [downloading, setDownloading] = useState<'pdf' | 'xml' | null>(null)
  const [emailing, setEmailing] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [voiding, setVoiding] = useState(false)
  const [emailConfirmOpen, setEmailConfirmOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [voidReason, setVoidReason] = useState('')

  const hasFiles = !!receipt.files
  const isPending = receipt.status === 'pending'
  const isIssued = receipt.status === 'issued'

  async function handleDownload(kind: 'pdf' | 'xml') {
    setDownloading(kind)
    try {
      await downloadTarif595Receipt(teamId, receipt.id, kind)
    } catch (err) {
      console.error('[tarif-595] download failed:', err)
      toast.error(t('actions.downloadError'))
    } finally {
      setDownloading(null)
    }
  }

  async function handleEmail() {
    setEmailing(true)
    try {
      const { data } = await callEmailTarif595Receipt({ teamId, receiptId: receipt.id })
      if (data.sent) toast.success(t('actions.emailSuccess'))
      else toast.error(t('actions.emailError'))
      invalidate(receipt.contact_id)
      setEmailConfirmOpen(false)
    } catch (err) {
      console.error('[tarif-595] email failed:', err)
      toast.error(t('actions.emailError'))
    } finally {
      setEmailing(false)
    }
  }

  async function handleRetry() {
    setRetrying(true)
    try {
      // The server resumes a `pending` doc from its own source/period/contact —
      // never re-derives one on the client — so a crash-then-retry always
      // produces the same numbered receipt rather than a second one.
      await callIssueTarif595Receipt({
        teamId,
        contactId: receipt.contact_id,
        source: receipt.source,
        from: receipt.period.from,
        to: receipt.period.to,
      })
      toast.success(t('actions.retrySuccess'))
      invalidate(receipt.contact_id)
    } catch (err) {
      console.error('[tarif-595] retry failed:', err)
      toast.error(t('actions.retryError'))
    } finally {
      setRetrying(false)
    }
  }

  async function handleVoid() {
    setVoiding(true)
    try {
      await callVoidTarif595Receipt({ teamId, receiptId: receipt.id, reason: voidReason.trim() || null })
      toast.success(t('actions.voidSuccess'))
      invalidate(receipt.contact_id)
      setVoidOpen(false)
      setVoidReason('')
    } catch (err) {
      console.error('[tarif-595] void failed:', err)
      toast.error(t('actions.voidError'))
    } finally {
      setVoiding(false)
    }
  }

  const hasAnyAction = hasFiles || (canManage && (isPending || isIssued))
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
            <DropdownMenuItem onClick={() => void handleDownload('pdf')} disabled={downloading !== null}>
              {downloading === 'pdf' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
              {t('actions.downloadPdf')}
            </DropdownMenuItem>
          )}
          {hasFiles && (
            <DropdownMenuItem onClick={() => void handleDownload('xml')} disabled={downloading !== null}>
              {downloading === 'xml' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {t('actions.downloadXml')}
            </DropdownMenuItem>
          )}
          {canManage && isIssued && (
            <DropdownMenuItem onClick={() => setEmailConfirmOpen(true)}>
              <Mail className="h-4 w-4" />
              {t('actions.email')}
            </DropdownMenuItem>
          )}
          {canManage && isPending && (
            <DropdownMenuItem onClick={() => void handleRetry()} disabled={retrying}>
              {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('actions.retry')}
            </DropdownMenuItem>
          )}
          {canManage && isIssued && (
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
            <AlertDialogDescription>
              {t('actions.emailConfirmBody', { number: receipt.number })}
            </AlertDialogDescription>
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
            <AlertDialogDescription>
              {t('actions.voidConfirmBody', { number: receipt.number })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="tarif595-void-reason">{t('actions.voidReasonLabel')}</Label>
            <Textarea
              id="tarif595-void-reason"
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
    </>
  )
}
