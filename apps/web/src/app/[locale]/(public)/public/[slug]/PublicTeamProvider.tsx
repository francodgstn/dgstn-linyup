'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { collectionGroup, query, where, limit, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { reviveTimestamps } from '@/lib/restTimestamps'
import type { TeamPublicProfile } from '@linyup/shared'
import { PUBLIC_PROFILE_SUBCOLLECTION } from '@linyup/shared'

// Resolved team public_profile summary (world-readable). Carries the bio-link
// fields plus the routing fields (`default_public_surface`, `active_public_surfaces`).
export type PublicTeamData = TeamPublicProfile

interface PublicTeamContextValue {
  slug: string
  teamId: string
  team: PublicTeamData
}

const PublicTeamContext = createContext<PublicTeamContextValue | null>(null)

// Consumed by every team-root surface (bio-link, booking, signup, contact-update,
// appointments, space, …) instead of each one re-querying public_profile itself.
export function usePublicTeam() {
  const ctx = useContext(PublicTeamContext)
  if (!ctx) throw new Error('usePublicTeam must be used within PublicTeamProvider')
  return ctx
}

type Status = 'loading' | 'found' | 'notfound'

interface Props {
  slug: string
  children: ReactNode
  /**
   * Server-resolved team (Firestore REST, `layout.tsx` → `fetchPublicTeam`) —
   * present on first render lets the whole `/public/{slug}/…` subtree render in
   * the SERVER HTML instead of a client-only spinner. Absent when the REST read
   * failed (or came back empty for a stale/unpublished tenant) — the provider
   * then falls back to exactly today's client-side query, unchanged.
   */
  initial?: { teamId: string; team: PublicTeamData }
}

// Resolves the team ONCE by slug — server-side when `initial` is provided
// (the common case), else CLIENT-SIDE (the Firebase client SDK must not be
// used for server-side reads — see CLAUDE.md) — and provides it to the whole
// `/public/{slug}/…` subtree. Centralises the loading / not-found states so the
// individual surfaces don't each duplicate them.
export function PublicTeamProvider({ slug, children, initial }: Props) {
  const [status, setStatus] = useState<Status>(initial ? 'found' : 'loading')
  const [teamId, setTeamId] = useState<string | null>(initial?.teamId ?? null)
  const [team, setTeam] = useState<PublicTeamData | null>(
    initial ? reviveTimestamps(initial.team) : null
  )

  useEffect(() => {
    if (initial) return // already resolved server-side — nothing to fetch
    let cancelled = false
    setStatus('loading')
    const q = query(
      collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
      where('slug', '==', slug),
      where('type', '==', 'team'),
      limit(1)
    )
    getDocs(q)
      .then((snap) => {
        if (cancelled) return
        if (snap.empty) {
          setStatus('notfound')
          return
        }
        const docSnap = snap.docs[0]
        setTeamId(docSnap.ref.parent.parent?.id ?? null)
        setTeam(docSnap.data() as PublicTeamData)
        setStatus('found')
      })
      .catch((err: unknown) => {
        // 'notfound' is the right SCREEN — there is nothing to render either way
        // — but it is the wrong DIAGNOSIS: a rules or index regression on this
        // lookup takes down every public surface of every tenant and looks
        // exactly like a mistyped slug. Log it so it is at least findable.
        reportPublicLoadFailure('team/resolve-slug', err)
        if (!cancelled) setStatus('notfound')
      })
    return () => {
      cancelled = true
    }
    // `initial` is read only to decide whether to skip the fetch — it is a
    // one-shot value for this mount (see the note above), not something a
    // later prop change is expected to react to here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  if (status === 'notfound' || !team || !teamId) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center px-4">
        <p className="text-lg font-semibold">Team not found</p>
        <p className="text-sm text-muted-foreground">No team exists at this URL.</p>
      </div>
    )
  }

  return (
    <PublicTeamContext.Provider value={{ slug, teamId, team }}>
      {children}
    </PublicTeamContext.Provider>
  )
}
