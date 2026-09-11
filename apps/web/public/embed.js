/*
 * Linyup embed loader — the HOST half of the embed bridge.
 *
 * Include once on any page that hosts a Linyup embed:
 *
 *   <!-- a section widget -->
 *   <iframe src="https://app.linyup.com/embed/<slug>/<widgetId>" data-linyup-embed
 *           style="width:100%;border:0"></iframe>
 *
 *   <!-- and/or a booking launcher, anywhere on the page -->
 *   <a href="https://app.linyup.com/public/<slug>/booking" data-linyup-book>Book now</a>
 *
 *   <script src="https://app.linyup.com/embed.js" async></script>
 *
 * It does two things:
 *
 *   1. RESIZES section iframes to their content (they post their height).
 *   2. OPENS THE BOOKING FUNNEL IN A MODAL over the studio's own page — the same
 *      panel a visitor gets on a Linyup-hosted website — instead of sending them
 *      away to app.linyup.com. Both a click on `[data-linyup-book]` in the
 *      studio's own HTML and a click on a Book button INSIDE a section widget
 *      land here; the widget asks (postMessage) rather than opening a tab once
 *      this script has announced itself.
 *
 * THE BACKDROP IS WHY THE MODAL IS DRAWN HERE and not inside the iframe: a panel
 * rendered in a content-sized iframe can only ever cover that iframe. The frame
 * is the panel; this script is the dialog around it.
 *
 * The app-side half is `apps/web/src/lib/embedBridge.ts`. A studio's page may
 * hold a cached copy of this file for a long time, so the protocol only ever
 * grows: an unknown message type is ignored, and every Linyup surface still
 * works with no launcher present at all.
 *
 * Safe to load more than once. No globals but `window.Linyup`.
 */
