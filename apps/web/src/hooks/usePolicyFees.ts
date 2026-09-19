'use client'

// Admin-side client hooks for the no-show policy fees (E5). Fees are created
// server-side by the strike counter (booking/policyFees.ts); managers can only
// resend the payment-link email or waive a pending fee.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { usePaymentMutationErrorToast } from './usePaymentErrorToast'
import { POLICY_FEES_SUBCOLLECTION, TEAMS_COLLECTION, type PolicyFee } from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

/** Recent policy fees for the team (manager read — see firestore.rules).
 *  Single-field orderBy; the caller filters by status client-side. */
export function usePolicyFees(teamId: string | null) {
  return useQuery({
    queryKey: ['policy-fees', teamId],
    enabled: !!teamId,
    queryFn: async (): Promise<PolicyFee[]> => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, POLICY_FEES_SUBCOLLECTION),
          orderBy('created_at', 'desc'),
          limit(50)
        )
      )
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PolicyFee)
    },
  })
}

export function useResendPolicyFeeLink() {
  const qc = useQueryClient()
  const onError = usePaymentMutationErrorToast()
  return useMutation({
    mutationFn: async (vars: { teamId: string; feeId: string }) => {
      const fn = callFunction<typeof vars, { ok: boolean }>('resendPolicyFeeLink')
      return (await fn(vars)).data
    },
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ['policy-fees', vars.teamId] }),
    onError,
  })
}

export function useWaivePolicyFee() {
  const qc = useQueryClient()
  const onError = usePaymentMutationErrorToast()
  return useMutation({
    mutationFn: async (vars: { teamId: string; feeId: string }) => {
      const fn = callFunction<typeof vars, { ok: boolean }>('waivePolicyFee')
      return (await fn(vars)).data
    },
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ['policy-fees', vars.teamId] }),
    onError,
  })
}
