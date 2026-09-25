'use client'

/**
 * WHICH SCOPE AM I STANDING IN, AND WHICH ONE WAS I IN BEFORE.
 *
 * ─── WHY A SCOPE AT ALL ─────────────────────────────────────────────────────
 *
 * Nearly every organization concept collides by name with a studio one: Events,
 * Places, Website, Plugins, Members and Settings all exist at both levels. Two
 * sidebar rows called "Events" never stop being ambiguous, whatever they are
 * labeled — so the org stopped being a section beside the studio and became a
 * place you stand in, with one unmistakable indicator saying which. The cost is
 * a click when moving between the two, which is what the flip below is for.
 * Full reasoning: docs/org-navigation.md.
 *
 * ─── SCOPE IS DERIVED FROM THE URL, NEVER STORED ────────────────────────────
 *
 * `/org/{orgId}/…` is org scope; anything else is the current studio. That is
 * already how the sidebar decided which row to highlight, and it means a link,
 * a bookmark, a refresh and the back button all agree by construction. A stored
 * "current scope" would be a second source of truth that the URL could
 * contradict, and the URL would be right.
 *
 * What IS stored is only the PREVIOUS scope, and only as a convenience.
 *
 * ─── THE FLIP IS BETWEEN TWO; IT DOES NOT CYCLE N ───────────────────────────
 *
 * What makes alt-tab worth having is the instant flip between the last two
 * things — the part everyone finds fiddly is holding a modifier to rotate
 * through a list. With three or more scopes the switcher menu is already the
 * better tool, so this always means "back to the previous one" and never "next
 * in some order".
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from '@/i18n/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useOrgLinks } from '@/hooks/useOrgLinks'

/** A place you can stand. `id` is a team id or an org id. */
export interface Scope {
  kind: 'team' | 'org'
  id: string
  name: string
}

/** Team ids and org ids are both Firestore ids and could in principle collide,
 *  so a scope is keyed by BOTH halves and never by the id alone. */
export function scopeKey(s: { kind: 'team' | 'org'; id: string }): string {
  return `${s.kind}:${s.id}`
}

const STORAGE_KEY = 'linyup_previous_scope'

interface ScopeContextValue {
  /** Where the URL says we are. Null only before auth resolves. */
  current: Scope | null
  /** The scope to flip back to, or null when there is nothing to flip to. */
  previous: Scope | null
  /** Every scope this login can reach, studios first. */
  available: Scope[]
  /** Href that lands in a scope. Team scope lands on the dashboard, because a
   *  team-scoped detail URL does not exist in the scope being entered. */
  hrefFor: (s: Scope) => string
}

const Ctx = createContext<ScopeContextValue>({
  current: null,
  previous: null,
  available: [],
  hrefFor: () => '/dashboard',
})

export function useScope() {
  return useContext(Ctx)
}

/** `/org/{orgId}/…` → the org id. Anything else → null. */
export function orgIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/org\/([^/?#]+)/)?.[1] ?? null
}

function readStored(): { kind: 'team' | 'org'; id: string } | null {
  // Malformed storage reads as "nothing remembered", never as an exception on a
  // nav render — same rule NavPinsContext follows.
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as unknown
    if (!p || typeof p !== 'object') return null
    const { kind, id } = p as { kind?: unknown; id?: unknown }
    if ((kind !== 'team' && kind !== 'org') || typeof id !== 'string' || !id) return null
    return { kind, id }
  } catch {
    return null
  }
}

export function ScopeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { team, currentTeamId } = useAuth()
  const { data: orgs } = useOrgLinks()

  // Hydrated AFTER mount: localStorage does not exist during SSR, and reading it
  // in render would make the first paint differ from the server's.
  const [storedPrevious, setStoredPrevious] = useState<{ kind: 'team' | 'org'; id: string } | null>(null)
  useEffect(() => setStoredPrevious(readStored()), [])

  const available = useMemo<Scope[]>(() => {
    const out: Scope[] = []
    // The studio the login is currently in. The switcher lists the OTHERS (it
    // owns that query); this list is what the flip resolves against, and the
    // current studio is the one it most often flips back to.
    if (currentTeamId) out.push({ kind: 'team', id: currentTeamId, name: team?.name ?? '' })
    for (const o of orgs ?? []) out.push({ kind: 'org', id: o.id, name: o.name })
    return out
  }, [currentTeamId, team?.name, orgs])

  const current = useMemo<Scope | null>(() => {
    const orgId = orgIdFromPath(pathname)
    if (orgId) {
      const known = (orgs ?? []).find((o) => o.id === orgId)
      // An org reached by URL that `useOrgLinks` has not returned yet is still
      // the current scope — the name fills in when the read lands.
      return { kind: 'org', id: orgId, name: known?.name ?? '' }
    }
    if (!currentTeamId) return null
    return { kind: 'team', id: currentTeamId, name: team?.name ?? '' }
  }, [pathname, orgs, currentTeamId, team?.name])

  // Record the scope we are LEAVING, not the one we are in. The ref is what
  // makes that possible without writing on every render.
  const lastScope = useRef<string | null>(null)
  useEffect(() => {
    if (!current) return
    const key = scopeKey(current)
    if (lastScope.current === key) return
    if (lastScope.current !== null) {
      const [kind, id] = lastScope.current.split(':') as ['team' | 'org', string]
      const prev = { kind, id }
      setStoredPrevious(prev)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prev))
      } catch {
        // A viewer with site data blocked simply gets no flip button.
      }
    }
    lastScope.current = key
  }, [current])

  const previous = useMemo<Scope | null>(() => {
    if (!storedPrevious || !current) return null
    // Never offer to flip to where we already are.
    if (scopeKey(storedPrevious) === scopeKey(current)) return null
    // A REMEMBERED SCOPE CAN STOP BEING REACHABLE — the studio was left, the org
    // membership revoked. Resolve it against what this login can reach NOW and
    // drop it silently rather than navigating somebody into a permission error.
    return available.find((s) => scopeKey(s) === scopeKey(storedPrevious)) ?? null
  }, [storedPrevious, current, available])

  // THE SCOPE ROOT, not a page inside it. Where an organization opens depends on
  // whether you run it or merely belong to one of its studios, and `/org/{id}`
  // is the one place that decides (see that route). Naming `/teams` here dropped
  // a member studio on the roster their own membership cannot list — the exact
  // "No teams have joined this organization yet" failure the overview exists to
  // prevent. `TeamSwitcher` already links to the root; Alt+O did not.
  const hrefFor = useCallback((s: Scope) => (s.kind === 'org' ? `/org/${s.id}` : '/dashboard'), [])

  const value = useMemo<ScopeContextValue>(
    () => ({ current, previous, available, hrefFor }),
    [current, previous, available, hrefFor],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
