import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  EMAIL_SENDER_INTEGRATION_DOC,
  ORGANIZATIONS_COLLECTION,
  TEAMS_COLLECTION,
  TEAM_INTEGRATIONS_SUBCOLLECTION,
  TEAM_MEMBERS_SUBCOLLECTION,
  USERS_COLLECTION,
  type EmailSenderConfig,
  type SaasPlan,
} from '@linyup/shared'

export type SenderScope = 'team' | 'org'

function senderDocRef(scope: SenderScope, entityId: string) {
  const col = scope === 'team' ? TEAMS_COLLECTION : ORGANIZATIONS_COLLECTION
  return admin
    .firestore()
    .collection(col)
    .doc(entityId)
    .collection(TEAM_INTEGRATIONS_SUBCOLLECTION)
    .doc(EMAIL_SENDER_INTEGRATION_DOC)
}

export async function getEmailSenderConfig(
  scope: SenderScope,
  entityId: string,
): Promise<EmailSenderConfig | null> {
  const snap = await senderDocRef(scope, entityId).get()
  return snap.exists ? (snap.data() as EmailSenderConfig) : null
}

// Merge-writes the sender config, stamping type + updatedAt. Never stores
// credentials (there are none) — only model, domain, verification status + DNS.
export async function writeEmailSenderConfig(
  scope: SenderScope,
  entityId: string,
  data: Partial<EmailSenderConfig>,
): Promise<void> {
  await senderDocRef(scope, entityId).set(
    { ...data, type: 'email_sender', updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  )
}

// Resolves a team's contact email for Reply-To, mirroring the resolution used by
// getInTouchForm: explicit settings.teamEmail → team.email → owner's user email.
export async function getTeamContactEmail(
  teamId: string,
  teamData?: Record<string, unknown>,
): Promise<string | undefined> {
  const db = admin.firestore()
  let team = teamData
  if (!team) {
    const snap = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
    team = (snap.data() as Record<string, unknown>) || {}
  }

  const settings = (team.settings as Record<string, unknown>) || {}
  if (typeof settings.teamEmail === 'string' && settings.teamEmail.trim()) {
    return settings.teamEmail.trim()
  }
  if (typeof team.email === 'string' && team.email.trim()) return (team.email as string).trim()

  // Fallback: the owner's account email.
  const ownerSnap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(TEAM_MEMBERS_SUBCOLLECTION)
    .where('role', '==', 'owner')
    .limit(1)
    .get()
  if (!ownerSnap.empty) {
    const ownerId = ownerSnap.docs[0].id
    const userSnap = await db.collection(USERS_COLLECTION).doc(ownerId).get()
    const email = userSnap.data()?.email
    if (typeof email === 'string' && email.trim()) return email.trim()
  }
  return undefined
}

// Everything sender resolution needs for a team, fetched in one place.
export interface StudioContext {
  teamName: string
  /**
   * The tenant's public slug. Carried purely so outbound mail can rewrite its
   * own `/public/{slug}/…` links onto a custom domain — it costs nothing, the
   * team document is already read here.
   */
  slug?: string
  plan?: SaasPlan
  contactEmail?: string
  config: EmailSenderConfig | null
  /**
   * `teams/{id}.owner_email_verified` VERBATIM — including undefined, which is
   * load-bearing. The field is written only for accounts created after the
   * verification gate shipped (2026-08-23), so an absent value means "this team
   * predates the question" and must NOT be read as "unverified". The gate in
   * `sendEntityMail` therefore blocks on an explicit `false` and nothing else.
   */
  ownerEmailVerified?: boolean
}

export async function loadStudioContext(teamId: string): Promise<StudioContext> {
  const db = admin.firestore()
  const teamSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
  const team = (teamSnap.data() as Record<string, unknown>) || {}
  const [contactEmail, config] = await Promise.all([
    getTeamContactEmail(teamId, team),
    getEmailSenderConfig('team', teamId),
  ])
  return {
    teamName: (team.name as string) || '',
    slug: team.slug as string | undefined,
    plan: team.plan as SaasPlan | undefined,
    contactEmail,
    config,
    ownerEmailVerified: team.owner_email_verified as boolean | undefined,
  }
}

// Org equivalent of loadStudioContext. Orgs have no dedicated contact-email
// field, so Reply-To falls back to the provided address (e.g. the requesting
// admin). Orgs are always a paid tier → BYO-eligible.
export async function loadOrgContext(orgId: string, fallbackContactEmail?: string): Promise<StudioContext> {
  const snap = await admin.firestore().collection(ORGANIZATIONS_COLLECTION).doc(orgId).get()
  const org = (snap.data() as Record<string, unknown>) || {}
  const config = await getEmailSenderConfig('org', orgId)
  return {
    teamName: (org.name as string) || '',
    slug: org.slug as string | undefined,
    plan: 'organization',
    contactEmail: (typeof org.email === 'string' && org.email.trim()) || fallbackContactEmail,
    config,
  }
}
