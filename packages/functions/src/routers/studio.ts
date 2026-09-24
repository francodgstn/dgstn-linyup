// The studio's day-to-day, behind one function: everything a signed-in member of
// STAFF does that is not money (routers/finance.ts), not what the studio pays
// Linyup (routers/billing.ts), not the organisation tier (routers/org.ts) and not
// a long job (routers/heavy.ts) — contacts and plans, sessions, events, waivers,
// team and invitations, domains, mail and WhatsApp settings, automations, API
// keys, the AI helpers (docs/functions-consolidation-plan.md → "Phase 2").
//
// It is the largest router by far, and that is the point of it: these are the
// callables that made a full deploy slow, and none of them has an event source or
// an outside party holding its name.
//
// WHO IS NOT HERE, on purpose: anything a MEMBER, a guest or the member app
// calls — booking, checkout, the Space, contact sign-in, the kiosk. Those are
// Phase 3, behind their own routers, because their traffic and their blast
// radius are a different thing from a manager editing a waiver.
//
// Some members have no client caller today (the inventory's callers column is
// how to find them). They are routed with their domain rather than left as the
// odd functions out.
//
// Every member ALSO stays exported standalone from src/index.ts until its alias
// is provably unused (utils/frozenFunctions.test.ts says why). Authorisation and
// the TENANT BOUNDARY are each member's own; the router adds none and removes
// none. This module must NOT call `setGlobalOptions` — src/index.ts owns it.

import { callableRouter } from '../utils/callableRouter'
import { acceptTeamInvitation } from '../teams/acceptTeamInvitation'
import { createTeam } from '../teams/createTeam'
import { getTeamInvitationDetails } from '../teams/getTeamInvitationDetails'
import {
  approveAffiliation,
  removeAffiliation,
  renewAffiliation,
  upsertAffiliation,
} from '../affiliations'
import { generateTeamSentiment } from '../aiInsights/teamSentiment'
import { createApiKey, revokeApiKey } from '../api/keys'
import {
  approveOAuthAuthorization,
  denyOAuthAuthorization,
  getOAuthAuthorizationRequest,
  revokeOAuthGrant,
} from '../api/oauth/consent'
import { cancelAppointmentSlot } from '../appointments/cancelSlot'
import { createStaffAppointment, markAppointmentPaid } from '../appointments/staffBooking'
import { assistantChat } from '../assistant'
import { confirmEmailVerified } from '../auth/confirmEmailVerified'
import { previewAutomationRule, triggerAutomationRule } from '../automation'
import { resendPolicyFeeLink, waivePolicyFee } from '../booking/policyFees'
import { promoteWaitlistEntry, removeWaitlistEntry } from '../booking/waitlist/admin'
import { checkInContact, deleteContact, moveContacts, restoreContact } from '../contacts'
import { sendContactRecapEmail } from '../contacts/aiRecapEmail'
import { generateContactSummary } from '../contacts/aiSummary'
import {
  createContactUpdateLink,
  createContactUpdateLinksBatch,
  revokeContactUpdateLinks,
} from '../contacts/contactUpdateLinks'
import { exportContacts } from '../contacts/exportContacts'
import { generateContactQR } from '../contacts/generateContactQR'
import { grantCredits } from '../contacts/grantCredits'
import { manageContactUpdateRequest } from '../contacts/manageContactUpdateRequest'
import { assignPlan, changePlan, endPlan } from '../contacts/planCallables'
import {
  checkPublicDomain,
  registerPublicDomain,
  removePublicDomain,
} from '../domains/publicDomain'
import { sendEventInvitations } from '../events'
import { addEventCheckin } from '../events/addEventCheckin'
import { duplicateEvent } from '../events/duplicateEvent'
import { recalculateScores, resetScores } from '../gamification'
import { triggerScoresRebuild } from '../gamification/triggerScoresRebuild'
import { checkSenderDomain, registerSenderDomain, useManagedSender } from '../mail/domainAuth'
import { sendTestEmail } from '../mail/sendTestEmail'
import { applyOfferingDraft, draftOfferings } from '../offer/draftOfferings'
import { unlockPlugin } from '../plugins/unlockPlugin'
import { confirmReferral, generateReferralCodes } from '../referrals'
import { cancelSession, generateRecurringSessions, updateRecurringSession } from '../sessions'
import {
  createCourseBlock,
  deleteCourseBlock,
  setCourseBlockStatus,
  updateCourseBlock,
} from '../courseBlocks'
import { enrolCourseBlockContact, withdrawFromCourseBlock } from '../courseBlocks/enrolment'
import { cancelCourseBlock } from '../courseBlocks/cancel'
import { addCourseBlockMeeting, duplicateCourseBlock } from '../courseBlocks/duplicate'
import { listCourseBlockWaitlist } from '../courseBlocks/waitlist'
import { setSessionLocation } from '../sessions/setSessionLocation'
import { setSessionTags } from '../sessions/setSessionTags'
import { createStudioTeam } from '../teams/createStudioTeam'
import { cancelTeamDeletion, requestTeamDeletion } from '../teams/deleteAccount'
import { listTeamMembers } from '../teams/listTeamMembers'
import { manageTeamInvitation } from '../teams/manageTeamInvitation'
import { manageTeamMember } from '../teams/manageTeamMember'
import { sendTeamInvitation } from '../teams/sendTeamInvitation'
import { validateTeamSlug } from '../teams/validateTeamSlug'
import {
  archiveWaiver,
  createWaiver,
  publishDocumentVersion,
  setWaiverRequirement,
  updateWaiver,
} from '../waivers/publish'
import { requestWaiverAcceptance } from '../waivers/request'
import { revokeWaiverAcceptance } from '../waivers/revoke'
import { unpublishWebsite } from '../website'
import {
  connectWhatsApp,
  disconnectWhatsApp,
  getWhatsAppSignupConfig,
  refreshWhatsAppStatus,
} from '../whatsapp/connect'
import { setContactWhatsAppConsent } from '../whatsapp/consent'
import { deleteWhatsAppTemplate, submitWhatsAppTemplate } from '../whatsapp/studioTemplates'
import { getWhatsAppUsage } from '../whatsapp/usage'

