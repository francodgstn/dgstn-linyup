// What a studio or an organization pays LINYUP, behind one function: checkout,
// cancel and reactivate, the billing portal, invoices, and plugin add-ons
// (docs/functions-consolidation-plan.md → "Phase 2").
//
// Team and org callables sit together because the client treats them as one
// flow — apps/web/src/hooks/useSaasBilling.ts picks the team or the org name
// from the billing scope. They are NOT merged: an org payer is authorized
// through org_members and a team payer through team_members (UX-75), and each
// member keeps its own check. The router adds none and removes none.
//
// NOT here: `handleStripeWebhook` and `handleTrialLifecycle`. The webhook's URL
// is registered with Stripe by function name (scripts/stripe-sync.ts), and the
// other is a schedule — neither is a callable.
//
// Every member ALSO stays exported standalone from src/index.ts until its alias
// is provably unused (utils/frozenFunctions.test.ts says why). This module must
// NOT call `setGlobalOptions` — src/index.ts owns it.

import { callableRouter } from '../utils/callableRouter'
import {
  createCheckoutSession,
  cancelSaasSubscription,
  getSaasInvoices,
  reactivateSaasSubscription,
  getBillingPortalUrl,
  activatePluginAddon,
  deactivatePluginAddon,
} from '../saas-billing'
import { createOrgCheckoutSession } from '../orgs'
import {
  cancelOrgSubscription,
  reactivateOrgSubscription,
  getOrgBillingPortalUrl,
  getOrgInvoices,
} from '../orgs/billing'

export const rpcBilling = callableRouter(
  'rpcBilling',
  {
    // No member asks for more than the defaults; every one is a short Stripe
    // round trip. A router's ceiling is concurrency × maxInstances for its
    // WHOLE domain, and an owner opens billing a few times a year.
    cpu: 1,
    concurrency: 40,
  },
  {
    createCheckoutSession,
    cancelSaasSubscription,
    getSaasInvoices,
    reactivateSaasSubscription,
    getBillingPortalUrl,
    activatePluginAddon,
    deactivatePluginAddon,
    createOrgCheckoutSession,
    cancelOrgSubscription,
    reactivateOrgSubscription,
    getOrgBillingPortalUrl,
    getOrgInvoices,
  }
)
