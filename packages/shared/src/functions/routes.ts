// ─── Callable routes ──────────────────────────────────────────────────────────
//
// The ONE place that says which ROUTER function serves a callable. Every gen2
// function is its own Cloud Run service, and nearly every recurring deploy
// failure scales with how many there are, so callables are being folded into a
// few domain routers (`docs/functions-consolidation-plan.md`). A router is an
// `onRequest` that hands `(req, res)` to the EXISTING `onCall` value, so auth,
// App Check and error serialisation are the SDK's own — nothing is
// re-implemented.
//
// Lives in @linyup/shared because both sides read it: the clients build the URL
// from it (`callFunction` in web, mobile and admin) and packages/functions
// asserts its router tables agree with it
// (`packages/functions/src/utils/routerCoverage.test.ts`).
//
// A name that is ABSENT here is called the way it always was,
// `httpsCallable(functions, name)`. That is also the rollback: delete a name's
// entry and every client goes back to the standalone function, which stays
// deployed under its old name until it is provably unused (the plan → "5.
// Compatibility and aliases").

export const ROUTER_NAMES = [
  // Throwaway: proves auth, App Check, CORS and error codes survive routing.
  // Deleted once the pilot router has shipped.
  'rpcSpike',
  'rpcMember',
  'rpcCheckout',
  'rpcStudio',
  'rpcFinance',
  'rpcOrg',
  'rpcBilling',
  'rpcHeavy',
  'rpcOps',
] as const

export type RouterName = (typeof ROUTER_NAMES)[number]

/**
 * Callable name → the router that serves it. Listing a name moves traffic only
 * for call sites that go through `callFunction`; the spike's members have none.
 */
export const CALLABLE_ROUTES: Readonly<Record<string, RouterName>> = {
  listAvailability: 'rpcSpike',
  getMyBookings: 'rpcSpike',

  // The operator console — the pilot. Called by apps/admin only.
  manageDemoTenant: 'rpcOps',
  setReviewAccess: 'rpcOps',
  getReviewAccess: 'rpcOps',
  resyncTenantFeeRate: 'rpcOps',
  previewPlatformNotice: 'rpcOps',
  sendPlatformNotice: 'rpcOps',

  // The finance desk: journal, monthly export, QR invoices, Tarif 595. Staff-only,
  // called by apps/web. The long jobs and the member's own receipt list are not
  // here — packages/functions/src/routers/finance.ts says why.
  exportFinanceReport: 'rpcFinance',
  createManualEntry: 'rpcFinance',
  reverseEntry: 'rpcFinance',
  closeFiscalYear: 'rpcFinance',
  setChartTemplate: 'rpcFinance',
  createInvoice: 'rpcFinance',
  voidInvoice: 'rpcFinance',
  downloadInvoice: 'rpcFinance',
  emailInvoice: 'rpcFinance',
  markInvoicePaid: 'rpcFinance',
  previewTarif595Receipt: 'rpcFinance',
  issueTarif595Receipt: 'rpcFinance',
  voidTarif595Receipt: 'rpcFinance',
  downloadTarif595Receipt: 'rpcFinance',
  emailTarif595Receipt: 'rpcFinance',
  suggestTarif595Mappings: 'rpcFinance',

  // What a studio or an organisation pays Linyup: checkout, cancel/reactivate,
  // the portal, invoices, plugin add-ons. Called by apps/web.
  createCheckoutSession: 'rpcBilling',
  cancelSaasSubscription: 'rpcBilling',
  getSaasInvoices: 'rpcBilling',
  reactivateSaasSubscription: 'rpcBilling',
  getBillingPortalUrl: 'rpcBilling',
  activatePluginAddon: 'rpcBilling',
  deactivatePluginAddon: 'rpcBilling',
  createOrgCheckoutSession: 'rpcBilling',
  cancelOrgSubscription: 'rpcBilling',
  reactivateOrgSubscription: 'rpcBilling',
  getOrgBillingPortalUrl: 'rpcBilling',
  getOrgInvoices: 'rpcBilling',

  // The organisation tier: member studios, org members and their invitations.
  // Called by apps/web; the invitation pages call some of these signed out.
  createOrganization: 'rpcOrg',
  inviteTeamToOrg: 'rpcOrg',
  acceptOrgInvitation: 'rpcOrg',
  declineOrgInvitation: 'rpcOrg',
  removeTeamFromOrg: 'rpcOrg',
  getOrgInvitationDetails: 'rpcOrg',
  requestTeamAccess: 'rpcOrg',
  addOrgMember: 'rpcOrg',
  updateOrgMemberRole: 'rpcOrg',
  removeOrgMember: 'rpcOrg',
  inviteOrgMember: 'rpcOrg',
  getOrgMemberInvitation: 'rpcOrg',
  acceptOrgMemberInvitation: 'rpcOrg',
  declineOrgMemberInvitation: 'rpcOrg',
  revokeOrgMemberInvitation: 'rpcOrg',
  unpublishOrgWebsite: 'rpcOrg',
}

export function routerForCallable(name: string): RouterName | null {
  return Object.prototype.hasOwnProperty.call(CALLABLE_ROUTES, name) ? CALLABLE_ROUTES[name] : null
}

/**
 * Where functions are served from, WITHOUT a trailing slash. `httpsCallableFromURL`
 * ignores `connectFunctionsEmulator`, so the emulator origin has to be spelled
 * out here rather than inherited from the Functions instance.
 */
export function functionsBaseUrl(args: {
  projectId: string
  region: string
  emulator?: { host: string; port: number } | null
}): string {
  const { projectId, region, emulator } = args
  if (emulator) return `http://${emulator.host}:${emulator.port}/${projectId}/${region}`
  return `https://${region}-${projectId}.cloudfunctions.net`
}

/** The router reads the callable's name from the LAST path segment. */
export function callableRouteUrl(args: { base: string; router: RouterName; name: string }): string {
  return `${args.base.replace(/\/+$/, '')}/${args.router}/${encodeURIComponent(args.name)}`
}
