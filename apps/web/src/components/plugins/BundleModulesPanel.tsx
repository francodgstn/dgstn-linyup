'use client'

// A plugin CONTAINER's module switches — for any container, at either scope.
//
// The container's install document holds the DESIRED module set in
// `config.modules`; a server-side reconciler (`plugins/bundleReconcile.ts`)
// materializes it into ordinary member install documents. So this panel writes
// ONE field on ONE document and never touches a member — which is why the whole
// product downstream can stay bundle-blind.
//
// TWO SCOPES, ONE PANEL. HMD installs at the ORGANISATION, so its switches are
// rendered on the org plugins page (an org-installed plugin shows no Configure
// control on a studio's own settings page, by design). AI insights installs at
// the STUDIO, so its switches are rendered in the studio's Configure dialog. The
// only difference is where the install document hangs — the reconciler already
// takes the same two scopes.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { doc, setDoc } from 'firebase/firestore'
import { toast } from 'sonner'
import { db } from '@/lib/firebase'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  ORGANIZATIONS_COLLECTION,
  ORG_INSTALLED_PLUGINS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  BUNDLE_MODULES_CONFIG_KEY,
  type InstalledPlugin,
} from '@linyup/shared'
import { memberManifestsOf } from '@/plugins/registry'

export type BundleInstallScope = { kind: 'team'; teamId: string } | { kind: 'org'; orgId: string }

function containerDoc(scope: BundleInstallScope, containerId: string) {
  return scope.kind === 'team'
    ? doc(db, TEAMS_COLLECTION, scope.teamId, INSTALLED_PLUGINS_SUBCOLLECTION, containerId)
    : doc(db, ORGANIZATIONS_COLLECTION, scope.orgId, ORG_INSTALLED_PLUGINS_SUBCOLLECTION, containerId)
}

export function BundleModulesPanel({
  containerId,
  scope,
  installation,
  canEdit,
}: {
  containerId: string
  scope: BundleInstallScope
  installation: InstalledPlugin | undefined
  canEdit: boolean
}) {
  const t = useTranslations('Plugins')
  const [busy, setBusy] = useState<string | null>(null)

  const members = memberManifestsOf(containerId)
  const modules = (installation?.config?.[BUNDLE_MODULES_CONFIG_KEY] ?? {}) as Record<string, boolean>

  async function toggle(memberId: string, on: boolean) {
    setBusy(memberId)
    try {
      await setDoc(
        containerDoc(scope, containerId),
        // Merge, so one switch never rewrites the whole map — two admins editing
        // different modules must not clobber each other.
        { config: { [BUNDLE_MODULES_CONFIG_KEY]: { [memberId]: on } } },
        { merge: true },
      )
    } catch (err) {
      console.error('[BundleModulesPanel] toggle failed:', err)
      toast.error(t('bundleModulesError'))
    } finally {
      setBusy(null)
    }
  }

  if (members.length === 0) return null

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">{t('bundleModulesTitle')}</p>
        {/* The reconciler is eventually consistent — a member document appears or
            disappears a beat after the switch moves. Say so rather than letting
            it read as a failed click. */}
        <p className="text-xs text-muted-foreground">{t('bundleModulesHint')}</p>
      </div>
      <div className="space-y-2">
        {members.map((m) => {
          // Absent means ON: a module shipped after this tenant installed the
          // container must reach them without anyone editing their data.
          const on = modules[m.id] !== false
          return (
            <div key={m.id} className="flex items-start gap-3 rounded-md border p-3">
              <div className="flex-1 min-w-0">
                <Label htmlFor={`module-${m.id}`} className="text-sm font-medium">
                  {t(m.nameKey as Parameters<typeof t>[0])}
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t(m.descriptionKey as Parameters<typeof t>[0])}
                </p>
              </div>
              <Switch
                id={`module-${m.id}`}
                checked={on}
                disabled={!canEdit || busy === m.id}
                onCheckedChange={(v) => toggle(m.id, v)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
