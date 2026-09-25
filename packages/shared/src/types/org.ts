import type { Timestamp } from './common'
import type { SaasStatus, RankingSystem, TenantFlags, SocialLink } from './team'
import type { ContactAddress } from './contact'
import type { Sha256Hex } from '../utils/identity'
import { normalizeEmail } from '../utils/normalizeEmail'

export type OrgRole = 'org_admin' | 'org_viewer'
export type OrgTeamStatus = 'invited' | 'active' | 'removed'
export type OrgInvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired'

export interface Organization {
  id: string
  name: string
  slug: string
  description?: string
  plan: 'organization'
  plan_status: SaasStatus
  /** When the org's trial ends (ORG_TRIAL_DAYS from creation). READ, never
   *  recomputed, by handleTrialLifecycle's org phase — editing this field is how
   *  a Linyup operator extends a hand-onboarded customer's trial. */
  trial_ends_at?: Timestamp
  /** Set when the org trial lapsed and the org was moved off the tier
   *  (lapseOrganization). Nothing reads it as state — the status does that; it
   *  is the "when" for support. */
  downgraded_from_trial_at?: Timestamp
  /** Operational flags — the SAME type and the same exemption as `Team.flags`:
   *  an internal, pilot or comped organization is never auto-lapsed by the trial
   *  sweep (`tenantExemptFromTrialSweep`). */
  flags?: TenantFlags
  stripe_customer_id?: string
  // Ranking systems shared across all teams in the org.
  // When set, overrides individual team ranking_systems for all linked teams.
  ranking_systems?: RankingSystem[]
  // Per-locale custom label for the affiliation concept (e.g. "Membership", "Lizenz").
  // Resolved at render time: term[locale] ?? term['en'] ?? 'Affiliation'.
  affiliation_term?: Partial<Record<'en' | 'de' | 'fr' | 'it', string>>
  // The language the org authors content in — same semantics as Team.language.
  // Site translations treat it as the source locale (resolveSiteSourceLocale in
  // shared/utils/siteTranslation.ts: validated value, else 'en').
  language?: 'en' | 'de' | 'fr' | 'it'
  /**
   * WHERE THE FEDERATION IS, AND HOW TO REACH IT.
   *
   * `ContactAddress` — the same four-part shape a contact's address uses, not a
   * free-text line — because it is the shape every reader in the codebase
   * already knows how to render, and a string would have to be parsed by the
   * first one that wanted a city.
   *
   * Public-facing: the org website's contact section shows these, the way a
   * studio's primary place does. Absent on every existing organization, and the
   * section renders whatever is filled in, so this is additive.
   */
  headquarters?: ContactAddress
  /** Where to write to the organization. Shown publicly when set. */
  contact_email?: string
  /** Where to call the organization. Shown publicly when set. */
  contact_phone?: string
  /** The organization's public website, if it has one outside Linyup. */
  contact_website?: string
  // When true, a contact's affiliation status is read-only for team managers.
  // Only org admins (and org-level automations when implemented) may change it.
  lock_affiliation?: boolean
  /**
   * The organization's own social profiles, rendered by the contact section of
   * its website when that section asks for them.
   *
   * SAME TYPE AS A TEAM'S (`Team.socialLinks`), because they are the same thing
   * and the renderer is already shared — `ContactBlock` reads `ctx.socialLinks`
   * without caring which tenant filled it. The org side simply never filled it,
   * so the section's "show social links" switch could not, in any state, change
   * what a visitor saw.
   */
  socialLinks?: SocialLink[]
  created: Timestamp
  createdBy: string
}

export interface OrgMember {
  userId: string
  orgId: string
  role: OrgRole
  joined: Timestamp
  addedBy: string
  /** Display copy denormalized from `users/{uid}` when the member is added, so
   *  the org Members list can name people without reading the users collection
   *  (an org admin has no rule that lets them). Absent on rows written before
   *  the member callables existed — the list falls back to the uid. */
  displayName?: string
  email?: string
}

export interface OrgTeam {
  teamId: string
  orgId: string
  status: OrgTeamStatus
  joined: Timestamp
  addedBy: string
  removed_at?: Timestamp
  /** Why the link ended. Absent = an org admin removed the team by hand
   *  (removeTeamFromOrg). 'org_lapsed' = the organization stopped paying and
   *  the studio was dropped to Free by lapseOrganization — the org admin's
   *  access to that studio's data ended with it. */
  removed_reason?: 'org_lapsed'
}

