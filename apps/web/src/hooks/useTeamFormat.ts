'use client'

import { useMemo } from 'react'
import { useLocale } from 'next-intl'
import { useAuth } from '@/contexts/AuthContext'
import { createRegionalFormatter, deviceTimeZone } from '@/lib/format'
import { resolveRegional, type RegionalFormatter, type RegionalSettings } from '@linyup/shared'

/**
 * THE date/time formatter for apps/web.
 *
 * It joins the two halves that decide how an instant reads: the reader's UI
 * LANGUAGE (per-user, from the URL locale — it picks the words) and the
 * studio's REGIONAL settings (team-wide `Team.regional` — zone, week start,
 * date order, hour cycle). A bare `toLocaleDateString()` asks the BROWSER
 * instead and answers with neither.
 *
 * The team doc already streams into `AuthContext` on a snapshot listener, so
 * this costs no read and updates the moment the owner saves. On a public
 * surface, where nobody is signed in, `team` is null and the Swiss defaults
 * apply — the same answer a tenant with no stored settings gets.
 *
 * ── THE ZONE RULE (this option is where it is written down) ─────────────────
 *
 * A surface LABELS in the zone its own arithmetic RUNS in. Half-converting one
 * is worse than not converting it: a week grid that lays blocks out with local
 * `getHours()` but prints the studio's zone puts a Zurich time on a New York
 * row, and a list that buckets by the device's calendar day under a divider
 * rendered in the studio's can head "Today · 23 August" over a row dated the
 * 24th.
 *
 * So `zone: 'device'` is the opt-out for a surface that POSITIONS or COMPUTES
 * with the browser's clock, and such a call site says which arithmetic makes it
 * one. Everything that merely LABELS a stored instant takes the studio's zone,
 * which is the default. Converting a surface means moving BOTH halves in the
 * same commit; if only one can move, leave both on the device's zone.
 *
 * The override changes the zone and nothing else — week start, date order and
 * hour cycle still come from `Team.regional`, because those are the studio's
 * choices regardless of which clock the surface is drawn against.
 */
export interface UseTeamFormatOptions {
  /** 'team' (default) renders in the studio's zone; 'device' in the browser's. */
  zone?: 'team' | 'device'
  /** Override the team being rendered (org pages showing another team's data). */
  regional?: Partial<RegionalSettings> | null
}

export function useTeamFormat(options: UseTeamFormatOptions = {}): RegionalFormatter {
  const locale = useLocale()
  const { team } = useAuth()
  const { zone = 'team', regional } = options
  const stored = regional ?? team?.regional ?? null
  // Serialized rather than passed by reference: the team doc is a fresh object
  // on every snapshot, so an identity dep would rebuild the Intl instances (and
  // their caches) on every unrelated team write.
  const storedKey = JSON.stringify(stored ?? {})

  return useMemo(
    () => createRegionalFormatter(locale, stored, zone === 'device' ? deviceTimeZone() : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, storedKey, zone]
  )
}

/**
 * The resolved settings on their own, for callers that need a single value
 * (`weekStartsOn` for a calendar grid, `timezone` for a hint line) rather than
 * the formatter bundle.
 */
export function useRegionalSettings(): RegionalSettings {
  const { team } = useAuth()
  const storedKey = JSON.stringify(team?.regional ?? {})
  return useMemo(
    () => resolveRegional(team?.regional),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storedKey]
  )
}
