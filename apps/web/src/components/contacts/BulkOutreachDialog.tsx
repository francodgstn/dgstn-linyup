'use client'

// Send a templated outreach email to the contacts selected on the list.
//
// Two things this deliberately does that the single-contact dialog doesn't:
//
//  • It tells you who WON'T get it, before you send. The server skips contacts
//    with no email and contacts who unsubscribed; a bulk send that silently
//    reaches 31 of 40 people while reporting success is how a studio learns
//    about its own opt-outs far too late.
//  • It reports the returned stats. The existing single-send awaits the
//    callable and discards `stats`, so a failed send looks identical to a
//    delivered one.

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { TEAMS_COLLECTION, OUTREACH_TEMPLATES_SUBCOLLECTION } from '@linyup/shared'
import type { Contact } from '@linyup/shared'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { AlertCircle, CheckCircle2, Mail, MailX } from 'lucide-react'

interface OutreachTemplateOption {
  id: string
  name: string
  active?: boolean
}

interface OutreachStats {
  total: number
  sent: number
  failed: number
  skipped: number
  skippedByReason: Record<string, number>
  errors: { contactId: string; error: string }[]
}

/** Who can actually be mailed, worked out from the already-loaded contacts. */
export function splitOutreachRecipients(contacts: Contact[]) {
  const mailable: Contact[] = []
  const noEmail: Contact[] = []
  const unsubscribed: Contact[] = []
  for (const c of contacts) {
    if (!c.email) noEmail.push(c)
    else if (c.email_unsubscribed === true) unsubscribed.push(c)
    else mailable.push(c)
  }
  return { mailable, noEmail, unsubscribed }
}

export function BulkOutreachDialog({
  open, onOpenChange, teamId, contacts, onSent,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string | null
  /** The selected contacts, resolved — needed to preview who is reachable. */
  contacts: Contact[]
  onSent?: () => void
}) {
  const t = useTranslations('Contacts')
  const [templateId, setTemplateId] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<OutreachStats | null>(null)

  // One id per user-initiated send: a retry of THIS send dedupes at the ESP,
  // while sending the same template again tomorrow is a new send.
  const [sendId, setSendId] = useState<string>('')

  const { data: templates = [] } = useQuery<OutreachTemplateOption[]>({
    // Same key + active-only filter as the automations builder's picker.
    queryKey: ['outreach_templates', teamId],
    enabled: open && !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(collection(db, TEAMS_COLLECTION, teamId!, OUTREACH_TEMPLATES_SUBCOLLECTION), orderBy('name', 'asc')),
      )
      return snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as { name?: string; active?: boolean }) }) as OutreachTemplateOption)
        .filter((tpl) => tpl.active !== false)
    },
  })

  const { mailable, noEmail, unsubscribed } = useMemo(
    () => splitOutreachRecipients(contacts),
    [contacts],
  )

  function reset() {
    setTemplateId(''); setError(null); setResult(null); setSendId('')
  }

  function handleOpenChange(v: boolean) {
    if (!v) reset()
    onOpenChange(v)
  }

  async function send() {
    if (!templateId || !teamId || !mailable.length || sending) return
    setSending(true)
    setError(null)
    // crypto.randomUUID is available in every browser this app supports.
    const id = sendId || crypto.randomUUID()
    setSendId(id)
    try {
      const fn = httpsCallable<
        { contactIds: string[]; templateId: string; teamId: string; sendId: string },
        { success: boolean; stats: OutreachStats }
      >(functions, 'sendOutreachEmail')
      const res = await fn({
        contactIds: mailable.map((c) => c.id),
        templateId,
        teamId,
        sendId: id,
      })
      setResult(res.data.stats)
      onSent?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const templateName = templates.find((tpl) => tpl.id === templateId)?.name

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            {t('bulkOutreachTitle')}
          </DialogTitle>
        </DialogHeader>

        {result ? (
          // ── Result ────────────────────────────────────────────────────────
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
              {t('outreachResultSent', { count: result.sent })}
            </p>
            {result.skipped > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('outreachResultSkipped', { count: result.skipped })}
              </p>
            )}
            {result.failed > 0 && (
              <p className="flex items-center gap-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {t('outreachResultFailed', { count: result.failed })}
              </p>
            )}
          </div>
        ) : (
          // ── Compose ───────────────────────────────────────────────────────
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('bulkOutreachDesc', { count: contacts.length })}
            </p>

            {templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('outreachNoTemplates')}{' '}
                <Link href={'/settings/emails' as Route} className="text-primary hover:underline">
                  {t('outreachManageTemplates')}
                </Link>
              </p>
            ) : (
              <Select value={templateId} onValueChange={(v) => setTemplateId(v ?? '')}>
                <SelectTrigger className="h-9 w-full text-sm">
                  <span className="flex flex-1 text-left text-sm truncate">
                    {templateName ?? (
                      <span className="text-muted-foreground">{t('outreachPickTemplate')}</span>
                    )}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {templates.map((tpl) => (
                    <SelectItem key={tpl.id} value={tpl.id}>{tpl.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Who is actually reachable — stated before sending, not after. */}
            <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1">
              <p className="flex items-center gap-2 text-sm">
                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                {t('outreachWillReceive', { count: mailable.length })}
              </p>
              {noEmail.length > 0 && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <MailX className="h-3.5 w-3.5 shrink-0" />
                  {t('outreachSkipNoEmail', { count: noEmail.length })}
                </p>
              )}
              {unsubscribed.length > 0 && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <MailX className="h-3.5 w-3.5 shrink-0" />
                  {t('outreachSkipUnsubscribed', { count: unsubscribed.length })}
                </p>
              )}
            </div>

            {mailable.length === 0 && (
              <p className="rounded-md bg-amber-500/10 border border-amber-500/30 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-400">
                {t('outreachNoRecipients')}
              </p>
            )}

            {error && (
              <p className="flex items-center gap-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />{error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {result ? t('outreachDone') : t('cancel')}
          </Button>
          {!result && (
            <Button onClick={send} disabled={!templateId || !mailable.length || sending}>
              {sending ? t('outreachSending') : t('outreachSendTo', { count: mailable.length })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
