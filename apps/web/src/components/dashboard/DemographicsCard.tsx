'use client'

/** The demographics half of `ContactsOverviewCard` — see `RosterCard` for why
 *  both survive as wrappers rather than as implementations. */

import { useTranslations } from 'next-intl'
import type { Contact, RankingSystem } from '@linyup/shared'
import { isRosterContact } from '@linyup/shared'
import { ContactsOverviewCard } from '@/components/dashboard/ContactsOverviewCard'

export function DemographicsCard({
  contacts,
  rankingSystems = [],
}: {
  contacts: Contact[]
  rankingSystems?: RankingSystem[]
}) {
  const t = useTranslations('Dashboard')
  const activeCount = contacts.filter(isRosterContact).length
  return (
    <ContactsOverviewCard
      contacts={contacts}
      rankingSystems={rankingSystems}
      groups={['demographics']}
      title={t('demoTitle')}
      subtitle={t('demoSubtitle', { count: activeCount })}
    />
  )
}
