// Everything a MEMBER or a GUEST does that is not paying, behind one function:
// booking and cancelling, appointments, the waitlist, contact sign-in, the Space
// (bookings, payments list, receipts, waivers, consent), contact-update links,
// public forms, event invitations, the kiosk, referrals
// (docs/functions-consolidation-plan.md → "Phase 3").
//
// This is the HOT PATH and the public one. Many members are called signed out or
// with a contact session, and that is theirs to decide: the router adds no
// authorisation and removes none, and a tenant boundary is never the router's to
// enforce.
//
// THE MEMBER APP CALLS SOME OF THESE BY THEIR OWN NAME, from store binaries that
// cannot be updated. Listing a name here moves only the callers that go through
// `callFunction`; every one stays exported standalone from src/index.ts, and the
// ones the app calls are on the frozen list until the app's minimum supported
// version has moved past the first build that routes
// (utils/frozenFunctions.test.ts).
//
// APP CHECK IS EACH MEMBER'S OWN — `submitForm` on the web flag,
// `sendContactVerificationCode` and `loginContactWithCode` on the MOBILE flag
// (utils/appCheck.ts). The SDK enforces it inside the member's own handler.
//
// This module must NOT call `setGlobalOptions` — src/index.ts owns it.

import { callableRouter } from '../utils/callableRouter'
import { getMyBookings } from '../booking/myBookings'
import { bookAppointment, listAvailability } from '../appointments/window'
import { joinCourseBlock } from '../courseBlocks/enrolment'
import { completeSignup, verifyContactCode } from '../auth/completeSignup'
import { loginContactWithCode } from '../auth/loginContactWithCode'
import { sendContactVerificationCode } from '../auth/sendContactVerificationCode'
import {
  bookSession,
  cancelBooking,
  getBookingDetails,
  rebookSession,
  sendBookingVerificationCode,
  verifyBookingCode,
} from '../booking'
import { getMyAttendance } from '../booking/myAttendance'
import { claimWaitlistSeat } from '../booking/waitlist/claim'
import { joinWaitlist } from '../booking/waitlist/join'
import { getWaitlistEntry, leaveWaitlist, listMyWaitlist } from '../booking/waitlist/manage'
import { listMyContactPayments } from '../contacts/contactPayments'
import { resolveContactUpdateLink, submitContactUpdateLink } from '../contacts/contactUpdateLinks'
import { getContactQR } from '../contacts/getContactQR'
import { requestContactUpdate } from '../contacts/requestContactUpdate'
import { cancelContactDeletion, requestContactDeletion } from '../contacts/selfDeletion'
import { switchActiveContact } from '../contacts/switchActiveContact'
import { getPublicDocumentVersion } from '../documents/publicVersion'
import { getEventInvitationDetails, handleEventInvitationResponse } from '../events'
import { submitForm } from '../forms/submitForm'
import { unlockKiosk } from '../kiosk'
import { getMyReferralCode, getMyReferralStats } from '../referrals'
import { selfCheckIn } from '../sessions'
import { listMyTarif595Receipts } from '../tarif595'
import { exportContactConsentHistory } from '../waivers/export'
import { resolveWaiverRequirement } from '../waivers/requirement'
import { signWaiverInSpace } from '../waivers/space'
import { setMyWhatsAppConsent } from '../whatsapp/consent'

export const rpcMember = callableRouter(
  'rpcMember',
  {
    // No member asks for more than the defaults. 512MiB because one instance now
    // serves the whole member surface at once. Concurrency matches what a plain
    // callable gets today, and maxInstances is the global one: this router's
    // ceiling is the busiest studio's Monday evening, so nothing is taken away.
    // `minInstances` is deliberately NOT set — it is an open decision in the plan.
    memory: '512MiB',
    cpu: 1,
    concurrency: 80,
  },
  {
    listAvailability,
    getMyBookings,
    bookAppointment,
    joinCourseBlock,
    completeSignup,
    loginContactWithCode,
    sendContactVerificationCode,
    verifyContactCode,
    bookSession,
    cancelBooking,
    claimWaitlistSeat,
    getBookingDetails,
    getMyAttendance,
    getWaitlistEntry,
    joinWaitlist,
    leaveWaitlist,
    listMyWaitlist,
    rebookSession,
    sendBookingVerificationCode,
    verifyBookingCode,
    cancelContactDeletion,
    getContactQR,
    listMyContactPayments,
    requestContactDeletion,
    requestContactUpdate,
    resolveContactUpdateLink,
    submitContactUpdateLink,
    switchActiveContact,
    getPublicDocumentVersion,
    getEventInvitationDetails,
    handleEventInvitationResponse,
    submitForm,
    unlockKiosk,
    getMyReferralCode,
    getMyReferralStats,
    selfCheckIn,
    listMyTarif595Receipts,
    exportContactConsentHistory,
    resolveWaiverRequirement,
    signWaiverInSpace,
    setMyWhatsAppConsent,
  }
)
