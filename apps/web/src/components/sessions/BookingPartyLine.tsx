'use client'

import { useTranslations } from 'next-intl'
import type { Booking } from '@linyup/shared'

/**
 * WHO ELSE IS COMING on a booking made for a group ("I come with another
 * person"). One booking, several people: the coach needs the count and the
 * names at the door, and they are nowhere else, because a companion is a name
 * on the booking and never a contact.
 *
 * Nothing for a booking of one, so every other roster row is unchanged. A
 * studio-made booking may name fewer companions than it books; the count is
 * still shown, since that is what the coach plans the lesson around.
 */
export function BookingPartyLine({
  booking,
  className = 'text-xs text-muted-foreground',
}: {
  booking: Pick<Booking, 'party_size' | 'participants'>
  className?: string
}) {
  const t = useTranslations('BookingParty')
  const size = booking.party_size ?? 1
  if (size < 2) return null
  const names = (booking.participants ?? []).filter((n) => n.trim().length > 0)
  return (
    <p className={className}>
      {names.length > 0
        ? t('groupWith', { count: size, names: names.join(', ') })
        : t('group', { count: size })}
    </p>
  )
}
