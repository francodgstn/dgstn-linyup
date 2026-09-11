# The booking modal, on the studio's own website

A studio that already has a website — Wix, Squarespace, WordPress, a hand-rolled
one — can put Linyup's booking funnel **on that site**, as a pop-up over the page
the visitor is already reading. Not a link to `app.linyup.com`, not a new tab:
the same panel a visitor gets on a Linyup-hosted website (`BookingOverlay`).

```html
<!-- anywhere in the studio's own HTML -->
<a href="https://app.linyup.com/public/iron-circle/booking" data-linyup-book>Book now</a>

<!-- once per page -->
<script src="https://app.linyup.com/embed.js" async></script>
```

That is the whole integration. A section widget (`schedule`, `activities`,
`pricing`) pasted on the same page picks it up automatically: its Book buttons
open the same pop-up instead of a new tab, as soon as the script is present.

## The three pieces

|                | Where                            | Owns                                                                        |
| -------------- | -------------------------------- | --------------------------------------------------------------------------- |
| The loader     | `apps/web/public/embed.js`       | The host page: the modal element, the URL mapping, resizing section iframes |
| The panel      | `app/[locale]/embed/[slug]/book` | The funnel, framed: providers + `BookingChrome`                             |
| The vocabulary | `src/lib/embedBridge.ts`         | The message types, and the app side of the handshake                        |

**The modal is drawn by the host page, not inside the iframe.** A dialog rendered
inside a content-sized iframe can only ever cover that iframe — the backdrop
would stop at its edges. So `embed.js` owns the backdrop, the sizing (centred
dialog ≥ 640px, bottom sheet below), the backdrop click, the scroll lock and the
history entry that makes Back close the panel; the iframe **is** the panel, and
renders the funnel with `FlowShell`'s overlay chrome — the same header, X and
in-panel sticky bar the website overlay uses.

**Escape is listened for on both sides**, and that is not redundancy: once the
visitor is typing in the form, focus is inside the frame, and a cross-origin
parent never sees the keystroke. The panel's own handler is the half that fires
in practice; it stands down while a popup layer inside the funnel (a select, the
waiver sheet) is open, because that layer owns Escape first.

**Nothing about the funnel is duplicated.** `/embed/{slug}/book` is the third host
of `BookingChrome` (page → website overlay → embed panel), and it reports
`kind: 'overlay'`, because from the funnel's point of view that is what it is: a
panel someone can close. Only the meaning of "close" and "leave for another URL"
differ, and those are two lines.

## The URL mapping (embed.js owns it)

A launcher's `href` is the **canonical public link**, and embed.js maps it:

| Clicked                                                     | Opened in the panel                       |
| ----------------------------------------------------------- | ----------------------------------------- |
| `/public/{slug}/booking`                                    | `/embed/{slug}/book`                      |
| `/public/{slug}/booking/{activitySlug}`                     | `…/book?activity={activitySlug}`          |
| `/public/{slug}/booking?session={id}`                       | `…/book?session={id}`                     |
| `/public/{slug}/booking?activity={id}`                      | `…/book?activityId={id}`                  |
| `/public/{slug}/appointments?activity={id}&provider=&date=` | `…/book?appointment={id}&provider=&date=` |

`activity` is the activity's **slug** on the booking route and its **id** on the
appointments route — the two public routes really do differ — so they are carried
under different names rather than guessed apart at the other end.

A locale prefix rides along unchanged. English is the unprefixed locale
(`localePrefix: 'as-needed'`), so a widget pinned to English passes its locale
and the panel URL carries `?hl=en`, the marker `proxy.ts` already understands.

**The href always stays on the element.** Without the script — still loading,
blocked, JS off, a middle-click — the launcher is an ordinary link to the booking
page, which works. Same principle as `bookProps` in `components/site/sections.tsx`.

## The handshake, and why it exists

