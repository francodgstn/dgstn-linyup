'use client'

// Contacts by id, in `documentId() in` chunks — for a surface that shows a
// handful of people NAMED by the rows it already has (a referral's referrer and
// referred, an event's attendees) and used to load the whole roster to resolve
// them. Archived and deleted people resolve too, which a live-roster read would
// not give: the rows name them, so the names must come back.
//
// Ten ids per `in` clause is the conservative bound the affiliations page
// already uses; the SDK allows thirty, and the difference is a few extra
// queries on a page of a hundred rows, not a correctness question.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { collection, documentId, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { CONTACTS_COLLECTION, type Contact } from '@linyup/shared'

const ID_CHUNK = 10

export function useContactsByIds(ids: readonly string[]) {
  const joined = Array.from(new Set(ids.filter(Boolean))).sort().join(',')
  const unique = useMemo(() => (joined ? joined.split(',') : []), [joined])
  return useQuery<Map<string, Contact>>({
    queryKey: ['contacts', 'by-ids', joined],
    enabled: unique.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const out = new Map<string, Contact>()
      for (let i = 0; i < unique.length; i += ID_CHUNK) {
        const snap = await getDocs(
          query(collection(db, CONTACTS_COLLECTION), where(documentId(), 'in', unique.slice(i, i + ID_CHUNK)))
        )
        for (const d of snap.docs) out.set(d.id, { ...(d.data() as Contact), id: d.id })
      }
      return out
    },
  })
}
