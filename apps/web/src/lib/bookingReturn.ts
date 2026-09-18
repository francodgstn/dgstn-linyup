// ─── Booking return-to across the Stripe round-trip ───────────────────────────
//
// Paying leaves the SPA entirely: the flow hands off to Stripe Checkout, which
// redirects to /pay/result. Without this, a visitor who was booking inside the
// overlay on the studio's website came back to a bare "back to booking" link and
// lost both the website they were on and their place in the funnel.
//
// sessionStorage, not a query param: it needs no backend change and cannot be
// forged into the redirect by a crafted /pay/result link (which is exactly why
// the value is still re-validated on read).

import { isLinyupOwnHost, isRestorableReturnPath } from '@linyup/shared'

const KEY = 'linyup:booking:return'

/**
 * Only same-origin app paths may be restored. A stored value is normally ours,
 * but sessionStorage is writable by any script on this origin, and this value
 * feeds a navigation — so it is treated as untrusted on the way out.
 *
 * Rejects absolute URLs, protocol-relative `//host` (which the browser resolves
 * off-site), and anything that isn't a public tenant path. On a studio's OWN
 * domain every page is theirs, so the short form (`/site/angebot`, `/booking`)
 * is accepted there too — the rule itself is `isRestorableReturnPath`.
 */
export function isRestorableBookingReturn(value: string | null | undefined): value is string {
  const customDomain = typeof window !== 'undefined' && !isLinyupOwnHost(window.location.hostname)
  return isRestorableReturnPath(value, { customDomain })
}

/** Called immediately before handing off to Stripe. */
export function rememberBookingReturn(href: string): void {
  if (typeof window === 'undefined') return
  try {
    const path = href.startsWith('http') ? new URL(href).pathname + new URL(href).search : href
    if (isRestorableBookingReturn(path)) window.sessionStorage.setItem(KEY, path)
  } catch {
    /* storage disabled (private mode) → fall back to the static CTA */
  }
}

/** Read-and-clear. Returns null when absent, unusable, or storage is blocked. */
export function takeBookingReturn(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.sessionStorage.getItem(KEY)
    window.sessionStorage.removeItem(KEY)
    return isRestorableBookingReturn(value) ? value : null
  } catch {
    return null
  }
}

// ─── "the payment really did succeed" flag ────────────────────────────────────
//
// The host page shows a CONFIRMED state when it reopens after checkout. Deciding
// that from a `?booked=1` query alone would let anyone send a victim a link that
// renders a convincing "Booking confirmed!" for a booking that never happened.
// So the query only marks intent; this one-shot flag — writable only by
// /pay/result after Stripe reported success — is the actual permission.

const CONFIRMED_KEY = 'linyup:booking:confirmed'

export function markBookingConfirmed(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(CONFIRMED_KEY, '1')
  } catch {
    /* storage disabled → the host just reopens without the confirmation */
  }
}

/** Read-and-clear, so a reload can't replay the confirmation. */
export function takeBookingConfirmed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const value = window.sessionStorage.getItem(CONFIRMED_KEY)
    window.sessionStorage.removeItem(CONFIRMED_KEY)
    return value === '1'
  } catch {
    return false
  }
}
