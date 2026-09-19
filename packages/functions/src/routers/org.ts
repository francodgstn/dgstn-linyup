// The organisation tier, behind one function: creating an org, its member
// studios (invite, accept, decline, remove, request access), its own members and
// their invitations, and taking the org website offline
// (docs/functions-consolidation-plan.md → "Phase 2").
//
// SOME MEMBERS ARE CALLED SIGNED OUT, and that is theirs to decide: the
// invitation pages read `getOrgInvitationDetails` / `getOrgMemberInvitation`
// before the visitor has an account. The router adds no authorisation and
// removes none — each member keeps its own check, and a tenant boundary is
// never the router's to enforce.
//
// NOT here: an org's own Linyup billing (routers/billing.ts, beside the team
// callables the client pairs it with), and `publishOrgWebsite`, which runs for
// minutes — the ROUTER's timeout governs, so it belongs with the long jobs.
//
// Every member ALSO stays exported standalone from src/index.ts until its alias
// is provably unused (utils/frozenFunctions.test.ts says why). This module must
// NOT call `setGlobalOptions` — src/index.ts owns it.

import { callableRouter } from '../utils/callableRouter'
import {
  createOrganization,
  inviteTeamToOrg,
  acceptOrgInvitation,
  declineOrgInvitation,
  removeTeamFromOrg,
  getOrgInvitationDetails,
  requestTeamAccess,
} from '../orgs'
import { addOrgMember, updateOrgMemberRole, removeOrgMember } from '../orgs/members'
import {
  inviteOrgMember,
  getOrgMemberInvitation,
  acceptOrgMemberInvitation,
  declineOrgMemberInvitation,
  revokeOrgMemberInvitation,
} from '../orgs/memberInvitations'
import { unpublishOrgWebsite } from '../orgWebsite'

export const rpcOrg = callableRouter(
  'rpcOrg',
  {
    // No member asks for more than the defaults. A router's ceiling is
    // concurrency × maxInstances for its WHOLE domain; organisations are few.
    cpu: 1,
    concurrency: 40,
  },
  {
    createOrganization,
    inviteTeamToOrg,
    acceptOrgInvitation,
    declineOrgInvitation,
    removeTeamFromOrg,
    getOrgInvitationDetails,
    requestTeamAccess,
    addOrgMember,
    updateOrgMemberRole,
    removeOrgMember,
    inviteOrgMember,
    getOrgMemberInvitation,
    acceptOrgMemberInvitation,
    declineOrgMemberInvitation,
    revokeOrgMemberInvitation,
    unpublishOrgWebsite,
  }
)
