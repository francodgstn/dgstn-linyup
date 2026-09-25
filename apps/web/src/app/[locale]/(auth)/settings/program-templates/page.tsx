'use client'

import { useTranslations } from 'next-intl'
import { useAuth } from '@/contexts/AuthContext'
import { useCapabilities } from '@/hooks/useCapabilities'
import { PageHeader } from '@/components/layout/PageHeader'
import { ProgramTemplatesManager } from '@/components/events/program/ProgramTemplatesManager'
import type { Team } from '@linyup/shared'

// Reusable event programs for this studio, plus any inherited from the parent
// organization (read-only). Authored EITHER here — "New template" opens the
// standalone editor at ./[templateId] — or on an event via "Save as template".

export default function ProgramTemplatesSettingsPage() {
  const t = useTranslations('EventProgram')
  const { currentTeamId, team } = useAuth()
  const { can } = useCapabilities()

  return (
    <div className="space-y-6">
      <PageHeader title={t('templatesTitle')} subtitle={t('templatesSubtitle')} />
      <ProgramTemplatesManager
        scope="team"
        ownerId={currentTeamId}
        inheritedOrgId={(team as Team & { org_id?: string })?.org_id ?? null}
        canEdit={can('events.manage')}
        basePath="/settings/program-templates"
      />
    </div>
  )
}
