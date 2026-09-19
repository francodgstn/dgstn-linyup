'use client'

// WHO IS ALREADY ON THE TEAM — the "being", as distinct from the "adding".
//
// A second user is a Studio feature (`multiple_managers`), and the gate for it
// sits on ADDING one: nothing removes or demotes a member when a team drops
// below Studio (`downgradeTeamToFree` never touches `team_members`). A surface
// that governs somebody who is ALREADY here therefore has to ask this question
// rather than the plan question — otherwise a team that legitimately holds a
// second member is locked out of managing them.
//
// Its own query key on purpose: `['team-members', teamId]` is already owned by
// two pages that map the callable response into their own shapes, and a third
// writer of that entry would serve one of them a row shape it does not expect.

import { useQuery } from '@tanstack/react-query'
import type { TeamRole } from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

interface SeatRow {
  userId: string
  role: TeamRole
}

export interface TeamSeats {
  /** Everyone with a `team_members` doc, owner included. */
  count: number
  /** Somebody other than the single owner is already here. */
  hasExtraMember: boolean
  /** Somebody actually holds the customizable Coach role today. */
  hasCoachRoleMember: boolean
}

export function useTeamSeats(teamId: string | null, enabled = true) {
  return useQuery<TeamSeats>({
    queryKey: ['team-seats', teamId],
    enabled: !!teamId && enabled,
    queryFn: async () => {
      const res = await callFunction('listTeamMembers')({ teamId })
      const members = (res.data as { members?: SeatRow[] }).members ?? []
      return {
        count: members.length,
        hasExtraMember: members.length > 1,
        hasCoachRoleMember: members.some((m) => m.role === 'coach'),
      }
    },
  })
}
