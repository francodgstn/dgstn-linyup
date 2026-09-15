// ─── Memberships — the studio's Stripe member subscriptions ─────────────────
//
// Whether a subscription is winding down, and when, is answered by the shared
// lifecycle readers (`subscriptionIsCancelling` / `subscriptionEndsAt` /
// `subscriptionCancellation`) inside the projection — never by reading
// `cancel_at_period_end` here.

import * as admin from 'firebase-admin'
import {
  LIVE_SUBSCRIPTION_STATUSES,
  MEMBER_SUBSCRIPTIONS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  projectSubscription,
  subscriptionIsCancelling,
  type ApiSubscription,
  type MemberSubscription,
} from '@linyup/shared'
import type { ApiPrincipal } from '../auth/principal'
import { requireScope, type ListPage } from '../access'
import { projectionContext, type TeamReadContext } from '../context'
import { loadPeople } from './people'

export const MEMBERSHIP_STATES = ['live', 'cancelling', 'past_due', 'trialing', 'ended'] as const
export type MembershipState = (typeof MEMBERSHIP_STATES)[number]

const STATUSES: Record<MembershipState, readonly string[]> = {
  live: LIVE_SUBSCRIPTION_STATUSES,
  cancelling: LIVE_SUBSCRIPTION_STATUSES,
  past_due: ['past_due'],
  trialing: ['trialing'],
  ended: ['canceled', 'unpaid', 'incomplete_expired'],
}

/** Newest subscriptions read per request; the (status, created_at) index orders them. */
const SCAN = 500

export async function listSubscriptions(
  principal: ApiPrincipal,
  team: TeamReadContext,
  input: { state: MembershipState; limit: number },
  nowMs: number
): Promise<ListPage<ApiSubscription>> {
  requireScope(principal, 'subscriptions:read')
  const snap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(principal.teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .where('status', 'in', [...STATUSES[input.state]])
    .orderBy('created_at', 'desc')
    .limit(SCAN)
    .get()

  let subs = snap.docs.map((d) => d.data() as MemberSubscription).filter((s) => s.duplicate !== true)
  if (input.state === 'cancelling') subs = subs.filter((s) => subscriptionIsCancelling(s))

  const pii = projectionContext(principal, team, nowMs).pii
  const people = await loadPeople(principal, subs.map((s) => s.contactId ?? ''), pii)
  // A coach sees the memberships of the people they may see, and no others.
  const ownOnly = principal.dataScope === 'own' && !principal.capabilities.has('contacts.view.all')
  // Money follows the reports capability, as the payments page does.
  const amounts = principal.role === 'owner' || principal.capabilities.has('reports.view')

  const rows: ApiSubscription[] = []
  for (const s of subs) {
    const person = s.contactId ? (people.get(s.contactId) ?? null) : null
    if (ownOnly && !person) continue
    rows.push(projectSubscription(s, { person, amounts, pii }))
  }
  return {
    object: 'list',
    data: rows.slice(0, input.limit),
    has_more: rows.length > input.limit || snap.size >= SCAN,
    next_cursor: null,
  }
}
