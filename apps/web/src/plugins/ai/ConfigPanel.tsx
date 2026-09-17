'use client'

// AI insights' Configure dialog on the studio's settings page: its module
// switches, at STUDIO scope.
//
// Unlike HMD (an org-level install whose switches live on the org plugins page),
// AI insights is installed by a studio, so this dialog is where its modules are
// chosen. When an organisation installed it instead, the studio's card shows no
// Configure control at all — so the org branch below is a fallback, not a path.

import { useTranslations } from 'next-intl'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { BundleModulesPanel } from '@/components/plugins/BundleModulesPanel'
import { AI_PLUGIN_ID } from '@linyup/shared'

export function ConfigPanel() {
  const t = useTranslations('Plugins')
  const { currentTeamId, teamRole } = useAuth()
  const { plugins } = useInstalledPlugins()
  const entry = plugins.find((p) => p.manifest.id === AI_PLUGIN_ID)

  if (!currentTeamId) return null
  if (entry?.source === 'org') {
    return <p className="text-sm text-muted-foreground">{t('bundleModulesOrgManaged')}</p>
  }
  return (
    <BundleModulesPanel
      containerId={AI_PLUGIN_ID}
      scope={{ kind: 'team', teamId: currentTeamId }}
      installation={entry?.installation}
      // The install document is owner-written (firestore.rules installed_plugins).
      canEdit={teamRole === 'owner'}
    />
  )
}
