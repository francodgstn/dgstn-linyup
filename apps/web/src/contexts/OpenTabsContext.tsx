'use client'

// Notion-style "open pages" model backing the desktop tab strip
// (OpenTabsStrip). There is always one ACTIVE tab that follows you as you
// navigate — its href/label update in place, so browsing through ten contacts
// keeps a single tab. Extra tabs are created ONLY by an explicit action:
// the strip's "＋ New tab" button, or ctrl/⌘/middle-click on a row to open it
// in a background tab. Nothing auto-multiplies on navigation.
//
// Tabs are keyed by a stable instance id (NOT the route), so the same page can
// live in two tabs and a tab can change what it points at. State (tabs +
// active tab) lives in localStorage; hydrated after mount to avoid an SSR
// mismatch.
//
// Kept separate from the sidebar's Favorites (NavPinsContext) on purpose: they
// answer different questions — "what am I in the middle of" vs "where do I go
// often". A TAB is the only thing in this app that can be PINNED; the sidebar
// says "always show" instead. Both mechanisms, and why they are not merged, are
// enumerated ONCE in THE NAV-MEMORY CENSUS at the top of
// contexts/NavPinsContext.tsx. Add to that list; never copy it.

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { EntityKind } from '@/lib/tab-routes'
import { normalizeTabPath } from '@/lib/tab-routes'

export interface OpenTab {
  /** Stable instance id (also the dnd id) — independent of the route. */
  tabId: string
  /** Current location this tab points at; may carry ?tab=payments etc. */
  href: string
  label: string
  entityKind?: EntityKind
  /** Protected from Close-others and cap eviction. */
  pinned: boolean
}

const STORAGE_KEY = 'linyup_open_tabs_v2'
const ENABLED_KEY = 'linyup_tabs_enabled'
const MAX_TABS = 15

let seq = 0
function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch {
    /* fall through */
  }
  seq += 1
  return `tab_${seq}_${Math.round(performance.now())}`
}

interface Persisted {
  tabs: OpenTab[]
  activeTabId: string | null
}

function persist(state: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

function readStored(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Persisted
  } catch {
    /* ignore malformed storage */
  }
  return null
}

// Evict the oldest unpinned, non-active tab until under the cap. If everything
// is pinned/active, the list is allowed to exceed the cap.
function enforceCap(tabs: OpenTab[], activeId: string | null): OpenTab[] {
  if (tabs.length <= MAX_TABS) return tabs
  const next = [...tabs]
  while (next.length > MAX_TABS) {
    const idx = next.findIndex((t) => !t.pinned && t.tabId !== activeId)
    if (idx === -1) break
    next.splice(idx, 1)
  }
  return next
}

interface OpenTabsValue {
  tabs: OpenTab[]
  activeTabId: string | null
  /** True once localStorage has been read; the strip waits for this. */
  hydrated: boolean
  /** Per-browser toggle for the whole tab strip (Settings → General). */
  enabled: boolean
  setEnabled: (value: boolean) => void
  /**
   * URL → tab sync (called by the strip on every navigation). If a tab already
   * points at this location, it becomes active (free dedup). Otherwise the
   * active tab follows here in place. With no tabs yet, the first one is
   * created. Never creates a tab for a location that isn't the active tab's.
   */
  reconcileLocation: (href: string, label: string, entityKind?: EntityKind) => void
  /** Entity pages upgrade the active tab's label/precise href once loaded. */
  setActiveMeta: (meta: { href?: string; label: string; entityKind?: EntityKind }) => void
  /** Explicit "＋": open a fresh tab and activate it (strip navigates to href). */
  newTab: (href: string, label: string, entityKind?: EntityKind) => void
  /** ctrl/⌘/middle-click: open in a background tab (no navigation, no switch). */
  openInNewTab: (href: string, label: string, entityKind?: EntityKind) => void
  switchTab: (tabId: string) => void
  closeTab: (tabId: string) => void
  closeOthers: (tabId: string) => void
  pinTab: (tabId: string) => void
  reorderTabs: (from: number, to: number) => void
}

const OpenTabsContext = createContext<OpenTabsValue | null>(null)

