'use client'

import { useQuery } from '@tanstack/react-query'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { useSpaceAuth } from './SpaceAuthProvider'
import { callFunction } from '@/lib/callFunction'

// The signed-in contact's own payment history + whether a Stripe billing portal is
// available to them. Backed by the `listMyContactPayments` callable (sanitized —
// no platform-fee fields). Shared by SpacePortalNav (to decide whether to show the
// Payments tab) and PaymentsHome, so it runs once and is cached.
//
// This is a MONEY read, and both consumers must read `isError`: rendering a
// failure as "no payments yet" tells somebody who paid that there is no record of
// it, and — because the nav hides the tab on an empty result — it would also
// remove the one surface that could correct the claim. Failure therefore KEEPS
// the tab (SpacePortalNav) and says so (PaymentsHome).

export interface ContactPayment {
  id: string
  kind: string
  label: string
  amount: number // minor units (Rappen)
  currency: string
  status: string
  refundedAmount: number // minor units
  createdAt: number | null // epoch ms
  /** The promo code this purchase was discounted with, or null. */
  promoCode?: string | null
}

export interface SpacePaymentsResult {
  payments: ContactPayment[]
  billingAvailable: boolean
}

const EMPTY: SpacePaymentsResult = { payments: [], billingAvailable: false }

export function useSpacePayments() {
  const { isAuthenticated, contact } = useSpaceAuth()
  return useQuery<SpacePaymentsResult>({
    queryKey: ['space-payments', contact?.id],
    enabled: isAuthenticated && !!contact?.id,
    staleTime: 60_000,
    queryFn: async () => {
      try {
        const fn = callFunction<Record<string, never>, SpacePaymentsResult>(
          'listMyContactPayments'
        )
        const res = await fn({})
        return res.data ?? EMPTY
      } catch (err: unknown) {
        reportPublicLoadFailure('space/payments', err)
        throw err
      }
    },
  })
}
