'use client'

// Admin-side client hooks for gift cards (E3). The public purchase/redeem flow
// (createGiftCardCheckout / checkGiftCard) is called inline from the public
// surfaces themselves (ShopHome, BookingForm, GiftCardRedeemField) — same
// convention those files already use for the other public checkouts. This file
// only covers what the Payments dashboard needs: listing + voiding.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { GIFT_CARDS_SUBCOLLECTION, TEAMS_COLLECTION, type GiftCard } from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

/** Recent gift cards for the team (manager read, function-only write — see
 *  firestore.rules). Single-field orderBy, no composite index needed. */
export function useTeamGiftCards(teamId: string | null) {
  return useQuery({
    queryKey: ['gift-cards', teamId],
    enabled: !!teamId,
    queryFn: async (): Promise<GiftCard[]> => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, GIFT_CARDS_SUBCOLLECTION),
          orderBy('created_at', 'desc'),
          limit(50)
        )
      )
      return snap.docs.map((d) => d.data() as GiftCard)
    },
  })
}

/**
 * Manager mint — the front desk sells a card for cash, or the studio comps one.
 * `idempotencyKey` must be minted when the DIALOG OPENS, not per submit: it is
 * the server's serialization key, so a double click (or a retried request) has
 * to carry the same one to get the same card back instead of a second one.
 */
export function useIssueGiftCard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (vars: {
      teamId: string
      /** MAJOR units (100 = CHF 100) — the card rail's unit, mirrored server-side. */
      amountMajor: number
      issueKind: 'paid' | 'comp'
      paymentMode?: string
      issueReason?: string
      purchaserContactId?: string
      idempotencyKey: string
    }) => {
      const fn = callFunction<typeof vars, { code: string; duplicate: boolean }>(
        'issueGiftCard'
      )
      return (await fn(vars)).data
    },
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ['gift-cards', vars.teamId] }),
  })
}

export function useVoidGiftCard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { teamId: string; code: string }) => {
      const fn = callFunction<typeof vars, { ok: boolean }>('voidGiftCard')
      return (await fn(vars)).data
    },
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ['gift-cards', vars.teamId] }),
  })
}
