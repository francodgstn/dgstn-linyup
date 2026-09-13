'use client'

import { useQuery } from '@tanstack/react-query'
import { httpsCallable } from 'firebase/functions'
import type { Tarif595MyReceiptsRequest, Tarif595MyReceiptsResult } from '@linyup/shared'
import { functions } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { useSpaceAuth } from './SpaceAuthProvider'

// The signed-in contact's own health-insurance receipts (Tarif 595) + whether
// the studio issues them at all. Backed by `listMyTarif595Receipts` — the
// contact SESSION decides who; the body carries only the team. Shared by
// SpacePortalNav (whether to show the Receipts tab), ReceiptsHome and the
// Account page's insurance section (gated on `enabled`), so it runs once.
//
// Both consumers read `isError`, the same rule as `useSpacePayments`: a
// failed read rendered as "no receipts" tells somebody who was handed a
// document that there is no record of it, and hides the one surface that
// could say otherwise.

export type { Tarif595MyReceipt } from '@linyup/shared'

const EMPTY: Tarif595MyReceiptsResult = { enabled: false, receipts: [] }

export function useSpaceReceipts() {
  const { isAuthenticated, contact, teamId } = useSpaceAuth()
  return useQuery<Tarif595MyReceiptsResult>({
    queryKey: ['space-receipts', teamId, contact?.id],
    enabled: isAuthenticated && !!contact?.id && !!teamId,
    staleTime: 60_000,
    queryFn: async () => {
      try {
        const fn = httpsCallable<Tarif595MyReceiptsRequest, Tarif595MyReceiptsResult>(functions, 'listMyTarif595Receipts')
        const res = await fn({ teamId: teamId! })
        return res.data ?? EMPTY
      } catch (err: unknown) {
        reportPublicLoadFailure('space/receipts', err)
        throw err
      }
    },
  })
}