export type TeamAccessType = 'view' | 'manage'
export type TeamAccessRequestStatus = 'pending' | 'approved' | 'denied'

export interface TeamAccessRequest {
  teamId: string
  orgId: string
  requestedBy: string
  requestedAt: Timestamp
  accessType: TeamAccessType
  status: TeamAccessRequestStatus
  processedBy?: string
  processedAt?: Timestamp
}

/**
 * A whole STUDIO invited into the organization — accepted by that studio's
 * OWNER, and accepting moves the studio's billing onto the org plan.
 *
 * NOT the same thing as `OrgMemberInvitation` below. See the naming rule beside
 * `ORG_INVITATIONS_SUBCOLLECTION` in paths.ts.
 */
export interface OrgInvitation {
  id: string
  orgId: string
  teamId?: string
  inviteeEmail?: string
  status: OrgInvitationStatus
  invitedBy: string
  created: Timestamp
  expires_at: Timestamp
}

export type OrgMemberInvitationStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'revoked'
  | 'expired'

/**
 * A PERSON invited to help run the organization — `organizations/{orgId}/
 * org_member_invitations/{invitationId}`. Accepting writes exactly one
 * `org_members/{uid}` row and nothing else: no studio changes hands, no billing
 * moves, no team is enrolled.
 *
 * WHY IT EXISTS: `addOrgMember` is a GRANT against an account that already
 * exists, and an address with no Linyup account got a named refusal — so an
 * organization could not bring in anybody who had not already signed up
 * (decision 12).
 *
 * DOC ID: a deterministic key derived from the normalized address
 * (`orgMemberInvitationId`), NOT an auto-id and NOT the token. Inviting the same
 * address twice therefore REFRESHES one row — a new token, a new deadline —
 * instead of leaving two live tokens and two "pending" rows that disagree about
 * which one accepting consumed.
 *
 * `token` is a bearer credential and the ONLY thing the emailed link carries.
 * It is not sufficient on its own: `acceptOrgMemberInvitation` also requires the
 * signed-in account's address to equal `email`. The token proves control of a
 * mailbox; the address match is what stops it attaching the wrong identity.
 */
export interface OrgMemberInvitation {
  orgId: string
  /** normalizeEmail() of the invited address — the identity this grant is for. */
  email: string
  /** The role that will be written to `org_members` on accept. */
  role: OrgRole
  /** Random 32-byte hex. Rotated whenever the address is re-invited, so the
   *  previous mail's link stops working the moment a new one is sent. */
  token: string
  status: OrgMemberInvitationStatus
  /** uid of the org admin who sent it. */
  invitedBy: string
  /** Display copy for the accept page ("X invited you to …"), denormalized
   *  because the invitee may not even have an account yet, let alone a rule
   *  that lets them read `users/{uid}`. */
  invitedByName?: string
  created: Timestamp
  updated_at?: Timestamp
  /** The deadline. Compared to `now` at accept time, so the expiry sweep is
   *  never what authorizes anything — see `expireOrgMemberInvitations`. */
  expires_at: Timestamp
  accepted_at?: Timestamp
  /** uid that accepted. Equal to the `org_members` doc id that was written. */
  acceptedBy?: string
  declined_at?: Timestamp
  revoked_at?: Timestamp
  revokedBy?: string
  /** Stamped by the daily sweep. Bookkeeping only. */
  expired_at?: Timestamp
}

/**
 * The doc id of an org member invitation — DERIVED FROM THE ADDRESS, so
 * inviting the same person twice addresses the same document.
 *
 * That is the whole answer to "what happens if the same address is invited
 * twice": the second invite REWRITES the first (new token, new deadline, new
 * role if it changed) instead of creating a second live token. One pending row
 * per (organization, address), always — the members list cannot show two, the
 * admin cannot wonder which one to revoke, and the older mail's link dies the
 * moment the newer one is sent.
 *
 * Hashed rather than the raw address, for two reasons: an address is legal
 * Firestore doc-id input only by luck (`/` is valid in an RFC 5322 local part
 * and would silently re-target the path), and a doc id is the one part of a
 * document that shows up in logs and index entries — a list of ids should not
 * be a harvestable list of a customer's staff addresses.
 *
 * `sha256Hex` is INJECTED for the same reason it is everywhere else in shared:
 * this module stays crypto-free and browser-safe. See utils/identity.ts.
 */
export function orgMemberInvitationId(email: string, sha256Hex: Sha256Hex): string {
  return sha256Hex(normalizeEmail(email)).slice(0, 40)
}
