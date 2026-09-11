'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import type { PublicDomainConfig, PublicDomainDnsRecord, PublicDomainStatus } from '@linyup/shared'
import { PUBLIC_DOMAIN_INTEGRATION_DOC, TEAM_INTEGRATIONS_SUBCOLLECTION } from '@linyup/shared'

// The domain a studio's PUBLIC PAGES are served from — the sibling of
// useEmailSenderSettings, which owns the domain they SEND from. Two different
// facts, two different docs, deliberately not fused. See docs/custom-domains.md.

type CustomDomainScope = 'team' | 'org'

interface ScopedPayload {
  scope: CustomDomainScope
  entityId: string
}

interface RegisterResult {
  hostname: string
  dnsRecord: PublicDomainDnsRecord
  status: PublicDomainStatus
}

interface CheckResult {
  status: PublicDomainStatus
  sslStatus: string | null
  error: string | null
}

export interface UseCustomDomainResult {
  data: PublicDomainConfig | null
  isLoading: boolean
  registerDomain: (hostname: string) => Promise<RegisterResult>
  checkDomain: () => Promise<CheckResult>
  removeDomain: () => Promise<void>
  isRegistering: boolean
  isChecking: boolean
  isRemoving: boolean
}

function configDocRef(scope: CustomDomainScope, entityId: string) {
  const collection = scope === 'team' ? 'teams' : 'organizations'
  return doc(db, collection, entityId, TEAM_INTEGRATIONS_SUBCOLLECTION, PUBLIC_DOMAIN_INTEGRATION_DOC)
}

export function useCustomDomain(
  scope: CustomDomainScope,
  entityId: string | null
): UseCustomDomainResult {
  const qc = useQueryClient()
  const queryKey = ['custom-domain', scope, entityId]

  const { data = null, isLoading } = useQuery<PublicDomainConfig | null>({
    queryKey,
    enabled: !!entityId,
    queryFn: async () => {
      if (!entityId) return null
      const snap = await getDoc(configDocRef(scope, entityId))
      return snap.exists() ? (snap.data() as PublicDomainConfig) : null
    },
  })

  const { mutateAsync: register, isPending: isRegistering } = useMutation({
    mutationFn: async (hostname: string) => {
      const fn = httpsCallable<ScopedPayload & { hostname: string }, RegisterResult>(
        functions,
        'registerPublicDomain'
      )
      const result = await fn({ scope, entityId: entityId!, hostname })
      return result.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  })

  const { mutateAsync: check, isPending: isChecking } = useMutation({
    mutationFn: async () => {
      const fn = httpsCallable<ScopedPayload, CheckResult>(functions, 'checkPublicDomain')
      const result = await fn({ scope, entityId: entityId! })
      return result.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  })

  const { mutateAsync: remove, isPending: isRemoving } = useMutation({
    mutationFn: async () => {
      const fn = httpsCallable<ScopedPayload, { removed: boolean }>(functions, 'removePublicDomain')
      await fn({ scope, entityId: entityId! })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  })

  return {
    data,
    isLoading,
    registerDomain: (hostname: string) => register(hostname),
    checkDomain: () => check(),
    removeDomain: async () => {
      await remove()
    },
    isRegistering,
    isChecking,
    isRemoving,
  }
}
