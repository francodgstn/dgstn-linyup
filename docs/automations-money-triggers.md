---
title: Money triggers for the automation engine
status: living
area: payments
---
# Money triggers for the automation engine

A studio can now automate off what Stripe does to a payment. Until this landed, the
engine could only react to CONTACT and BOOKING documents.

## The triggers

| Trigger | Seam | Fires when |
|---|---|---|
| `payment_received` | payment row | the payment is succeeded **and** has a contact, and one of those was missing before |
| `payment_refunded` | payment row | `amount_refunded` strictly increased, landing in a refunded status |
| `payment_disputed` | payment row | `dispute_status` went from absent to present |
| `subscription_payment_failed` | contact | the subscription rollup becomes `past_due` |
| `subscription_cancel_requested` | contact | a live subscription starts winding down |

The payment-row edges are owned by the module header of
`packages/functions/src/automation/paymentEvents.ts`; the contact edges by
`resolveContactEvents` in `packages/functions/src/automation/onContactWrite.ts`. Those
are the census — add an edge there, and refer to it from anywhere else rather than
restating it.

**The two contact-seam triggers shipped separately** (the 2026-08 prod-canary pass) and
are not part of this change; they are in the table because the split between the two
seams is the thing worth understanding, and half a table cannot explain it.

## Why the seam is split

It looks like an inconsistency and it is not. It is where the subject actually is.

A refund has no contact-level fact: payments live at
`teams/{teamId}/member_payments/{paymentIntentId}` and are not mirrored onto the
contact, so the payment row is the only place the event exists.

A failed **recurring** charge is the opposite. Its payment row has no `contactId` at
all — an invoice-generated PaymentIntent carries no metadata of its own, and
`handleInvoice` only pays for the expand that resolves the payment link when the invoice
is `paid`. So a money-seam `payment_failed` would be systematically subject-less for
exactly the dunning case it would exist to serve. A cancellation is more extreme still:
it writes no payment row whatsoever.

Both of those facts are already on the contact, put there by
`rollupMemberSubscriptions` — `subscription_status: 'past_due'`, and
`ActiveSubscriptionSummary.cancelling`. So both are ordinary contact-document deltas,
they fire for every write path (webhook, manager callable, seed) rather than for one,
and no money handler was touched to get them.

## What the payment resolver has to survive

Everything below is a real ordering hazard, not a hypothetical, and each one is why an
edge is keyed the way it is:

- **One sale writes the payment document several times**, from two Stripe handlers whose
  order Stripe does not guarantee (`connect/webhook.ts` documents a 1–4 s skew), plus a
  fee mirror and per-kind stamps. Nothing here may be keyed on "the document changed".
- **`contactId` routinely arrives on a later write than `status: 'succeeded'`.** So
  `payment_received` waits for the SUBJECT, not for the status. That subject can also
  arrive months later, from a manager assigning an unclaimed row by hand — which is what
  `PAYMENT_SUBJECT_ARRIVAL_WINDOW_MS` bounds, and it bounds the arrival branch only.
- **Three auto-refund branches stamp `status: 'refunded'` while `amount_refunded` is
  still 0**, with the authoritative `charge.refunded` write landing afterwards. So
  `payment_refunded` is keyed on the AMOUNT, not on the status transition. That also
  makes a second partial refund expressible — `partially_refunded →
  partially_refunded` is no transition at all, but it is a second real event.
- **Stripe redelivers events**, and every refund write is an ABSOLUTE cumulative figure.
  A redelivery therefore re-writes the same number, the amount does not increase, and
  nothing fires twice.
- **`handleDispute` writes the same field for the opening and the closing event**, so
  the dispute edge is the FIRST appearance, not any change.

## Two rules to keep

**An unassigned payment fires nothing.** `member_payments.contactId` is nullable.
Firing with no subject would still stamp `last_run_at` and write an `automation_logs`
row saying "0 matched" — a run history that lies about what happened — and every action
but `notify_team`/`webhook` operates on a contact anyway. The event is deferred, not
lost: assigning the row is itself a write, and the arrival branch picks it up while the
payment is still recent.

**The money facts ride in `EventDelta`, never in `AutomationContext.payload`.**
`resolveEventDelayMinutes` refuses a delay to any run carrying a non-empty payload — a
blanket rule about persisting caller data in the Cloud Tasks queue. A payload here would
kill the delay silently, while the rule builder went on offering the field. The accepted
cost is that the amount and the currency are **not** addressable from an action template
as `{{payload.*}}`; the payment row is the record. `paymentEvents.test.ts` reads
`onMemberPaymentWrite.ts` and pins this.

## Scoping a rule

`trigger.paymentKind` narrows the three payment-row triggers to one
`MemberPayment.kind`, so "when someone buys a course, send the welcome guide" is one
rule. It mirrors `trigger.subscriptionTypeId`, which narrows the subscription family
the same way.

**A scope is only real if the ENGINE narrows on it.** `subscription_cancel_requested`
shipped emitting a `subscriptionTypeId` delta that `fireEventRules` never matched on,
so a rule narrowed to one plan fired when any plan was cancelled — the builder offered
a control that silently did nothing. Nothing typed catches that: the delta field is
optional, the branch is a valid boolean expression, and the rule fires; only the
narrowing is missing. It was found by driving the emulator, and
`automation/subscriptionScope.test.ts` now reads both files and pins them in agreement.

All three payment triggers honour a delay, through the same Cloud Tasks path as every
other event trigger. `delayedRules.test.ts` reads both the engine and the rule builder
and fails the build if the two ever disagree about that.

## Known gaps

- The **BYO/external payment rail** writes `teams/{id}/payment_events`, a different
  collection. None of these triggers fire for a studio on that rail.
- No trigger for `effects_reversal.state === 'failed'` (the money went back and the
  entitlement did not). It is an ops alert whose only sensible action is `notify_team`,
  and it is already visible on the payments row.
