'use client'

// "Ask these people to sign it."
//
// The bulk half of `requestWaiverAcceptance`. The per-row half (the contact's
// Documents tab) calls the same callable with one id — one server path, one
// outcome vocabulary, so a single ask and a bulk ask can never disagree about
// what happened.
//
// TWO THINGS IT SAYS OUT LOUD, both because a mailing that reports only a total
// teaches a manager to trust it blindly:
//
//  • WHICH DOCUMENTS CAN BE ASKED FOR. Only the ones required before booking:
//    the mail carries the member's Space link, and Space presents the waiver
//    policy. A document that is merely shown at signup has no page to send
//    anybody to, so it is listed as unavailable WITH the reason, rather than
//    silently missing from the picker.
//  • WHAT HAPPENED PER PERSON. Sent, already signed, no email address, not
//    delivered, skipped — five outcomes, five sentences. "No email address" in
//    particular is the one the studio has to act on themselves.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertCircle, CheckCircle2, ShieldCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import type { AskedDocument } from '@/hooks/useContactDocuments'
import { callFunction } from '@/lib/callFunction'

export type WaiverRequestOutcome =
  | 'sent'
  | 'already_signed'
  | 'no_email'
  | 'not_delivered'
  | 'skipped'

export interface WaiverRequestCounts {
  sent: number
  already_signed: number
  no_email: number
  not_delivered: number
  skipped: number
}

/** The server's ceiling on one call, restated so the dialog can chunk rather
 *  than hand the manager a refusal. Keep in step with
 *  MAX_WAIVER_REQUEST_RECIPIENTS in packages/functions/src/waivers/request.ts. */
const CHUNK = 200

function addCounts(a: WaiverRequestCounts, b: WaiverRequestCounts): WaiverRequestCounts {
  return {
    sent: a.sent + b.sent,
    already_signed: a.already_signed + b.already_signed,
    no_email: a.no_email + b.no_email,
    not_delivered: a.not_delivered + b.not_delivered,
    skipped: a.skipped + b.skipped,
  }
}

export function AskToSignDialog({
  open, onOpenChange, teamId, documents, contactIds, onSent,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string | null
  /** Everything the studio asks for. The picker offers the required ones; the
   *  rest are shown as unavailable with the reason. */
  documents: AskedDocument[]
  contactIds: string[]
  onSent?: () => void
}) {
  const t = useTranslations('Contacts')
  const askable = documents.filter((d) => d.requiredBeforeBooking)
  const signupOnly = documents.filter((d) => !d.requiredBeforeBooking)

  const [documentId, setDocumentId] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<WaiverRequestCounts | null>(null)

  function handleOpenChange(v: boolean) {
    if (!v) {
      setDocumentId('')
      setError(null)
      setResult(null)
    }
    onOpenChange(v)
  }

  async function send() {
    if (!documentId || !teamId || contactIds.length === 0 || sending) return
    setSending(true)
    setError(null)
    try {
      const fn = callFunction<
        { teamId: string; documentId: string; contactIds: string[] },
        { counts: WaiverRequestCounts }
      >('requestWaiverAcceptance')
      let total: WaiverRequestCounts = {
        sent: 0, already_signed: 0, no_email: 0, not_delivered: 0, skipped: 0,
      }
      // Chunked at the server's own ceiling: a "select all" on a large roster is
      // a legitimate ask, and it should not come back as a refusal about numbers.
      for (let i = 0; i < contactIds.length; i += CHUNK) {
        const res = await fn({ teamId, documentId, contactIds: contactIds.slice(i, i + CHUNK) })
        total = addCounts(total, res.data.counts)
      }
      setResult(total)
      onSent?.()
    } catch (e) {
      const reason = (e as { details?: { reason?: string } }).details?.reason
      setError(
        reason === 'document_not_required'
          ? t('askToSignNotRequired')
          : reason === 'team_has_no_slug'
            ? t('askToSignNoSlug')
            : t('askToSignError')
      )
    } finally {
      setSending(false)
    }
  }

  const selected = askable.find((d) => d.documentId === documentId)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            {t('askToSignTitle')}
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
              {t('askToSignResultSent', { count: result.sent })}
            </p>
            {result.already_signed > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('askToSignResultAlready', { count: result.already_signed })}
              </p>
            )}
            {result.no_email > 0 && (
              <p className="flex items-center gap-2 text-xs text-amber-600">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {t('askToSignResultNoEmail', { count: result.no_email })}
              </p>
            )}
            {result.not_delivered > 0 && (
              <p className="flex items-center gap-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {t('askToSignResultNotDelivered', { count: result.not_delivered })}
              </p>
            )}
            {result.skipped > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('askToSignResultSkipped', { count: result.skipped })}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('askToSignDesc', { count: contactIds.length })}
            </p>

            <Select value={documentId} onValueChange={(v) => setDocumentId(v ?? '')}>
              <SelectTrigger className="h-9 w-full text-sm">
                <span className="flex flex-1 truncate text-left text-sm">
                  {selected?.title ?? (
                    <span className="text-muted-foreground">{t('askToSignPickDocument')}</span>
                  )}
                </span>
              </SelectTrigger>
              <SelectContent>
                {askable.map((d) => (
                  <SelectItem key={d.documentId} value={d.documentId}>{d.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Not hidden: a document that CANNOT be asked for, with the reason
                and the one switch that changes it. Hiding it is what made the
                two consent mechanisms look like peers in the first place. */}
            {signupOnly.length > 0 && (
              <div className="rounded-lg border bg-muted/30 p-2.5">
                <p className="text-xs text-muted-foreground">
                  {t('askToSignSignupOnly', {
                    documents: signupOnly.map((d) => d.title).join(', '),
                  })}
                </p>
              </div>
            )}

            <p className="text-xs text-muted-foreground">{t('askToSignRepeatHint')}</p>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => handleOpenChange(false)}>{t('askToSignClose')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={sending}>
                {t('askToSignCancel')}
              </Button>
              <Button onClick={send} disabled={!documentId || sending || contactIds.length === 0}>
                {sending ? t('askToSignSending') : t('askToSignAction')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
