'use client'

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { ORGANIZATIONS_COLLECTION } from '@linyup/shared'

interface OrgLink {
  id: string
  name: string
}

/**
 * Returns the orgs the current user can access in the sidebar.
 *
 * Strategy (no collectionGroup query needed):
 *   1. If the current team has org_id set, include that org.
 *   2. Also check profile.orgIds (stored when a user creates/joins an org as admin).
 *
 * Both paths use direct document reads — no composite index required.
 */
export function useOrgLinks() {
  const { team, profile } = useAuth()

  return useQuery<OrgLink[]>({
    queryKey: ['org-links', team?.org_id, profile?.id],
    queryFn: async () => {
      const orgIds = new Set<string>()

      // From the current team membership
      if (team?.org_id) orgIds.add(team.org_id)

      // From org admin memberships stored on the user profile
      if (Array.isArray(profile?.orgIds)) {
        for (const id of profile.orgIds) orgIds.add(id)
      }

      if (orgIds.size === 0) return []

      const results = await Promise.all(
        [...orgIds].map(async (orgId) => {
          const snap = await getDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId))
          if (!snap.exists()) return null
          return { id: snap.id, name: snap.data().name as string }
        })
      )

      return results.filter(Boolean) as OrgLink[]
    },
  })
}
