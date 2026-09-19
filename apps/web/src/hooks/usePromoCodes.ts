'use client'

// Admin-side client hooks for promo codes (Wave 3 Phase 3), modelled on
// useGiftCards.ts. The PUBLIC side (previewPromoCode) is called inline from the
// public surfaces themselves — same convention every other public checkout uses.
//
// READS are direct Firestore (manager-only per firestore.rules); WRITES are all
// callables, and that asymmetry is the point: every writer of this document
// lives in one server file (packages/functions/src/connect/promoCodes.ts) and
// every one of them writes inside a transaction that read the document first —
// a capped counter and a capped live-reservation map cannot survive a blind
// write. A client write of any field would put a writer outside that set, which
// is why the rules deny client writes outright rather than allow-listing fields.
// See firestore.rules, the promo_codes block, for the argument in full.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  PROMO_CODES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type PromoAudience,
  type PromoCode,
  type PromoEffect,
  type PromoScopeKind,
} from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

/** What the create/edit form sends. `maxUses` is REQUIRED and `null` means "no
 *  limit" — the server refuses a payload that omits the key entirely, so the
 *  fastest path through the form cannot produce an uncapped code by accident. */
export interface PromoCodeInput {
  code: string
  effect: PromoEffect
  percent?: number
  amount?: number
  validFromMs: number | null
  validUntilMs: number | null
  maxUses: number | null
  maxUsesPerContact: number | null
  restrictToContactId: string | null
  audience: PromoAudience
  appliesTo: PromoScopeKind[]
  /** The optional entity allow-lists — the second, finer half of `applies_to`.
   *  An EMPTY array means "everything of the chosen kinds": the server stores
   *  `null` for it, so one meaning has one representation on disk. Always sent,
   *  including empty, so clearing a narrowing works. */
  activityIds: string[]
  courseIds: string[]
  productIds: string[]
  label: string | null
}

/** Recent codes for the team. Single-field orderBy — no composite index, the
 *  same shape `useTeamGiftCards` uses (and the reason `firestore.index.json`
 *  gains nothing in this phase). */
export function useTeamPromoCodes(teamId: string | null) {
  return useQuery({
    queryKey: ['promo-codes', teamId],
    enabled: !!teamId,
    queryFn: async (): Promise<PromoCode[]> => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, PROMO_CODES_SUBCOLLECTION),
          orderBy('created_at', 'desc'),
          limit(100)
        )
      )
      return snap.docs.map((d) => d.data() as PromoCode)
    },
  })
}

function useTeamMutation<TVars extends { teamId: string }, TOut>(name: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (vars: TVars) => {
      const fn = callFunction<TVars, TOut>(name)
      return (await fn(vars)).data
    },
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ['promo-codes', vars.teamId] }),
  })
}

export function useCreatePromoCode() {
  return useTeamMutation<{ teamId: string } & PromoCodeInput, { code: string }>('createPromoCode')
}

export function useUpdatePromoCode() {
  return useTeamMutation<{ teamId: string } & PromoCodeInput, { ok: boolean }>('updatePromoCode')
}

export function useSetPromoCodeStatus() {
  return useTeamMutation<
    { teamId: string; code: string; status: 'active' | 'disabled' },
    { ok: boolean }
  >('setPromoCodeStatus')
}

/** Clears every LIVE reservation on one code. It writes only the reservations
 *  map — never `usage_count` — so it frees a stuck campaign without handing it
 *  uses back. */
export function useReleasePromoReservations() {
  return useTeamMutation<{ teamId: string; code: string }, { released: number }>(
    'releasePromoReservations'
  )
}

/** Forgets ONE person's use so they can apply the code again. Also a delete of
 *  lifecycle state, not a counter adjustment: the campaign's total is unchanged. */
export function useClearPromoRedemption() {
  return useTeamMutation<
    { teamId: string; code: string; email?: string; contactId?: string },
    { ok: boolean }
  >('clearPromoRedemption')
}
