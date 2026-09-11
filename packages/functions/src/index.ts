import * as admin from 'firebase-admin'
import { setGlobalOptions } from 'firebase-functions/v2'

// Initialize Firebase Admin (once)
if (!admin.apps.length) {
  admin.initializeApp()
}

// Set region once — individual modules must NOT call setGlobalOptions.
//
// `maxInstances` is a COST CEILING, not a capacity plan: it bounds what a
// trigger loop or a traffic spike can scale into (there was no bound at all —
// see docs/scalability-2026-09.md, "Secondary limits"). Twenty per function is
// generous for every path this product runs today; a hot callable that ever
// needs more sets its own `maxInstances` in its options, which overrides this,
// and says why. The billing budget (infra/modules/budget) is the other half.
setGlobalOptions({ region: 'europe-west6', maxInstances: 20 })

// Teams
export { createTeam } from './teams/createTeam'
export { createStudioTeam } from './teams/createStudioTeam'
export { onTeamCreated } from './teams/onTeamCreated'
export { validateTeamSlug } from './teams/validateTeamSlug'
export { sendTeamInvitation } from './teams/sendTeamInvitation'
export { getTeamInvitationDetails } from './teams/getTeamInvitationDetails'
export { acceptTeamInvitation } from './teams/acceptTeamInvitation'
export { manageTeamInvitation } from './teams/manageTeamInvitation'
export { manageTeamMember } from './teams/manageTeamMember'
export { listTeamMembers } from './teams/listTeamMembers'

// Auth
export { sendContactVerificationCode } from './auth/sendContactVerificationCode'
export { generateApiKey } from './auth/generateApiKey'

// Signup gating (limited launch) — blocking function + invite email trigger
export { beforeSignup } from './auth/beforeSignup'
export { confirmEmailVerified } from './auth/confirmEmailVerified'
export { requestTeamDeletion, cancelTeamDeletion } from './teams/deleteAccount'
export { onSignupInviteCreated } from './auth/onSignupInviteCreated'

// Affiliations
export { upsertAffiliation, removeAffiliation, approveAffiliation, renewAffiliation } from './affiliations'

// Sync triggers
export { syncTeamPublicProfile } from './sync/syncTeamPublicProfile'
export { syncSessionPublicProfile } from './sync/syncSessionPublicProfile'
export { syncActivityPublicProfile } from './sync/syncActivityPublicProfile'
export { syncStudioDropIn } from './sync/syncStudioDropIn'
export { syncCoursePublicProfile } from './sync/syncCoursePublicProfile'
export { syncFormPublicProfile } from './sync/syncFormPublicProfile'
export { syncDocumentPublicProfile } from './sync/syncDocumentPublicProfile'
export {
  syncEventPublicProfile,
  syncEventProgramPublicProfile,
} from './sync/syncEventPublicProfile'
export { indexUser } from './sync/indexUser'
export { syncSubscriptionTypesToPublicProfile } from './sync/syncSubscriptionTypesToPublicProfile'
export { syncProductsToPublicProfile } from './sync/syncProductsToPublicProfile'
export { syncMemberCapabilities } from './sync/syncMemberCapabilities'
export { syncPrimaryPlaceToPublicProfile } from './sync/syncPrimaryPlaceToPublicProfile'
export { syncTeamCoachesPublicProfile } from './sync/syncTeamCoachesPublicProfile'
export { onContactSubscriptionChange } from './sync/onContactSubscriptionChange'
export { onMemberSubscriptionWrite } from './sync/onMemberSubscriptionWrite'
export { onSessionUpdate } from './sync/onSessionUpdate'
export { onActivityTypeChange } from './sync/onActivityTypeChange'
export { onInstalledPluginStatusChange } from './sync/onInstalledPluginStatusChange'
// Bundle reconciliation — the ONE writer of a container's member installs.
// Separate from the trigger above on purpose: that one carries a
// non-idempotent activation hook and cannot be retried; these can.
export { onTeamBundleInstallChange, onOrgBundleInstallChange } from './plugins/bundleTriggers'
export { onAffiliationWrite } from './sync/onAffiliationWrite'
export { syncAffiliationContactLive } from './sync/syncAffiliationContactLive'
export { onCreditGrantWrite } from './sync/onCreditGrantWrite'
// Availability writes re-run the team sync so the appointment picker's liveness
// flag (active_public_surfaces.appointments) can't go stale — see the file.
export { onAvailabilityWrite } from './sync/onAvailabilityWrite'

