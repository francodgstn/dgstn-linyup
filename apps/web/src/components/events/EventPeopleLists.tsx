'use client'

/**
 * WHO SAID YES, AND WHO WAS ASKED — the two people lists on an event.
 *
 * Extracted from the team event page so the ORG event page can show them too.
 * An organisation runs the federation's events (HMD's Fighting Cup is the case
 * that prompted it) and could see only the programme and the check-ins, which
 * is the half of the story that happens on the day.
 *
 * ── TENANT-AGNOSTIC, LIKE `ProgramTab` ─────────────────────────────────────
 * Both read `events/{eventId}/…`, a path with no tenant in it, so neither
 * component needs to know whose event it is. That is why this is a move rather
 * than a copy: a second implementation would be two lists drifting apart.
 *
 * ── EXCEPT FOR ONE THING: THE LINK ─────────────────────────────────────────
 * A name links to `/contacts/{id}`, which is a STUDIO route. An org-wide event
 * draws its RSVPs from every member studio, and an org admin opening one lands
 * on a page their membership does not let them read. So linking is a prop, off
 * by default, and org scope leaves the names as plain text rather than offering
 * a dead end.
 */

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import type { Route } from 'next'
import { db } from '@/lib/firebase'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EVENTS_COLLECTION, EVENT_ATTENDEES_SUBCOLLECTION, EVENT_INVITATIONS_SUBCOLLECTION } from '@linyup/shared'
import type { Timestamp } from 'firebase/firestore'

// The row shapes, owned HERE because both readers now live here. They were
// declared inside the team event page, which is exactly the sort of type that
// gets re-declared rather than imported the moment a second page needs it.
export interface EventAttendee {
  id: string
  contactId: string
  firstname?: string
  lastname?: string
  email?: string
  notes?: string | null
  respondedAt?: Timestamp
}

export interface EventInvitation {
  id: string
  contactId: string
  firstname?: string
  lastname?: string
  email?: string
  status?: 'sent' | 'opened' | 'responded' | 'declined'
  sentAt?: Timestamp
  firstOpenedAt?: Timestamp
  respondedAt?: Timestamp
}

function formatDateTime(ts?: { toDate(): Date } | null) {
  if (!ts) return '—'
  return ts.toDate().toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function invStatusVariant(status?: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'responded':
      return 'default'
    case 'opened':
      return 'secondary'
    case 'declined':
      return 'destructive'
    default:
      return 'outline'
  }
}

function PersonName({
  contactId,
  linkContacts,
  children,
}: {
  contactId?: string
  linkContacts: boolean
  children: ReactNode
}) {
  if (!contactId || !linkContacts) return <p className="text-sm font-medium">{children}</p>
  return (
    <Link href={`/contacts/${contactId}` as Route} className="text-sm font-medium hover:underline">
      {children}
    </Link>
  )
}

function RowSkeleton({ trailing }: { trailing?: boolean }) {
  return (
    <div className="flex gap-3 p-4 border-b last:border-0">
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-56" />
      </div>
      {trailing ? (
        <div className="space-y-1.5 shrink-0">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-3 w-24" />
        </div>
      ) : (
        <Skeleton className="h-3 w-20 shrink-0" />
      )}
    </div>
  )
}

/**
 * WHO ACCEPTED, not who came.
 *
 * The rows carry `respondedAt` and the invitee's reply note, and a DECLINE
 * deletes its row outright (`handleEventInvitationResponse`) — so this list is
 * the yeses, and the empty state says so rather than saying "no attendees".
 * Presence is the separate `checkins` collection, shown by the Check-ins tab.
 */
export function EventRsvpList({
  eventId,
  linkContacts = false,
}: {
  eventId: string
  linkContacts?: boolean
}) {
  const t = useTranslations('Events')
  const q = useQuery<EventAttendee[]>({
    queryKey: ['event-attendees', eventId],
    enabled: !!eventId,
    queryFn: async () => {
      const snap = await getDocs(collection(db, EVENTS_COLLECTION, eventId, EVENT_ATTENDEES_SUBCOLLECTION))
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as EventAttendee)
    },
  })

  return (
    <div className="rounded-xl border overflow-hidden bg-card">
      {q.isLoading && Array.from({ length: 4 }).map((_, i) => <RowSkeleton key={i} />)}

      {!q.isLoading && (q.data?.length ?? 0) === 0 && (
        <div className="py-14 text-center text-muted-foreground text-sm">
          {t('detail_rsvpsEmpty')}
        </div>
      )}

      {!q.isLoading &&
        q.data?.map((a) => (
          <div key={a.id} className="flex items-start gap-3 p-4 border-b last:border-0">
            <div className="flex-1 min-w-0">
              <PersonName contactId={a.contactId} linkContacts={linkContacts}>
                {[a.firstname, a.lastname].filter(Boolean).join(' ') || a.contactId}
              </PersonName>
              {a.email && <p className="text-xs text-muted-foreground mt-0.5">{a.email}</p>}
              {a.notes && (
                <p className="text-xs text-muted-foreground/70 italic mt-0.5">&quot;{a.notes}&quot;</p>
              )}
            </div>
            {a.respondedAt && (
              <span className="text-xs text-muted-foreground shrink-0 mt-0.5">
                {formatDateTime(a.respondedAt)}
              </span>
            )}
          </div>
        ))}
    </div>
  )
}

/** Who was asked, and what came back. Newest first. */
export function EventInvitationList({
  eventId,
  linkContacts = false,
}: {
  eventId: string
  linkContacts?: boolean
}) {
  const t = useTranslations('Events')
  const q = useQuery<EventInvitation[]>({
    queryKey: ['event-invitations', eventId],
    enabled: !!eventId,
    queryFn: async () => {
      const snap = await getDocs(
        query(collection(db, EVENTS_COLLECTION, eventId, EVENT_INVITATIONS_SUBCOLLECTION), orderBy('sentAt', 'desc'))
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as EventInvitation)
    },
  })

  return (
    <div className="rounded-xl border overflow-hidden bg-card">
      {q.isLoading && Array.from({ length: 5 }).map((_, i) => <RowSkeleton key={i} trailing />)}

      {!q.isLoading && (q.data?.length ?? 0) === 0 && (
        <div className="py-14 text-center text-muted-foreground text-sm">
          {t('detail_invitationsEmpty')}
        </div>
      )}

      {!q.isLoading &&
        q.data?.map((inv) => (
          <div key={inv.id} className="flex items-center gap-3 p-4 border-b last:border-0">
            <div className="flex-1 min-w-0">
              <PersonName contactId={inv.contactId} linkContacts={linkContacts}>
                {[inv.firstname, inv.lastname].filter(Boolean).join(' ') || inv.contactId}
              </PersonName>
              {inv.email && <p className="text-xs text-muted-foreground mt-0.5">{inv.email}</p>}
            </div>
            <div className="flex flex-col items-end gap-0.5 shrink-0">
              <Badge variant={invStatusVariant(inv.status)} className="text-xs">
                {t(`detail_invStatus_${inv.status ?? 'sent'}` as Parameters<typeof t>[0])}
              </Badge>
              {inv.sentAt && (
                <span className="text-xs text-muted-foreground">{formatDateTime(inv.sentAt)}</span>
              )}
            </div>
          </div>
        ))}
    </div>
  )
}
