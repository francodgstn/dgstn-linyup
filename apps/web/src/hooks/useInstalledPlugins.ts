'use client'

import { useEffect, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import {
  TEAMS_COLLECTION,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  ORGANIZATIONS_COLLECTION,
  ORG_INSTALLED_PLUGINS_SUBCOLLECTION,
} from '@linyup/shared'
import type { InstalledPlugin, PluginId, PluginManifest } from '@linyup/shared'
import { PLUGIN_REGISTRY } from '@/plugins/registry'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InstalledPluginEntry {
  manifest: PluginManifest
  installation: InstalledPlugin
  /** Whether this plugin was installed at the org level (managed by the org admin). */
  source: 'org' | 'team'
}

export interface UseInstalledPluginsResult {
  /** Only plugins that are installed and active */
  plugins: InstalledPluginEntry[]
  isInstalled: (id: PluginId) => boolean
  getConfig: (id: PluginId) => Record<string, unknown> | undefined
  isLoading: boolean
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Real-time subscription to a team's installed plugins, merged with any plugins
 * installed at the org level (when the team belongs to an organization).
 *
 * AN ORG INSTALL DELIBERATELY CONFERS THE FEATURE, and there is no second
 * plan check here on purpose (UX-35). The organization is the payer: joining one
 * sets `teams/{id}.plan = 'organization'` in the same write that sets `org_id`
 * (acceptOrgInvitation), and `pluginAccessForPlan` includes every plugin at that
 * tier — so the receiving team's own plan already says yes, and re-asking would
 * only introduce a way for the two answers to differ. `org_id` IS the grant.
 *
 * That invariant — org_id ⇒ plan 'organization' — is the thing to protect. It
 * was broken once, by the trial sweep downgrading a member studio for its
 * ORG's trial status; the fix belongs where the invariant is broken, never in a
 * second gate here that would silently strip a paying org's studios of their
 * features whenever plan propagation lagged by a webhook.
 *
 * - Subscribes to `teams/{teamId}/installed_plugins` (always).
 * - Also subscribes to `organizations/{orgId}/installed_plugins` when the team
 *   has an `org_id` field. Org plugins are shown as active for all sub-studios.
 * - If both org and team have an entry for the same plugin, the TEAM entry wins
 *   (preserves any team-specific config).
 * - `source` on each entry lets the UI distinguish org-managed plugins.
 */
export function useInstalledPlugins(): UseInstalledPluginsResult {
  const { currentTeamId, team } = useAuth()
  const orgId = (team as { org_id?: string } | null)?.org_id ?? null

  const [teamInstallations, setTeamInstallations] = useState<InstalledPlugin[]>([])
  const [orgInstallations, setOrgInstallations] = useState<InstalledPlugin[]>([])
  const [teamLoading, setTeamLoading] = useState(true)
  const [orgLoading, setOrgLoading] = useState(true)

  // ── Team subscription ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!currentTeamId) {
      setTeamInstallations([])
      setTeamLoading(false)
      return
    }

    const colRef = collection(db, TEAMS_COLLECTION, currentTeamId, INSTALLED_PLUGINS_SUBCOLLECTION)

    const unsubscribe = onSnapshot(
      colRef,
      (snap) => {
        const docs = snap.docs.map((d) => ({ pluginId: d.id, ...d.data() } as InstalledPlugin))
        setTeamInstallations(docs)
        setTeamLoading(false)
      },
      (err) => {
        console.error('[useInstalledPlugins] team snapshot error:', err)
        setTeamLoading(false)
      }
    )

    return unsubscribe
  }, [currentTeamId])

  // ── Org subscription (only when the team belongs to an org) ───────────────
  useEffect(() => {
    if (!orgId) {
      setOrgInstallations([])
      setOrgLoading(false)
      return
    }

    const colRef = collection(
      db,
      ORGANIZATIONS_COLLECTION,
      orgId,
      ORG_INSTALLED_PLUGINS_SUBCOLLECTION
    )

    const unsubscribe = onSnapshot(
      colRef,
      (snap) => {
        const docs = snap.docs.map((d) => ({ pluginId: d.id, ...d.data() } as InstalledPlugin))
        setOrgInstallations(docs)
        setOrgLoading(false)
      },
      (err) => {
        console.error('[useInstalledPlugins] org snapshot error:', err)
        setOrgLoading(false)
      }
    )

    return unsubscribe
  }, [orgId])

  const isLoading = teamLoading || (orgId !== null && orgLoading)

  // ── Merge: team entry takes priority over org entry for the same pluginId ──
  const activeTeam = teamInstallations.filter((i) => i.status === 'active')
  const activeOrg = orgInstallations.filter((i) => i.status === 'active')

  const teamPluginIds = new Set(activeTeam.map((i) => i.pluginId))

  // Org entries that don't have a team-level override
  const orgOnly = activeOrg.filter((i) => !teamPluginIds.has(i.pluginId))

  // Combined list: team entries first, then org-only
  const allActive: Array<{ installation: InstalledPlugin; source: 'org' | 'team' }> = [
    ...activeTeam.map((installation) => ({ installation, source: 'team' as const })),
    ...orgOnly.map((installation) => ({ installation, source: 'org' as const })),
  ]

  const plugins: InstalledPluginEntry[] = allActive
    .map(({ installation, source }) => {
      const manifest = PLUGIN_REGISTRY.find((m) => m.id === installation.pluginId)
      if (!manifest) return null
      return { manifest, installation, source }
    })
    .filter((e): e is InstalledPluginEntry => e !== null)

  const isInstalled = (id: PluginId) =>
    allActive.some((e) => e.installation.pluginId === id)

  const getConfig = (id: PluginId) =>
    allActive.find((e) => e.installation.pluginId === id)?.installation.config

  return { plugins, isInstalled, getConfig, isLoading }
}