// Booking
export {
  bookSession,
  sendBookingVerificationCode,
  verifyBookingCode,
  cancelBooking,
  getBookingDetails,
  rebookSession,
} from './booking'
export { createDropInCheckout } from './booking/dropIn'
// The member's own upcoming bookings. A callable for the same reason
// `listMyWaitlist` is one — the rules authorise a contact to GET their own
// booking and never to LIST their bookings across sessions — plus one this
// surface adds: a booking on a session the STUDIO entered has no public mirror
// to be found through, because a session is mirrored only while it is on sale.
export { getMyBookings } from './booking/myBookings'
// Waitlist (class-only) — join/leave the queue for a full class, and the
// promoter that offers a seat to the front of it. The promoter is a session
// TRIGGER, not a call site hook: every event that frees a seat converges on a
// session-document write. See booking/waitlist/promote.ts.
// The claim settles a seat that is ALREADY held — free through
// claimWaitlistSeat, paid through the ordinary createDropInCheckout with the
// offer token attached. The hourly sweep (booking/waitlist/sweep.ts) rolls a
// lapsed offer on and rides bookingRemindersHourly, so it exports no function
// of its own.
// `getWaitlistEntry` is what makes the two token links resolvable at all: the
// queue is never client-readable without a contact session, and a guest who
// joined from the public form has only the token in their mail.
export { joinWaitlist } from './booking/waitlist/join'
export { claimWaitlistSeat } from './booking/waitlist/claim'
// `listMyWaitlist` is the signed-in counterpart: the rules can authorise a
// contact to GET their own entry, but never to LIST their entries across
// sessions, so the member surfaces need a callable for it.
export { getWaitlistEntry, leaveWaitlist, listMyWaitlist } from './booking/waitlist/manage'
export { promoteWaitlistOnSeatFreed } from './booking/waitlist/promote'
// A queue whose class will never run. Hung on the session document, not on
// cancelSession, because a standalone session is deleted client-side.
export { teardownWaitlistOnSessionDeleted } from './booking/waitlist/teardown'
// The studio's own row actions. Callables, never client writes — the rules deny
// every client write to the queue, including a schedule.manage holder's.
export { promoteWaitlistEntry, removeWaitlistEntry } from './booking/waitlist/admin'

// Gamification
export { recalculateScores, resetScores } from './gamification'
export { triggerScoresRebuild } from './gamification/triggerScoresRebuild'
export { processScoresRebuildJob } from './gamification/processScoresRebuildJob'
export { recalculateScoresFromDate } from './gamification/recalculateScoresFromDate'

// Sessions
export {
  generateRecurringSessions,
  cancelSession,
  updateRecurringSession,
  selfCheckIn,
} from './sessions'
export { setSessionLocation } from './sessions/setSessionLocation'
// The background drain for "delete this and all following" on a large series.
// Enqueued by cancelSession; chains itself batch by batch. The Cloud Tasks queue
// is created by Firebase with this function's name, which is why the enqueuer
// addresses it as locations/europe-west6/functions/runSeriesTeardown.
export { runSeriesTeardown } from './sessions/teardownWorker'
export { setSessionTags } from './sessions/setSessionTags'

