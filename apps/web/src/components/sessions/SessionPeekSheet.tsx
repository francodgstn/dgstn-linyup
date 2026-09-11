'use client'

import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { collection, doc, getDoc, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet'
import {
  Clock, MapPin, User, Users, BookOpen, CheckCircle2,
  ExternalLink, Pencil, Trash2, Repeat2, UserPlus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SeriesSummary } from '@/components/sessions/SeriesSummary'
import { SESSIONS_COLLECTION, PARTICIPANTS_SUBCOLLECTION, SESSION_BOOKINGS_SUBCOLLECTION } from '@linyup/shared'
import type { Session, Activity, Booking } from '@linyup/shared'
import type { Route } from 'next'
import { Tip } from '@/components/ui/tip'

const PARTICIPANTS_PREVIEW_LIMIT = 8

// Matches the palette used in SessionsCalendar / session detail page
const PALETTE = ['#7C3AED', '#EC4899', '#3B82F6', '#10B981', '#F59E0B', '#F43F5E', '#0EA5E9', '#22C55E']

function activityAccent(activityId?: string | null, activities: Activity[] = []): string {
  const custom = activities.find((a) => a.id === activityId)?.color
  if (custom) return custom
  if (!activityId) return PALETTE[0]
  let h = 0
  for (const ch of activityId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function formatDate(ts?: { toDate(): Date } | null) {
  if (!ts) return '—'
  return ts.toDate().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}
function formatTime(ts?: { toDate(): Date } | null) {
  if (!ts) return ''
  return ts.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

interface ParticipantDoc {
  id: string
  contact?: string
  firstname: string
  lastname: string
  avatar_url?: string | null
}

/**
 * A roster name in the peek, linked to the person's record — the same fix
 * UX-63 made on /bookings and UX-91 made on the session detail page. A row
 * with no contact id (a guest booking that never became a contact) stays text.
 */
function PeekName({ contactId, children }: { contactId?: string | null; children: ReactNode }) {
  if (!contactId) return <span className="text-sm truncate">{children}</span>
  return (
    <Link href={`/contacts/${contactId}` as Route} className="text-sm truncate hover:underline">
      {children}
    </Link>
  )
}

interface SessionPeekSheetProps {
  sessionId: string | null
  onClose: () => void
  activities: Activity[]
  onEdit: (s: Session) => void
  onDelete: (s: Session) => void
}

export function SessionPeekSheet({ sessionId, onClose, activities, onEdit, onDelete }: SessionPeekSheetProps) {
  const t = useTranslations('Calendar')
  const tS = useTranslations('Sessions')
  const open = !!sessionId

  // Same query keys as the session detail page → shared cache, instant full-page navigation
  const sessionQ = useQuery<Session | null>({
    queryKey: ['session', sessionId],
    enabled: open,
    queryFn: async () => {
      const snap = await getDoc(doc(db, SESSIONS_COLLECTION, sessionId!))
      if (!snap.exists()) return null
      return { id: snap.id, ...snap.data() } as Session
    },
  })

  const participantsQ = useQuery<ParticipantDoc[]>({
    queryKey: ['session-participants', sessionId],
    enabled: open,
    queryFn: async () => {
      const snap = await getDocs(collection(db, SESSIONS_COLLECTION, sessionId!, PARTICIPANTS_SUBCOLLECTION))
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as ParticipantDoc)
    },
  })

  const bookingsQ = useQuery<Booking[]>({
    queryKey: ['session-bookings', sessionId],
    enabled: open,
    queryFn: async () => {
      const snap = await getDocs(collection(db, SESSIONS_COLLECTION, sessionId!, SESSION_BOOKINGS_SUBCOLLECTION))
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Booking)
    },
  })

  const session = sessionQ.data
  const participants = participantsQ.data ?? []
  const pendingBookings = (bookingsQ.data ?? []).filter((b) => !b.status || b.status === 'pending')
  const accent = activityAccent(session?.activityId, activities)
  const visibleParticipants = participants.slice(0, PARTICIPANTS_PREVIEW_LIMIT)
  const moreCount = participants.length - visibleParticipants.length

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <SheetContent side="right" className="data-[side=right]:w-full data-[side=right]:sm:max-w-md gap-0 p-0">
        {/* Activity accent bar */}
        <div className="h-1 w-full shrink-0" style={{ background: accent }} />

        {sessionQ.isLoading && (
          <div className="p-4 space-y-3">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        )}

        {!sessionQ.isLoading && !session && (
          <div className="p-8 text-center text-sm text-muted-foreground">{t('peekNotFound')}</div>
        )}

        {session && (
          <>
            <SheetHeader className="pb-3">
              <div className="flex items-start gap-2 pr-8">
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <SheetTitle className="truncate">
                    {session.activityName ?? t('noActivity')}
                  </SheetTitle>
                  {session.seriesId && (
                    <Repeat2
                      className="h-4 w-4 text-muted-foreground shrink-0"
                      aria-label={tS('partOfSeries')}
                    />
                  )}
                  {session.status && session.status !== 'open' && (
                    <Badge
                      variant="outline"
                      className={cn('text-xs shrink-0', session.status === 'cancelled'
                        ? 'text-destructive border-destructive/30'
                        : 'text-amber-600 border-amber-300')}
                    >
                      {t(session.status === 'cancelled' ? 'statusCancelled' : 'statusFull')}
                    </Badge>
                  )}
                </div>
                {/* Action icons in the header — visible immediately without scrolling */}
                <div className="flex items-center gap-1 shrink-0 -mt-0.5">
                  <Tip label={t('peekEdit')}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onEdit(session)}
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
                      onClick={() => onDelete(session)}
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
                    {formatDate(session.start)} · {formatTime(session.start)}
                    {session.end ? ` – ${formatTime(session.end)}` : ''}
                  </span>
                </div>
                {session.location && (
                  <div className="flex items-center gap-2">
                    <MapPin className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{session.location}</span>
                  </div>
                )}
                {session.providerName && (
                  <div className="flex items-center gap-2">
                    <User className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{session.providerName}</span>
                  </div>
                )}
                {/* The repeating fact, spelled out: which pattern, and when it
                    stops. The loop glyph above says only "this repeats". */}
                {session.seriesId && (
                  <div className="flex items-center gap-2">
                    <Repeat2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      <SeriesSummary seriesId={session.seriesId} fallback={tS('partOfSeries')} />
                    </span>
                  </div>
                )}
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
              {/* Quick stats */}
              <div className="flex flex-wrap gap-2">
                <div className="flex items-center gap-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 px-2.5 py-1.5 text-xs font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {participants.length} {t('peekCheckIns')}
                </div>
                {pendingBookings.length > 0 && (
                  <div className="flex items-center gap-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 px-2.5 py-1.5 text-xs font-medium">
                    <BookOpen className="h-3.5 w-3.5" />
                    {pendingBookings.length} {t('peekPendingBookings')}
                  </div>
                )}
                {session.max_participants != null && (
                  // The only chip here without words on it — the two beside it
                  // say "Check-ins" and "Pending bookings" and this one says
                  // `1 / 12`, which could be either of them. It is neither: it
                  // is SEATS HELD against capacity.
                  <Tip label={t('peekCapacity')}>
                    <div className="flex items-center gap-1.5 rounded-lg bg-muted text-muted-foreground px-2.5 py-1.5 text-xs font-medium">
                      <Users className="h-3.5 w-3.5" />
                      {session.bookings_count ?? 0} / {session.max_participants}
                    </div>
                  </Tip>
                )}
                {session.allowBooking && (
                  <Badge variant="secondary" className="text-xs self-center">{t('peekBookingOpen')}</Badge>
                )}
              </div>

              {/* Notes */}
              {session.notes && (
                <p className="text-sm text-muted-foreground leading-relaxed border-l-2 pl-3" style={{ borderColor: accent }}>
                  {session.notes}
                </p>
              )}

              {/* Pending bookings */}
              {pendingBookings.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    {t('peekPendingBookings')}
                  </p>
                  <div className="space-y-0.5">
                    {pendingBookings.map((b) => (
                      <div key={b.id} className="flex items-center gap-2.5 py-1.5">
                        <div className="h-7 w-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-[10px] font-bold shrink-0">
                          {b.firstname?.[0]}{b.lastname?.[0]}
                        </div>
                        <PeekName contactId={b.contact}>{b.lastname} {b.firstname}</PeekName>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Check-ins */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  {t('peekCheckIns')}
                </p>
                {participantsQ.isLoading && (
                  <div className="space-y-2">
                    {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
                  </div>
                )}
                {!participantsQ.isLoading && participants.length === 0 && (
                  <p className="text-sm text-muted-foreground py-2">{t('peekNoCheckIns')}</p>
                )}
                <div className="space-y-0.5">
                  {visibleParticipants.map((p) => (
                    <div key={p.id} className="flex items-center gap-2.5 py-1.5">
                      <div className="h-7 w-7 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-[10px] font-bold shrink-0">
                        {p.firstname?.[0]}{p.lastname?.[0]}
                      </div>
                      <PeekName contactId={p.contact}>{p.lastname} {p.firstname}</PeekName>
                    </div>
                  ))}
                </div>
                {moreCount > 0 && (
                  <p className="text-xs text-muted-foreground mt-1.5">{t('peekMore', { count: moreCount })}</p>
                )}
              </div>
            </div>

            <SheetFooter className="flex-row items-center gap-2 border-t">
              <Link
                href={`/sessions/${session.id}` as Route}
                className={cn(buttonVariants({ variant: 'default' }), 'flex-1')}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('peekOpenFull')}
              </Link>
              <Link
                href={`/sessions/${session.id}` as Route}
                className={cn(buttonVariants({ variant: 'outline' }))}
                title="Add participant"
              >
                <UserPlus className="h-4 w-4" />
                Add participant
              </Link>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
