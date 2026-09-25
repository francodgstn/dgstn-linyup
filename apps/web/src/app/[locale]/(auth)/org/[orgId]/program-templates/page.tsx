'use client'

import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import { useOrg } from '@/contexts/OrgContext'
import { PageHeader } from '@/components/layout/PageHeader'
import { ProgramTemplatesManager } from '@/components/events/program/ProgramTemplatesManager'

// Org-wide program templates: the federation authors the standard camp or
// competition program once and every member studio can apply it. Only an org
// admin can change them (enforced in firestore.rules, not just here).

export default function OrgProgramTemplatesPage() {
  const t = useTranslations('EventProgram')
  const { orgId } = useParams<{ orgId: string }>()
  const { isAdmin } = useOrg()

  return (
    <div className="space-y-6">
      <PageHeader title={t('templatesTitle')} subtitle={t('templatesOrgSubtitle')} />
      <ProgramTemplatesManager
        scope="org"
        ownerId={orgId}
        canEdit={isAdmin}
        basePath={`/org/${orgId}/program-templates`}
      />
    </div>
  )
}
