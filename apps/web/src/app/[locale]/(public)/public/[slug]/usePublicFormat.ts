'use client'

import { useMemo } from 'react'
import { useLocale } from 'next-intl'
import { createRegionalFormatter, type RegionalFormatter } from '@linyup/shared'
import { usePublicTeam } from './PublicTeamProvider'

/**
 * THE date/time formatter for the public surfaces — the Space, and any sibling
 * under `/public/{slug}` that labels a stored instant.
 *
 * The same two halves `useTeamFormat` joins for the admin: the reader's UI
 * LANGUAGE (the URL locale — the Space has its own switcher) picks the words,
 * and the studio's REGIONAL settings — mirrored onto the public profile as
 * `TeamPublicProfile.regional`: zone, week start, date order, hour cycle — pick
 * the shape. A bare `toLocaleDateString()` asks the BROWSER instead and answers
 * with neither: an en-US browser showed US dates and 12-hour times inside a
 * German studio's portal, and the same goal read "15 Sep 2026" on the coach's
 * tab and in the app but "9/15/2026" on the member's portal.
 *
 * Studio zone, always. Everything here LABELS a stored instant — a booking, a
 * goal's date, a payment — for a member of a physical studio, and nothing on
 * these surfaces positions anything by the device's clock (the opt-out
 * `useTeamFormat` has for the admin's week grid has no case here).
 */
export function usePublicFormat(): RegionalFormatter {
  const locale = useLocale()
  const { team } = usePublicTeam()
  const stored = team.regional ?? null
  // Serialised, not by reference: the provider hands out one object per load,
  // but a key is cheaper than trusting that on every consumer.
  const storedKey = JSON.stringify(stored ?? {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createRegionalFormatter(locale, stored), [locale, storedKey])
}
