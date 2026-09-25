---
title: Payments e2e review 2026-09
description: "Every payment and receipt surface driven end to end in Stripe test mode, 2026-09-25: what was fixed, what is open"
status: record
area: ops
---
# Payments e2e review, 2026-09-25

Every money path a studio or a member can take, clicked through in a real
browser against one local slot, paid for on Stripe's hosted Checkout with test
cards, with the webhooks delivered by `stripe listen` and the result read back
from Firestore and, where the number is the point, from Stripe. The specs are in
`apps/web/e2e/payments/` and rerun with the recipe in its README.

Nothing here touched a deployed environment.

**Result of the final run** (fresh seed, all fixes in): 30 passed, 2 skipped,
0 failed across `e2e/payments` and `e2e/promo-code-checkout.spec.ts`, with the
two touched specs rerun green after the last fix. The two skips are the open
decisions below, kept as `test.fixme` so they turn into failing tests the day
the behaviour is chosen.

## What was covered

| Area | Flow | Spec |
|---|---|---|
| Member shop | New customer buys a product (login-first registration, direct charge, provisional contact confirmed) | `shop-product` |
| | Declined card: refused on Stripe, back to "Payment cancelled", nothing recorded | `shop-product` |
| | Membership (monthly Starter): Stripe subscription, `member_subscriptions`, plan on the contact | `member-shop` |
| | Course block (8-week course): enrolment | `member-shop` |
| | Online course (purchase tier): lifetime entitlement, opens in Space | `member-shop` |
| | Gift card bought by a guest, then redeemed as a tender on a product (Stripe charged the difference) | `member-shop` |
| | Space: payment history, "Manage billing in Stripe" opens the billing portal | `member-shop` |
| Booking funnel | Open drop-in (anyone may pay), guest | `booking` |
| | Sign-up-only class: a registered member pays; a stranger is told why and nothing is written | `booking` |
| | Drop-in paid in full by a gift card (no Stripe) | `booking` |
| | Priced trial on a plan-gated class | `booking` |
| | Paid appointment (the hold is the session) | `booking` |
| Studio | Payment link for a membership, paid by a new person | `studio-payments` |
| | Refund: the partial refusal on a membership is explained inline, then the full refund | `studio-payments` |
| | Manual cash payment gives a plan; voiding it takes the plan back | `studio-payments` |
| | Tarif 595 receipt from a payment: issued, PDF downloaded by the studio and by the member in Space, voided | `studio-payments` |
| | QR-bill invoices: install, invoice, PDF, mark paid (records the payment) | `studio-payments` |
| | Gift card issued at the desk for cash | `studio-payments` |
| | Staff-booked appointment with an emailed payment link, paid by the client | `studio-payments` |
| Studio to Linyup | Free studio upgrades to Coach on Stripe Checkout and lands back active | `saas-billing` |
| | Billing portal, cancel at period end, resume | `saas-billing` |
| | Paid add-on on a Coach subscription (the Stripe item is added) | `saas-billing` |
| Organisation | A member studio's Billing says the organisation pays, in the studio's language | `org-billing` |
| | The organisation subscribes (open decision below) | `org-billing` (fixme) |

The earlier `promo-code-checkout.spec.ts` stays where it is.

## Fixed in this branch

