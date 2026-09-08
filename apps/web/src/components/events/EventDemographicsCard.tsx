'use client'

/**
 * WHO WAS IN THE ROOM — the roster's demographics, for one event.
 *
 * The same card `/contacts` shows over a studio's whole roster, pointed at the
 * people who actually checked in. Age, gender and belt are the three questions a
 * studio asks after a camp or an exam ("was it the kids?", "which grades came?"),
 * and they are answered here rather than by exporting the list and counting.
 *
 * ── REUSED, NOT REDRAWN ─────────────────────────────────────────────────────
 * `ContactsOverviewCard` already owns the donut, the legend, the palettes and
 * the empty state, and it takes a plain `Contact[]`. Drawing a second set of the
 * same three charts here would be the "same component twice" that card's own
 * header describes being merged away. It is passed `groups={['demographics']}`,
 * the single-group shape `/contacts` already renders.
 *
 * ── THE CHECK-IN DOES NOT CARRY ANY OF THIS ─────────────────────────────────
 * `EventCheckin.contact` is a snapshot of `{id, firstname, lastname}` — no
 * birthdate, no gender, no rank. So the contacts are fetched, batched thirty at
 * a time, exactly as `useCompetitorDetails` does for the printed lineup sheet
 * and for the same reason: an event roster is read occasionally by one person,
 * and widening every check-in document to save that read would cost every
 * check-in ever written.
 *
 * ── IT DEGRADES, AND SAYS SO ────────────────────────────────────────────────
 * A contact that cannot be read is simply absent from the counts. That is not
 * rare on migrated data — HMD's import carries check-ins whose contact no longer
 * exists — so the subtitle reports how many of the check-ins are actually
 * represented rather than implying the chart covers everyone. A chart that
 * silently describes 60 of 82 people is worse than one that says which.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { collection, documentId, getDocs, query, where } from 'firebase/firestore'
import { useTranslations } from 'next-intl'
import { db } from '@/lib/firebase'
import { CONTACTS_COLLECTION } from '@linyup/shared'
import type { Contact, EventCheckin, RankingSystem } from '@linyup/shared'
import { ContactsOverviewCard } from '@/components/dashboard/ContactsOverviewCard'
import { Skeleton } from '@/components/ui/skeleton'

/** Firestore `in` takes 30 values. */
function chunk<T>(xs: T[], n = 30): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export function useEventAttendeeContacts(checkins: EventCheckin[]) {
  const contactIds = useMemo(
    () => [...new Set(checkins.map((c) => c.contact?.id).filter(Boolean) as string[])].sort(),
    [checkins]
  )

  return useQuery<Contact[]>({
    // Keyed on the ids themselves, so the roster changing re-fetches and a
    // re-render with the same people does not.
    queryKey: ['event-attendee-contacts', contactIds],
    enabled: contactIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const groups = await Promise.all(
        chunk(contactIds).map((ids) =>
          getDocs(query(collection(db, CONTACTS_COLLECTION), where(documentId(), 'in', ids)))
        )
      )
      return groups.flatMap((snap) =>
        snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Contact)
      )
    },
  })
}

export function EventDemographicsCard({
  checkins,
  rankingSystems = [],
  loading = false,
}: {
  checkins: EventCheckin[]
  rankingSystems?: RankingSystem[]
  loading?: boolean
}) {
  const t = useTranslations('Events')
  const contactsQ = useEventAttendeeContacts(checkins)

  // Nothing to describe. Deliberately renders NOTHING rather than an empty
  // chart: an event before its day has no attendance, and a card reading "0" in
  // three donuts says the feature is broken rather than that the camp is next
  // month.
  if (!loading && checkins.length === 0) return null

  if (loading || contactsQ.isLoading) {
    return <Skeleton className="h-[248px] w-full rounded-xl" />
  }

  const contacts = contactsQ.data ?? []
  if (contacts.length === 0) return null

  return (
    <ContactsOverviewCard
      contacts={contacts}
      rankingSystems={rankingSystems}
      groups={['demographics']}
      title={t('demographicsTitle')}
      subtitle={t('demographicsSubtitle', {
        shown: contacts.length,
        total: checkins.length,
      })}
    />
  )
}
