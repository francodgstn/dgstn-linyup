'use client'

// The booking ROW — shared by the general /bookings list and the per-contact
// Bookings tab, so the two surfaces render one booking identically and share
// one action menu rather than growing a second, silently-diverging one.
// Everything a caller needs to draw a row lives here: the date/avatar/status
// helpers, the BookingStatus vocabulary + its Badge variant, and the row
// itself. Extracted from `bookings/page.tsx` — a pure move, not a redesign.
//
// `showContact` mirrors `PaymentsTable`'s flag of the same name: on a
// contact-scoped view the avatar, the name link and the "View contact" menu
// item all point at the page the reader is already on, so they are dropped
// and the row leads with the CLASS instead.

import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Link, useRouter } from '@/i18n/navigation'
import type { Booking } from '@linyup/shared'
import { personInitials } from '@linyup/shared'
import { avatarColor } from '@/lib/colors'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  MoreHorizontal,
  Check,
  X,
  UserX,
  Undo,
  Repeat,
  ExternalLink,
  User,
  CalendarDays,
} from 'lucide-react'
import type { SessionInfo } from '@/hooks/useBookingsWindow'
import type { BookingAction } from '@/hooks/useBookingActions'

// ─── helpers ──────────────────────────────────────────────────────────────────

export function tsToDate(ts: unknown): Date | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: unknown }).toDate === 'function')
    return (ts as { toDate(): Date }).toDate()
  if (typeof (ts as { seconds?: unknown }).seconds === 'number')
    return new Date((ts as { seconds: number }).seconds * 1000)
  return null
}

