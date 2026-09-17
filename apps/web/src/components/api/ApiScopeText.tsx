'use client'

// How an API scope reads to a person — one wording for the key dialog on
// Settings → API keys and the OAuth consent page, so the owner creating a key
// and the member connecting Claude are told the same thing. Written out per
// scope so every message key is a literal the i18n check can see.

import { useTranslations } from 'next-intl'
import type { ApiScope } from '@linyup/shared'

export function ApiScopeName({ scope }: { scope: ApiScope }) {
  const t = useTranslations('ApiKeys')
  switch (scope) {
    case 'contacts:read':
      return <>{t('scopeContacts')}</>
    case 'contacts:read:pii':
      return <>{t('scopeContactsPii')}</>
    case 'schedule:read':
      return <>{t('scopeSchedule')}</>
    case 'offerings:read':
      return <>{t('scopeOfferings')}</>
    case 'subscriptions:read':
      return <>{t('scopeSubscriptions')}</>
    case 'reports:read':
      return <>{t('scopeReports')}</>
    case 'finance:read':
      return <>{t('scopeFinance')}</>
  }
}

export function ApiScopeHint({ scope }: { scope: ApiScope }) {
  const t = useTranslations('ApiKeys')
  switch (scope) {
    case 'contacts:read':
      return <>{t('scopeContactsHint')}</>
    case 'contacts:read:pii':
      return <>{t('scopeContactsPiiHint')}</>
    case 'schedule:read':
      return <>{t('scopeScheduleHint')}</>
    case 'offerings:read':
      return <>{t('scopeOfferingsHint')}</>
    case 'subscriptions:read':
      return <>{t('scopeSubscriptionsHint')}</>
    case 'reports:read':
      return <>{t('scopeReportsHint')}</>
    case 'finance:read':
      return <>{t('scopeFinanceHint')}</>
  }
}
