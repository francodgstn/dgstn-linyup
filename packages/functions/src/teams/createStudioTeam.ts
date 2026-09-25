import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { isReservedSlug, TRIAL_DAYS } from '@linyup/shared'

// ─────────────────────────────────────────────────────────────────────────────
// createStudioTeam — self-service studio (team) creation.
//
// The team-side twin of `createOrganization`: the ONE place a person turns their
// account into a studio. It replaces the old CLIENT-SIDE provisioning (three
// separate setDoc() writes from the browser, guarded by a `team_members`
// self-provision rule), which was the bootstrap that made the 2026-08-26 team
// takeover (#106) possible — a self-provision rule must grant a write to a
// not-yet-member, i.e. to "anyone", so it is permanently one missing conjunct
// from "anyone owns anything". Bootstrapping in a callable removes the footgun
// instead of bounding it: the Admin SDK bypasses rules, so once every caller
// goes through here the `team_members` self-provision disjunct can be deleted
// (as its org twin already was) and BOTH membership collections collapse to a
// single writer rule.
//
// Three things a callable does that the rules bootstrap could not:
//  • ATOMICITY — team doc + owner membership + user profile commit in ONE batch,
//    so a mid-sequence failure can no longer orphan a team with a createdBy and
//    no owner membership (the client path did three sequential awaits).
//  • VALIDATION — slug uniqueness needs a privileged query (`teams` is not
//    client-listable); the reserved-word + collision logic lives here, matching
//    createTeamRecord / validateTeamSlug.
//  • IDENTITY — tenant ownership must belong to a DURABLE account. Contact and
//    kiosk sessions are Firebase CUSTOM tokens (uid `contact:{id}` / `kiosk:{id}`,
//    scoped to one team, expiring); letting the lowest-trust principal in the
//    system mint tenants is exactly the direction #106 warned against. Refused
//    below by sign_in_provider, so a member session can never own a studio.
// ─────────────────────────────────────────────────────────────────────────────

// The bio-link starter links every new studio gets — identical to the shape the
// client `provisionTeam` wrote, so no signup behavior changes. Everything else a
// team needs at birth (default payment modes, the trial-cleanup automation) is
// provisioned by the `onTeamCreated` trigger, which fires for this create too.
const DEFAULT_LINKS = [
  {
    label: 'Book Now',
    description: 'Reserve your spot in a session',
    url: '',
    showInBioLink: true,
    target: 'booking',
  },
  {
    label: 'Membership Signup',
    description: 'Join our community and become a member',
    url: '',
    showInBioLink: true,
    target: 'signup',
  },
]

// Server-authoritative slug resolution — same normalization, reserved-word guard
// and single collision query as createTeamRecord (utils/teams.ts). The slug is
// the tenant's public address; a studio can rename it later from Settings.
async function resolveTeamSlug(
  db: admin.firestore.Firestore,
  name: string,
  teamId: string
): Promise<string> {
  const normalized = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)

  // A too-short name yields no usable slug; fall back to an id-derived one so the
  // studio is never left publicly unaddressable.
  const base = normalized.length >= 3 ? normalized : `team-${teamId.slice(0, 6).toLowerCase()}`
  const candidate = isReservedSlug(base) ? `${base.slice(0, 44)}-team` : base

  const existing = await db.collection('teams').where('slug', '==', candidate).limit(1).get()
  return existing.empty
    ? candidate
    : `${candidate.slice(0, 44)}-${teamId.slice(0, 4).toLowerCase()}`
}

interface CreateStudioTeamInput {
  name?: string
  sportType?: string
  /** ISO 4217, uppercase — the currency every price the studio types is authored in. */
  defaultCurrency?: string
  /** The language the studio mails its members in (Team.language). */
  language?: 'en' | 'de' | 'fr' | 'it'
  /** The terms version the signup form actually showed and the owner ticked. */
  termsVersion?: string
}

export const createStudioTeam = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  // A studio may be created ONLY from a durable personal account. Contact/kiosk
  // sessions are custom tokens; refuse them by provider (the authoritative
  // signal — it also covers any future custom-token principal, not just the
  // `contact:`/`kiosk:` uids of today).
  const signInProvider = (request.auth.token.firebase as { sign_in_provider?: string } | undefined)
    ?.sign_in_provider
  if (signInProvider === 'custom') {
    throw new HttpsError(
      'permission-denied',
      'A studio can only be created from a personal account, not a member session.'
    )
  }

  const data = (request.data ?? {}) as CreateStudioTeamInput
  const name = data.name?.trim()
  if (!name) throw new HttpsError('invalid-argument', 'Team name is required')

  const uid = request.auth.uid
  const token = request.auth.token
  const email = (token.email as string | undefined) ?? ''
  const emailVerified = token.email_verified === true
  const displayName = (token.name as string | undefined) ?? undefined
  const photoURL = (token.picture as string | undefined) ?? undefined

  const db = admin.firestore()
  const teamRef = db.collection('teams').doc()
  const teamId = teamRef.id
  const slug = await resolveTeamSlug(db, name, teamId)

  // Read the user doc up front so `created_at` is stamped only when the profile
  // is new (a social user may already have one) — mirrors the client path.
  const userRef = db.collection('users').doc(uid)
  const userSnap = await userRef.get()

  const now = FieldValue.serverTimestamp()
  const trialEndsAt = Timestamp.fromDate(new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000))

  const batch = db.batch()

  // Team document — new studios start on a full-access Studio trial.
  batch.set(teamRef, {
    name,
    slug,
    description: '',
    sport_type: data.sportType ?? '',
    ...(data.defaultCurrency ? { default_currency: data.defaultCurrency } : {}),
    ...(data.language ? { language: data.language } : {}),
    // The contract record — written in the SAME commit as the studio, so a team
    // cannot exist without the acceptance collected alongside it. The email is
    // taken from the verified token, never a client field.
    ...(data.termsVersion
      ? {
          terms_accepted: {
            version: data.termsVersion,
            accepted_at: now,
            accepted_by_uid: uid,
            accepted_by_email: email,
          },
        }
      : {}),
    links: DEFAULT_LINKS,
    settings: {},
    plan: 'studio',
    plan_status: 'trial',
    // Read by the mail gate: an email/password signup cannot send mail as this
    // studio until verified; a social sign-in arrives already verified.
    owner_email_verified: emailVerified,
    trial_ends_at: trialEndsAt,
    created: now,
    createdBy: uid,
    primaryContact: uid,
  })

  // Owner membership.
  batch.set(teamRef.collection('team_members').doc(uid), {
    userId: uid,
    teamId,
    role: 'owner',
    joined: now,
    addedBy: uid,
  })

  // User profile — merge so an existing profile keeps its created_at.
  batch.set(
    userRef,
    {
      email,
      ...(displayName ? { displayName } : {}),
      ...(photoURL ? { photoURL } : {}),
      currentTeam: teamId,
      email_verified: emailVerified,
      ...(userSnap.exists ? {} : { created_at: now }),
    },
    { merge: true }
  )

  await batch.commit()
  return { teamId, slug }
})
