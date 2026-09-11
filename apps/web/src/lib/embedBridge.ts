// ─── The embed bridge ─────────────────────────────────────────────────────────
//
// The message protocol between a Linyup embed — this app, running in a
// cross-origin iframe on a studio's OWN website — and `apps/web/public/embed.js`,
// the loader the studio pastes next to it.
//
// **The host half lives in `public/embed.js`**, a plain un-built script served to
// third-party pages, so it cannot import this module. That file is the OWNER of
// what the host does with each message (which URL a booking link becomes, how the
// modal is drawn); this one is the app-side vocabulary. Both halves ship
// together, but a studio's page may have an OLD embed.js cached for a long time —
// so every addition here must be additive and safely ignorable by a host that has
// never heard of it, and the app must still work with no host script at all.
//
// `targetOrigin: '*'` throughout, deliberately: the host is a different studio's
// website on every page and we do not know its origin. Nothing sent this way is
// a secret — a content height, "the visitor clicked this public link", "close
// me", "the browser needs to go to Stripe". Nothing is ACCEPTED from the host
// but a capability announcement, which is a hint, never an instruction.

/** Every message type, child → host unless noted. */
export const EMBED_MESSAGE = {
  /** Content height, so the host can size a section iframe (the original one). */
  height: 'linyup:embed:height',
  /** "Is a modal launcher present?" — sent on mount; the host replies `host`. */
  hello: 'linyup:embed:hello',
  /** HOST → CHILD. The reply: embed.js is here and can open a booking modal. */
  host: 'linyup:embed:host',
  /** "Open this public link for me" — the host maps it to a modal, or a tab. */
  open: 'linyup:embed:open',
  /** The booking modal finished loading (the host reveals the panel). */
  ready: 'linyup:embed:ready',
  /** The booking funnel wants out — the host tears the modal down. */
  close: 'linyup:embed:close',
  /** The flow must leave for a top-level URL (Stripe refuses to be framed). */
  navigate: 'linyup:embed:navigate',
} as const

/** Fire-and-forget to whatever is hosting this frame. No-op when not framed. */
export function postToHost(message: Record<string, unknown>): void {
  if (typeof window === 'undefined' || window.parent === window) return
  try {
    window.parent.postMessage(message, '*')
  } catch {
    /* a host that tore the frame down mid-flight — nothing to recover */
  }
}

/** True when this document is running inside someone else's page. */
export function isFramed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.top !== window.self
  } catch {
    // Cross-origin ancestors throw on some property reads; being unable to look
    // IS being framed.
    return true
  }
}

/**
 * Could the host turn this link into a booking modal?
 *
 * Deliberately BROAD — it only decides whether to ask. `embed.js` owns the real
 * mapping and falls back to opening a tab for anything it cannot place, so a
 * false positive here costs nothing and a false negative silently loses the
 * feature. Same-origin only: a studio's own external links stay ordinary links.
 */
export function isBookableAppHref(href: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const url = new URL(href, window.location.href)
    if (url.origin !== window.location.origin) return false
    return /^\/(?:(?:de|fr|it)\/)?public\/[A-Za-z0-9_-]+\/(?:booking|appointments)(?:\/|$)/.test(
      url.pathname
    )
  } catch {
    return false
  }
}
