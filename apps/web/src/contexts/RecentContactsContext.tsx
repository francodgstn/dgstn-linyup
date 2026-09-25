'use client'

/**
 * RECENTLY VIEWED CONTACTS — the fourth nav-memory mechanism.
 *
 * THE CENSUS OF ALL FOUR IS OWNED BY `contexts/NavPinsContext.tsx`'s header.
 * Read it before touching this file, and add there rather than starting a
 * second list. In one line, this one is: the PEOPLE you just had open, newest
 * first, shown ONLY in the sidebar search panel before anything is typed.
 *
 * WHY IT IS NOT ANY OF THE OTHER THREE:
 *  · Favorites' recent half is a rolling history of NAV DESTINATIONS (pages),
 *    keyed by nav id. It answers "where do I go often". A person is not a
 *    destination in that catalog and never enters it — `/contacts/123`
 *    records the "contacts" PAGE there, which is exactly the wrong answer to
 *    "who was I just looking at".
 *  · Open tabs answers "what am I in the middle of", and cannot answer this at
 *    all: `reconcileLocation` rewrites the active tab IN PLACE, so browsing ten
 *    contacts leaves one tab and no history — and the strip is a per-browser
 *    setting, so with it switched off it records nothing whatsoever.
 *  · Saved filters are not destinations, they are stored ContactFilters.
 *
 * VOCABULARY RULE, since "recent" is a word this app already spends: nothing
 * here is called `recent*` bare. It is `recentContact*` / RECENT_CONTACTS_* in
 * code and "recently viewed contacts" on screen, always with the noun.
 *
 * IDS ONLY, NEVER NAMES. A stored name is wrong the moment somebody is renamed,
 * and every other client store here keeps ids. The panel resolves them against
 * the roster it already reads (`useActiveContacts` / `useArchivedContacts`), so
 * a name is never stale and an ARCHIVED person still resolves — and carries the
 * same amber badge the search results give them.
 *
 * AN ID THAT NO LONGER RESOLVES IS SIMPLY NOT RENDERED (the panel drops it), and
 * this store does NOT prune on that: "not in the roster" also means "the roster
 * has not loaded yet", so pruning on it would quietly eat the list on every cold
 * open. A deleted contact therefore costs one dormant string until it falls off
 * the end of the list, and never a blank row.
 *
 * SCOPED PER TEAM. The stored shape is `{ [teamId]: contactId[] }` — not one
 * flat list — so switching teams shows that team's people and never the
 * previous team's, and switching BACK does not start from nothing. The write
 * carries the contact's OWN `teamId` (authoritative, from the loaded document)
 * while the read uses `currentTeamId`, so an org admin looking at another team's
 * contact records it under that team and it cannot surface in this one.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'

/** Stable identity so "this team has no history" does not re-render the sidebar. */
const NO_IDS: string[] = []

const STORAGE_KEY = 'linyup_recent_contacts'
/** Ids kept per team. Short on purpose: this is "who was I just looking at". */
const RECENT_CONTACTS_MAX = 8
/** Teams kept, most-recently-written first — bounds the key for good. */
const RECENT_CONTACTS_TEAMS_MAX = 8

type Store = Record<string, string[]>

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Store = {}
    for (const [teamId, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) out[teamId] = ids.filter((id): id is string => typeof id === 'string')
    }
    return out
  } catch {
    return {}
  }
}

function persist(store: Store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    /* ignore (private mode, quota) */
  }
}

/** In-memory wins per team — it is the newer of the two by construction. */
function mergeStores(memory: Store, stored: Store): Store {
  const merged: Store = { ...stored }
  for (const [teamId, ids] of Object.entries(memory)) {
    merged[teamId] = Array.from(new Set([...ids, ...(stored[teamId] ?? [])])).slice(
      0,
      RECENT_CONTACTS_MAX
    )
  }
  return merged
}

interface RecentContactsValue {
  /** Contact ids for the CURRENT team, newest first. May contain ids that no longer resolve. */
  recentContactIds: string[]
  /** Record that a contact's detail page was opened. Pass the contact's own teamId. */
  recordContactVisit: (contactId: string, teamId: string) => void
}

const RecentContactsContext = createContext<RecentContactsValue | null>(null)

export function RecentContactsProvider({ children }: { children: React.ReactNode }) {
  const { currentTeamId } = useAuth()
  // Starts empty and hydrates after mount — localStorage does not exist during SSR.
  const [store, setStore] = useState<Store>({})
  // Effects fire child-first, so the contact page can record a visit BEFORE the
  // hydration effect below has run. Until it has, the writer reads storage
  // itself and merges, so the first visit of a session never clobbers history.
  const hydrated = useRef(false)

  useEffect(() => {
    const stored = readStore()
    // Anything recorded before this ran was already persisted by the writer's
    // own read-through, so merging in-memory-first only re-states what is on disk.
    setStore((prev) => mergeStores(prev, stored))
    hydrated.current = true
  }, [])

  const recordContactVisit = useCallback((contactId: string, teamId: string) => {
    if (!contactId || !teamId) return
    setStore((prev) => {
      const base = hydrated.current ? prev : mergeStores(prev, readStore())
      const current = base[teamId] ?? []
      if (base === prev && current[0] === contactId) return prev
      const ids = [contactId, ...current.filter((id) => id !== contactId)].slice(
        0,
        RECENT_CONTACTS_MAX
      )
      // Current team first, then the other teams in their existing order, capped
      // — an LRU by write, so the key cannot grow without bound.
      const others = Object.entries(base).filter(([id]) => id !== teamId)
      const next: Store = { [teamId]: ids }
      for (const [otherTeamId, otherIds] of others.slice(0, RECENT_CONTACTS_TEAMS_MAX - 1))
        next[otherTeamId] = otherIds
      persist(next)
      return next
    })
  }, [])

  const recentContactIds = (currentTeamId ? store[currentTeamId] : undefined) ?? NO_IDS

  const value = useMemo(
    () => ({ recentContactIds, recordContactVisit }),
    [recentContactIds, recordContactVisit]
  )

  return <RecentContactsContext.Provider value={value}>{children}</RecentContactsContext.Provider>
}

// Not every tree mounts the provider (public surfaces do not); a no-op keeps a
// record call harmless there rather than throwing. A CONSTANT, not a fresh
// object per call: a new identity every render would re-fire the caller's effect
// on every render for the rest of the page's life.
const NO_PROVIDER: RecentContactsValue = { recentContactIds: NO_IDS, recordContactVisit: () => {} }

export function useRecentContacts(): RecentContactsValue {
  return useContext(RecentContactsContext) ?? NO_PROVIDER
}
