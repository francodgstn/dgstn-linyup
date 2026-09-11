'use client'

// The rebook picker — extracted from `bookings/page.tsx` so the per-contact
// Bookings tab can offer the same "move to a different session" flow through
// the same dialog. A pure move; `useFutureSessions` and `RebookDialog` are
// unchanged from the page's originals.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { Booking } from '@linyup/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { tsToDate } from './BookingRow'
import { SESSIONS_COLLECTION } from '@linyup/shared'

/** Stable identity for the rebook picker before its exclusion set has loaded. */
export const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set<string>()

// Future sessions available for rebooking — read only once the rebook dialog is
// actually open, since nothing else on the page looks at them.
export function useFutureSessions(teamId: string | null, enabled: boolean) {
  return useQuery<{ id: string; activityName?: string; start?: string; end?: string }[]>({
    queryKey: ['future-sessions', teamId],
    enabled: !!teamId && enabled,
    staleTime: 2 * 60 * 1000,
    queryFn: async () => {
      if (!teamId) return []
      const now = new Date()
      const q = query(
        collection(db, SESSIONS_COLLECTION),
        where('teamId', '==', teamId),
        where('allowBooking', '==', true),
        orderBy('start', 'asc'),
        limit(50)
      )
      const snap = await getDocs(q)
      return snap.docs
        .map((d) => {
          const data = d.data()
          const start = tsToDate(data.start)
          return {
            id: d.id,
            activityName: data.activityName as string | undefined,
            start: start?.toISOString(),
            end: tsToDate(data.end)?.toISOString(),
          }
        })
        .filter((s) => s.start && new Date(s.start) > now)
    },
  })
}

export function RebookDialog({
  booking,
  futureSessions,
  bookedSessionIds,
  loadingOptions,
  onConfirm,
  onClose,
  loading,
}: {
  booking: Booking
  futureSessions: { id: string; activityName?: string; start?: string; end?: string }[]
  bookedSessionIds: ReadonlySet<string>
  /** The picker's two queries are fired by this dialog OPENING, so it draws
   *  first with nothing. Without this it announces "no other bookable sessions"
   *  for the length of a round trip and then silently repopulates under the
   *  manager — a false negative on the one screen that has to be trusted. */
  loadingOptions: boolean
  onConfirm: (newSessionId: string) => void
  onClose: () => void
  loading: boolean
}) {
  const t = useTranslations('Bookings')
  const [selectedId, setSelectedId] = useState('')

  const options = futureSessions.filter(
    (s) => s.start && new Date(s.start) > new Date() && !bookedSessionIds.has(s.id)
  )

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('rebookTitle')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('rebookDesc', { name: `${booking.firstname} ${booking.lastname}` })}
        </p>
        {loadingOptions ? (
          <Skeleton className="h-9 w-full rounded-md" />
        ) : options.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('rebookNoSessions')}</p>
        ) : (
          <Select value={selectedId} onValueChange={(v) => setSelectedId(v ?? '')}>
            <SelectTrigger>
              <span className="flex flex-1 text-left text-sm truncate">
                {(() => {
                  const selected = options.find((s) => s.id === selectedId)
                  if (!selected)
                    return <span className="text-muted-foreground">{t('rebookPickSession')}</span>
                  const start = selected.start ? new Date(selected.start) : null
                  return start
                    ? `${selected.activityName ?? '—'} · ${start.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                    : (selected.activityName ?? selected.id)
                })()}
              </span>
            </SelectTrigger>
            <SelectContent>
              {options.map((s) => {
                const start = s.start ? new Date(s.start) : null
                const end = s.end ? new Date(s.end) : null
                const label = start
                  ? start.toLocaleDateString([], {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                    }) +
                    ' ' +
                    start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
                    (end
                      ? ' – ' + end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                      : '')
                  : s.id
                return (
                  <SelectItem key={s.id} value={s.id} label={s.activityName ?? '—'}>
                    {label}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {t('rebookCancel')}
          </Button>
          <Button
            onClick={() => selectedId && onConfirm(selectedId)}
            disabled={loading || !selectedId}
          >
            {loading ? t('rebookInProgress') : t('rebookConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
