'use client'

// "WHAT'S NEXT" — the first thing the member portal says, and the thing it used
// not to say at all.
//
// Space Home opened with a card containing her own name and nothing else, then
// a membership block, then a shop menu. The single question a member opens a
// portal to answer — *am I in tomorrow's class, and when* — was two taps away on
// the bookings tab, while four separate links offered to sell her something
// (UX-38, UX-55). This card answers it above everything else, and when the
// answer is "nothing", it offers THE BOOKING SURFACE rather than the shop.
//
// It also carries the greeting, so the standalone welcome card is gone: two
// cards to say "hello {name}" and "here is your next class" is one card.
//
// A FAILED READ IS NOT AN EMPTY DIARY. "Nothing booked" would be a claim, and a
// member who is in fact booked would read it as a lost booking — the exact
// failure `getMyBookings` exists to have fixed. On failure this says the read
// failed and offers a retry.

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { CalendarClock, MapPin, UserRound, ChevronRight, CalendarPlus } from 'lucide-react'
import { QueryErrorState } from '@/components/ui/query-error'
import { Skeleton } from '@/components/ui/skeleton'
import { loadFailureDetail } from '@/lib/publicQueryError'
import { useSpaceAuth } from './SpaceAuthProvider'
import { useSpaceTheme } from './useSpaceTheme'
import { useSpaceNextBooking } from './useSpaceNextBooking'
import { usePublicFormat } from '../usePublicFormat'

interface Props {
  /** Whether `/public/{slug}/booking` is actually live for this studio — from
   *  `TeamPublicProfile.active_public_surfaces.booking`, the same world-readable
   *  signal the bio-link uses. No CTA is offered into a dead surface. */
  bookingLive: boolean
}

export function SpaceNextUpCard({ bookingLive }: Props) {
  const t = useTranslations('Space')
  const { slug, contact } = useSpaceAuth()
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const fmt = usePublicFormat()
  const { data: next, isPending, isError, error, refetch } = useSpaceNextBooking()

  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }
  const bookHref = `/public/${slug}/booking` as Route
  const start = next?.start ? new Date(next.start) : null
  const end = next?.end ? new Date(next.end) : null
  const validStart = start && !Number.isNaN(start.getTime()) ? start : null
  const validEnd = end && !Number.isNaN(end.getTime()) ? end : null

  return (
    <section className="rounded-2xl p-4" style={cardStyle}>
      <p className="text-xs" style={{ color: textMuted }}>
        {t('welcomeBackNamed', { name: contact?.firstname ?? '' })}
      </p>

      {isError ? (
        <div className="mt-3">
          <QueryErrorState
            onRetry={() => void refetch()}
            title={t('nextUpLoadFailed')}
            detail={loadFailureDetail(error)}
            theme={{ textMain, textMuted, accent, border: cardBorder }}
          />
        </div>
      ) : isPending ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-48" />
        </div>
      ) : next ? (
        <>
          <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: accent }}>
            {t('nextUpTitle')}
          </p>
          <div className="mt-1.5 flex items-start gap-3">
            <div
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
              style={{ background: `${accent}1f`, color: accent }}
            >
              {next.kind === 'appointment' ? (
                <UserRound className="h-5 w-5" />
              ) : (
                <CalendarClock className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-lg font-semibold leading-tight truncate" style={{ color: textMain }}>
                {next.activityName ??
                  (next.kind === 'appointment' ? t('bookingsAppointment') : t('bookingsSession'))}
              </p>
              <p className="text-sm" style={{ color: textMain }}>
                {validStart ? fmt.custom(validStart, { weekday: 'short', day: 'numeric', month: 'short' }) : ''}
                {validStart ? ` · ${fmt.time(validStart)}` : ''}
                {validEnd ? `–${fmt.time(validEnd)}` : ''}
              </p>
              {/* The provider is what tells two otherwise identical appointment
                  slots apart, so an appointment never drops it. */}
              {next.kind === 'appointment' && next.providerName && (
                <p className="mt-0.5 text-xs" style={{ color: textMuted }}>
                  {t('bookingsWithProvider', { name: next.providerName })}
                </p>
              )}
              {next.location && (
                <p className="mt-0.5 flex items-center gap-1 text-xs" style={{ color: textMuted }}>
                  <MapPin className="h-3 w-3" />
                  <span className="truncate">{next.location}</span>
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {bookingLive && (
              <Link
                href={bookHref}
                className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold"
                style={{ background: accent, color: '#fff' }}
              >
                <CalendarPlus className="h-4 w-4" />
                {t('bookAnother')}
              </Link>
            )}
            <Link
              href={`/public/${slug}/space/bookings` as Route}
              className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
              style={{ color: accent }}
            >
              {t('navBookings')}
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm" style={{ color: textMain }}>
            {t('nextUpNone')}
          </p>
          {bookingLive && (
            <Link
              href={bookHref}
              className="mt-3 inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold"
              style={{ background: accent, color: '#fff' }}
            >
              <CalendarPlus className="h-4 w-4" />
              {t('bookAClass')}
            </Link>
          )}
        </>
      )}
    </section>
  )
}
