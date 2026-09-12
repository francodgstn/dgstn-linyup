'use client'

/**
 * THE COMPETITOR DETAILS THE PRINTOUT NEEDS AND THE CHECK-IN DOES NOT CARRY.
 *
 * `EventCheckin.contact` is a snapshot of `{ id, firstname, lastname }` — enough
 * for a roster, and deliberately small. The lineup printout wants age, belt and
 * club as well, because that is what the old hmd-lineup sheet put in front of
 * the officials at the table, so those are fetched here.
 *
 * FETCHED AT EXPORT TIME, not denormalised onto the check-in. A cup roster is
 * read once, by one person, on the morning of the event; widening every
 * check-in document to save that read would cost every check-in ever written.
 *
 * DEGRADES PER COMPETITOR. A contact that cannot be read prints with blanks in
 * those columns rather than failing the export — the sheet is wanted at the
 * table in the next few minutes, and a missing belt is a smaller problem than
 * no sheet.
 */

import { useQuery } from '@tanstack/react-query'
import { collection, documentId, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { CONTACTS_COLLECTION, TEAMS_COLLECTION, findRankLevel } from '@linyup/shared'
import type { Contact, EventCheckin, RankingSystem } from '@linyup/shared'

export interface CompetitorDetail {
  age: number | null
  /** The belt's own label from the ranking system, not its number. */
  belt: string | null
  club: string | null
}

/** Whole years at the event, which is what an age-bounded category means. */
function ageAt(birthdate: unknown, on: Date): number | null {
  const d =
    birthdate && typeof birthdate === 'object' && 'toDate' in (birthdate as object)
      ? (birthdate as { toDate(): Date }).toDate()
      : null
  if (!d || Number.isNaN(d.getTime())) return null
  let age = on.getFullYear() - d.getFullYear()
  const before =
    on.getMonth() < d.getMonth() || (on.getMonth() === d.getMonth() && on.getDate() < d.getDate())
  if (before) age -= 1
  return age >= 0 && age < 120 ? age : null
}

/** Firestore `in` takes 30 values; every lookup here is keyed off a live roster. */
function chunk<T>(xs: T[], n = 30): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export function useCompetitorDetails(
  checkins: EventCheckin[],
  rankingSystems: RankingSystem[],
  eventDate: Date
) {
  const contactIds = [...new Set(checkins.map((c) => c.contact.id).filter(Boolean))].sort()

  return useQuery<Map<string, CompetitorDetail>>({
    // The ids, not the checkins array — the roster's IDENTITY is what the answer
    // depends on, and a re-render with a new array of the same people must not
    // refetch a hundred contacts.
    queryKey: ['fighting-cup-competitors', contactIds.join(','), rankingSystems.length],
    enabled: contactIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const contacts = new Map<string, Contact>()
      for (const part of chunk(contactIds)) {
        const snap = await getDocs(
          query(collection(db, CONTACTS_COLLECTION), where(documentId(), 'in', part))
        )
        for (const d of snap.docs) contacts.set(d.id, { ...d.data(), id: d.id } as Contact)
      }

      // Club names, resolved once per distinct team rather than per competitor —
      // a federation cup draws from every member studio, and the same club
      // appears on dozens of rows.
      const teamIds = [...new Set([...contacts.values()].map((c) => c.teamId).filter(Boolean))]
      const teamNames = new Map<string, string>()
      for (const part of chunk(teamIds as string[])) {
        const snap = await getDocs(
          query(collection(db, TEAMS_COLLECTION), where(documentId(), 'in', part))
        )
        for (const d of snap.docs) teamNames.set(d.id, (d.data().name as string) ?? '')
      }

      const out = new Map<string, CompetitorDetail>()
      for (const id of contactIds) {
        const c = contacts.get(id)
        if (!c) {
          out.set(id, { age: null, belt: null, club: null })
          continue
        }
        // The belt: the FIRST ranking system this contact holds a level in.
        // A cup competitor has one discipline in practice, and printing the
        // number would be printing an implementation detail at a table where
        // people say "blue".
        let belt: string | null = null
        for (const sys of rankingSystems) {
          const level = c.ranks?.[sys.id]
          if (level == null) continue
          belt = findRankLevel(sys.levels, level)?.label ?? String(level)
          break
        }
        out.set(id, {
          age: ageAt(c.birthdate, eventDate),
          belt,
          club: c.teamId ? (teamNames.get(c.teamId) ?? null) : null,
        })
      }
      return out
    },
  })
}