export function formatDate(ts: unknown): string {
  const d = tsToDate(ts)
  if (!d) return '—'
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatTime(ts: unknown): string {
  const d = tsToDate(ts)
  if (!d) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatIso(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return (
    d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  )
}

// ─── status vocabulary ─────────────────────────────────────────────────────────
// ONE vocabulary for a booking's status, now shared by both mounts. The
// bookings page used to style `no_show` `secondary`; the contact tab's own
// copy (`BOOKING_STATUS_KEY`, now deleted) styled it `destructive`. Sharing a
// row settles the disagreement rather than picking a side silently: a no-show
// is a seat that was held and wasted, so it reads RED at a glance on every
// surface now, not just the one that happened to write it that way first.
// `cancelled` stays `destructive` too — the two are told apart by their
// label, not their colour (Franco, 2026-08-29).

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'no_show' | 'rebooked'

export const STATUS_VARIANT: Record<
  BookingStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  pending: 'outline',
  confirmed: 'default',
  cancelled: 'destructive',
  no_show: 'destructive',
  rebooked: 'secondary',
}

/** The ONE status-label builder, so every caller labels a status identically —
 *  a second copy of this switch is exactly how the two surfaces would drift. */
export function buildBookingStatusLabels(
  t: ReturnType<typeof useTranslations<'Bookings'>>
): Record<BookingStatus, string> {
  return {
    pending: t('statusPending'),
    confirmed: t('statusConfirmed'),
    cancelled: t('statusCancelled'),
    no_show: t('statusNoShow'),
    rebooked: t('statusRebooked'),
  }
}

// ─── row ──────────────────────────────────────────────────────────────────────

export function BookingRow({
  booking,
  sessionInfo,
  statusLabel,
  showContact = true,
  onAction,
  onRebook,
}: {
  booking: Booking
  sessionInfo?: SessionInfo
  statusLabel: Record<BookingStatus, string>
  /** Hide the avatar, the name link and the "View contact" menu item — the
   *  contact IS the page on a contact-scoped view, so repeating it on every
   *  row is redundant, and the row leads with the CLASS instead. Same
   *  reasoning as `PaymentsTable`'s `showContact`. */
  showContact?: boolean
  onAction: (booking: Booking, action: BookingAction) => void
  onRebook: (booking: Booking) => void
}) {
  const t = useTranslations('Bookings')
  const router = useRouter()
  const status: BookingStatus = (booking.status as BookingStatus) ?? 'pending'
  // `formatIso` already renders the day AND the start time. A second
  // `formatTime` call sat here casting the ISO string to a Timestamp shape it
  // never had, so it returned '' and printed nothing; spelled honestly it would
  // print the time twice.
  const sessionDate = sessionInfo?.start ? formatIso(sessionInfo.start) : null
  const activityName = sessionInfo?.activityName

  const isPending = status === 'pending'
  const isConfirmed = status === 'confirmed'
  const isNoShow = status === 'no_show'
  const isActive = isPending || isConfirmed || isNoShow

  const sessionLine = (
    <>
      <span className="text-muted-foreground font-normal">{t('labelClassDate')} </span>
      {activityName && <span>{activityName}</span>}
      {activityName && sessionDate && <span className="text-muted-foreground font-normal"> · </span>}
      {sessionDate && <span>{sessionDate}</span>}
    </>
  )

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b last:border-0 group">
      {showContact ? (
        <div
          className={`h-10 w-10 rounded-full shrink-0 flex items-center justify-center text-white text-sm font-semibold ${avatarColor(booking.id)}`}
        >
          {personInitials(booking)}
        </div>
      ) : (
        // The contact-scoped row loses the identity avatar (the contact IS the
        // page) but keeps a leading tile so the row doesn't start flush left —
        // a CalendarDays mark instead, since the row now leads with the class.
        <div className="h-10 w-10 rounded-full shrink-0 flex items-center justify-center bg-primary/10">
          <CalendarDays className="h-4 w-4 text-primary" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        {showContact && (
          <>
            {/* The two entities a booking row is ABOUT are its contact and its
                session, and both used to be reachable only through the row's action
                menu — so the most common thing to do with a row cost a menu open.
                They are links now; the menu keeps the actions. */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {booking.contact ? (
                <Link
                  href={`/contacts/${booking.contact}` as Route}
                  className="font-medium text-sm truncate hover:underline"
                >
                  {booking.firstname} {booking.lastname}
                </Link>
              ) : (
                <p className="font-medium text-sm truncate">
                  {booking.firstname} {booking.lastname}
                </p>
              )}
              {booking.is_new_contact && (
                <Badge variant="outline" className="text-xs shrink-0">
                  {t('trialBadge')}
                </Badge>
              )}
            </div>
            {/* The reference rides with the email because it is the other thing a
                caller can read out. Until now it was minted, mailed to the contact
                and never shown to the studio, so a phone call about "booking
                BK-7F3K9Q" had nowhere to land. */}
            <p className="text-xs text-muted-foreground truncate">
              {booking.email ?? '—'}
              {booking.booking_reference && (
                <span className="ml-1.5">
                  · {t('labelReference')} <span className="font-mono">{booking.booking_reference}</span>
                </span>
              )}
            </p>
          </>
        )}
        {(activityName || sessionDate) &&
          (booking.session ? (
            <Link
              href={`/sessions/${booking.session}` as Route}
              className={`block text-sm text-foreground/80 truncate font-medium hover:underline ${showContact ? 'mt-0.5' : ''}`}
            >
              {sessionLine}
            </Link>
          ) : (
            <p
              className={`text-sm text-foreground/80 truncate font-medium ${showContact ? 'mt-0.5' : ''}`}
            >
              {sessionLine}
            </p>
          ))}
        {/* Contact-scoped: the trial badge + reference move down here since the
            name line above (where they used to live) is gone. */}
        {!showContact && (booking.is_new_contact || booking.booking_reference) && (
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5 text-xs text-muted-foreground">
            {booking.is_new_contact && (
              <Badge variant="outline" className="text-xs shrink-0">
                {t('trialBadge')}
              </Badge>
            )}
            {booking.booking_reference && (
              <span>
                {t('labelReference')} <span className="font-mono">{booking.booking_reference}</span>
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <div className="hidden sm:flex flex-col items-end gap-1">
          <Badge variant={STATUS_VARIANT[status]} className="text-xs">
            {statusLabel[status]}
          </Badge>
          {/* Two dates show on a row and only one of them is the one the filter
              is ranging on, so both say which they are. */}
          <p className="text-xs text-muted-foreground">
            {t('labelBookedOn')} {formatDate(booking.joinedAt as Parameters<typeof formatDate>[0])}
            {formatTime(booking.joinedAt as Parameters<typeof formatTime>[0]) && (
              <> · {formatTime(booking.joinedAt as Parameters<typeof formatTime>[0])}</>
            )}
          </p>
        </div>
        <div className="flex sm:hidden">
          <Badge variant={STATUS_VARIANT[status]} className="text-xs">
            {statusLabel[status]}
          </Badge>
        </div>

        {isActive && (
          <DropdownMenu>
            <DropdownMenuTrigger className="h-8 w-8 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent">
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {isPending && (
                <DropdownMenuItem onClick={() => onAction(booking, 'confirm')} className="gap-2">
                  <Check className="h-3.5 w-3.5 text-green-600" />
                  {t('actionConfirm')}
                </DropdownMenuItem>
              )}
              {isConfirmed && (
                <DropdownMenuItem onClick={() => onAction(booking, 'revert')} className="gap-2">
                  <Undo className="h-3.5 w-3.5 text-orange-500" />
                  {t('actionRevert')}
                </DropdownMenuItem>
              )}
              {(isPending || isNoShow) && (
                <DropdownMenuItem onClick={() => onAction(booking, 'no_show')} className="gap-2">
                  <UserX className="h-3.5 w-3.5 text-orange-500" />
                  {t('actionNoShow')}
                </DropdownMenuItem>
              )}
              {isPending && booking.booking_token && (
                <DropdownMenuItem onClick={() => onRebook(booking)} className="gap-2">
                  <Repeat className="h-3.5 w-3.5" />
                  {t('actionRebook')}
                </DropdownMenuItem>
              )}
              {(isPending || isNoShow) && <DropdownMenuSeparator />}
              {(isPending || isNoShow) && (
                <DropdownMenuItem
                  onClick={() => onAction(booking, 'cancel')}
                  className="gap-2 text-destructive focus:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                  {t('actionCancel')}
                </DropdownMenuItem>
              )}
              {(booking.session || (showContact && booking.contact)) && <DropdownMenuSeparator />}
              {booking.session && (
                <DropdownMenuItem
                  onClick={() => router.push(`/sessions/${booking.session}` as Route)}
                  className="gap-2"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t('viewSession')}
                </DropdownMenuItem>
              )}
              {showContact && booking.contact && (
                <DropdownMenuItem
                  onClick={() => router.push(`/contacts/${booking.contact}` as Route)}
                  className="gap-2"
                >
                  <User className="h-3.5 w-3.5" />
                  {t('viewContact')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}
