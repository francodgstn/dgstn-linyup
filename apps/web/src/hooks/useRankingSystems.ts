'use client'

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import {  effectiveRankingSystems, rankingSystemsManagedByOrg, ORGANIZATIONS_COLLECTION } from '@linyup/shared'
import type { RankingSystem, Organization } from '@linyup/shared'

interface RankingSystemsResult {
  rankingSystems: RankingSystem[]
  /** true when ranking systems are owned by the org, not the team */
  managedByOrg: boolean
  orgId: string | null
  loading: boolean
}

/**
 * THE effective ranking systems for the current team.
 *
 * The rule itself lives in `effectiveRankingSystems` (@linyup/shared) so that
 * this hook, the automation builder and the server-side automation engine give
 * the same answer. Only the READ is here.
 *
 * Two behaviours worth knowing, both corrected here:
 *
 *  - An organisation with NO systems of its own does not blank its studios.
 *    This used to return the org's list whenever an `org_id` existed, so a
 *    studio inside such an org saw none of its OWN systems — configuration it
 *    could still see in its settings, applying nowhere.
 *  - Callers that need this must use the hook. Several surfaces read
 *    `team.ranking_systems` directly and were therefore blank for any
 *    org-managed tenant; they now come through here.
 */
export function useRankingSystems(): RankingSystemsResult {
  const { team } = useAuth()
  const orgId = team?.org_id ?? null

  const { data: orgRankingSystems, isLoading: orgLoading } = useQuery<RankingSystem[]>({
    queryKey: ['org-ranking-systems', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      if (!orgId) return []
      const snap = await getDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId))
      if (!snap.exists()) return []
      const org = snap.data() as Organization
      return org.ranking_systems ?? []
    },
  })

  return {
    rankingSystems: effectiveRankingSystems(team?.ranking_systems, orgRankingSystems),
    managedByOrg: rankingSystemsManagedByOrg(orgRankingSystems),
    orgId,
    loading: orgId ? orgLoading : false,
  }
}