// Contacts
export { deleteContact, restoreContact, checkInContact, moveContacts } from './contacts'
export { generateContactQR } from './contacts/generateContactQR'
export { getContactQR } from './contacts/getContactQR'
export { requestContactUpdate } from './contacts/requestContactUpdate'
export { grantCredits } from './contacts/grantCredits'
export { manageContactUpdateRequest } from './contacts/manageContactUpdateRequest'
export {
  createContactUpdateLink,
  createContactUpdateLinksBatch,
  revokeContactUpdateLinks,
  resolveContactUpdateLink,
  submitContactUpdateLink,
} from './contacts/contactUpdateLinks'
export { switchActiveContact } from './contacts/switchActiveContact'
export { listMyContactPayments, createContactBillingPortalSession } from './contacts/contactPayments'
// Contact alerts — the ONE writer of alerts_count (previously dead; see the
// module header for the two sites that create alerts without it).
export { trackContactAlerts } from './contacts/trackAlerts'
// Contact notes — the ONE writer of notes_count, which is what makes the shared
// contact filter able to ask "has notes" without reading a subcollection.
export { trackContactNotes } from './contacts/trackNotes'

// Coaching (goals, steps, evaluations, performance check-ins). `trackGoals` is
// the ONE writer of the contact's coaching counters and the three coaching
// activity-log events; `trackGoalEvaluations` denormalizes the newest
// evaluation onto its goal; `trackPerformanceCheckins` maintains
// `last_checkin_at` and logs a submission. The daily `stampOverdueGoals` task
// (see ./dailyTasks) is what wakes `trackGoals` when a goal falls overdue with
// no write of its own.
export { trackGoals } from './coaching/trackGoals'
export { teardownGoal } from './coaching/teardownGoal'
export { trackGoalEvaluations } from './coaching/trackGoalEvaluations'
export { trackPerformanceCheckins } from './coaching/trackPerformanceCheckins'

// Events
export {
  sendEventInvitations,
  getEventInvitationDetails,
  handleEventInvitationResponse,
} from './events'
export { trackEventAttendees } from './events/trackEventAttendees'
export { addEventCheckin } from './events/addEventCheckin'
export { duplicateEvent } from './events/duplicateEvent'

// Analytics
export {
  trackBookings,
  trackSessions,
  weeklyReports,
  trackContacts,
  trackSessionParticipants,
} from './analytics'
export { capturePlatformMetrics } from './analytics/platformMetrics'

// App-store presence (App Store Connect + Google Play → store_presence/*).
// Read-only; gated by STORE_INGEST_ENABLED, which is 'false' everywhere until
// somebody turns it on. See appstores/ingest.ts.
export { ingestAppStores } from './appstores/ingest'
export { refreshStorePresence } from './appstores/ops'
// App Store Connect push notifications (WWDC25 webhooks). Registered manually
// per app in ASC → Users and Access → Integrations → Webhooks; verifies Apple's
// HMAC and fails closed when no secret is configured.
export { handleAppStoreWebhook } from './appstores/webhook'

// Daily maintenance tasks + the hourly multi-step booking-reminder scan
export { dailyTasks, bookingRemindersHourly } from './dailyTasks'

// Auth / Membership
export { verifyContactCode, completeSignup } from './auth/completeSignup'
export { loginContactWithCode } from './auth/loginContactWithCode'

// Appointments (1:1 slots) — activity-bound, availability-only. Nothing is
// pre-generated: listAvailability computes free starts on the fly and
// bookAppointment materialises a Session lazily (overlap-safe) at booking
// time; the paid-access gate is shared with bookSession via booking/access.ts.
// Cancellation is handled by the shared cancelBooking callable.
export { listAvailability, bookAppointment } from './appointments/window'
// Paid appointments — reserve→pay→confirm via Stripe Connect (see checkout.ts).
export { createAppointmentCheckout } from './appointments/checkout'
// Staff "phone booking" — a manager creates/blocks an appointment directly
// from the admin (existing/new contact, free/paid-offline/pending-offline/
// payment-link), and settles a pending offline hold once paid in person.
export { createStaffAppointment, markAppointmentPaid } from './appointments/staffBooking'
// A manager cancels an appointment — and kills the Stripe payment link behind a
// link-mode hold on the way out, so a late payment can no longer re-acquire the
// slot that was just called off (see cancelSlot.ts for the ordering).
export { cancelAppointmentSlot } from './appointments/cancelSlot'

