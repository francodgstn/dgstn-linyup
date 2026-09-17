'use client'

// Contact detail — the member's own WhatsApp answer. docs/whatsapp-outbound.md
// → "Opt-in surfaces": booking form, signup form, Space, member app, staff (this
// row) — a STOP reply goes through the webhook. Shown when the plugin is
// installed (staff can record consent even before the studio finishes
// connecting a number) OR the contact already carries an answer, so a later
// uninstall never hides a fact already on file.
//
// Writes go through `setContactWhatsAppConsent` only — `Contact.whatsapp_consent`
// is function-written (firestore.rules denies every client write on it).

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { httpsCallable } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import { MessageCircle } from 'lucide-react'
import {
  whatsappConsentAllows,
  WHATSAPP_PLUGIN_ID,
  type Contact,
  type WhatsAppConsentSource,
} from '@linyup/shared'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

function formatConsentDate(ts: unknown): string {
  const d = (ts as { toDate?: () => Date } | null | undefined)?.toDate?.()
  return d ? d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
}

export function WhatsAppConsentRow({ teamId, contact }: { teamId: string | null; contact: Contact }) {
  const t = useTranslations('Contacts')
  const { isInstalled } = useInstalledPlugins()
  const { can } = useCapabilities()
  const { confirm, confirmDialog } = useConfirm()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<'in' | 'out' | null>(null)

  const installed = isInstalled(WHATSAPP_PLUGIN_ID)
  const consent = contact.whatsapp_consent ?? null

  // Neither installed nor ever answered — nothing to show or manage.
  if (!installed && !consent) return null

  const canManage = can('contacts.manage')
  const optedIn = whatsappConsentAllows(contact)

  async function record(optIn: boolean) {
    if (!teamId) return
    // Opting a member IN is the one direction that needs a beat of friction —
    // it is the studio attesting the member actually agreed, not just tidying
    // a record. Opting out never needs it: it can only narrow who is messaged.
    if (optIn) {
      const ok = await confirm({
        title: t('whatsappConfirmOptInTitle'),
        description: t('whatsappConfirmOptInDesc'),
        confirmLabel: t('whatsappConfirmOptInAction'),
        destructive: false,
      })
      if (!ok) return
    }
    setBusy(optIn ? 'in' : 'out')
    try {
      const fn = httpsCallable<{ teamId: string; contactId: string; optIn: boolean }, { ok: boolean }>(
        functions,
        'setContactWhatsAppConsent'
      )
      await fn({ teamId, contactId: contact.id, optIn })
      await qc.invalidateQueries({ queryKey: ['contact', contact.id] })
    } finally {
      setBusy(null)
    }
  }

  const sourceLabel = (source: WhatsAppConsentSource) => t(`whatsappSource_${source}`)

  return (
    <div className="grid grid-cols-[150px_1fr] gap-2 py-2 border-b last:border-0">
      <span className="text-sm text-muted-foreground flex items-center gap-1">
        <MessageCircle className="h-3.5 w-3.5" />
        {t('whatsappTitle')}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={optedIn ? 'secondary' : 'outline'}
          className={optedIn ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : ''}
        >
          {optedIn ? t('whatsappOptedIn') : consent ? t('whatsappOptedOut') : t('whatsappNotAsked')}
        </Badge>
        {consent && (
          <span className="text-xs text-muted-foreground">
            {formatConsentDate(consent.at)} · {sourceLabel(consent.source)}
          </span>
        )}
        {canManage && (
          <div className="ml-auto flex items-center gap-1">
            {optedIn ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={busy !== null}
                onClick={() => record(false)}
              >
                {t('whatsappMarkOptedOut')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={busy !== null}
                onClick={() => record(true)}
              >
                {t('whatsappMarkOptedIn')}
              </Button>
            )}
          </div>
        )}
      </div>
      {confirmDialog}
    </div>
  )
}
