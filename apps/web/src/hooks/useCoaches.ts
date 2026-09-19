'use client'

// Coaches — the team's roster for assigning an instructor to a session. The
// roster is the set of team members flagged as coaches (per-member `isCoach`, the
// same source as the /coaches page) — any role, since owners/managers can coach
// too. Reads go through the `listTeamMembers` callable because member display
// names live on users/{uid}, which Firestore rules deny reading cross-user
// client-side.
//
// Fallback: if every member has opted out of the roster, return all of them as
// `pickable`, so a solo owner/manager can still be assigned.

import { useQuery } from '@tanstack/react-query'
import { callFunction } from '@/lib/callFunction'

export interface CoachOption {
  userId: string
  role: string
  displayName: string | null
  email: string | null
  isCoach: boolean
}

/** Human label for a coach option (name → email → uid). */
export function coachLabel(c: Pick<CoachOption, 'displayName' | 'email' | 'userId'>): string {
  return c.displayName || c.email || c.userId
}

export function useCoaches(teamId: string | null) {
  // Distinct key from the schedule page's `useTeamMembers` (same team, but that one
  // reads the subcollection without `role`) — a shared key would cross-populate and
  // break the `role === 'coach'` filter, since SessionFormDialog mounts inside it.
  const q = useQuery<CoachOption[]>({
    queryKey: ['team-coaches-roster', teamId],
    enabled: !!teamId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await callFunction('listTeamMembers')({ teamId })
      return (res.data as { members?: CoachOption[] }).members ?? []
    },
  })

  const members = q.data ?? []
  const coaches = members.filter((m) => m.isCoach)
  // If everyone opted out, fall back to every member so a solo owner/manager can
  // still be picked as the instructor.
  const pickable = coaches.length > 0 ? coaches : members

  return { members, coaches, pickable, isLoading: q.isLoading }
}
