'use client'

// THE RECURRING AGREEMENT's data — a contact's Stripe subscriptions
// (member_subscriptions) and the freeze / resume / cancel mutations that act on
// ONE of them.
//
// The section that used to render them as a separate billing list is gone
// (2026-09-25): a plan and the billing that pays for it are one card now
// (docs/multi-plan-holdings.md §5), drawn by the contact page's PlansList, which
// uses these hooks. The confirm copy and the reasoning about why canceling is
// offered even while paused live there too.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { MemberSubscription } from '@linyup/shared'
import { MEMBER_SUBSCRIPTIONS_SUBCOLLECTION, TEAMS_COLLECTION } from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

// ─── member subscriptions hook ────────────────────────────────────────────────

export function useContactMemberSubscriptions(teamId: string | null, contactId: string) {
  return useQuery<Array<MemberSubscription & { id: string }>>({
    queryKey: ['contact-member-subscriptions', teamId, contactId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, MEMBER_SUBSCRIPTIONS_SUBCOLLECTION),
          where('contactId', '==', contactId)
        )
      )
      return snap.docs.map((d) => ({ ...(d.data() as MemberSubscription), id: d.id }))
    },
  })
}

// ─── freeze / resume mutations ────────────────────────────────────────────────

export function usePauseMemberSubscription(teamId: string | null, contactId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (subscriptionId: string) => {
      const fn = callFunction<{ teamId: string; subscriptionId: string }, { ok: boolean }>(
        'pauseMemberSubscription'
      )
      return (await fn({ teamId: teamId!, subscriptionId })).data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contact-member-subscriptions', teamId, contactId] })
      qc.invalidateQueries({ queryKey: ['contact', contactId] })
    },
  })
}

export function useResumeMemberSubscription(teamId: string | null, contactId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (subscriptionId: string) => {
      const fn = callFunction<{ teamId: string; subscriptionId: string }, { ok: boolean }>(
        'resumeMemberSubscription'
      )
      return (await fn({ teamId: teamId!, subscriptionId })).data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contact-member-subscriptions', teamId, contactId] })
      qc.invalidateQueries({ queryKey: ['contact', contactId] })
    },
  })
}

/**
 * STOP THE BILLING, not just freeze it.
 *
 * Until 2026-08-23 this section could only FREEZE (`pause_collection`), and the
 * only way to cancel anything was a radio buried inside the "change
 * subscription" dialog that defaulted to KEEP. So a studio that froze a
 * membership and then removed the plan from the contact was left with a live
 * Stripe subscription nobody could see a way to stop — and the only apparent
 * exit was to RESUME the billing, which is the opposite of what they wanted.
 *
 * Offered in every live state INCLUDING paused, for that exact reason.
 */
export function useCancelMemberSubscription(teamId: string | null, contactId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (subscriptionId: string) => {
      const fn = callFunction<{ teamId: string; subscriptionId: string }, { ok: boolean }>(
        'cancelMemberSubscription'
      )
      return (await fn({ teamId: teamId!, subscriptionId })).data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contact-member-subscriptions', teamId, contactId] })
      qc.invalidateQueries({ queryKey: ['contact', contactId] })
    },
  })
}
