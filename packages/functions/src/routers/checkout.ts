// Where a member or a guest PAYS, behind one function: every checkout (drop-in,
// appointment, membership, product, course, gift card), the gift-card and promo
// checks the form makes before it, claiming a finished checkout, and the contact's
// own billing portal (docs/functions-consolidation-plan.md → "Phase 3").
//
// It is its own router, apart from routers/member.ts, for BLAST RADIUS: a bad
// deploy of the booking surface must not also stop a studio taking money, and the
// reverse. It is apart from routers/finance.ts because that one is staff.
//
// APP CHECK IS EACH MEMBER'S OWN. The checkouts, `previewPromoCode` and
// `checkGiftCard` carry `enforceAppCheck` (utils/appCheck.ts), and the SDK
// enforces it inside the member's own handler, which is what the router calls —
// so the flag keeps working here without the router knowing it exists
// (utils/callableRouter.test.ts puts an enforcing member behind a real router).
//
// NOT here: `handleConnectWebhook`. Its URL is registered with Stripe by function
// name (scripts/stripe-sync.ts), and it is not a callable.
//
// Every member ALSO stays exported standalone from src/index.ts until its alias
// is provably unused (utils/frozenFunctions.test.ts says why). Authorisation is
// each member's own; the router adds none and removes none. This module must NOT
// call `setGlobalOptions` — src/index.ts owns it.

import { callableRouter } from '../utils/callableRouter'
import { createAppointmentCheckout } from '../appointments/checkout'
import { createDropInCheckout } from '../booking/dropIn'
import { createCourseBlockCheckout } from '../courseBlocks/checkout'
import { claimCheckoutSession } from '../connect/claimCheckoutSession'
import { createGiftCardCheckout, checkGiftCard } from '../connect/giftCards'
import {
  createCourseCheckout,
  createMembershipCheckout,
  createProductCheckout,
} from '../connect/payments'
import { previewPromoCode } from '../connect/promoCodes'
import { createContactBillingPortalSession } from '../contacts/contactPayments'

export const rpcCheckout = callableRouter(
  'rpcCheckout',
  {
    // No member asks for more than the defaults; each is a Stripe round trip.
    // 512MiB because one instance now serves the whole paying surface at once.
    // Concurrency matches what a plain callable gets today, so routing takes
    // nothing away from the money path.
    memory: '512MiB',
    cpu: 1,
    concurrency: 80,
  },
  {
    createAppointmentCheckout,
    createDropInCheckout,
    createCourseBlockCheckout,
    createCourseCheckout,
    createGiftCardCheckout,
    createMembershipCheckout,
    createProductCheckout,
    checkGiftCard,
    previewPromoCode,
    claimCheckoutSession,
    createContactBillingPortalSession,
  }
)