// SaaS billing (Linyup's own platform subscriptions — Stripe)
export {
  createCheckoutSession,
  handleStripeWebhook,
  cancelSaasSubscription,
  getSaasInvoices,
  reactivateSaasSubscription,
  getBillingPortalUrl,
  activatePluginAddon,
  deactivatePluginAddon,
  handleTrialLifecycle,
} from './saas-billing'

// Locked plugins (key-gated) + the in-app AI assistant
export { unlockPlugin } from './plugins/unlockPlugin'
export { assistantChat } from './assistant'

// AI offer drafting — an EXPERIMENT, not a plugin (see EXPERIMENTAL_FEATURES).
// Two callables on purpose: `draftOfferings` runs the model and writes nothing,
// `applyOfferingDraft` writes and runs no model. The seam between them is where
// a human decides.
export { draftOfferings, applyOfferingDraft } from './offer/draftOfferings'

// Kiosk mode (entrance-tablet PIN unlock)
export { unlockKiosk } from './kiosk'

// Organizations (multi-team tier)
export {
  createOrganization,
  inviteTeamToOrg,
  acceptOrgInvitation,
  declineOrgInvitation,
  removeTeamFromOrg,
  createOrgCheckoutSession,
  getOrgInvitationDetails,
  requestTeamAccess,
} from './orgs'

// Org member management (add / change role / remove). Authorized by
// assertOrgAdmin against org_members — never hasTeamRole (UX-75, UX-34).
export { addOrgMember, updateOrgMemberRole, removeOrgMember } from './orgs/members'

// Org MEMBER invitations — a PERSON is invited to help run the organisation and
// accepts for themselves, which is the only door open to an address that has no
// Linyup account yet (decision 12). NOT the org_invitations rail above, which
// invites a whole STUDIO and moves its billing; see orgs/memberInvitations.ts.
export {
  inviteOrgMember,
  getOrgMemberInvitation,
  acceptOrgMemberInvitation,
  declineOrgMemberInvitation,
  revokeOrgMemberInvitation,
} from './orgs/memberInvitations'

// An org's OWN Linyup billing. Separate from the team callables below because
// the payer is authorized through org_members, not team_members (UX-75).
export {
  cancelOrgSubscription,
  reactivateOrgSubscription,
  getOrgBillingPortalUrl,
  getOrgInvoices,
} from './orgs/billing'

// Team-level billing (BYO — teams charging their own students on their OWN
// gateway account; no platform fee). Both webhooks record into payment_events.
export { handlePayrexxWebhook } from './billing/handlePayrexxWebhook'
export { handleTeamStripeWebhook } from './billing/handleTeamStripeWebhook'

// Email sending (Brevo) — BYO domain authentication + event webhook.
// Sender resolution + the central mail service live in ./mail and are called
// by every send site via ../utils/email.
export { registerSenderDomain, checkSenderDomain, useManagedSender } from './mail/domainAuth'
export { sendTestEmail } from './mail/sendTestEmail'
export { handleBrevoWebhook } from './mail/handleBrevoWebhook'

// Public-site localization — machine-translates tenant-authored site content
// (team/org published sites go through publishWebsite/publishOrgWebsite
// directly; embed widgets have no publish step, so they get their own
// trigger). See ./translate/translateSite.ts.
export { onEmbedWidgetsWritten } from './translate/onEmbedWidgetsWritten'

// Custom PUBLIC domains (Cloudflare for SaaS) — the domain a studio's pages are
// SERVED from, as opposed to the one it SENDS from above. See docs/custom-domains.md.
export {
  registerPublicDomain,
  checkPublicDomain,
  removePublicDomain,
} from './domains/publicDomain'

