'use client'

// WhatsApp plugin — "this month's messages" line (docs/whatsapp-outbound.md →
// "6e"). Meta bills the studio directly; Linyup only counts, from the send log,
// what Meta confirmed and how it priced it. No re-billing, no Linyup metering.

import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { useWhatsAppUsage } from './hooks'

const CATEGORY_KEYS = ['utility', 'marketing', 'service', 'authentication'] as const

export function WhatsAppUsageLine({ teamId }: { teamId: string }) {
  const t = useTranslations('Plugins')
  const usageQ = useWhatsAppUsage(teamId, true)

  if (usageQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('loading')}
      </div>
    )
  }
  if (usageQ.isError || !usageQ.data) return null

  const { byCategory } = usageQ.data
  const total = CATEGORY_KEYS.reduce((sum, k) => sum + (byCategory[k] ?? 0), 0)

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('whatsappUsageTitle')}
      </p>
      {total === 0 ? (
        <p className="text-xs text-muted-foreground">{t('whatsappUsageNone')}</p>
      ) : (
        <ul className="space-y-0.5">
          {CATEGORY_KEYS.filter((k) => (byCategory[k] ?? 0) > 0).map((k) => (
            <li key={k} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {t(`whatsappUsageCategory_${k}` as Parameters<typeof t>[0])}
              </span>
              <span className="font-medium">{byCategory[k]}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t('whatsappUsageBillingNote')}</p>
    </div>
  )
}
