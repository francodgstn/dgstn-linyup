'use client'

/**
 * SEND THE MEMBER RECAP — the `ai-member-recap` module's dialog.
 *
 * It shows the email as it will arrive: the greeting, the two labelled parts and
 * the sign-off come from `composeMemberRecap` in @linyup/shared — the very
 * function the server renders the email with — so the preview cannot drift from
 * the message. The two parts are editable, because model text addressed to a
 * member leaves only after somebody at the studio has read it. What is sent is
 * what is in the boxes when Send is pressed.
 *
 * One `sendId` per open dialog: a double click or a retry of the same send
 * dedupes server-side, while opening the dialog again tomorrow is a new send.
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { httpsCallable } from 'firebase/functions'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import {
  MEMBER_RECAP_PART_MAX_CHARS,
  composeMemberRecap,
  type Contact,
  type ContactAiMemberRecap,
} from '@linyup/shared'
import { functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type SendResult = { sent: true } | { sent: false; reason: 'not_delivered' }

export function MemberRecapDialog({
  open,
  onOpenChange,
  contact,
  recap,
  language,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  contact: Contact
  recap: ContactAiMemberRecap
  /** The language the summary was written in — the email's language. */
  language: string
}) {
  // Mounted only while open (see the card), so every opening starts from the
  // stored recap and gets a fresh sendId.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <RecapForm
          contact={contact}
          recap={recap}
          language={language}
          onDone={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  )
}

function RecapForm({
  contact,
  recap,
  language,
  onDone,
}: {
  contact: Contact
  recap: ContactAiMemberRecap
  language: string
  onDone: () => void
}) {
  const t = useTranslations('Contacts')
  const qc = useQueryClient()
  const { team } = useAuth()
  const [status, setStatus] = useState(recap.status)
  const [nextSession, setNextSession] = useState(recap.nextSession)
  const [sending, setSending] = useState(false)
  const [sendId] = useState(() => crypto.randomUUID())

  const message = composeMemberRecap({
    firstname: contact.firstname,
    teamName: team?.name ?? '',
    status,
    nextSession,
    language,
  })
  const canSend = !!message.status && !!message.nextSession && !sending

  async function send() {
    if (!canSend) return
    setSending(true)
    try {
      const call = httpsCallable<
        { teamId: string; contactId: string; sendId: string; status: string; nextSession: string },
        SendResult
      >(functions, 'sendContactRecapEmail')
      const res = await call({
        teamId: contact.teamId,
        contactId: contact.id,
        sendId,
        status,
        nextSession,
      })
      if (res.data.sent) {
        toast.success(t('recapSent', { name: contact.firstname ?? '' }))
        qc.invalidateQueries({ queryKey: ['contact', contact.id] })
        qc.invalidateQueries({ queryKey: ['contact-activity-log', contact.id] })
        onDone()
      } else {
        toast.error(t('recapNotDelivered'))
      }
    } catch (err) {
      console.error('[member-recap] send failed:', err)
      const reason = (err as { details?: { reason?: string } })?.details?.reason
      toast.error(
        reason === 'unsubscribed'
          ? t('recapUnsubscribed')
          : reason === 'no_email'
            ? t('recapNoEmail')
            : t('recapFailed')
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('recapDialogTitle')}</DialogTitle>
        <DialogDescription>{t('recapDialogDescription', { email: contact.email ?? '' })}</DialogDescription>
      </DialogHeader>

      {/* The email, as it arrives. Fixed lines are plain text; the two parts
          are the boxes. */}
      <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
        <p className="text-xs text-muted-foreground">
          {t('recapSubject')} <span className="font-medium text-foreground">{message.subject}</span>
        </p>
        <p>{message.greeting}</p>
        <div className="space-y-1">
          <label htmlFor="recap-status" className="block font-semibold">
            {message.statusLabel}
          </label>
          <Textarea
            id="recap-status"
            value={status}
            maxLength={MEMBER_RECAP_PART_MAX_CHARS}
            onChange={(e) => setStatus(e.target.value)}
            rows={3}
            className="bg-background"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="recap-next" className="block font-semibold">
            {message.nextSessionLabel}
          </label>
          <Textarea
            id="recap-next"
            value={nextSession}
            maxLength={MEMBER_RECAP_PART_MAX_CHARS}
            onChange={(e) => setNextSession(e.target.value)}
            rows={3}
            className="bg-background"
          />
        </div>
        <p className="whitespace-pre-line">
          {message.signOff}
          {'\n'}
          {message.teamName}
        </p>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('recapReviewHint')}</p>

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={sending}>
          {t('cancel')}
        </Button>
        <Button onClick={send} disabled={!canSend} className="gap-1.5">
          <Send className="h-4 w-4" />
          {sending ? t('recapSending') : t('recapSend')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
