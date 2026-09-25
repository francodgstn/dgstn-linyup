'use client'

// One studio program template, edited on its own — no event required.
// See the header of components/events/program/ProgramTemplateEditor.tsx.

import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import type { Route } from 'next'
import { useRouter } from '@/i18n/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useCapabilities } from '@/hooks/useCapabilities'
import { PageHeader } from '@/components/layout/PageHeader'
import { ProgramTemplateEditor } from '@/components/events/program/ProgramTemplateEditor'

const LIST_HREF = '/settings/program-templates' as Route

export default function ProgramTemplateEditPage() {
  const t = useTranslations('EventProgram')
  const { templateId } = useParams<{ templateId: string }>()
  const { currentTeamId } = useAuth()
  const { can } = useCapabilities()
  const router = useRouter()

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('templateEditTitle')}
        subtitle={t('templateEditSubtitle')}
        back={{ href: LIST_HREF, label: t('templatesBack') }}
      />
      <ProgramTemplateEditor
        scope="team"
        ownerId={currentTeamId}
        templateId={templateId}
        canEdit={can('events.manage')}
        onDone={() => router.push(LIST_HREF)}
      />
    </div>
  )
}
