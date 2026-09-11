'use client'

import { createContext, useCallback, useContext, type ReactNode } from 'react'
import type { Route } from 'next'
import { useRouter } from '@/i18n/navigation'

// ─── Booking chrome ───────────────────────────────────────────────────────────
//
// The public booking funnels (class `BookingForm`, `AppointmentPicker`) render in
// two places: as a full page at /public/{slug}/booking|appointments, and as an
// overlay on top of the studio's website. The flow logic is identical; only the
// frame and the meaning of "leave the flow" differ.
//
// This context is that seam. Its DEFAULT value is exactly the page behaviour, so
// the route variants need no provider at all and are unaffected.

export type ChromeKind = 'page' | 'overlay'

export interface BookingChromeValue {
  kind: ChromeKind
  /**
   * Overlay only. "Leave the flow" means CLOSE, not navigate — the visitor came
   * from the website behind the panel and expects to land back on it.
   */
  onClose?: () => void
  /**
   * How the flow leaves for a different route (Stripe). Overlay hosts remember
   * where to come back to before handing off.
   */
  navigate: (href: string) => void
  /**
   * Swap the CLASS funnel for the APPOINTMENT one, in place.
   *
   * Appointments are a separate flow (a per-provider slot picker), but from the
   * visitor's point of view picking "Personal Training" off the activity list is
   * just the next step — bouncing them to a full page mid-overlay is jarring.
   * Only overlay hosts provide this; page chrome leaves it undefined and the
   * flow navigates as before.
   */
  switchToAppointments?: (activityId: string) => void
}

const PAGE_CHROME: BookingChromeValue = {
  kind: 'page',
  navigate: (href) => {
    if (typeof window !== 'undefined') window.location.href = href
  },
}

const BookingChromeContext = createContext<BookingChromeValue>(PAGE_CHROME)

/** Defaults to page chrome, so an unwrapped flow behaves exactly as before. */
export function useBookingChrome(): BookingChromeValue {
  return useContext(BookingChromeContext)
}

/**
 * "I am done with this flow — get me out."
 *
 * In a panel that means CLOSE: the visitor came from the page behind it (the
 * studio's website, on a Linyup site or on their own), and it is already showing
 * whatever `href` would navigate to. As a page it means going there.
 *
 * Every exit goes through here rather than deciding for itself, because getting
 * it wrong is invisible on a page and fatal in a frame: in the embed `href` is
 * an app page that sends `X-Frame-Options: DENY`, so navigating to it does not
 * merely lose the visitor's place — it blanks the panel they are standing in.
 */
export function useExitFlow(): (href: Route) => void {
  const chrome = useBookingChrome()
  const router = useRouter()
  return useCallback(
    (href: Route) => {
      if (chrome.kind === 'overlay') chrome.onClose?.()
      else router.push(href)
    },
    [chrome, router]
  )
}

export function BookingChromeProvider({
  value,
  children,
}: {
  value: BookingChromeValue
  children: ReactNode
}) {
  return <BookingChromeContext.Provider value={value}>{children}</BookingChromeContext.Provider>
}
