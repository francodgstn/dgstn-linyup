'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useOrgRole } from '@/hooks/useOrgRole'
import { useLocale } from 'next-intl'
import type { Organization, SaasSubscription, OrgRole } from '@linyup/shared'
import { resolveAffiliationTerm } from '@linyup/shared'

interface OrgContextValue {
  org: Organization | null
  subscription: SaasSubscription | null
  userRole: OrgRole | null
  loading: boolean
  isAdmin: boolean
  affiliationTerm: string
}

const OrgContext = createContext<OrgContextValue>({
  org: null,
  subscription: null,
  userRole: null,
  loading: true,
  isAdmin: false,
  affiliationTerm: 'Affiliation',
})

export function OrgProvider({ orgId, children }: { orgId: string; children: ReactNode }) {
  const locale = useLocale()

  const { data: org, isLoading: orgLoading } = useQuery<Organization | null>({
    queryKey: ['org', orgId],
    queryFn: async () => {
      const snap = await getDoc(doc(db, 'organizations', orgId))
      return snap.exists() ? ({ id: snap.id, ...snap.data() } as Organization) : null
    },
  })

  // THE ROLE READ LIVES IN `useOrgRole`, not here. The app shell needs the same
  // answer to choose the org's sidebar rows and it renders OUTSIDE this
  // provider, so the two share a query key rather than a context — see the
  // hook's header.
  const { role: userRole, isOrgAdmin, loading: roleLoading } = useOrgRole(orgId)

  // ADMIN ONLY. `saas_subscriptions/{orgId}` admits an org_admin and nobody else,
  // so asking unconditionally made every org_viewer and every member studio take
  // a retried permission-denied on every org page they opened. Only the billing
  // page reads it, and that is admin-only.
  const { data: subscription, isLoading: subLoading } = useQuery<SaasSubscription | null>({
    queryKey: ['org-subscription', orgId],
    enabled: isOrgAdmin,
    queryFn: async () => {
      const snap = await getDoc(doc(db, 'saas_subscriptions', orgId))
      return snap.exists() ? (snap.data() as SaasSubscription) : null
    },
  })


  const loading = orgLoading || subLoading || roleLoading
  const affiliationTerm = resolveAffiliationTerm(org?.affiliation_term, locale)

  return (
    <OrgContext.Provider value={{
      org: org ?? null,
      subscription: subscription ?? null,
      userRole: userRole ?? null,
      loading,
      isAdmin: userRole === 'org_admin',
      affiliationTerm,
    }}>
      {children}
    </OrgContext.Provider>
  )
}

export function useOrg() {
  return useContext(OrgContext)
}
