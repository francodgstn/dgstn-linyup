'use client'

// The settings rail — a searchable, grouped vertical tab list shared by the whole
// /settings/* area via the settings layout. Highlights the active destination
// (matching path + ?tab= for the team sub-sections) and carries the "always show"
// toggle that adds/removes an item from the sidebar's Favourites group (vocabulary:
// THE NAV-MEMORY CENSUS in contexts/NavPinsContext.tsx). On desktop it sits beside
// the detail pane; on mobile it IS the /settings index list.

import { useLocale, useMessages, useTranslations } from 'next-intl'
import { usePathname } from '@/i18n/navigation'
import { useSearchParams } from 'next/navigation'
import { Star } from 'lucide-react'
import { SETTINGS_ITEMS, SETTINGS_GROUPS } from '@/lib/settings-nav'
import { sortNavRows } from '@/lib/navSort'
import { useNavPins } from '@/contexts/NavPinsContext'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { NavRail, type NavRailGroup } from './NavRail'
import { Tip } from '@/components/ui/tip'

export function SettingsRail() {
  const t = useTranslations('Nav')
  const locale = useLocale()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const currentTab = searchParams.get('tab')
  const { can } = useCapabilities()
  // Same derivation the team-settings page makes — the owner-only surfaces are
  // the ones this capability names.
  const canEdit = can('team.settings')
  const { isInstalled } = useInstalledPlugins()
  const { isAlwaysShown, toggleAlwaysShown } = useNavPins()

  const labelOf = (key: string) => t(key as Parameters<typeof t>[0])

  // THE SAME KEYWORD INDEX THE GLOBAL SEARCH USES (`Nav.searchKeywords`, keyed by
  // the item's id — see the catalogue built in (auth)/layout.tsx).
  //
  // This box used to match the visible LABEL and nothing else, which made it
  // strictly worse than the global search it sits next to: typing "stripe",
  // "leaderboard" or "permissions" produced "No settings match your search" —
  // a confident FALSE NEGATIVE, on a rail where every row was already on screen
  // to be scanned. A search that answers "it isn't here" about a page that is
  // here teaches the reader the setting does not exist, so the box was worth
  // either fixing or removing. Read through `useMessages` rather than `t()` so
  // an id with no keywords is simply label-only instead of a missing-key error.
  const messages = useMessages() as unknown as {
    Nav?: { searchKeywords?: Record<string, string> }
  }
  const keywordsOf = (id: string) => messages.Nav?.searchKeywords?.[id] ?? ''
  // Hide plugin/role-gated items when their condition doesn't hold. Searching is
  // NavRail's job — it matches the label and these keywords together.
  const gateOk = (item: (typeof SETTINGS_ITEMS)[number]) => {
    if (item.gate === 'ownerOnly') return canEdit
    if (item.gate === 'customFields') return isInstalled('custom-fields')
    return true
  }

  // Active when the path matches and ?tab= matches — team sub-sections share the
  // /settings/team path and differ only by tab.
  const isActive = (href: string) => {
    const [path, qs] = href.split('?')
    if (pathname !== path) return false
    const tab = qs ? new URLSearchParams(qs).get('tab') : null
    return tab == null ? currentTab == null : currentTab === tab
  }

  // Rows are RESOLVED here — label, gate, active state and the pin — and drawn
  // by NavRail, which the org rail shares so the two cannot drift apart
  // visually. Everything above this line is what makes a STUDIO rail a studio
  // rail, and none of it is meaningful on an org row.
  const railGroups: NavRailGroup[] = SETTINGS_GROUPS.map((group) => ({
    key: group.key,
    label: labelOf(group.labelKey),
    // ALPHABETICAL WITHIN THE GROUP, leads first — the same rule the sidebar's
    // sections follow, written down once in `lib/navSort.ts`. Sorted on the
    // RESOLVED label, so it is alphabetical in the language actually on screen.
    rows: sortNavRows(
      SETTINGS_ITEMS.filter((i) => i.group === group.key && gateOk(i)).map((item) => ({
        item,
        label: labelOf(item.labelKey),
        lead: item.lead,
      })),
      locale
    ).map(({ item, label }) => {
      const shown = isAlwaysShown(item.id)
      return {
        id: item.id,
        href: item.href,
        label,
        icon: item.icon,
        active: isActive(item.href),
        keywords: keywordsOf(item.id),
        trailing: (
          <Tip label={shown ? t('shortcutStopAlwaysShowing') : t('shortcutAlwaysShow')}>
            <button
              type="button"
              onClick={() => toggleAlwaysShown(item.id)}
              aria-label={shown ? t('shortcutStopAlwaysShowing') : t('shortcutAlwaysShow')}
              aria-pressed={shown}
              className={`absolute right-1 rounded-md p-1 transition-all ${
                shown
                  ? 'text-primary opacity-100'
                  : 'text-muted-foreground/40 opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100'
              }`}
            >
              {/* A star, matching the "always show in Favourites" toggle in the
                  main sidebar (ShortcutButton, app/[locale]/(auth)/layout.tsx) —
                  the two must never drift, since both read/write the same
                  `useNavPins` state.

                  THE LAST STAR COLLISION IS GONE (2026-09-20). This rail used to
                  be drawn beside the marketplace, whose cards carry their OWN
                  amber "recommended" star — a different object (a manifest flag
                  we set, not a personal choice) wearing the same glyph on one
                  screen. It was out of scope for the 2026-08-29 rename (UX-84),
                  which only moved the SIDEBAR's version of that clash (nav
                  favourite vs. nav plugin-suggestion) onto a puzzle piece. The
                  marketplace is now a full page at /plugins with no rail on it,
                  so the two never share a screen and neither had to move. */}
              <Star className={`h-3.5 w-3.5 ${shown ? 'fill-current' : ''}`} />
            </button>
          </Tip>
        ),
      }
    }),
  }))

  return (
    <NavRail
      groups={railGroups}
      searchPlaceholder={t('settingsSearchPlaceholder')}
      noResultsLabel={t('settingsNoResults')}
    />
  )
}
