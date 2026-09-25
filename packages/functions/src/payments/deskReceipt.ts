/* eslint-disable no-console */
/**
 * THE RECEIPT FOR A SALE MADE BY HAND — cash at the desk, a bank transfer typed
 * in later, a payment a manager assigns to the person it belonged to, a pack of
 * credits given outright.
 *
 * UX-77 made every ONLINE paid rail confirm itself. Every offline one still
 * confirmed nothing, so a desk-sold ten-pack told the buyer nothing at all —
 * the same silence, one rail over. UX-80 closes it.
 *
 * ── THREE RULES, EACH OF WHICH IS WHY THIS FILE EXISTS ───────────────────────
 *
 * 1. THE SEND IS NOT IN `applyPaymentEffects`, AND MUST NEVER MOVE THERE.
 *    That function is deliberately RE-RUN on every manager edit — a re-assign, a
 *    line-item correction, a second save of the same dialog. It is idempotent
 *    about entitlements (a grant is keyed by payment ref, a course purchase by
 *    contact) but an email is not an entitlement: a send placed there would mail
 *    the member again on each re-save, and the studio would have no way to stop
 *    it. The decision therefore lives at the CALLABLES, one per rail.
 *
 * 2. IT IS NOT IN `writeManualPaymentEvent` EITHER, for the mirror of the same
 *    reason. That helper is shared with rails that already confirm themselves in
 *    their own words — the appointments phone-booking flow
 *    (`appointments/staffBooking.ts`, which sends an appointment confirmation
 *    with the time and the .ics) and the gift-card till (`connect/giftCards.ts`,
 *    whose mail carries the CODE). Putting the send in the shared writer would
 *    send those buyers a second, worse mail about the same money.
 *
 * 3. IT IS A CHOICE, NOT A TOGGLE. `connect/purchaseReceipts.ts` is ALWAYS ON
 *    and `utils/systemEmails.ts` explains why: a web buyer who is told nothing
 *    is stranded. A desk buyer is not stranded — a human just handed them the
 *    thing — so the studio decides per sale, on the dialog, in front of the
 *    person. That is deliberately NOT a `SystemEmailKey`: a hidden switch in
 *    settings is exactly the silence this finding is about, and a per-sale
 *    checkbox is visible at the moment it matters. An OMITTED flag never sends
 *    (an API caller that predates this cannot surprise anybody); the default
 *    the studio actually sees is chosen in the UI, by what the sale GRANTS.
 *
 * WHAT THE COPY MAY CLAIM. Bodies are the UX-77 templates unchanged — a desk
 * sale is the same receipt with a different tender — with three honesty edits
 * carried on the parameters rather than in a fourth template:
 *
 *   • THE TENDER IS NAMED. `PaidAmount.methodLabel` prints the studio's own mode
 *     ("Paid: CHF 120.00 (Cash)"), so nobody reads a bare amount and assumes a
 *     card was charged. There is no Stripe object behind a cash sale, so there
 *     is no refund path through Stripe and no line claims one.
 *   • NOTHING RENEWS. `recurring` is always FALSE here. A manual payment creates
 *     no Stripe subscription, so the recurring copy ("renews automatically …
 *     manage or cancel it from your member area") would promise a billing portal
 *     that does not exist for this member. A cash membership is a one-off
 *     payment and the mail says exactly that.
 *   • GIVEN IS NOT BOUGHT. `grantCredits` passes `granted: true`, which swaps
 *     "Thank you — your purchase is confirmed" for "{studio} has added N credits
 *     to your account". A cash pack IS a purchase and keeps the purchase copy.
 *
 * The member-area invitation stays on all three: the entitlement written by
 * `applyPaymentEffects` is the real one, so the credits, the membership and the
 * course are genuinely there to open, and the passwordless sign-in works for a
 * contact who has never seen the platform.
 *
 * IDEMPOTENCY. The tender ref of a desk sale is the PAYMENT ROW'S DOC ID
 * (`teams/{t}/payment_events/manual:{key}`, or the Connect/BYO row being
 * assigned) — the same string `applyPaymentEffects` used as its payment ref. It
 * is what makes a desk sale unique, and it is already the dedupe key for the row
 * itself: `writeManualPaymentEvent` creates the doc with `.create()`, so a
 * double-click carrying the same client key writes one row, reports
 * `duplicate`, and the callable returns before reaching this module. The
 * `mail_sends` ledger key (`purchase-…-{contactId}-{docId}`) is the second net,
 * and it is the only one on the assign rail, where re-saving the dialog is a
 * legitimate repeat call. Re-assigning to a DIFFERENT contact keys differently
 * and mails, which is correct; moving it back does not, which is also correct.
 *
 * NOTHING HERE THROWS — same posture as the shop receipts, for the same reason:
 * the money is recorded and the entitlement is granted before this is called,
 * and a mail outage must not fail the manager's save.
 */
import * as admin from 'firebase-admin'
import {
  PRODUCTS_SUBCOLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  deskReceiptKindFor,
  type PaymentLineItem,
} from '@linyup/shared'
import {
  sendCoursePurchaseReceipt,
  sendMembershipPurchaseReceipt,
  sendProductPurchaseReceipt,
} from '../connect/purchaseReceipts'

export interface DeskSaleReceiptParams {
  teamId: string
  contactId: string
  /** What was bought — already normalized by `normalizePaymentLineItem`. */
  lineItem: PaymentLineItem
  /** The payment row's doc id. Doubles as the credit-grant id (that is the ref
   *  `applyPaymentEffects` grants under) and as the mail ledger's tender ref. */
  paymentRef: string
  /** Gross, MINOR units, or null when the row carries no amount. */
  amountRappen: number | null
  currency: string
  /** The studio's own payment-mode label ("Cash", "TWINT"), when it has one. */
  methodLabel?: string | null
}

