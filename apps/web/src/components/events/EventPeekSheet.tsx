'use client'

import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet'
import {
  Clock,
  MapPin,
  User,
  Users,
  Mail,
  CreditCard,
  ExternalLink,
  Pencil,
  Trash2,
  UserPlus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { eventTypeColor } from '@/lib/eventTypeColor'
import { EVENTS_COLLECTION } from '@linyup/shared'
import type { Event } from '@linyup/shared'
import type { Route } from 'next'
import { Tip } from '@/components/ui/tip'

// Matches the event-type palette used in SessionsCalendar
const BUILTIN_TYPES = ['competition', 'camp', 'exam', 'seminar', 'workshop']

function formatDate(ts?: { toDate(): Date } | null) {
  if (!ts) return '—'
  return ts.toDate().toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}
function formatTime(ts?: { toDate(): Date } | null) {
  if (!ts) return ''
  return ts.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

interface EventPeekSheetProps {
  eventId: string | null
  onClose: () => void
  onEdit: (e: Event) => void
  onDelete: (e: Event) => void
}

export function EventPeekSheet({ eventId, onClose, onEdit, onDelete }: EventPeekSheetProps) {
  const t = useTranslations('Calendar')
  const tE = useTranslations('Events')
  const open = !!eventId

  // Same query key as the event detail page → shared cache, instant full-page navigation
  const eventQ = useQuery<Event | null>({
    queryKey: ['event', eventId],
    enabled: open,
    queryFn: async () => {
      const snap = await getDoc(doc(db, EVENTS_COLLECTION, eventId!))
      if (!snap.exists()) return null
      return { id: snap.id, ...snap.data() } as Event
    },
  })

  const event = eventQ.data
  const accent = eventTypeColor(event?.type)
  const typeLabel = event
    ? BUILTIN_TYPES.includes(event.type)
      ? tE(`type_${event.type}` as Parameters<typeof tE>[0])
      : event.type
    : ''
  // RSVPs ONLY. This fell back to `participants_count` — the CHECK-IN count —
  // and then labelled whichever it found with the same word, so an event with
  // no acceptances and twelve people through the door reported "12 RSVPs".
  // They are different facts; the fallback silently substituted one for the
  // other.
  const rsvps = event?.attendees_count ?? 0
  const invitations = event?.invitations_sent_count ?? 0

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <SheetContent
        side="right"
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-md gap-0 p-0"
      >
        {/* Event-type accent bar */}
        <div className="h-1 w-full shrink-0" style={{ background: accent }} />

        {eventQ.isLoading && (
          <div className="p-4 space-y-3">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        )}

        {!eventQ.isLoading && !event && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {t('peekEventNotFound')}
          </div>
        )}

        {event && (
          <>
            <SheetHeader className="pb-3">
              <div className="flex items-start gap-2 pr-8">
                <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                  <SheetTitle className="truncate">{event.title}</SheetTitle>
                  <Badge
                    variant="secondary"
                    className="text-xs shrink-0"
                    style={{ backgroundColor: `${accent}1F`, color: accent }}
                  >
                    {typeLabel}
                  </Badge>
                  {event.scope === 'org' && (
                    <Badge variant="outline" className="text-xs shrink-0">
                      Org
                    </Badge>
                  )}
                  {event.status === 'cancelled' && (
                    <Badge
                      variant="outline"
                      className="text-xs shrink-0 text-destructive border-destructive/30"
                    >
                      {t('statusCancelled')}
                    </Badge>
                  )}
                </div>
                {/* Action icons in the header — visible immediately without scrolling */}
                <div className="flex items-center gap-1 shrink-0 -mt-0.5">
                  <Tip label={t('peekEdit')}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onEdit(event)}
                      aria-label={t('peekEdit')}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </Tip>
                  <Tip label={t('peekDelete')}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => onDelete(event)}
                      aria-label={t('peekDelete')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </Tip>
                </div>
              </div>
              <div className="space-y-1.5 text-sm text-muted-foreground mt-1">
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    {formatDate(event.start)} · {formatTime(event.start)}
                    {event.end ? ` – ${formatTime(event.end)}` : ''}
                  </span>
                </div>
                {event.location && (
                  <div className="flex items-center gap-2">
                    <MapPin className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{event.location}</span>
                  </div>
                )}
                {event.coachName && (
                  <div className="flex items-center gap-2">
                    <User className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{event.coachName}</span>
                  </div>
                )}
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
              {/* Quick stats */}
              <div className="flex flex-wrap gap-2">
                <div className="flex items-center gap-1.5 rounded-lg bg-muted text-muted-foreground px-2.5 py-1.5 text-xs font-medium">
                  <Users className="h-3.5 w-3.5" />
                  {rsvps} {tE('detail_tabRsvps')}
                </div>
                {invitations > 0 && (
                  <div className="flex items-center gap-1.5 rounded-lg bg-muted text-muted-foreground px-2.5 py-1.5 text-xs font-medium">
                    <Mail className="h-3.5 w-3.5" />
                    {invitations} {tE('detail_tabInvitations')}
                  </div>
                )}
                {event.fee != null && event.fee > 0 && (
                  <div className="flex items-center gap-1.5 rounded-lg bg-muted text-muted-foreground px-2.5 py-1.5 text-xs font-medium">
                    <CreditCard className="h-3.5 w-3.5" />
                    {tE('fieldFee')}: {event.fee}
                  </div>
                )}
              </div>

              {/* Description */}
              {event.description && (
                <p
                  className="text-sm text-muted-foreground leading-relaxed border-l-2 pl-3"
                  style={{ borderColor: accent }}
                >
                  {event.description}
                </p>
              )}
            </div>

            <SheetFooter className="flex-row items-center gap-2 border-t">
              <Link
                href={`/events/${event.id}` as Route}
                className={cn(buttonVariants({ variant: 'default' }), 'flex-1')}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('peekOpenFull')}
              </Link>
              <Link
                href={`/events/${event.id}` as Route}
                className={cn(buttonVariants({ variant: 'outline' }))}
                title="Add check-in"
              >
                <UserPlus className="h-4 w-4" />
                Add check-in
              </Link>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
