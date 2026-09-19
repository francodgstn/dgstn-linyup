'use client'

// Contact detail — the member's own WhatsApp answers. docs/whatsapp-outbound.md
// → "Opt-in surfaces" / "6a": booking form, signup form, Space, member app,
// staff (this row) — a STOP reply goes through the webhook. TWO independent
// answers, reminders and news-and-offers, each with its own status/date/source
// and its own staff control — a STOP ends both, Meta's own "stop promotions"
// failure ends marketing alone. Shown when the plugin is installed (staff can
// record consent even before the studio finishes connecting a number) OR the
// contact already carries an answer on either question, so a later uninstall
// never hides a fact already on file.
//
// Writes go through `setContactWhatsAppConsent` only — both consent fields are
// function-written (firestore.rules denies every client write on them).

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { MessageCircle } from 'lucide-react'
import {
  whatsappConsentAllows,
  WHATSAPP_PLUGIN_ID,
  type Contact,
  type WhatsAppConsent,
  type WhatsAppConsentKind,
  type WhatsAppConsentSource,
} from '@linyup/shared'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { callFunction } from '@/lib/callFunction'

function formatConsentDate(ts: unknown): string {
  const d = (ts as { toDate?: () => Date } | null | undefined)?.toDate?.()
  return d ? d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
}

export function WhatsAppConsentRow({ teamId, contact }: { teamId: string | null; contact: Contact }) {
  const { isInstalled } = useInstalledPlugins()
  const installed = isInstalled(WHATSAPP_PLUGIN_ID)
  const hasEitherAnswer = !!contact.whatsapp_consent || !!contact.whatsapp_marketing_consent

  // Neither installed nor ever answered — nothing to show or manage.
  if (!installed && !hasEitherAnswer) return null

  return (
    <>
      <WhatsAppConsentKindRow
        teamId={teamId}
        contact={contact}
        kind="reminders"
        consent={contact.whatsapp_consent ?? null}
      />
      <WhatsAppConsentKindRow
        teamId={teamId}
        contact={contact}
        kind="marketing"
        consent={contact.whatsapp_marketing_consent ?? null}
      />
    </>
  )
}

function WhatsAppConsentKindRow({
  teamId,
  contact,
  kind,
  consent,
}: {
  teamId: string | null
  contact: Contact
  kind: WhatsAppConsentKind
  consent: WhatsAppConsent | null
}) {
  const t = useTranslations('Contacts')
  const { can } = useCapabilities()
  const { confirm, confirmDialog } = useConfirm()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<'in' | 'out' | null>(null)

  const canManage = can('contacts.manage')
  const optedIn = whatsappConsentAllows(contact, kind)

  async function record(optIn: boolean) {
    if (!teamId) return
    // Opting a member IN is the one direction that needs a beat of friction —
    // it is the studio attesting the member actually agreed, not just tidying
    // a record. Opting out never needs it: it can only narrow who is messaged.
    if (optIn) {
      const ok = await confirm({
        title: t('whatsappConfirmOptInTitle'),
        description:
          kind === 'marketing' ? t('whatsappConfirmMarketingOptInDesc') : t('whatsappConfirmOptInDesc'),
        confirmLabel: t('whatsappConfirmOptInAction'),
        destructive: false,
      })
      if (!ok) return
    }
    setBusy(optIn ? 'in' : 'out')
    try {
      const fn = callFunction<
        { teamId: string; contactId: string; optIn: boolean; kind: WhatsAppConsentKind },
        { ok: boolean }
      >('setContactWhatsAppConsent')
      await fn({ teamId, contactId: contact.id, optIn, kind })
      await qc.invalidateQueries({ queryKey: ['contact', contact.id] })
    } finally {
      setBusy(null)
    }
  }

  const sourceLabel = (source: WhatsAppConsentSource) => t(`whatsappSource_${source}`)
  const title = kind === 'marketing' ? t('whatsappMarketingTitle') : t('whatsappRemindersRowTitle')

  return (
    <div className="grid grid-cols-[150px_1fr] gap-2 py-2 border-b last:border-0">
      <span className="text-sm text-muted-foreground flex items-center gap-1">
        <MessageCircle className="h-3.5 w-3.5" />
        {title}
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
