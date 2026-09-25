/**
 * THE ONE SALES ROUTE in the product.
 *
 * There is no self-service lane for the Organization tier — `createOrganization`
 * exists as a callable but nothing in the product calls it — so every surface
 * that offers the tier has to end in a conversation. It ended in a mailto typed
 * inline on the billing page; a second copy on the org upsell would have been
 * the first step toward two addresses that disagree.
 */
export const ORG_ENQUIRY_MAILTO =
  'mailto:hello@linyup.com?subject=Organisation%20plan%20enquiry'
