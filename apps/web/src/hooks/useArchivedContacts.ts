'use client'

// THE list query for a team's ARCHIVED contacts (archived, not deleted).
//
// It sits BESIDE `useActiveContacts` rather than inside it, deliberately
// (UX-21). "Active" is a meaning half the app depends on — the payment and
// booking pickers, the roster card, the dashboard counts — and widening that
// hook to sometimes include archived people would have changed all of them
// silently to fix one search box. A caller that wants former members asks for
// them by name.
//
// WHY THE QUERY LOOKS LIKE THIS. It is the query the contacts page's Archived
// tab has always run, lifted here verbatim rather than re-derived:
//
//   teamId ==, deleted_at == null, archived_at != null, orderBy(archived_at desc)
//
// which matters twice over. It keeps the ORDERING trap closed — a contacts query
// that invents its own sort works in the emulator and fails on a real project
// for want of a composite index — and it keeps the QUERY KEY identical, so the
// contacts page and the sidebar search share one cache entry: open search after
// visiting Contacts and the archived read costs nothing at all.
//
// DELETED CONTACTS ARE NOT HERE AND MUST NOT BE ADDED. Someone asked to be
// removed; surfacing them in a search box works against that, and `deleted_at ==
// null` above is the whole of the enforcement on this side. (The rules and the
// anonymisation job are the rest of it.)
//
// COACH SCOPE: own-scoped members are not served by this hook — pass `null` for
// them, exactly as the contacts page does when it hides the Archived tab. The
// broad query above is DENIED for a coach by the Firestore rules (they may read
// only their assigned contacts), so running it would fail rather than return
// less, and a coach's book is the people they teach now.
//
// TWO READERS, TWO SHAPES (2026-09-11, docs/scalability-2026-09.md §17 A2).
// An archive grows with churn and never shrinks, so the Archived TAB reads it a
// page at a time (`useArchivedContactsPage`) with a count beside it, and says
// what it is showing. The sidebar SEARCH keeps the whole read (`useArchivedContacts`):
// a former member is exactly who you look up when they come back (UX-21), and
// a search that only finds the recently archived would have quietly stopped
// answering that. It is armed only once a real query is typed — one read per
// panel session — which is the cost the decision accepts. The two share the
// same shape and ordering, and both sit under the `['contacts', …]` key that
// every contact mutation invalidates.

import { useQuery } from '@tanstack/react-query'
import {
  collection,
  getCountFromServer,
  getDocs,
  orderBy,
  query,
  where,
  type Query,
  type DocumentData,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { CONTACTS_COLLECTION, type Contact } from '@linyup/shared'
import { usePagedQuery } from './usePagedQuery'

/** The Archived tab's page. The archive is roster-scale, so the page is wide. */
export const ARCHIVED_PAGE_SIZE = 200

function archivedQuery(teamId: string): Query<DocumentData> {
  return query(
    collection(db, CONTACTS_COLLECTION),
    where('teamId', '==', teamId),
    where('archived_at', '!=', null),
    where('deleted_at', '==', null),
    orderBy('archived_at', 'desc')
  )
}

/** The Archived tab: newest archive first, a page at a time. */
export function useArchivedContactsPage(teamId: string | null, pageSize = ARCHIVED_PAGE_SIZE) {
  return usePagedQuery<Contact>({
    queryKey: ['contacts', 'archived', 'page', teamId],
    enabled: !!teamId,
    pageSize,
    base: () => archivedQuery(teamId!),
    map: (d) => ({ ...(d.data() as Contact), id: d.id }),
  })
}

/** How many are archived in all — the tab's count, without loading them. */
export function useArchivedContactsCount(teamId: string | null) {
  return useQuery<number>({
    queryKey: ['contacts', 'archived', 'count', teamId],
    enabled: !!teamId,
    staleTime: 60_000,
    queryFn: async () => (await getCountFromServer(archivedQuery(teamId!))).data().count,
  })
}

export function useArchivedContacts(teamId: string | null) {
  return useQuery<Contact[]>({
    queryKey: ['contacts', 'archived', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(archivedQuery(teamId))
      return snap.docs.map((d) => ({ ...(d.data() as Contact), id: d.id }))
    },
  })
}