export const rpcStudio = callableRouter(
  'rpcStudio',
  {
    // The max of the members': the team-sentiment run asks for 120s. 512MiB
    // because one instance now serves a whole domain at once rather than one
    // callable, and the exports build their file in memory.
    memory: '512MiB',
    timeoutSeconds: 120,
    // A router's ceiling is concurrency × maxInstances for its WHOLE domain.
    // This is every staff screen of every studio, so both stay at the generous
    // end: forty a instance, and the global maxInstances.
    cpu: 1,
    concurrency: 40,
  },
  {
    createTeam,
    acceptTeamInvitation,
    getTeamInvitationDetails,
    approveAffiliation,
    removeAffiliation,
    renewAffiliation,
    upsertAffiliation,
    generateTeamSentiment,
    approveOAuthAuthorization,
    createApiKey,
    denyOAuthAuthorization,
    getOAuthAuthorizationRequest,
    revokeApiKey,
    revokeOAuthGrant,
    cancelAppointmentSlot,
    createStaffAppointment,
    markAppointmentPaid,
    assistantChat,
    confirmEmailVerified,
    previewAutomationRule,
    triggerAutomationRule,
    promoteWaitlistEntry,
    removeWaitlistEntry,
    resendPolicyFeeLink,
    waivePolicyFee,
    assignPlan,
    changePlan,
    checkInContact,
    createContactUpdateLink,
    createContactUpdateLinksBatch,
    deleteContact,
    endPlan,
    exportContacts,
    generateContactQR,
    generateContactSummary,
    grantCredits,
    manageContactUpdateRequest,
    moveContacts,
    restoreContact,
    revokeContactUpdateLinks,
    sendContactRecapEmail,
    checkPublicDomain,
    registerPublicDomain,
    removePublicDomain,
    addEventCheckin,
    duplicateEvent,
    sendEventInvitations,
    recalculateScores,
    resetScores,
    triggerScoresRebuild,
    checkSenderDomain,
    registerSenderDomain,
    sendTestEmail,
    useManagedSender,
    applyOfferingDraft,
    draftOfferings,
    unlockPlugin,
    confirmReferral,
    generateReferralCodes,
    cancelSession,
    createCourseBlock,
    deleteCourseBlock,
    cancelCourseBlock,
    duplicateCourseBlock,
    addCourseBlockMeeting,
    listCourseBlockWaitlist,
    enrolCourseBlockContact,
    withdrawFromCourseBlock,
    setCourseBlockStatus,
    updateCourseBlock,
    generateRecurringSessions,
    setSessionLocation,
    setSessionTags,
    updateRecurringSession,
    cancelTeamDeletion,
    createStudioTeam,
    listTeamMembers,
    manageTeamInvitation,
    manageTeamMember,
    requestTeamDeletion,
    sendTeamInvitation,
    validateTeamSlug,
    archiveWaiver,
    createWaiver,
    publishDocumentVersion,
    requestWaiverAcceptance,
    revokeWaiverAcceptance,
    setWaiverRequirement,
    updateWaiver,
    unpublishWebsite,
    connectWhatsApp,
    deleteWhatsAppTemplate,
    disconnectWhatsApp,
    getWhatsAppSignupConfig,
    getWhatsAppUsage,
    refreshWhatsAppStatus,
    setContactWhatsAppConsent,
    submitWhatsAppTemplate,
  }
)
