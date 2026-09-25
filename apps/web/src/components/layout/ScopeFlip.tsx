'use client'

/**
 * FLIP BACK TO THE SCOPE YOU WERE JUST IN — the alt-tab chord.
 *
 * This module is the KEY HANDLER ONLY. It kept its name when the visible button
 * was removed (see below) so the import in the shell did not churn.
 *
 * The one real cost of making an organization a scope is the click to get back,
 * and an org admin who also runs a studio pays it all day.
 *
 * IT TOGGLES BETWEEN TWO; IT DOES NOT CYCLE N. What makes alt-tab worth having
 * is the instant flip between the last two things — the part everyone finds
 * fiddly is holding a modifier to rotate through a list. With three or more
 * scopes the switcher menu is already the better tool, so this always means
 * "back to the previous one" and never "next in some order".
 *
 * ── A CHORD ONLY, AS OF 2026-08-27 (a reversal, recorded) ──────────────────
 *
 * This shipped with a visible button too, on the argument that a bare shortcut
 * is undiscoverable — the same point the sidebar search makes about itself.
 * Franco removed it: on the header row it competed for the space that says
 * WHERE YOU ARE, which is the row's whole job, and the switcher one click away
 * already reaches every scope.
 *
 * DISCOVERABILITY IS DEFERRED, NOT ABANDONED. The chord is meant to appear in a
 * shortcuts list opened from elsewhere in the app. Until that exists, Alt+O is
 * genuinely undiscoverable — which is a real cost, accepted knowingly rather
 * than overlooked, and the reason this note says so out loud.
 *
 * The guard below still refuses when there is no previous scope, so the chord
 * can never land somewhere arbitrary.
 *
 * ── THE CHORD IS Alt+O, AND THE GUARD IS NOT OPTIONAL ───────────────────────
 *
 * Windows-first, on Swiss, German and French keyboards — which eliminates almost
 * everything. Ctrl+Shift+O opens the bookmark manager in Chrome and Edge and the
 * Library in Firefox; most of the Ctrl+Shift+letter space is similarly spoken
 * for. Alt+S is already bound by the search panel. Alt is the app's own
 * precedent for exactly this situation (see the note beside that binding).
 *
 * `!e.ctrlKey` IS THE LOAD-BEARING PART. On those three layouts AltGr produces
 * `@`, `#`, `~` and `|`, and the browser reports AltGr as ctrlKey AND altKey
 * together — so a bare `e.altKey` handler fires while somebody is typing an
 * email address into a form on the page. The typing guard below is the second
 * half of the same concern.
 */

import { useEffect } from 'react'
import { useRouter } from '@/i18n/navigation'
import type { Route } from 'next'
import { useScope } from '@/contexts/ScopeContext'

/** Is the keystroke going into something the person is typing in? */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** The global chord. Mounted once by the shell, beside the other key handlers. */
export function useScopeFlipShortcut() {
  const { previous, hrefFor } = useScope()
  const router = useRouter()

  useEffect(() => {
    if (!previous) return
    function onKey(e: KeyboardEvent) {
      // `e.key` rather than `e.code`: the letter the layout actually produces is
      // what the tooltip promises, and Alt+O on a Swiss keyboard is still O.
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key !== 'o' && e.key !== 'O') return
      if (isTyping(e.target)) return
      e.preventDefault()
      router.push(hrefFor(previous!) as Route)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previous, hrefFor, router])
}

/**
 * Mounts the chord ONCE.
 *
 * The hook cannot simply live in the sidebar: `SidebarContent` renders twice —
 * the desktop aside and the mobile drawer — so the listener would be registered
 * twice and one keypress would navigate twice. This renders nothing and exists
 * only to give the handler a single home inside the scope provider.
 */
export function ScopeFlipShortcut() {
  useScopeFlipShortcut()
  return null
}
