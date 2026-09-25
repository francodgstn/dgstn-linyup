import type { Timestamp } from './common'

// Public, world-readable signup flag (app_settings/public). Drives client UX in
// apps/web; the authoritative enforcement is the beforeUserCreated blocking
// function. Whether signup is open is not sensitive.
export interface PublicAppSettings {
  public_signup_enabled: boolean
  updated_at?: Timestamp
  updated_by?: string // operator email that last toggled it
}

// An email authorized to create a Linyup account while public signup is closed.
// Doc id = normalizeEmail(email). Persistent — the operator removes entries.
export interface SignupAllowlistEntry {
  email: string
  added_by: string // operator email — or, when `source` says so, a Cloud Function
  added_at: Timestamp
  note?: string
  /** WHO PUT THIS HERE. Absent = the operator console, which is where every
   *  entry came from until organizations could invite their own admins.
   *
   *  'org_member_invitation' means `inviteOrgMember` added it so the invitee can
   *  create the account the invitation is waiting for — without it the whole
   *  rail is dead while public signup is closed (beforeSignup fails closed).
   *  It is a permission to CREATE AN ACCOUNT and nothing more: the org role is
   *  granted only by accepting the invitation, which separately requires the
   *  signed-in address to be the invited one. Recorded rather than silent so an
   *  operator reviewing the allowlist can see which entries a customer added
   *  and which they did. */
  source?: 'operator' | 'org_member_invitation'
  /** Set with `source: 'org_member_invitation'` — the organization whose admin
   *  caused the entry. Attribution only; nothing reads it as state. */
  org_id?: string
}

// Write-to-send queue: creating one of these triggers the invite email
// (onSignupInviteCreated), then the doc has served its purpose.
export interface SignupInvite {
  email: string
  created_by: string // operator email
  created_at: Timestamp
}