Every snippet already pasted in the wild opens booking links in a **new tab**
(`EmbedSection`'s click delegation), because the app's own pages send
`X-Frame-Options: DENY` and would fail silently in a frame. That behaviour must
not change under a studio that never updates its page.

So the panel is **opt-in by announcement**: `embed.js` tells each widget frame
`linyup:embed:host` when that frame loads, the widget asks with
`linyup:embed:hello` (**retried** for a few seconds, because an `async` script
and a `loading="lazy"` iframe can settle in either order and one unanswered
hello would cost the panel for the life of the page), and only a widget that has
heard back delegates its booking clicks. No script, or an old cached one: new
tab, exactly as before.

A widget's clicks are intercepted by a **capture-phase listener on the
document**, not by an `onClick` on its wrapper. The schedule block's
session-detail card stops propagation on its own container — it is a hand-rolled
backdrop that must not close when the card itself is clicked — which swallowed
the Book button inside it and let that link navigate the frame into the
`X-Frame-Options` wall. Capturing at the document runs before any React handler,
so a section cannot opt out of the rule by accident.

The host accepts messages **only from the app's own origin**, so nothing else on
the studio's page (an ad frame, another widget) can open a dialog or move the
window. The app side accepts exactly one thing from the host — "a launcher is
here" — which grants a capability and can instruct nothing.

## Paying

Stripe Checkout refuses to be framed, so a paid booking cannot stay in the panel.
`chrome.navigate` posts `linyup:embed:navigate` and **the host moves the whole
window** — the same departure a visitor makes from a Linyup-hosted site. Stripe
returns them to `/pay/result`, which confirms the booking and signs them in
(`claimCheckoutSession`), rather than to a dead panel behind a tab they closed.

`rememberBookingReturn` is deliberately **not** called here. It writes to
`app.linyup.com`'s sessionStorage, and an embedded frame's storage is partitioned
per host site — the top-level `/pay/result` Stripe redirects to would not see it.
Bringing the buyer back to _the studio's own page_ would need that page's URL to
survive the round trip, which means trusting an origin we have not verified; the
custom-domain rail (`resolveBaseUrl` + `activeCustomDomainHost`) is the precedent
for how that has to be earned. **Open**, not forgotten — see below.

A studio that has a verified custom domain has the better answer today: serve the
booking page on it, and the visitor never leaves the studio's domain at all.

## What the panel is not

- **Not indexed.** `robots: noindex` — it is a chrome-less duplicate of a real
  page, and only ever meant to be opened inside a frame.
- **Not a page.** Opened directly it redirects to the canonical route, because a
  Close button with no host to talk to is a trap.
- **Not a history writer.** `disableStepUrl`: a `pushState` inside the frame
  lands in the TOP window's joint session history, so the visitor's Back button
  would walk the funnel's steps instead of closing the panel.

## Framing, and the clickjacking question

`/embed/*` is served with `frame-ancestors *` (`proxy.ts`) — it has to be: the
whole point is that any studio's own domain can frame it, and we do not know
those domains. That now includes the booking funnel.

What a hostile framer could do with it is book a class in a victim's name — every
booking asks for a name and an email, or an already-signed-in contact session that
is **partitioned to the framing site** (a member signed in on `app.linyup.com` is
not signed in inside someone else's frame). Money never moves in the frame:
payment leaves for Stripe as a top-level navigation the visitor sees. This is the
same posture as every booking embed on the market, and the same one the section
widgets have always had.

## Open

- **Return to the host page after payment.** Needs a _verified_ studio origin
  (DNS, as the custom-domain rail does) before `/pay/result` may redirect to it —
  an unverified one is an open redirect through our own customer list, which is
  exactly what `resolveBaseUrl`'s comment refuses.
- **A session-detail modal inside a section widget** is still drawn inside that
  widget's frame, so on a tall page it can sit off-screen. Unchanged by this
  work; the fix is the same move the booking panel just made.
- **Org-scoped widgets** (`/embed/org/…`) do not exist yet — see
  `docs/open-defects.md`. The launcher is team-scoped for the same reason.