export function OpenTabsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Persisted>({ tabs: [], activeTabId: null })
  const [hydrated, setHydrated] = useState(false)
  const [enabled, setEnabledState] = useState(true)

  // Hydrate once from storage. Kept OUT of the state updaters: React StrictMode
  // double-invokes updaters to catch impurity, so a side effect there (seeding,
  // persisting) runs twice and corrupts state. Updaters below are pure; the
  // effects here own the side effects.
  useEffect(() => {
    const stored = readStored()
    if (stored?.tabs?.length) setState({ tabs: stored.tabs, activeTabId: stored.activeTabId })
    try {
      const raw = localStorage.getItem(ENABLED_KEY)
      if (raw != null) setEnabledState(raw === 'true')
    } catch {
      /* ignore */
    }
    setHydrated(true)
  }, [])

  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value)
    try {
      localStorage.setItem(ENABLED_KEY, String(value))
    } catch {
      /* ignore */
    }
  }, [])

  // Persist on change, but only after hydration so the initial empty state never
  // overwrites stored tabs before they're read.
  useEffect(() => {
    if (!hydrated) return
    persist(state)
  }, [state, hydrated])

  const commit = useCallback(
    (updater: (prev: Persisted) => Persisted) => setState(updater),
    []
  )

  const reconcileLocation = useCallback(
    (href: string, label: string, entityKind?: EntityKind) => {
      commit((prev) => {
        const path = normalizeTabPath(href)
        // A tab already at this location → make it active (dedup), don't move anything.
        const match = prev.tabs.find((t) => normalizeTabPath(t.href) === path)
        if (match) {
          return match.tabId === prev.activeTabId
            ? prev
            : { ...prev, activeTabId: match.tabId }
        }
        // No active tab yet (fresh session / closed last tab) → create one.
        const active = prev.tabs.find((t) => t.tabId === prev.activeTabId)
        if (!active) {
          const tab: OpenTab = { tabId: genId(), href, label, entityKind, pinned: false }
          return {
            tabs: enforceCap([...prev.tabs, tab], tab.tabId),
            activeTabId: tab.tabId,
          }
        }
        // The active tab navigated somewhere new → it follows here in place.
        return {
          ...prev,
          tabs: prev.tabs.map((t) =>
            t.tabId === active.tabId ? { ...t, href, label, entityKind } : t
          ),
        }
      })
    },
    [commit]
  )

  const setActiveMeta = useCallback(
    (meta: { href?: string; label: string; entityKind?: EntityKind }) => {
      commit((prev) => {
        const active = prev.tabs.find((t) => t.tabId === prev.activeTabId)
        if (!active) return prev
        // Only upgrade when the active tab is actually on this route.
        if (meta.href && normalizeTabPath(active.href) !== normalizeTabPath(meta.href)) {
          return prev
        }
        const nextHref = meta.href ?? active.href
        const nextKind = meta.entityKind ?? active.entityKind
        if (active.label === meta.label && active.href === nextHref && active.entityKind === nextKind) {
          return prev
        }
        return {
          ...prev,
          tabs: prev.tabs.map((t) =>
            t.tabId === active.tabId
              ? { ...t, label: meta.label, href: nextHref, entityKind: nextKind }
              : t
          ),
        }
      })
    },
    [commit]
  )

  const newTab = useCallback(
    (href: string, label: string, entityKind?: EntityKind) => {
      commit((prev) => {
        const tab: OpenTab = { tabId: genId(), href, label, entityKind, pinned: false }
        return { tabs: enforceCap([...prev.tabs, tab], tab.tabId), activeTabId: tab.tabId }
      })
    },
    [commit]
  )

  const openInNewTab = useCallback(
    (href: string, label: string, entityKind?: EntityKind) => {
      commit((prev) => {
        const path = normalizeTabPath(href)
        // Already open somewhere → don't duplicate.
        if (prev.tabs.some((t) => normalizeTabPath(t.href) === path)) return prev
        const tab: OpenTab = { tabId: genId(), href, label, entityKind, pinned: false }
        return { ...prev, tabs: enforceCap([...prev.tabs, tab], prev.activeTabId) }
      })
    },
    [commit]
  )

  const switchTab = useCallback(
    (tabId: string) => commit((prev) => (prev.activeTabId === tabId ? prev : { ...prev, activeTabId: tabId })),
    [commit]
  )

  const closeTab = useCallback(
    (tabId: string) =>
      commit((prev) => {
        const idx = prev.tabs.findIndex((t) => t.tabId === tabId)
        if (idx === -1) return prev
        const tabs = prev.tabs.filter((t) => t.tabId !== tabId)
        let activeTabId = prev.activeTabId
        if (tabId === prev.activeTabId) {
          const neighbour = prev.tabs[idx + 1] ?? prev.tabs[idx - 1]
          activeTabId = neighbour ? neighbour.tabId : null
        }
        return { tabs, activeTabId }
      }),
    [commit]
  )

  const closeOthers = useCallback(
    (tabId: string) =>
      commit((prev) => ({
        tabs: prev.tabs.filter((t) => t.tabId === tabId || t.pinned),
        activeTabId: tabId,
      })),
    [commit]
  )

  const pinTab = useCallback(
    (tabId: string) =>
      commit((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => (t.tabId === tabId ? { ...t, pinned: !t.pinned } : t)),
      })),
    [commit]
  )

  const reorderTabs = useCallback(
    (from: number, to: number) =>
      commit((prev) => {
        if (from === to || from < 0 || to < 0 || from >= prev.tabs.length || to >= prev.tabs.length) {
          return prev
        }
        const tabs = [...prev.tabs]
        const [moved] = tabs.splice(from, 1)
        tabs.splice(to, 0, moved)
        return { ...prev, tabs }
      }),
    [commit]
  )

  return (
    <OpenTabsContext.Provider
      value={{
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        hydrated,
        enabled,
        setEnabled,
        reconcileLocation,
        setActiveMeta,
        newTab,
        openInNewTab,
        switchTab,
        closeTab,
        closeOthers,
        pinTab,
        reorderTabs,
      }}
    >
      {children}
    </OpenTabsContext.Provider>
  )
}

export function useOpenTabs(): OpenTabsValue {
  const ctx = useContext(OpenTabsContext)
  if (!ctx) throw new Error('useOpenTabs must be used within OpenTabsProvider')
  return ctx
}

/**
 * Called by a detail page to upgrade the ACTIVE tab with a real label (and the
 * precise href, e.g. carrying the current sub-tab) once its entity has loaded.
 * The active tab is the one on this route (a detail page only renders when its
 * route is current), and setActiveMeta guards on that. Pass `enabled: false`
 * while loading to avoid writing a placeholder label.
 */
export function useRegisterTab(reg: {
  href: string
  label: string
  entityKind: EntityKind
  enabled?: boolean
}) {
  const { setActiveMeta } = useOpenTabs()
  const { href, label, entityKind, enabled = true } = reg
  useEffect(() => {
    if (!enabled || !label) return
    setActiveMeta({ href, label, entityKind })
  }, [setActiveMeta, href, label, entityKind, enabled])
}