// Stripe Connect (member → studio payments; studio's own Stripe balance + platform fee)
export { startConnectOnboarding, getConnectStatus, disconnectConnectAccount } from './connect'
export {
  createMemberPayment,
  createMemberSubscription,
  createMembershipPayment,
  createMembershipCheckout,
  createProductCheckout,
  createCourseCheckout,
  pauseMemberSubscription,
  resumeMemberSubscription,
  cancelMemberSubscription,
} from './connect/payments'
// Sign the buyer in from the checkout they just completed — the /pay/result
// success path. Public callable; mints through buildContactSession like every
// other sign-in. See connect/claimCheckoutSession.ts.
export { claimCheckoutSession } from './connect/claimCheckoutSession'
export { refundMemberPayment } from './connect/refunds'
export { handleConnectWebhook } from './connect/webhook'
// Gift cards (E3) — public purchase + balance check, manager mint + void.
export {
  createGiftCardCheckout,
  checkGiftCard,
  issueGiftCard,
  voidGiftCard,
} from './connect/giftCards'
// Promo codes (Wave 3 Phase 3) — the public quote plus the manager lifecycle.
// A promo is a Stage A price MODIFIER: `previewPromoCode` only QUOTES, the code
// is applied inside resolvePaymentOptions, and the reserve/commit/release
// engine is called from the checkout callables and the webhook rather than
// being exposed. The two manager corrections are deletes of lifecycle state —
// neither touches `usage_count`, which has exactly one writer.
export {
  previewPromoCode,
  createPromoCode,
  updatePromoCode,
  setPromoCodeStatus,
  clearPromoRedemption,
  releasePromoReservations,
} from './connect/promoCodes'
// Waivers (Wave 3 Phase 4) — document authoring, version publishing and the
// team's waiver policy. `publishDocumentVersion` replaces the client status flip
// for EVERY document kind (signup consent has to be recorded against a real
// version of a real terms document); the plan gate fires only for waivers.
// A waiver document is callable-only, so all five of these exist: without
// `updateWaiver` and `archiveWaiver` a studio could mint a waiver and never
// author, correct or retire it.
export {
  createWaiver,
  updateWaiver,
  publishDocumentVersion,
  setWaiverRequirement,
  archiveWaiver,
} from './waivers/publish'
// The public half: the ONE answer a booking surface renders its consent step
// from. It writes nothing, and the client calls it only when the team's public
// mirror lists a required waiver — so a tenant with no waivers pays zero extra
// round-trips on the acquisition path. The GATE itself is not a callable: it is
// composed into each booking rail above its first contact write (waivers/gate.ts
// carries the census of which rails, and which are deliberately exempt).
export { resolveWaiverRequirement } from './waivers/requirement'
// The frozen text of an OLDER version of a publicly shared document — the one
// thing a PINNED document link needs and the public mirror (latest only) cannot
// give. Same double gate as the mirror, waivers refused; see documents/publicVersion.ts.
export { getPublicDocumentVersion } from './documents/publicVersion'
// One member's COMPLETE consent history, as a self-contained artefact — the
// answer to "show me what this person signed", which is the whole reason a
// studio keeps a waiver at all. A callable rather than a client read because it
// materialises the frozen text from every version an acceptance names and
// verifies each stored fingerprint against it, and because the SECOND, mandatory
// query — every record under the same email address — is an operator tool that a
// member's own download must never receive.
export { exportContactConsentHistory } from './waivers/export'
// A member re-signing from their own account. NOT an attendance rail and
// deliberately outside waivers/gate.ts's census — it books nothing and admits
// nobody — but composed from the same policy read, the same pure decision and
// the same ledger writer, so there is still one answer to "does this tick
// count". Without it, a `require_resign` publish is discovered by being refused
// mid-booking, which is a compliance feature choosing the worst possible moment
// to introduce itself.
export { signWaiverInSpace } from './waivers/space'
// Withdrawing a signature. A manager-only sibling of the ledger rather than part
// of it: the accepted event is never touched, a revocation is a NEW row naming
// the one it revokes, and the only thing that moves is the current-state row's
// status. Ungated by plan — retiring is not creating, and a team must always be
// able to withdraw a signature it holds.
export { revokeWaiverAcceptance } from './waivers/revoke'
// Asking somebody to sign. The half this folder was missing: a studio that makes
// a document mandatory has, until it, no remedy for the people already on its
// books — the requirement binds at their next booking, where they meet it as a
// refusal. It sends the EXISTING Space sign link, writes no state of any kind,
// and is safe to call twice (one mail per document version per contact per day).
export { requestWaiverAcceptance } from './waivers/request'
// The acceptance ledger seen from the person's side: one trigger on the
// append-only `acceptances` subcollection writes the `waiver_accepted` /
// `waiver_revoked` activity events for EVERY rail, rather than a logActivity call
// bolted onto each one (and forgotten by the next).
export { trackWaiverAcceptances } from './waivers/trackAcceptances'
// No-show policy fees (E5) — manager resend-link + waive. The strike counter
// itself (processNoShowStrike) is wired into automation/onBookingWrite, not a
// callable.
export { resendPolicyFeeLink, waivePolicyFee } from './booking/policyFees'
// Cross-rail payment editing (assign contact + edit comment + line-item) for Connect + BYO.
export { updatePaymentRecord } from './connect/updatePayment'
// Manual cash / bank-transfer payments — recorded into the unified payment_events ledger,
// and un-recorded (void) when the manager entered one by mistake.
export { recordManualPayment } from './payments/recordManualPayment'
export { voidManualPayment } from './payments/voidManualPayment'

