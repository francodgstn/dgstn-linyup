'use client'

// A contact's plan PERIODS — `contacts/{id}/subscription_history`.
//
// This is the ONLY store of when a plan started and stopped. `member_subscriptions`
// describes the CURRENT state of a Stripe subscription and nothing else: it has no
// period start, and its `created_at` is re-stamped by every webhook event, so
// "which plan did they hold on 14 March" is not answerable from it. Anything
// asking a question about a past date has to come here.
//
// Shared between the History segment (which lists it), the header's attendance
// chart (which draws it as bands) and the payments statement (which merges it
// with payments) — one query key, so they cost one read between them rather than
// one each.
//
// Known limit, worth carrying to any reader: the writer keys on the contact's
// PRIMARY plan, so a contact who held two plans at once has an incomplete record
// for the period before that was fixed. There is no backfill; the ledger reports
// the gap where it can compute it rather than papering over it.

import { useQuery } from '@tanstack/react-query'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  CONTACTS_COLLECTION,
  CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION,
  type SubscriptionHistoryEntry,
} from '@linyup/shared'

export function useSubscriptionHistory(contactId: string) {
  return useQuery<SubscriptionHistoryEntry[]>({
    queryKey: ['subscription-history', contactId],
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, CONTACTS_COLLECTION, contactId, CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION),
          orderBy('start_date', 'desc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as SubscriptionHistoryEntry)
    },
  })
}
