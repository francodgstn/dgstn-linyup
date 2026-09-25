'use client'

/**
 * THE active tab of a multi-tab surface — held in the URL, never in component
 * state alone.
 *
 * The bug this exists to remove (UX-22): a tab kept only in `useState` is lost
 * by everything that re-enters the page from outside React — a refresh, a
 * pasted link, the browser Back button, a restored open-tab. The user lands on
 * the default tab and has to find their place again, every time. It read as
 * "the app forgot", because it had.
 *
 * The convention is `?tab=` — already what `/settings/team`, `/offer/plans` and
 * the contact detail page used, so this generalizes the existing shape rather
 * than inventing a second one. Two consequences worth knowing:
 *
 *  - The URL is kept TRUTHFUL: whatever tab is showing is in the address bar,
 *    including the default one. That is what makes "copy the URL" work at any
 *    moment, and what lets one page deep-link a specific tab of another (UX-71
 *    builds on exactly this).
 *  - The sync is a `history.replaceState`, NOT a router navigation. A tab click
 *    is not a new history entry — Back should leave the page, not walk back
 *    through the tabs the user clicked on the way in. It also means no re-render
 *    of the route tree, and `usePathname()` is query-agnostic so sidebar/tab-strip
 *    active detection is unaffected.
 *
 * An unknown or missing value falls back, so a stale link (a tab that has since
 * been renamed, or one gated off for this user) opens the page rather than an
 * empty pane.
 *
 * ── A SECOND LEVEL: `enabled` ───────────────────────────────────────────────
 * The same hook drives a SEGMENT inside one tab (`?seg=`), which only means
 * anything while that tab is the one showing. `enabled: false` makes the hook
 * REMOVE its param instead of writing it, so `?seg=` does not trail around the
 * URL of a page it says nothing about. The React state survives, so switching
 * away and back restores the segment and re-writes the param.
 */

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { useSearchParams } from 'next/navigation'

export function useTabParam<T extends string>(
  ids: readonly T[],
  fallback: T,
  key = 'tab',
  opts?: {
    /** False → the param is deleted rather than written. For a nested `?seg=`
     *  whose tab is not currently showing. Defaults to true. */
    enabled?: boolean
  }
): [T, Dispatch<SetStateAction<T>>] {
  const searchParams = useSearchParams()
  const enabled = opts?.enabled ?? true
  // Read ONCE, at mount. After that the state is the source of truth and the URL
  // follows it — reading `searchParams` on every render would fight the
  // replaceState below (which Next does not observe) and could snap the tab back.
  const [tab, setTab] = useState<T>(() => {
    const p = searchParams.get(key)
    return p && (ids as readonly string[]).includes(p) ? (p as T) : fallback
  })

  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const current = p.get(key)
    if (enabled) {
      if (current === tab) return
      p.set(key, tab)
    } else {
      if (current === null) return
      p.delete(key)
    }
    const qs = p.toString()
    window.history.replaceState(
      null,
      '',
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    )
  }, [key, tab, enabled])

  return [tab, setTab]
}