// Finance — monthly rollups of the finance journal (always-on core infra) and
// the plugin-gated monthly CSV export.
export { monthlyFinanceReports } from './finance/monthlyReports'
export { exportFinanceReport } from './finance/exportReport'
export { exportContacts } from './contacts/exportContacts'
export { previewPlatformNotice, sendPlatformNotice } from './ops/platformNotices'

// Accounting (finance plugin) — double-entry ledger derived from the journal.
export { onFinanceTransactionWrite } from './accounting/onFinanceTransactionWrite'
export { rebuildAccountingLedger } from './accounting/rebuild'
export { createManualEntry, reverseEntry } from './accounting/manualEntries'
export { closeFiscalYear } from './accounting/close'
export { setChartTemplate } from './accounting/settings'

// In-app feedback — ops email notification on new submissions
export { onFeedbackCreated } from './feedback/onFeedbackCreated'

// Outreach
export { sendOutreachEmail } from './outreach'

// Referrals
export {
  generateReferralCodes,
  confirmReferral,
  getMyReferralCode,
  getMyReferralStats,
} from './referrals'

// A contact closing their own account, from the mobile app. Only moves a date —
// the dailyTasks sweep is what acts, and it anonymises. See contacts/selfDeletion.ts.
export { requestContactDeletion, cancelContactDeletion } from './contacts/selfDeletion'

// Operator-only: the production demo tenant and the app-store review login.
// Triggered from the operator console, executed here so the code ships through
// the reviewed prod deploy rather than from a workstation — see ops/demoTenant.ts.
export { manageDemoTenant, setReviewAccess, getReviewAccess } from './ops'

// Bio-link
export { getInTouchForm } from './bio-link/getInTouchForm'

// Custom Forms plugin — public submission callable
export { submitForm } from './forms/submitForm'

// Website plugin (studio site builder) — publish/unpublish the public snapshot
export { publishWebsite, unpublishWebsite } from './website'

// Organization website (org-level public site) — publish/unpublish the public snapshot
export { publishOrgWebsite, unpublishOrgWebsite } from './orgWebsite'

// Automation engine (Phase 1–3: scheduled, manual callables, event triggers, delayed via Cloud Tasks)
export {
  triggerAutomationRule,
  previewAutomationRule,
  onContactWrite,
  onBookingWrite,
  onMemberPaymentWrite,
  onSessionWrite,
  executeDelayedRule,
  inboundWebhook,
} from './automation'

// --- Stubs (TODO: port from hmd-lineup) ---
// export { generateDashboardInsight } from './analytics'
