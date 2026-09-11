import { useRef, useState } from 'react'
import { collection, getCountFromServer, query, where, FieldPath } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { CONTACTS_COLLECTION } from '@linyup/shared'

// The primary-rank rule itself lives in @linyup/shared (`primaryRank`) — one
// resolver for the web and the member app. This module keeps the web-only
// holder counting behind the ranking editors' destructive confirms.

// ─── who is affected by a destructive ranking edit ────────────────────────────

/**
 * A count here decorates a confirm dialog; it must never become the reason an
 * edit cannot be made. Past this many aggregation queries we answer "unknown"
 * rather than firing hundreds of round trips off a single delete click.
 *
 * SIXTY-FOUR, and the arithmetic is the point. Deleting ONE level across a
 * federation is one query per studio — 16 for HMD, cheap, and the common case
 * keeps its number. Deleting a whole SYSTEM is studios × levels: HMD's 16
 * studios on a 15-belt scale is 240 aggregations, each also paying the `get()`s
 * its rules perform, fired the instant somebody clicks a trash icon and repeated
 * in full on every reopen. That is a multi-second spinner and ~10³ document
 * reads to decorate a dialog the user may well cancel. Past this budget the
 * caller warns in words instead, which is the honest answer to a question we
 * declined to ask.
 */
const MAX_HOLDER_COUNT_QUERIES = 64

/**
 * How many contacts of `teamIds` currently sit at one of `values` in `systemId`.
 *
 * `null` means "could not be established" — the rules refused the read, or the
 * fan-out was too large to be worth taking. Callers MUST distinguish it from
 * `0`: a zero printed when nothing was actually counted reads as "nobody is
 * affected", which is the single most damaging thing this dialog could say.
 *
 * Counting, not downloading: `getCountFromServer` returns a number, so a studio
 * with thousands of contacts pays for one aggregation per level, not a list.
 */
export async function countRankHolders(
  teamIds: string[],
  systemId: string,
  values: number[],
): Promise<number | null> {
  const distinct = [...new Set(values)]
  if (!teamIds.length || !distinct.length) return 0
  if (teamIds.length * distinct.length > MAX_HOLDER_COUNT_QUERIES) return null

  try {
    let total = 0
    // One team at a time, its levels in parallel. An organisation counting a
    // fifteen-step belt scale across every member studio would otherwise open
    // several hundred simultaneous requests the instant somebody clicks a
    // delete icon.
    for (const teamId of teamIds) {
      const perLevel = await Promise.all(
        distinct.map(async (value) => {
          const snap = await getCountFromServer(
            query(
              collection(db, CONTACTS_COLLECTION),
              where('teamId', '==', teamId),
              // Equality filters and nothing else, deliberately — Firestore
              // serves that shape from its automatic single-field indexes, so
              // no composite index is needed for a system id nobody could have
              // declared in advance. `FieldPath` rather than a dotted string
              // keeps `systemId` ONE segment whatever the tenant typed into it.
              where(new FieldPath('ranks', systemId), '==', value),
              // Trashed contacts are not part of the answer. Every other
              // "how many contacts" query in the app excludes them
              // (useActiveContacts), so counting them here would print a number
              // larger than any the studio can see anywhere else.
              //
              // ARCHIVED CONTACTS ARE COUNTED, and that is not an oversight: an
              // archived member is a real person who still holds this rank, and
              // restoring them after the level is gone is exactly the orphaned
              // state this dialog exists to warn about.
              where('deleted_at', '==', null),
            ),
          )
          return snap.data().count
        }),
      )
      total += perLevel.reduce((a, b) => a + b, 0)
    }
    // `ranks[systemId]` holds a single number per contact, so no contact can be
    // matched by two levels: the sum is a headcount, not a tally of ranks.
    return total
  } catch {
    // Refused by the rules, or an index that does not exist in this project.
    // Answer "unknown" and let the caller warn in words.
    return null
  }
}

/**
 * The holder count that decorates a destructive ranking confirm: `undefined`
 * while it is being taken, `null` when it could not be, a number otherwise.
 *
 * Client-only (it holds state). It lives beside `countRankHolders` so the level
 * confirm and the system confirm — in either editor — cannot drift apart on how
 * they represent "still counting" and "we do not know".
 */
export function useRankHolderCount() {
  const [count, setCount] = useState<number | null | undefined>(undefined)
  const token = useRef(0)

  /**
   * `teamIds` of `null` means the set of studios to count over is itself
   * unknown (the org's member list has not loaded, or the read failed). That
   * answers "unknown", never "none" — counting over an empty list would return
   * a reassuring zero for a question nobody actually asked.
   */
  const start = (teamIds: string[] | null, systemId: string, values: number[]) => {
    const mine = ++token.current
    setCount(undefined)
    if (!teamIds) {
      setCount(null)
      return
    }
    void countRankHolders(teamIds, systemId, values).then((n) => {
      // A confirm opened while an earlier one was still counting must not be
      // decorated with the earlier one's answer.
      if (token.current === mine) setCount(n)
    })
  }

  /** Abandon an in-flight count — the confirm was dismissed. */
  const reset = () => {
    token.current += 1
    setCount(undefined)
  }

  return { count, start, reset }
}
