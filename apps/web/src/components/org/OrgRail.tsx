'use client'

/**
 * The organization's settings rail — the org-scope twin of `SettingsRail`,
 * drawn by the same `NavRail` so the two are the same object visually.
 *
 * It resolves its own rows, because everything a studio rail resolves differs
 * here: labels come from the `Org` namespace, Affiliations is rendered with the
 * organization's own word for it, the gate is an ORG ROLE rather than a team
 * capability, and there is no pin — the "always show" store is keyed per studio
 * (see THE NAV-MEMORY CENSUS in contexts/NavPinsContext.tsx), so pinning an org
 * destination into a studio's Favorites would file it under whichever studio
 * happened to be current.
 */

import { useLocale, useTranslations } from 'next-intl'
import { usePathname } from '@/i18n/navigation'
import { useOrg } from '@/contexts/OrgContext'
import { ORG_RAIL_GROUPS, ORG_RAIL_ITEMS, orgHref } from '@/lib/org-nav'
import { NavRail, type NavRailGroup } from '@/components/settings/NavRail'
import { sortNavRows } from '@/lib/navSort'

export function OrgRail({ orgId }: { orgId: string }) {
  const t = useTranslations('Org')
  const locale = useLocale()
  const pathname = usePathname()
  const { affiliationTerm, isAdmin } = useOrg()

  const label = (item: (typeof ORG_RAIL_ITEMS)[number]) =>
    item.dynamicLabel === 'affiliationTerm'
      ? affiliationTerm
      : t(item.labelKey as Parameters<typeof t>[0])

  const groups: NavRailGroup[] = ORG_RAIL_GROUPS.map((group) => ({
    key: group.key,
    label: t(group.labelKey as Parameters<typeof t>[0]),
    // ALPHABETICAL WITHIN THE GROUP — the one rule all three navs follow, in
    // `lib/navSort.ts`. No org row is a `lead`: none of them is opened often
    // enough for its position to be load-bearing, which is the only thing that
    // marker is for. Affiliations sorts under the ORGANIZATION'S OWN WORD for
    // it, which is the label actually on screen.
    rows: sortNavRows(
      ORG_RAIL_ITEMS.filter((i) => i.group === group.key)
        // NAVIGATION, NOT ENFORCEMENT. The pages and the rules both check for
        // themselves; hiding a row a member studio could only look at is the same
        // courtesy `SettingsGate.ownerOnly` does on the studio side.
        .filter((i) => !i.adminOnly || isAdmin)
        .map((item) => ({ item, label: label(item) })),
      locale
    ).map(({ item, label: rowLabel }) => {
      const href = orgHref(orgId, item.path)
      return {
        id: item.id,
        href,
        label: rowLabel,
        icon: item.icon,
        // `startsWith`, so a detail route under a rail destination keeps its
        // own row lit rather than lighting none.
        active: pathname === href || pathname.startsWith(`${href}/`),
      }
    }),
  }))

  return (
    <NavRail
      groups={groups}
      searchPlaceholder={t('railSearchPlaceholder')}
      noResultsLabel={t('railNoResults')}
    />
  )
}
