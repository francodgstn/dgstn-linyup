'use client'

// One organization-wide program template, edited on its own. The federation
// authors the standard camp agenda once; every member studio applies it.
// See the header of components/events/program/ProgramTemplateEditor.tsx.

import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import type { Route } from 'next'
import { useRouter } from '@/i18n/navigation'
import { useOrg } from '@/contexts/OrgContext'
import { PageHeader } from '@/components/layout/PageHeader'
import { ProgramTemplateEditor } from '@/components/events/program/ProgramTemplateEditor'

export default function OrgProgramTemplateEditPage() {
  const t = useTranslations('EventProgram')
  const { orgId, templateId } = useParams<{ orgId: string; templateId: string }>()
  const { isAdmin } = useOrg()
  const router = useRouter()
  const listHref = `/org/${orgId}/program-templates` as Route

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('templateEditTitle')}
        subtitle={t('templateEditSubtitle')}
        back={{ href: listHref, label: t('templatesBack') }}
      />
      <ProgramTemplateEditor
        scope="org"
        ownerId={orgId}
        templateId={templateId}
        canEdit={isAdmin}
        onDone={() => router.push(listHref)}
      />
    </div>
  )
}