/**
 * Send the one receipt this desk sale warrants, or nothing.
 *
 * Returns the kind that was sent (or null) so the caller can log it; the caller
 * decides WHETHER, this decides WHICH. Never throws.
 */
export async function sendDeskSaleReceipt(
  p: DeskSaleReceiptParams
): Promise<'subscription' | 'course' | 'product' | null> {
  // The SHARED predicate the manager's checkbox is mounted on
  // (`deskReceiptKindFor`, packages/shared/src/types/payment.ts), so the box can
  // never offer a mail this function would then decline to send. It also owns
  // the reasons the other kinds are excluded — read them there.
  const kind = deskReceiptKindFor(p.lineItem)
  if (!kind) return null

  const paid =
    p.amountRappen != null && p.amountRappen > 0
      ? {
          amount: Math.round(p.amountRappen) / 100,
          currency: p.currency,
          // Named, so a bare amount cannot read as a card charge.
          ...(p.methodLabel?.trim() ? { methodLabel: p.methodLabel.trim() } : {}),
        }
      : null

  try {
    switch (kind) {
      case 'subscription': {
        await sendMembershipPurchaseReceipt({
          teamId: p.teamId,
          contactId: p.contactId,
          tenderRef: p.paymentRef,
          // `applyPaymentEffects` grants credits under the payment ref, so this
          // is the grant that was just written when the price carried any. When
          // it carried none the lookup misses and the membership body is used —
          // the same fork the shop rail makes, decided by the same fact.
          creditGrantId: p.paymentRef,
          planName: await subscriptionTypeName(p.teamId, p.lineItem),
          // ALWAYS false — see the module header. A manual payment creates no
          // Stripe subscription and there is no billing portal to promise.
          recurring: false,
          // `applyPaymentEffects` writes no membership expiry on this rail (the
          // subscription axis is separate from the affiliation axis), so there
          // is no date to state. A credit pack's own expiry rides on the grant.
          validUntil: null,
          paid,
        })
        return 'subscription'
      }
      case 'course': {
        if (!p.lineItem.courseId) return null
        await sendCoursePurchaseReceipt({
          teamId: p.teamId,
          contactId: p.contactId,
          courseId: p.lineItem.courseId,
          courseTitle: p.lineItem.label ?? null,
          tenderRef: p.paymentRef,
          paid,
        })
        return 'course'
      }
      case 'product': {
        await sendProductPurchaseReceipt({
          teamId: p.teamId,
          contactId: p.contactId,
          itemLabel: await productLabel(p.teamId, p.lineItem),
          productId: p.lineItem.productId ?? null,
          tenderRef: p.paymentRef,
          paid,
        })
        return 'product'
      }
    }
  } catch (err) {
    // Unreachable in practice — each sender swallows its own failures — but the
    // manager's save must not depend on that staying true.
    console.error(
      `[desk-receipt] send failed (team=${p.teamId} contact=${p.contactId} ref=${p.paymentRef}):`,
      err
    )
    return null
  }
}

/** The plan name for the receipt: the manager's own label if she typed one,
 *  else the subscription type's name. Only used for a membership without
 *  credits — a credit pack's name comes off the grant document, which is the
 *  name the credits were actually granted under. */
async function subscriptionTypeName(teamId: string, li: PaymentLineItem): Promise<string> {
  if (li.label) return li.label
  if (!li.subscriptionTypeId) return 'Membership'
  try {
    const snap = await admin
      .firestore()
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
      .doc(li.subscriptionTypeId)
      .get()
    return (snap.data()?.name as string | undefined) || 'Membership'
  } catch {
    return 'Membership'
  }
}

/** "Hoodie · XL" if the manager picked one, else the product's own name. */
async function productLabel(teamId: string, li: PaymentLineItem): Promise<string> {
  if (li.label) return li.label
  if (!li.productId) return 'Product'
  try {
    const snap = await admin
      .firestore()
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(PRODUCTS_SUBCOLLECTION)
      .doc(li.productId)
      .get()
    return (snap.data()?.name as string | undefined) || 'Product'
  } catch {
    return 'Product'
  }
}

export interface GrantedCreditsReceiptParams {
  teamId: string
  contactId: string
  /** The credit grant that was just written — doc id under
   *  contacts/{id}/credit_grants. Also the tender ref: there is no payment. */
  grantId: string
  /** Name of the subscription type the credits were granted under. */
  planName: string
}

/**
 * The receipt for credits a studio GAVE — the `grantCredits` rail (a goodwill
 * make-up lesson, a correction, a pack whose money was taken somewhere this
 * platform never saw).
 *
 * The same credit-pack body, with `granted: true` and no `paid` line, because
 * both of those would otherwise be lies: there is no amount, and the purchase
 * copy thanks the reader for a purchase they did not make. Everything else is
 * identical, because the payload is identical — a number, a scope, an expiry.
 */
export async function sendGrantedCreditsReceipt(p: GrantedCreditsReceiptParams): Promise<void> {
  try {
    await sendMembershipPurchaseReceipt({
      teamId: p.teamId,
      contactId: p.contactId,
      // No payment exists, so the GRANT is the tender: a repeated call with the
      // same grant id is deduped by the mail ledger, and a genuinely second
      // grant has a different id and mails again.
      tenderRef: `grant:${p.grantId}`,
      creditGrantId: p.grantId,
      planName: p.planName,
      recurring: false,
      validUntil: null,
      paid: null,
      granted: true,
    })
  } catch (err) {
    console.error(
      `[desk-receipt] granted-credits send failed (team=${p.teamId} contact=${p.contactId} grant=${p.grantId}):`,
      err
    )
  }
}
