'use client'

import { useEffect } from 'react'

/**
 * "YOU HAVE UNSAVED CHANGES" — THE ONE PLACE THAT SAYS IT.
 *
 * An editor that holds a draft in React state loses it to any navigation, and
 * the loss is SILENT: no error, no dialog, nothing to undo. The website builder
 * is where this hurts most (a studio owner writes a blog post between two
 * classes, clicks something in the sidebar, and the post is gone), but nothing
 * about the problem is specific to it — so the guard lives here, not there.
 *
 * It covers the two ways a page leaves:
 *
 *   1. The BROWSER leaving — tab close, reload, a link out of the app. The
 *      browser's own `beforeunload` prompt; its wording is the browser's, not
 *      ours, and `confirmMessage` is ignored by every current browser. Nothing
 *      to do about that, and a generic prompt still beats none.
 *   2. The APP navigating — a sidebar link, a card, anything rendering an
 *      `<a>`. The App Router has no navigation events to subscribe to, so the
 *      guard intercepts the CLICK in the capture phase, before the router sees
 *      it, and asks. This is why it is a click interceptor rather than a router
 *      hook: there is no router hook to use.
 *
 * Deliberately NOT covered: the back button. `popstate` fires after the history
 * entry has already moved, so "cancelling" it means pushing the user's own
 * history back — a fight with the browser that ends in a loop. A back button
 * that leaves is the price of not building that.
 *
 * Passing `false` removes both listeners, so the hook costs nothing while the
 * editor is clean — which is most of the time.
 */
export function useUnsavedChangesGuard(dirty: boolean, confirmMessage: string) {
  useEffect(() => {
    if (!dirty) return

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Legacy shape some browsers still need to show their own prompt.
      e.returnValue = ''
    }

    const onClick = (e: MouseEvent) => {
      // Leave modified clicks (new tab / new window / download) alone — they
      // do not take this page anywhere.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const anchor = (e.target as HTMLElement | null)?.closest?.('a')
      if (!anchor) return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#') || anchor.target === '_blank' || anchor.hasAttribute('download')) return
      // An external link leaves through `beforeunload` instead — it is the
      // browser's navigation, and asking twice is worse than asking once.
      const url = new URL(href, window.location.href)
      if (url.origin !== window.location.origin) return
      // Same page (a query-only change, e.g. this builder's own tab state) is
      // not leaving anything.
      if (url.pathname === window.location.pathname) return
      if (!window.confirm(confirmMessage)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    // Capture phase: the router's own handler runs on the bubble.
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClick, true)
    }
  }, [dirty, confirmMessage])
}
