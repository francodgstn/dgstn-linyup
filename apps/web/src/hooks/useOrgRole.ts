'use client'

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { ORGANIZATIONS_COLLECTION, ORG_MEMBERS_SUBCOLLECTION } from '@linyup/shared'
import type { OrgRole } from '@linyup/shared'

/**
 * WHAT THIS PERSON IS TO **THIS** ORGANIZATION — and the distinction it draws
 * is the one the org scope is built on.
 *
 * There are two ways to be in org scope and they are not the same thing:
 *
 *   an ORG MEMBER   — a person with an `org_members` row, who runs the
 *                     federation. Returns their role.
 *   a MEMBER STUDIO — somebody whose STUDIO belongs to the organization but who
 *                     has no row of their own. Returns null.
 *
 * The second is not an error state and not a lesser admin: it is most of the
 * people who will ever open an organization, and it is why `null` here selects
 * a different navigation catalog rather than a permission denial.
 *
 * ONE READ, TWO CONSUMERS. `OrgProvider` needs this for the org's own pages and
 * the app shell needs it to pick the sidebar rows, and the shell sits OUTSIDE
 * the provider — so they cannot share a context. They share the react-query
 * cache key instead, which is why this hook exists rather than two getDocs.
 *
 * IT IS NAVIGATION, NEVER ENFORCEMENT. `firestore.rules` decides what may be
 * read; this only decides what is worth offering. A member studio that types
 * `/org/{id}/settings` gets a page that cannot load, exactly as it would have
 * before — hiding the row spares them the dead end, it does not create the
 * boundary.
 *
 * Reading it is always allowed: `org_members/{memberId}` admits
 * `memberId == request.auth.uid`, so asking about yourself never denies, in any
 * organization, whether or not you belong to it.
 */
export function useOrgRole(orgId: string | null | undefined) {
  const { user } = useAuth()

  const query = useQuery<OrgRole | null>({
    // The SAME key OrgProvider used when it owned this query — a shell render
    // and an org page render share one network read.
    queryKey: ['org-role', orgId, user?.uid],
    enabled: !!user && !!orgId,
    queryFn: async () => {
      if (!user || !orgId) return null
      const snap = await getDoc(
        doc(db, ORGANIZATIONS_COLLECTION, orgId, ORG_MEMBERS_SUBCOLLECTION, user.uid)
      )
      return snap.exists() ? ((snap.data().role as OrgRole) ?? null) : null
    },
  })

  return {
    role: query.data ?? null,
    /** Runs the organization. */
    isOrgAdmin: query.data === 'org_admin',
    /** Has a seat at the organization at all — admin or viewer. */
    isOrgMember: query.data != null,
    /**
     * UNRESOLVED IS NOT "NO". A caller that treats a pending read as "not a
     * member" renders the member studio's navigation for a beat and then swaps
     * it, which reads as the app changing its mind about who you are.
     *
     * A DISABLED QUERY IS PENDING FOREVER in react-query v5, so the enablement
     * condition is repeated here — without it, every caller outside org scope
     * would sit in a loading state that never ends.
     */
    loading: !!user && !!orgId && query.isPending,
  }
}
