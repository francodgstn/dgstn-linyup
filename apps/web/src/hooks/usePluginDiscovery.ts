'use client'

import { useCallback } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { pluginVisibleToTenant } from '@linyup/shared'
import type { PluginManifest } from '@linyup/shared'

/**
 * Resolves the current tenant once and hands back the DISCOVERY predicate every
 * plugin catalog filters on. A plugin with no `audience` is public; one with
 * an audience is visible only to the teams it names and to every team belonging
 * to an organization it names.
 *
 * The org half comes from `team.org_id` — the same field `useInstalledPlugins`
 * reads to merge org-level installs, so "which org am I in" is answered from one
 * place on both the discovery and the install side.
 *
 * `canDiscover` is about FINDING a plugin, never about running one. Call sites
 * that show an INSTALLED plugin must OR this with their install check (see the
 * marketplace at `/plugins`), so a tenant dropped from an allow-list keeps the
 * card for the thing it is still running.
 */
export function usePluginDiscovery(): {
  canDiscover: (manifest: Pick<PluginManifest, 'audience'>) => boolean
} {
  const { currentTeamId, team } = useAuth()
  const orgId = (team as { org_id?: string } | null)?.org_id ?? null

  const canDiscover = useCallback(
    (manifest: Pick<PluginManifest, 'audience'>) =>
      pluginVisibleToTenant(manifest, { teamId: currentTeamId, orgId }),
    [currentTeamId, orgId],
  )

  return { canDiscover }
}
