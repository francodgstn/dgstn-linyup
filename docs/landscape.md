---
title: Landscape
description: Every app, service, provider and store around Linyup on one screen, and how a request travels through them.
status: living
area: start
order: 2
---
# Landscape

The whole system on one screen: who uses Linyup, the apps they open, where those
are hosted, the backend, the Google Cloud services underneath, the third parties
we depend on, and how code reaches each environment.

On the docs site the diagram is interactive (`pnpm dev:docs`): select a box to
see what it connects to, where it runs, and the page that explains it. Its data
lives in `apps/docs/src/data/landscape.ts`. Change a box there, not here.

## How to read it

- **Layers run top to bottom**, from the people who use Linyup down to the
  services and providers underneath, with build and deploy last.
- **Three kinds of box.** A plain box is our code. A shaded box is a managed
  Google Cloud service in our own projects. A dashed box is a third party.
- **Connections light up** instead of being drawn as lines. With this many boxes,
  drawing every line at once would be unreadable.

## Four journeys through it

**A member pays for a drop-in class.** The public booking page (web app) reads
the studio and its classes from the `public_profile` mirrors in Firestore, never
from the main collections. Paying calls `createDropInCheckout` through the
`rpcCheckout` router. The price comes from the one resolver,
`resolvePaymentOptions`, and the charge is a Stripe Checkout session on the
**studio's own** connected account. Stripe then calls the Connect webhook, which
confirms the booking and records the payment. Firestore triggers recount the
session's seats, fire automations and post the finance journal row, and the
confirmation email goes out through Brevo. See
[Member payments](./payment-contact-studio.md).

**A studio publishes its website.** The dashboard calls `publishWebsite`
(through `rpcHeavy`), which machine-translates the site into the other three
languages (DeepL) and writes the published copy and one translated copy per
language. Visitors read those
copies at `/public/{slug}/site`. On a studio's own domain, the Cloudflare
tenant-router Worker serves the same pages. See
[Site translations](./site-translations.md) and
[Custom domains](./custom-domains.md).

**The nightly jobs run.** Cloud Scheduler starts a dispatcher, which lists the
tenants and enqueues one Cloud Task per team. A `…ForTeam` worker then does that
one team's reminders, no-shows or reports. One failing tenant cannot stop the
others. See [Scheduled jobs](/rules/scheduled-jobs/).

**A change ships.**
- **Pull request:** `verify.yml` checks it.
- **Merge to main:** `deploy.yml` deploys functions, rules, and the landing, help
  and api hosting to staging, and App Hosting rolls the web apps out from main.
- **`v*` tag:** `deploy-prod.yml` does the same for production after a reviewer
  approves. It then checks that every function is actually callable.
- **`sandbox-*` tag:** `deploy-sandbox.yml` deploys to the sandbox.
- **Member app:** builds and updates go through Expo EAS (`mobile.yml`).

See [Environments](/rules/environments/).

## What surprises newcomers

- **One Next.js app is both the dashboard and every public page.** Bio-link,
  website, Space, shop, booking and the embed panel all live in `apps/web`, next
  to the studio dashboard.
- **Public pages never read the main collections.** They read world-readable
  `public_profile` mirrors that triggers keep in sync. See
  [Public data boundary](/rules/public-data/).
- **A new callable is not a new function.** Callables are served by a few
  domain routers. Triggers, schedules, task queues and webhooks are not routed.
  See [Callables are served by routers](/rules/callables-are-served-by-routers-a-new-callable-is-not-a-new-/).
- **The member app is a client we cannot update.** Installed binaries keep
  calling functions by name, so those names stay deployed.
- **Linyup never holds a studio's money.** Members pay into the studio's own
  Stripe account through Connect direct charges, and the platform takes a fee.
- **No SMTP, no hosted video, no Realtime Database.** Mail goes through Brevo's
  HTTP API. Lessons embed YouTube or Vimeo. `database.rules.json` denies
  everything and no code uses the Realtime Database.
- **Firestore rules denials are not logged** anywhere on the server. The
  browser console is the only trail.
- **Two regions.** Functions, Firestore and Storage run in `europe-west6`
  (Zurich). The App Hosting backends run in `europe-west4` (Netherlands), the
  nearest EU region App Hosting offers.

## How they connect (C4)

The landscape shows what exists. The C4 views below show what calls what, at
three levels of zoom:

- **Context:** Linyup as one box, with the people who use it and the outside
  systems it depends on.
- **Containers:** what runs inside that box, with a labelled arrow for every
  call. A dashed arrow is an event, a webhook or a queue: nobody waits on it.
- **Components:** inside the web app and inside Cloud Functions.

Select an element to follow its arrows. An element marked ⊕ opens up: double-click
it, or use the button in the panel. **Full screen** opens the viewer in a modal
where scrolling zooms. The views are laid out automatically when the site is
built. Their model is `apps/docs/src/data/c4.ts`.
