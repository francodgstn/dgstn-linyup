'use client'

import { useQuery } from '@tanstack/react-query'
import { collectionGroup, query, where, getDocs, doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import type { Organization } from '@linyup/shared'
import { ORGANIZATIONS_COLLECTION, ORG_MEMBERS_SUBCOLLECTION } from '@linyup/shared'

interface UserOrg extends Organization {
  id: string
  role: 'org_admin' | 'org_viewer'
}

export function useUserOrgs() {
  const { user } = useAuth()

  return useQuery<UserOrg[]>({
    queryKey: ['user-orgs', user?.uid],
    enabled: !!user,
    queryFn: async () => {
      if (!user) return []

      // Find all org_members docs where this user is a member
      const membershipsSnap = await getDocs(
        query(
          collectionGroup(db, ORG_MEMBERS_SUBCOLLECTION),
          where('userId', '==', user.uid)
        )
      )

      if (membershipsSnap.empty) return []

      // Load each org doc by direct ID lookup
      const results = await Promise.all(
        membershipsSnap.docs.map(async (memberDoc) => {
          const orgId = memberDoc.ref.parent.parent?.id
          if (!orgId) return null
          const orgSnap = await getDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId))
          if (!orgSnap.exists()) return null
          return {
            id: orgSnap.id,
            ...orgSnap.data(),
            role: memberDoc.data().role,
          } as UserOrg
        })
      )

      return results.filter(Boolean) as UserOrg[]
    },
  })
}
