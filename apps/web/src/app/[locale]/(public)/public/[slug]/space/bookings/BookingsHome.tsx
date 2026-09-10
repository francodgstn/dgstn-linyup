'use client'

import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { httpsCallable } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import { useTranslations } from 'next-intl'
import { CalendarClock, MapPin, X, UserRound, Loader2 } from 'lucide-react'
import type { BookingCancelEffect, CancelBookingResult, MyBooking, MyBookingsResult } from '@linyup/shared'
import {
  cancelEffectKeys,
  cancelFailureIsRetryable,
  cancelFailureKey,
} from '@/lib/bookingCancellation'
import { QueryErrorState } from '@/components/ui/query-error'
import {
  loadFailureDetail,
  reportPublicActionFailure,
  reportPublicLoadFailure,
} from '@/lib/publicQueryError'
import SpaceSignInWall from '../SpaceSignInWall'
import { useSpaceAuth } from '../SpaceAuthProvider'
import { useSpaceTheme } from '../useSpaceTheme'
import { usePublicFormat } from '../../usePublicFormat'

// "My bookings" — one server read of HER bookings, through `getMyBookings`.
//
// It used to be a client fan-out: list the TEAM's next 80 public session
// mirrors, then `getDoc` each one's `bookings/{contactId}`. That was wrong three
// ways (UX-10) and only the first was visible. It filtered on
// `type == 'session'`, and an appointment is mirrored as
// `type == 'appointment_session'` — so a member holding a paid appointment was
// told, flatly, that she had none. It truncated at 80 mirrors of the STUDIO's
// schedule, so her list got shorter as the studio got busier. And a session is
// mirrored at all only while `allowBooking` is true, so a booking the studio
// entered for her had no public document to be found through.
//
// The last of those is why this is a callable and not a widened query: the
// server reads `sessions` directly, so what the studio happens to be selling
// online stops deciding what the member can see she has booked.
//
// Cost: 80 mirror documents + up to 80 `getDoc` per visit, before. One callable
// round trip now.

function formatDate(iso: string | null): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

