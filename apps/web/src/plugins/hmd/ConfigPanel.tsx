'use client'

// The HMD container's Configure slot on a STUDIO's settings page.
//
// The real module switches are `BundleModulesPanel`
// (components/plugins/BundleModulesPanel.tsx), rendered on the ORG plugins page:
// HMD installs at organization level, and an org-installed plugin shows no
// Configure control on a studio's own settings page (by design — the studio does
// not own the install). The panel lived in this file until 2026-09-16, when the
// AI insights container needed the same switches at studio scope.

import { useTranslations } from 'next-intl'

/**
 * The slot-convention export (`pluginSlot(id, 'ConfigPanel')`), which the STUDIO
 * settings dialog resolves.
 *
 * It deliberately renders an explanation rather than the switches. The container
 * is installed at ORG level, so the real panel needs an `orgId` and the org's
 * install document — neither of which the studio dialog has — and a studio owner
 * is not the person who decides which modules an organization runs.
 *
 * In practice this is unreachable today: an org-managed install shows no
 * Configure control on a studio's settings page at all. It exists so that a
 * direct team-level install of a container degrades into a sentence instead of a
 * failed dynamic import.
 */
export function ConfigPanel() {
  const t = useTranslations('Plugins')
  return <p className="text-sm text-muted-foreground">{t('bundleModulesOrgManaged')}</p>
}
