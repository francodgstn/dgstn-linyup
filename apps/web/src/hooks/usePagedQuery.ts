'use client'

// THE ONE CURSOR PATTERN for a Firestore list the web reads directly.
//
// A list that grows with time (submissions, referrals, an archive) cannot be
// read whole — docs/scalability-2026-09.md §17 — and the bookings page and the
// Space already showed the two honest shapes: a window with a `tooWide`
// refusal, or a cursor the reader walks page by page. This is the cursor one,
// for a client read: the caller supplies the ORDERED base query and a row
// mapper; the hook appends `startAfter(lastDoc)` + `limit(pageSize)` and
// flattens the pages. A page shorter than `pageSize` is the last one.
//
// The cursor is the last `QueryDocumentSnapshot` of a page, which is exact —
// no tie-breaking on a timestamp — and TanStack keeps it by reference (a
// snapshot is a class instance, not a plain object, so structural sharing
// leaves it alone).
//
// What it does NOT do, on purpose: a total. A count is a separate aggregation
// (`getCountFromServer`) that a caller asks for when the surface needs to say
// "N of M"; most lists only need "load more".

import { useMemo } from 'react'
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query'
import {
  getDocs,
  limit,
  query,
  startAfter,
  type DocumentData,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

type Cursor = QueryDocumentSnapshot<DocumentData> | null

interface Page<T> {
  rows: T[]
  cursor: Cursor
}

export interface PagedQueryOptions<T> {
  /** Without the page size — the hook appends it, so two callers asking for
   *  different pages of one list never share a cache entry by accident. */
  queryKey: readonly unknown[]
  enabled?: boolean
  pageSize: number
  /** The ordered query, WITHOUT its page bounds. Must carry an `orderBy` —
   *  `startAfter` on a document is only meaningful against one. */
  base: () => Query<DocumentData>
  map: (doc: QueryDocumentSnapshot<DocumentData>) => T
  staleTime?: number
}

export function usePagedQuery<T>(opts: PagedQueryOptions<T>) {
  const q = useInfiniteQuery<Page<T>, Error, InfiniteData<Page<T>>, readonly unknown[], Cursor>({
    queryKey: [...opts.queryKey, opts.pageSize],
    enabled: opts.enabled ?? true,
    staleTime: opts.staleTime,
    initialPageParam: null,
    queryFn: async ({ pageParam }) => {
      const snap = await getDocs(
        query(opts.base(), ...(pageParam ? [startAfter(pageParam)] : []), limit(opts.pageSize))
      )
      return {
        rows: snap.docs.map(opts.map),
        cursor: snap.docs.length === opts.pageSize ? snap.docs[snap.docs.length - 1]! : null,
      }
    },
    // `null` = no further page (TanStack v5 treats null and undefined alike).
    getNextPageParam: (last) => last.cursor,
  })
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.rows) ?? [], [q.data])
  return {
    rows,
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error,
    hasMore: q.hasNextPage,
    isLoadingMore: q.isFetchingNextPage,
    loadMore: () => {
      void q.fetchNextPage()
    },
    refetch: q.refetch,
  }
}