export default function BookingsHome() {
  const t = useTranslations('Space')
  const tCancel = useTranslations('BookingCancellation')
  const { teamId, contact, isAuthenticated } = useSpaceAuth()
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const fmt = usePublicFormat()
  const contactId = contact?.id ?? null
  const [cancelling, setCancelling] = useState<string | null>(null)
  // Which booking's cancel failed, and why — held per booking so the sentence
  // appears on the row whose button was pressed, next to the button. `key` is a
  // `BookingCancellation` message key; `retryable` is true ONLY for a failure
  // that could plausibly succeed on a second press.
  const [cancelError, setCancelError] = useState<{
    id: string
    key: string
    retryable: boolean
  } | null>(null)
  // Cancel is a two-step press on this surface: the first arms it (and states
  // what cancelling returns), the second does it. It used to fire on one click
  // with no confirmation and no explanation — for a destructive action on
  // something the member may have paid for.
  const [confirming, setConfirming] = useState<string | null>(null)
  // What the last cancellation gave back. The row it belonged to is gone by the
  // time this renders, so it lives above the list rather than on the row.
  const [cancelled, setCancelled] = useState<BookingCancelEffect | null>(null)

  // `isError` is read, not ignored: a failed read must not render as "you have
  // no bookings" — a member who cannot see her booking assumes it was lost.
  // The visitor-facing state and the developer-facing trace are two separate
  // obligations, so the query also logs (see lib/publicQueryError.ts): without
  // it this is the one Tier-1 public surface a failure leaves no record of.
  //
  // Paged, not capped: the server walks back through HER OWN reservations, and
  // a full page means her history continues rather than that her list ends. In
  // practice page one is the whole answer — a booking for an upcoming session
  // is almost always among the most recently made ones — so the "check for
  // more" control below is an offer, not a chore.
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['space-bookings', teamId, contactId],
    enabled: isAuthenticated && !!teamId && !!contactId,
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam }): Promise<MyBookingsResult> => {
      try {
        const fn = httpsCallable<{ teamId: string; cursor: number | null }, MyBookingsResult>(
          functions,
          'getMyBookings'
        )
        const res = await fn({ teamId: teamId ?? '', cursor: pageParam })
        return res.data ?? { bookings: [], cursor: null, scanned: 0 }
      } catch (err: unknown) {
        reportPublicLoadFailure('space/bookings', err)
        throw err
      }
    },
    // Stop when the server stops moving: the cursor is inclusive of its own
    // boundary document, so a page that returns the cursor it was given has
    // nothing further to walk to.
    getNextPageParam: (last, _pages, lastParam) =>
      last.cursor !== null && last.cursor !== lastParam ? last.cursor : undefined,
  })

  // One booking per session per contact, so `sessionId` is a key and not just a
  // grouping — which is what makes the inclusive page boundary harmless.
  const bookings: MyBooking[] = Array.from(
    new Map(
      (data?.pages ?? []).flatMap((page) => page.bookings).map((b) => [b.sessionId, b])
    ).values()
  ).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))

  // The cancel is the one WRITE on this page, and it used to fail into nothing:
  // no sentence for the member, no line in the console. The old note said a
  // refetch kept the list honest anyway — it does not, because the refetch is
  // inside the try, after the call that just threw. So the row stayed exactly as
  // it was, which is precisely how a successful cancel would look mid-refresh:
  // the member reads "nothing happened", presses Cancel again, and the studio
  // gets a person who believes they are out of a class they are still booked
  // into (or a second attempt against a cutoff rule that refused the first).
  async function cancel(b: MyBooking) {
    if (!b.cancelToken) return
    setCancelling(b.sessionId)
    setCancelError(null)
    try {
      const fn = httpsCallable<{ token: string }, CancelBookingResult>(functions, 'cancelBooking')
      const res = await fn({ token: b.cancelToken })
      // The server says what it gave back; the banner repeats that answer. A
      // returned lesson credit is the single most useful thing this surface can
      // tell her, and it used to say nothing at all.
      setCancelled(res.data?.returned ?? { credit: false, usageUnit: false, paid: false })
      setConfirming(null)
      await refetch()
    } catch (err: unknown) {
      reportPublicActionFailure('space/cancel-booking', err)
      // Deliberately NO refetch here: the list is unchanged because the cancel
      // did not happen, and re-reading it would only redraw the same row under
      // the message. The booking is still live — which is what the sentence says.
      //
      // WHICH sentence is the fix for the old one: every refusal cancelBooking
      // gives is permanent (the class started, the studio checked her in, the
      // booking is already gone), and the single message it used to show ended
      // "Please try again". `cancelFailureKey` names what actually happened, and
      // the button is withdrawn unless a retry could work.
      setCancelError({
        id: b.sessionId,
        key: cancelFailureKey(err),
        retryable: cancelFailureIsRetryable(err),
      })
    } finally {
      setCancelling(null)
    }
  }

  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }

  if (!isAuthenticated) {
    return <SpaceSignInWall prompt={t('bookingsSignInPrompt')} />
  }

  return (
    <div className="mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide mb-4" style={{ color: textMuted }}>
        {t('bookingsTitle')}
      </h2>

      {/* The cancelled booking's row is gone by now, so the answer lives here.
          "Cancelled" alone was the old behaviour and it left the one question
          she actually has — what happened to my credit — unanswered. */}
      {cancelled && (
        <div className="mb-4 rounded-2xl p-3.5" style={cardStyle}>
          <p className="text-sm font-semibold" style={{ color: textMain }}>
            {t('bookingsCancelDone')}
          </p>
          {cancelEffectKeys(cancelled, 'did').map((key) => (
            <p key={key} className="text-xs mt-1" style={{ color: textMuted }}>
              {tCancel(key)}
            </p>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="h-6 w-6 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: accent, borderTopColor: 'transparent' }} />
        </div>
      ) : isError ? (
        <QueryErrorState
          onRetry={() => void refetch()}
          title={t('bookingsLoadFailed')}
          detail={loadFailureDetail(error)}
          theme={{ textMain, textMuted, accent, border: cardBorder }}
        />
      ) : (
        <div className="space-y-2.5">
          {/* Empty is stated even when a further page can still be asked for —
              the sentence and the offer to look further back are two different
              things, and hiding the first would leave a bare button. */}
          {bookings.length === 0 && (
            <p className="text-sm text-center py-12" style={{ color: textMuted }}>{t('bookingsEmpty')}</p>
          )}
          {bookings.map((b) => {
            const start = formatDate(b.start)
            const end = formatDate(b.end)
            const isAppointment = b.kind === 'appointment'
            const Icon = isAppointment ? UserRound : CalendarClock
            return (
              <div key={b.sessionId} className="flex items-center gap-3 rounded-2xl p-3.5" style={cardStyle}>
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: `${accent}1f`, color: accent }}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate" style={{ color: textMain }}>
                    {b.activityName ?? (isAppointment ? t('bookingsAppointment') : t('bookingsSession'))}
                  </p>
                  <p className="text-xs" style={{ color: textMuted }}>
                    {start ? fmt.custom(start, { weekday: 'short', day: 'numeric', month: 'short' }) : ''}
                    {start ? ` · ${fmt.time(start)}` : ''}
                    {end ? `–${fmt.time(end)}` : ''}
                  </p>
                  {/* The provider is what tells two otherwise identical
                      appointment slots apart, so it is never dropped from an
                      appointment row. */}
                  {isAppointment && b.providerName && (
                    <p className="text-xs mt-0.5" style={{ color: textMuted }}>
                      {t('bookingsWithProvider', { name: b.providerName })}
                    </p>
                  )}
                  {b.location && (
                    <p className="text-xs flex items-center gap-1 mt-0.5" style={{ color: textMuted }}>
                      <MapPin className="h-3 w-3" /> <span className="truncate">{b.location}</span>
                    </p>
                  )}
                  {/* A called-off session stays on the list and says so. A
                      booking that simply disappears is read as a booking that
                      was lost — which is the failure this whole surface is
                      being repaired for. */}
                  {b.sessionCancelled && (
                    <p className="text-xs mt-1 font-medium" style={{ color: '#dc2626' }}>
                      {t('bookingsCancelledByStudio')}
                    </p>
                  )}
                  {/* Armed, not yet done: what cancelling gives back, stated
                      before the second press rather than after it. */}
                  {confirming === b.sessionId &&
                    cancelEffectKeys(b.cancelEffect, 'will').map((key) => (
                      <p key={key} className="text-xs mt-1" style={{ color: textMuted }}>
                        {tCancel(key)}
                      </p>
                    ))}
                  {cancelError?.id === b.sessionId && (
                    <p role="alert" className="text-xs mt-1" style={{ color: '#dc2626' }}>
                      {tCancel(cancelError.key)}
                    </p>
                  )}
                </div>
                {/* Shown only when the server says `cancelBooking` will accept
                    it — the token comes back only in that case, so the button
                    cannot be offered for a call that is going to refuse. And
                    withdrawn again once it HAS refused for a permanent reason,
                    so the member is not invited to press into the same wall. */}
                {b.cancellable &&
                  b.cancelToken &&
                  !(cancelError?.id === b.sessionId && !cancelError.retryable) && (
                    <div className="shrink-0 flex items-center gap-1.5">
                      {confirming === b.sessionId && (
                        <button
                          onClick={() => setConfirming(null)}
                          disabled={cancelling === b.sessionId}
                          className="rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                          style={{ border: `1px solid ${cardBorder}`, color: textMuted }}
                        >
                          {t('bookingsCancelKeep')}
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (confirming === b.sessionId) void cancel(b)
                          else {
                            setCancelError(null)
                            setCancelled(null)
                            setConfirming(b.sessionId)
                          }
                        }}
                        disabled={cancelling === b.sessionId}
                        className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                        style={
                          confirming === b.sessionId
                            ? { background: '#dc2626', color: '#fff' }
                            : { border: `1px solid ${cardBorder}`, color: textMuted }
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                        {cancelling === b.sessionId
                          ? t('cancelling')
                          : confirming === b.sessionId
                            ? t('bookingsCancelConfirm')
                            : t('bookingsCancel')}
                      </button>
                    </div>
                  )}
              </div>
            )
          })}

          {hasNextPage && (
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full inline-flex items-center justify-center gap-2 rounded-2xl py-2.5 text-xs font-medium disabled:opacity-60"
              style={{ border: `1px solid ${cardBorder}`, color: textMuted }}
            >
              {isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('bookingsLoadMore')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