;(function () {
  if (window.__linyupEmbed) return
  window.__linyupEmbed = true
  // The flag the resizer-only version of this file used. Setting it too means a
  // page that also carries an OLD cached copy runs it as a no-op instead of
  // resizing every section twice.
  window.__linyupEmbedResizer = true

  var MODAL_BREAKPOINT = 640
  var Z = 2147483000
  // Replaced by the panel's own localized title as soon as it reports ready —
  // the host page cannot know the visitor's language, and the panel does.
  var LABEL = 'Booking'

  // ── Where the app lives ────────────────────────────────────────────────────
  // Taken from this script's own URL, so a staging/sandbox page talks to the
  // host it was served from rather than a hardcoded production origin.
  var APP_ORIGIN = (function () {
    try {
      var el = document.currentScript
      if (!el) {
        var all = document.getElementsByTagName('script')
        for (var i = all.length - 1; i >= 0; i--) {
          if (all[i].src && all[i].src.indexOf('/embed.js') !== -1) {
            el = all[i]
            break
          }
        }
      }
      return el && el.src ? new URL(el.src, location.href).origin : location.origin
    } catch {
      return location.origin
    }
  })()

  // ── The booking URL mapping (THE owner) ────────────────────────────────────
  //
  // Canonical public link  →  the framable panel that shows the same funnel:
  //
  //   /public/{slug}/booking                  →  /embed/{slug}/book
  //   /public/{slug}/booking/{activitySlug}   →  /embed/{slug}/book?activity={slug}
  //   /public/{slug}/booking?session={id}     →  /embed/{slug}/book?session={id}
  //   /public/{slug}/booking?activity={id}    →  /embed/{slug}/book?activityId={id}
  //   /public/{slug}/appointments?activity=…  →  /embed/{slug}/book?appointment=…
  //
  // `activity` means the activity's SLUG on the booking route and its ID on the
  // appointments route — the two public routes really do differ — so they are
  // carried under different names rather than guessed apart later.
  //
  // A locale prefix is kept as-is. English has no prefix under `as-needed`, so a
  // widget that pinned English passes `hl` and it rides along as `?hl=en`
  // (proxy.ts turns that marker into the English page).
  var PUBLIC_PATH =
    /^\/(?:(de|fr|it)\/)?public\/([A-Za-z0-9_-]+)\/(booking|appointments)(?:\/([A-Za-z0-9_-]+))?\/?$/

  function toBookUrl(href, hl) {
    var url
    try {
      url = new URL(href, location.href)
    } catch {
      return null
    }
    if (url.origin !== APP_ORIGIN) return null
    // Already a panel URL (hand-written snippet, or window.Linyup with a href).
    if (/^\/(?:(?:de|fr|it)\/)?embed\/[A-Za-z0-9_-]+\/book\/?$/.test(url.pathname)) {
      return url.toString()
    }
    var m = PUBLIC_PATH.exec(url.pathname)
    if (!m) return null

    var locale = m[1]
    var slug = m[2]
    var route = m[3]
    var sub = m[4]
    var from = url.searchParams
    var to = new URLSearchParams()

    if (route === 'appointments') {
      // `appointments/{token}` is the cancel route, not a booking link. Only the
      // bare route opens the picker.
      if (sub) return null
      if (from.get('activity')) to.set('appointment', from.get('activity'))
      if (from.get('provider')) to.set('provider', from.get('provider'))
      if (from.get('date')) to.set('date', from.get('date'))
    } else {
      if (sub) to.set('activity', sub)
      if (from.get('session')) to.set('session', from.get('session'))
      if (from.get('activity')) to.set('activityId', from.get('activity'))
      if (from.get('date')) to.set('date', from.get('date'))
      if (from.get('referral')) to.set('referral', from.get('referral'))
    }

    var lang = locale || (hl === 'de' || hl === 'fr' || hl === 'it' ? hl : null)
    if (!lang && (hl === 'en' || from.get('hl') === 'en')) to.set('hl', 'en')

    var query = to.toString()
    return (
      APP_ORIGIN +
      (lang ? '/' + lang : '') +
      '/embed/' +
      slug +
      '/book' +
      (query ? '?' + query : '')
    )
  }

  /** Build a panel URL straight from options (the window.Linyup API). */
  function bookUrlFromOptions(o) {
    if (!o) return null
    if (o.href) return toBookUrl(o.href, o.locale)
    if (!o.slug || !/^[A-Za-z0-9_-]+$/.test(o.slug)) return null
    var lang = o.locale === 'de' || o.locale === 'fr' || o.locale === 'it' ? o.locale : null
    var q = new URLSearchParams()
    var keys = ['session', 'activity', 'activityId', 'appointment', 'provider', 'date', 'referral']
    for (var i = 0; i < keys.length; i++) if (o[keys[i]]) q.set(keys[i], String(o[keys[i]]))
    if (!lang && o.locale === 'en') q.set('hl', 'en')
    var query = q.toString()
    return (
      APP_ORIGIN +
      (lang ? '/' + lang : '') +
      '/embed/' +
      o.slug +
      '/book' +
      (query ? '?' + query : '')
    )
  }

  // ── The modal ──────────────────────────────────────────────────────────────

  var modal = null // { root, panel, frame, restoreFocus, htmlOverflow, bodyOverflow, pushedHistory }
  var stylesInjected = false

  function injectStyles() {
    if (stylesInjected) return
    stylesInjected = true
    var css =
      '.linyup-modal{position:fixed;inset:0;z-index:' +
      Z +
      ';display:flex;align-items:flex-end;justify-content:center;' +
      'background:rgba(15,23,42,.55);opacity:0;transition:opacity .18s ease}' +
      '.linyup-modal.is-open{opacity:1}' +
      '.linyup-modal__panel{position:relative;width:100%;height:92vh;height:92dvh;background:#fff;' +
      'border-radius:16px 16px 0 0;overflow:hidden;box-shadow:0 25px 50px -12px rgba(0,0,0,.45);' +
      'transform:translateY(16px);transition:transform .22s ease}' +
      '.linyup-modal.is-open .linyup-modal__panel{transform:none}' +
      '.linyup-modal__frame{display:block;width:100%;height:100%;border:0;opacity:0;transition:opacity .15s ease}' +
      '.linyup-modal__frame.is-ready{opacity:1}' +
      // Gone once the panel paints, not merely covered: the frame fades in, and
      // a spinner showing through a half-transparent panel reads as a stall.
      '.linyup-modal__panel.is-ready .linyup-modal__spinner{display:none}' +
      '.linyup-modal__spinner{position:absolute;top:50%;left:50%;width:28px;height:28px;margin:-14px 0 0 -14px;' +
      'border:2px solid rgba(100,116,139,.25);border-top-color:rgba(100,116,139,.8);border-radius:50%;' +
      'animation:linyup-spin .7s linear infinite}' +
      '@keyframes linyup-spin{to{transform:rotate(360deg)}}' +
      '@media (min-width:' +
      MODAL_BREAKPOINT +
      'px){' +
      '.linyup-modal{align-items:center;padding:24px}' +
      '.linyup-modal__panel{max-width:672px;height:min(92vh,860px);border-radius:16px}}' +
      '@media (prefers-reduced-motion:reduce){' +
      '.linyup-modal,.linyup-modal__panel,.linyup-modal__frame{transition:none}' +
      '.linyup-modal__spinner{animation:none}}'
    var style = document.createElement('style')
    style.setAttribute('data-linyup', 'embed')
    style.appendChild(document.createTextNode(css))
    ;(document.head || document.documentElement).appendChild(style)
  }

  function newFrame(url) {
    var frame = document.createElement('iframe')
    frame.className = 'linyup-modal__frame'
    frame.setAttribute('title', LABEL)
    frame.setAttribute('allow', 'clipboard-write')
    frame.src = url
    return frame
  }

  function openModal(url) {
    if (!url) return
    injectStyles()

    // Already open — swap the panel's contents rather than stacking dialogs.
    // A NEW element, not `frame.src = url`: navigating a live iframe pushes an
    // entry onto the TOP window's joint session history, so Back would step
    // through the panels instead of closing the first one. A freshly created
    // frame's initial load does not.
    if (modal) {
      var fresh = newFrame(url)
      modal.panel.className = 'linyup-modal__panel'
      modal.panel.replaceChild(fresh, modal.frame)
      modal.frame = fresh
      return
    }

    var root = document.createElement('div')
    root.className = 'linyup-modal'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-label', LABEL)

    var panel = document.createElement('div')
    panel.className = 'linyup-modal__panel'

    var spinner = document.createElement('div')
    spinner.className = 'linyup-modal__spinner'

    var frame = newFrame(url)

    panel.appendChild(spinner)
    panel.appendChild(frame)
    root.appendChild(panel)

    // Backdrop only — a click that started inside the panel must not close it.
    root.addEventListener('mousedown', function (e) {
      if (e.target === root) closeModal()
    })

    var html = document.documentElement
    var body = document.body
    modal = {
      root: root,
      panel: panel,
      frame: frame,
      restoreFocus: document.activeElement,
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      pushedHistory: false,
    }
    // Lock BOTH: `html` covers most browsers, `body` covers the ones whose
    // scroll container is the body (and iOS, which honours neither reliably —
    // the panel's own overscroll-contain does the rest).
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    body.appendChild(root)

    // Back closes the panel, as it does on a Linyup-hosted site. The URL is
    // unchanged, so a host SPA sees no route change to react to. The handler
    // closes on ANY pop while the panel is open — a popstate cannot say whose
    // entry was just left (it carries the state of the one arrived at), and
    // dismissing a dialog when the page navigates under it is right anyway.
    try {
      if (window.history && history.pushState) {
        history.pushState({ linyupBookingModal: true }, '', location.href)
        modal.pushedHistory = true
      }
    } catch {
      /* history blocked (sandboxed host) — Escape and the X still close it */
    }

    document.addEventListener('keydown', onKeydown, true)
    window.addEventListener('popstate', onPopState)
    // rAF so the transition has a frame to start from.
    requestAnimationFrame(function () {
      root.className = 'linyup-modal is-open'
    })
    try {
      frame.focus()
    } catch {
      /* focusing a cross-origin frame can throw in older browsers */
    }
  }

  /** `skipHistory` — the caller has already dealt with the entry we pushed, or
   *  is about to leave the page and must not race a `history.back()`. */
  function closeModal(skipHistory) {
    if (!modal) return
    var m = modal
    modal = null
    document.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('popstate', onPopState)
    document.documentElement.style.overflow = m.htmlOverflow
    document.body.style.overflow = m.bodyOverflow
    if (m.root.parentNode) m.root.parentNode.removeChild(m.root)
    if (m.restoreFocus && m.restoreFocus.focus) {
      try {
        m.restoreFocus.focus()
      } catch {
        /* the element went away while the panel was open */
      }
    }
    // Pop the entry we pushed, unless the pop IS what closed us — or we are
    // leaving for Stripe, where a back() racing the assignment below can land
    // the visitor on the previous page instead of on checkout.
    if (m.pushedHistory && !skipHistory) {
      try {
        history.back()
      } catch {
        /* nothing to go back to */
      }
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape' || e.keyCode === 27) closeModal()
  }

  function onPopState() {
    if (modal) closeModal(true)
  }

  function navigateTop(href) {
    var url
    try {
      url = new URL(href, APP_ORIGIN)
    } catch {
      return
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return
    // Stripe Checkout refuses to be framed, so paying means leaving this page —
    // exactly as it does from a Linyup-hosted site. The whole window goes, so
    // the visitor comes back to a real confirmation rather than to a dead panel
    // behind a tab they closed.
    closeModal(true)
    location.href = url.toString()
  }

  // ── Talking to the frames ──────────────────────────────────────────────────

  function sectionFrames() {
    return document.querySelectorAll('iframe[data-linyup-embed]')
  }

  /** Tell a widget that a launcher is here, so it asks instead of opening a tab. */
  function announce(target) {
    if (!target) return
    try {
      target.postMessage({ type: 'linyup:embed:host', version: 1, modal: true }, APP_ORIGIN)
    } catch {
      /* frame gone */
    }
  }

  /**
   * Announce to every widget frame, now and when it finishes loading.
   *
   * The `load` listener is the load-bearing half: a frame that has not navigated
   * yet is still `about:blank`, which inherits the HOST's origin — so announcing
   * to it with `targetOrigin: APP_ORIGIN` is dropped by the browser, and leaves
   * a warning in the studio's console that looks like our bug. A
   * `loading="lazy"` widget below the fold may not have loaded at all when this
   * script does. The widget's own retried `hello` covers whatever is missed.
   */
  function announceAll() {
    var frames = sectionFrames()
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i]
      if (!frame.__linyupWatched) {
        frame.__linyupWatched = true
        frame.addEventListener('load', onFrameLoad)
      }
      // Only once it has actually navigated — see above. A frame that loaded
      // before this script ran gets its answer from its own `hello` instead.
      if (frame.__linyupLoaded) announce(frame.contentWindow)
    }
  }

  function onFrameLoad(event) {
    event.target.__linyupLoaded = true
    announce(event.target.contentWindow)
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || typeof data.type !== 'string' || data.type.indexOf('linyup:embed:') !== 0) return
    // Only the app may drive this script. The host page is a studio's own site
    // and anything else on it (an ad frame, another widget) must not be able to
    // open a dialog or navigate the window.
    if (event.origin !== APP_ORIGIN) return

    if (data.type === 'linyup:embed:height' && typeof data.height === 'number') {
      var frames = sectionFrames()
      for (var i = 0; i < frames.length; i++) {
        // Match the iframe whose document sent the message (handles multiple
        // embeds on one page).
        if (frames[i].contentWindow === event.source) {
          frames[i].style.height = data.height + 'px'
          break
        }
      }
      return
    }

    if (data.type === 'linyup:embed:hello') {
      announce(event.source)
      // Cheap, and it picks up frames added since the last sweep (a lazy widget
      // further down the page, or one a site builder inserted after load).
      announceAll()
      return
    }

    if (data.type === 'linyup:embed:open' && typeof data.href === 'string') {
      var url = toBookUrl(data.href, data.hl)
      if (url) openModal(url)
      // Not something we can place in a panel — honour the click as a link. The
      // widget delegated because we said we were here; dropping it would lose
      // the click entirely.
      else window.open(data.href, '_blank', 'noopener,noreferrer')
      return
    }

    // The rest is the booking panel talking about itself.
    if (!modal || event.source !== modal.frame.contentWindow) return

    if (data.type === 'linyup:embed:ready') {
      modal.frame.className = 'linyup-modal__frame is-ready'
      modal.panel.className = 'linyup-modal__panel is-ready'
      if (typeof data.title === 'string' && data.title) {
        modal.root.setAttribute('aria-label', data.title)
        modal.frame.setAttribute('title', data.title)
      }
    } else if (data.type === 'linyup:embed:close') {
      closeModal()
    } else if (data.type === 'linyup:embed:navigate' && typeof data.href === 'string') {
      navigateTop(data.href)
    }
  })

  // ── Launchers in the studio's own HTML ─────────────────────────────────────
  //
  //   <a href="…/public/{slug}/booking" data-linyup-book>Book now</a>
  //   <button data-linyup-book data-linyup-slug="dojo" data-linyup-session="…">Book</button>
  //
  // The href is kept on purpose: without this script (still loading, blocked,
  // JS off) the link is an ordinary link to the booking page, and a
  // middle-click still opens it in a tab.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    var node = e.target
    if (!node || !node.closest) node = node && node.parentElement
    var el = node && node.closest ? node.closest('[data-linyup-book]') : null
    if (!el) return

    // Three ways to say it, tried in order: a URL in the attribute, the
    // element's own href, or the pieces as data-attributes (for a <button>,
    // which has no href to carry). The first that maps wins.
    var locale = el.getAttribute('data-linyup-locale')
    var attr = el.getAttribute('data-linyup-book')
    var target =
      (attr ? toBookUrl(attr, locale) : null) ||
      (el.href ? toBookUrl(el.href, locale) : null) ||
      bookUrlFromOptions({
        slug: el.getAttribute('data-linyup-slug'),
        session: el.getAttribute('data-linyup-session'),
        activity: el.getAttribute('data-linyup-activity'),
        appointment: el.getAttribute('data-linyup-appointment'),
        provider: el.getAttribute('data-linyup-provider'),
        date: el.getAttribute('data-linyup-date'),
        locale: locale,
      })
    if (!target) return // not a Linyup booking link — leave the click alone
    e.preventDefault()
    openModal(target)
  })

  // ── Public API ─────────────────────────────────────────────────────────────
  var api = window.Linyup || {}
  /** Linyup.openBooking({ slug, session|activity|appointment, provider, date, locale }) */
  api.openBooking = function (options) {
    openModal(bookUrlFromOptions(options))
  }
  api.closeBooking = function () {
    closeModal()
  }
  window.Linyup = api

  // Both orders are covered: a widget that mounted first asks (`hello`), and one
  // that mounts later hears this.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceAll)
  } else {
    announceAll()
  }
  window.addEventListener('load', announceAll)
})()