1. **A visitor could not pay for a class anyone may pay for.** The commonest
   setup ("CHF 25 per class, plan holders free") offered a newcomer only
   "First time here", which sent them to the free `bookSession`; the server
   refused with "registered members only" and no price was ever shown. The
   "Pay for a single class" door rendered only on members-only classes, the one
   place the server refuses strangers. The door pairing dated from July and was
   never updated for the derived access model (#405). `BookingForm.tsx`.
2. **`createDropInCheckout` wrote before refusing a stranger.** On a class behind
   "Only people who signed up with you" it minted a provisional contact and
   recorded a waiver acceptance, then refused. The guest view is now decided
   before any write, with reason `guest`, which the funnel shows in words.
3. **Every staff "Send payment link" for an appointment failed.** The Checkout
   Session was asked to live 7 days; Stripe allows under 24 hours and refused
   every one ("Failed to create the payment link"). The link now lasts as long
   as Stripe allows, and the email says 24 hours instead of 7 days. An unpaid
   link therefore releases its slot after a day rather than a week.
4. **Signing in with a saved language other than the URL's needed two tries.**
   After a correct password, `AuthContext` switched `/login` to `/de/login`,
   which beat the page's own redirect and left the owner on an emptied form. The
   sign-in pages now leave the language to the page they land on.
5. **Tarif 595 receipt from a payment attested the wrong period.** For a plan
   payment it proposed the plan row's span, which for an open row ends today: a
   monthly payment receipted the day it was paid covered one day. It now
   proposes the period that payment bought (one billing period from the payment
   date, clipped to the row).
6. **Dialogs in the payments area rendered at 384px on desktop**, so the Tarif
   595 receipt dialog's table and footer spilled out of the box. The shared
   dialog's `sm:max-w-sm` outranks a bare `max-w-*`; fixed here for the Tarif 595
   and finance dialogs. The same defect sits in about fifty other dialogs; that
   sweep is a separate task.
7. **Billing page copy was English in every language**: the "Billing managed by
   organization" banner a member studio sees, the "{plan} plan" heading and the
   status badge. Translated.
8. **The billing page threw an IntlError on the checkout return.** The webhook's
   first write can land before the one that names the plan, and the heading
   rendered an undefined plan. Guarded.
9. **Form labels not tied to their inputs** on the public booking and
   appointment forms and the QR-bill invoice dialog, so screen readers could not
   name the fields and a tap on a label did nothing. Wired (`htmlFor`/`id`).
10. **Every Space visit by a signed-in member failed hydration.** The contact
    auth provider started `isRestoring` from localStorage, so the server rendered
    "Sign in" while the member's browser rendered the placeholder, and React
    discarded the server HTML. The same split touched the shop grid and the
    public sign-in bar. It now starts as restoring on both sides. It only
    surfaced once fix 11 let a worktree's server render real studio data;
    production renders real data, so it was live there.
11. **Local tooling**: `local-env init` now points `HOSTING_URL` at the slot's
    web port (SaaS checkout returned worktree runs to slot 0's app), and the
    server-side Firestore REST reads follow the slot's emulator port instead of
    slot 0's (a worktree's public pages rendered from another checkout's data,
    which is why the first run saw "not accepting online payments").

## Needs a decision

- **Refunding a Stripe-billed membership.** The refund dialog says it "takes back
  what the payment gave: the membership it set up". For a membership billed by a
  Stripe subscription it does not: `reversePaymentEffects` only clears a plan a
  one-off payment set, records `subscription: skipped_not_owner`, and the
  subscription stays active and bills again next month. Options: cancel the
  Stripe subscription when its only payment is refunded in full, or keep the
  behaviour and say so in the dialog and the toast. Pinned as a `fixme` in
  `studio-payments.spec.ts`.
- **Organisation checkout.** The org Billing page offers a self-serve
  "Subscribe", but `linyup_organization_monthly` is archived on the platform
  (`scripts/stripe-sync.ts` treats the org tier as sales-led and never creates
  it), so it fails with "Failed to create checkout session". Either "Subscribe"
  becomes "Talk to us", or the price goes live. Check live mode too: only test
  mode was reachable from here. Pinned as a `fixme` in `org-billing.spec.ts`.
- **Sign-up-only classes with a drop-in price.** A known member pays through the
  guest form, recognised by email and exact name; a stranger now gets a clear
  refusal after the form and the waiver. A cleaner flow would identify first
  (sign in, then pay), which the funnel's step machine does not do today.

## Seen, not changed

- **The appointment picker sometimes drops back to the slot list** after
  Confirm, silently. Seen twice in five full runs, never in isolation or by hand;
  the funnel was being refactored the same day (#496 to #500).
- **"Courses starting soon"** lists a course that started 17 days ago, which the
  shop still sells. Selling after the start is deliberate (no closing date means
  open); the heading is not.
- **The Payments list does not refresh itself**: a payment that lands while the
  page is open appears on reload.
- **Nested buttons**: plugin marketplace cards are `role="button"` with Install
  and Details buttons inside, which assistive technology flattens away. The
  payment table rows carry an icon-only edit button with no accessible name.
- **The QR-bill plugin page, when not installed**, says to install it from the
  marketplace but gives no link, and its workspace tab reads "Qr Invoices".
- **Opening a paid course block asks the free rail first** (`joinCourseBlock`,
  a 400 by design) before the checkout, one wasted round trip per purchase.

## Dev-only noise

Under `next dev --webpack` (the deep-worktree workaround) the staff layout's
server render fails on jsdom's bundled stylesheet path and the client renders
normally; next-themes also warns about its inline script. The specs allow both
by name. Production builds with Turbopack and was not reproduced there.
