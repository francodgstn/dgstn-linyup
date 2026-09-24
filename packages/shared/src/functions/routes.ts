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
 * for call sites that go through `callFunction`.
 */
export const CALLABLE_ROUTES: Readonly<Record<string, RouterName>> = {
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
  // … and the staff side of member payments: Connect, subscriptions, refunds,
  // manual payments, gift cards, promo codes.
  cancelMemberSubscription: 'rpcFinance',
  clearPromoRedemption: 'rpcFinance',
  createMemberPayment: 'rpcFinance',
  createMembershipPayment: 'rpcFinance',
  createMemberSubscription: 'rpcFinance',
  createPromoCode: 'rpcFinance',
  disconnectConnectAccount: 'rpcFinance',
  getConnectStatus: 'rpcFinance',
  issueGiftCard: 'rpcFinance',
  pauseMemberSubscription: 'rpcFinance',
  refundMemberPayment: 'rpcFinance',
  getPaymentReceiptUrl: 'rpcFinance',
  releasePromoReservations: 'rpcFinance',
  resumeMemberSubscription: 'rpcFinance',
  setPromoCodeStatus: 'rpcFinance',
  startConnectOnboarding: 'rpcFinance',
  updatePaymentRecord: 'rpcFinance',
  updatePromoCode: 'rpcFinance',
  voidGiftCard: 'rpcFinance',
  recordManualPayment: 'rpcFinance',
  voidManualPayment: 'rpcFinance',

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

  // The long jobs — minutes-long or a gigabyte. Together so that their profile is
  // paid only by the calls that need it.
  rebuildAccountingLedger: 'rpcHeavy',
  refreshStorePresence: 'rpcHeavy',
  recalculateScoresFromDate: 'rpcHeavy',
  publishOrgWebsite: 'rpcHeavy',
  sendOutreachEmail: 'rpcHeavy',
  startTarif595BulkIssue: 'rpcHeavy',
  publishWebsite: 'rpcHeavy',

  // The studio's day-to-day: every staff callable that is not money, billing, the
  // org tier or a long job. Nothing a member, a guest or the member app calls.
  approveAffiliation: 'rpcStudio',
  removeAffiliation: 'rpcStudio',
  renewAffiliation: 'rpcStudio',
  upsertAffiliation: 'rpcStudio',
  generateTeamSentiment: 'rpcStudio',
  approveOAuthAuthorization: 'rpcStudio',
  createApiKey: 'rpcStudio',
  denyOAuthAuthorization: 'rpcStudio',
  getOAuthAuthorizationRequest: 'rpcStudio',
  revokeApiKey: 'rpcStudio',
  revokeOAuthGrant: 'rpcStudio',
  cancelAppointmentSlot: 'rpcStudio',
  createStaffAppointment: 'rpcStudio',
  markAppointmentPaid: 'rpcStudio',
  assistantChat: 'rpcStudio',
  confirmEmailVerified: 'rpcStudio',
  previewAutomationRule: 'rpcStudio',
  triggerAutomationRule: 'rpcStudio',
  promoteWaitlistEntry: 'rpcStudio',
  removeWaitlistEntry: 'rpcStudio',
  resendPolicyFeeLink: 'rpcStudio',
  waivePolicyFee: 'rpcStudio',
  assignPlan: 'rpcStudio',
  changePlan: 'rpcStudio',
  checkInContact: 'rpcStudio',
  createContactUpdateLink: 'rpcStudio',
  createContactUpdateLinksBatch: 'rpcStudio',
  deleteContact: 'rpcStudio',
  endPlan: 'rpcStudio',
  exportContacts: 'rpcStudio',
  generateContactQR: 'rpcStudio',
  generateContactSummary: 'rpcStudio',
  grantCredits: 'rpcStudio',
  manageContactUpdateRequest: 'rpcStudio',
  moveContacts: 'rpcStudio',
  restoreContact: 'rpcStudio',
  revokeContactUpdateLinks: 'rpcStudio',
  sendContactRecapEmail: 'rpcStudio',
  checkPublicDomain: 'rpcStudio',
  registerPublicDomain: 'rpcStudio',
  removePublicDomain: 'rpcStudio',
  addEventCheckin: 'rpcStudio',
  duplicateEvent: 'rpcStudio',
  sendEventInvitations: 'rpcStudio',
  recalculateScores: 'rpcStudio',
  resetScores: 'rpcStudio',
  triggerScoresRebuild: 'rpcStudio',
  checkSenderDomain: 'rpcStudio',
  registerSenderDomain: 'rpcStudio',
  sendTestEmail: 'rpcStudio',
  useManagedSender: 'rpcStudio',
  applyOfferingDraft: 'rpcStudio',
  draftOfferings: 'rpcStudio',
  unlockPlugin: 'rpcStudio',
  confirmReferral: 'rpcStudio',
  generateReferralCodes: 'rpcStudio',
  cancelSession: 'rpcStudio',
  createCourseBlock: 'rpcStudio',
  updateCourseBlock: 'rpcStudio',
  setCourseBlockStatus: 'rpcStudio',
  deleteCourseBlock: 'rpcStudio',
  cancelCourseBlock: 'rpcStudio',
  duplicateCourseBlock: 'rpcStudio',
  addCourseBlockMeeting: 'rpcStudio',
  listCourseBlockWaitlist: 'rpcStudio',
  enrolCourseBlockContact: 'rpcStudio',
  withdrawFromCourseBlock: 'rpcStudio',
  generateRecurringSessions: 'rpcStudio',
  setSessionLocation: 'rpcStudio',
  setSessionTags: 'rpcStudio',
  updateRecurringSession: 'rpcStudio',
  cancelTeamDeletion: 'rpcStudio',
  createStudioTeam: 'rpcStudio',
  listTeamMembers: 'rpcStudio',
  manageTeamInvitation: 'rpcStudio',
  manageTeamMember: 'rpcStudio',
  requestTeamDeletion: 'rpcStudio',
  sendTeamInvitation: 'rpcStudio',
  validateTeamSlug: 'rpcStudio',
  archiveWaiver: 'rpcStudio',
  createWaiver: 'rpcStudio',
  publishDocumentVersion: 'rpcStudio',
  requestWaiverAcceptance: 'rpcStudio',
  revokeWaiverAcceptance: 'rpcStudio',
  setWaiverRequirement: 'rpcStudio',
  updateWaiver: 'rpcStudio',
  unpublishWebsite: 'rpcStudio',
  connectWhatsApp: 'rpcStudio',
  deleteWhatsAppTemplate: 'rpcStudio',
  disconnectWhatsApp: 'rpcStudio',
  getWhatsAppSignupConfig: 'rpcStudio',
  getWhatsAppUsage: 'rpcStudio',
  refreshWhatsAppStatus: 'rpcStudio',
  setContactWhatsAppConsent: 'rpcStudio',
  submitWhatsAppTemplate: 'rpcStudio',
  // … and joining a studio as staff: signing up and accepting a team invitation.
  createTeam: 'rpcStudio',
  acceptTeamInvitation: 'rpcStudio',
  getTeamInvitationDetails: 'rpcStudio',

  // Where a member or a guest PAYS. Its own router for blast radius.
  createAppointmentCheckout: 'rpcCheckout',
  createCourseBlockCheckout: 'rpcCheckout',
  createDropInCheckout: 'rpcCheckout',
  createCourseCheckout: 'rpcCheckout',
  createGiftCardCheckout: 'rpcCheckout',
  createMembershipCheckout: 'rpcCheckout',
  createProductCheckout: 'rpcCheckout',
  checkGiftCard: 'rpcCheckout',
  previewPromoCode: 'rpcCheckout',
  claimCheckoutSession: 'rpcCheckout',
  createContactBillingPortalSession: 'rpcCheckout',

  // Everything else a member or a guest does: booking, the Space, contact sign-in,
  // the kiosk. The member app calls some of these by their OWN name and keeps
  // doing so until it routes (Phase 4) — listing them here moves only callFunction callers.
  joinCourseBlock: 'rpcMember',
  joinCourseBlockWaitlist: 'rpcMember',
  leaveCourseBlockWaitlist: 'rpcMember',
  claimCourseBlockPlace: 'rpcMember',
  getCourseWaitlistEntry: 'rpcMember',
  listAvailability: 'rpcMember',
  getMyBookings: 'rpcMember',
  bookAppointment: 'rpcMember',
  completeSignup: 'rpcMember',
  loginContactWithCode: 'rpcMember',
  sendContactVerificationCode: 'rpcMember',
  verifyContactCode: 'rpcMember',
  bookSession: 'rpcMember',
  cancelBooking: 'rpcMember',
  claimWaitlistSeat: 'rpcMember',
  getBookingDetails: 'rpcMember',
  getMyAttendance: 'rpcMember',
  getWaitlistEntry: 'rpcMember',
  joinWaitlist: 'rpcMember',
  leaveWaitlist: 'rpcMember',
  listMyWaitlist: 'rpcMember',
  rebookSession: 'rpcMember',
  sendBookingVerificationCode: 'rpcMember',
  verifyBookingCode: 'rpcMember',
  cancelContactDeletion: 'rpcMember',
  getContactQR: 'rpcMember',
  listMyContactPayments: 'rpcMember',
  requestContactDeletion: 'rpcMember',
  requestContactUpdate: 'rpcMember',
  resolveContactUpdateLink: 'rpcMember',
  submitContactUpdateLink: 'rpcMember',
  switchActiveContact: 'rpcMember',
  getPublicDocumentVersion: 'rpcMember',
  getEventInvitationDetails: 'rpcMember',
  handleEventInvitationResponse: 'rpcMember',
  submitForm: 'rpcMember',
  unlockKiosk: 'rpcMember',
  getMyReferralCode: 'rpcMember',
  getMyReferralStats: 'rpcMember',
  selfCheckIn: 'rpcMember',
  listMyTarif595Receipts: 'rpcMember',
  exportContactConsentHistory: 'rpcMember',
  resolveWaiverRequirement: 'rpcMember',
  signWaiverInSpace: 'rpcMember',
  setMyWhatsAppConsent: 'rpcMember',
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

// ─── When the router is not there ─────────────────────────────────────────────
//
// A client and the backend it talks to do not deploy together. The member app
// ships over the air on its own lane, so a build that routes can reach a phone
// BEFORE the project it talks to has that router — and the only way back from a
// broken member app is another over-the-air update. The web has a smaller window
// of the same kind wherever its rollout is not ordered after the functions deploy.
//
// So a routed call that finds NO ROUTER falls back to the callable's own name,
// which stays deployed until it is provably unused. That is safe for one reason
// only: in both cases below the member never ran, so nothing is executed twice.
//
//   - the function does not exist → the platform answers 404, which the SDK
//     reports as `not-found` with the bare message 'not-found'
//   - the router exists but does not serve that name (a route rolled back on the
//     server first) → the router's own 404, 'No such callable on <router>'
//
// A `not-found` a MEMBER throws ('Session not found') has its own message and is
// NOT a fallback: the member ran, and running it again is not ours to decide.
//
// WHAT IT DOES NOT COVER: a missing function, IN A BROWSER. The platform's 404
// carries no CORS headers, so the browser withholds the response and the SDK
// reports `internal` — which could equally be a member that ran and crashed, so
// it is never a fallback. The web therefore still depends on its rollout being
// ordered after the functions deploy (the production workflow does that); only
// the router's OWN 404, which answers with CORS headers, reaches it. A phone has
// no CORS, so the member app gets both cases — and it is the one that needs them.

const ROUTER_UNKNOWN_NAME = 'No such callable on '

export function isRouterMissingError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null
  if (!e || typeof e.code !== 'string' || typeof e.message !== 'string') return false
  if (e.code !== 'functions/not-found' && e.code !== 'not-found') return false
  return e.message.toLowerCase() === 'not-found' || e.message.startsWith(ROUTER_UNKNOWN_NAME)
}

// Remembered for the life of the page or app session, so a project without the
// router costs ONE failed round trip per router, not one per call. A reload or an
// app restart asks again, which is how a client notices the router has arrived.
const routersFoundMissing = new Set<RouterName>()

/**
 * `routed`, falling back to `direct` when the router is not there. Both are built
 * lazily by the caller; neither is invoked until a call is made.
 */
export function withRouterFallback<Req, Res>(args: {
  router: RouterName
  routed: (data?: Req | null) => Promise<Res>
  direct: (data?: Req | null) => Promise<Res>
  onFallback?: (router: RouterName) => void
}): (data?: Req | null) => Promise<Res> {
  const { router, routed, direct, onFallback } = args
  return async (data) => {
    if (routersFoundMissing.has(router)) return direct(data)
    try {
      return await routed(data)
    } catch (error) {
      if (!isRouterMissingError(error)) throw error
      routersFoundMissing.add(router)
      onFallback?.(router)
      return direct(data)
    }
  }
}

/** Test seam: forget which routers were found missing. */
export function resetRouterFallbackMemory(): void {
  routersFoundMissing.clear()
}
