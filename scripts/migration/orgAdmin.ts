/**
 * WHO THE ORG ADMIN IS ON THE TARGET — resolved once, read by every pass that
 * writes a row in their name.
 *
 * The admin's email is the same on both sides; their UID need not be. On a
 * fresh emulator it is — the auth pass imports the source account under its
 * source uid — but on a project where the admin ALREADY HAS A LOGIN (production,
 * where Franco signed up months before this migration ran) the two differ, and
 * every pass that resolved the uid from the SOURCE users then wrote
 * `org_members/{sourceUid}`, `team_members/{sourceUid}` and `createdBy` against
 * a login nobody uses, while the auth import of the source account either
 * duplicated the email or was refused. The person who owns the migration would
 * have been locked out of the organisation it created.
 *
 * So the TARGET's auth is asked first — that is the login that will actually be
 * typed — and the source `users` collection only when the target has never
 * heard of the email. Both uids are returned, because the passes that copy
 * source rows keyed by the source uid need to REMAP them (team_members) or skip
 * them (the source profile document) when the two differ.
 */
import type { MigrationConfig } from './config'
import { sourceDb, targetAuth } from './config'

export interface OrgAdminIdentity {
  email: string
  /** The uid the admin's login has on the TARGET, when one exists there. */
  targetUid: string | null
  /** The uid the admin has in the SOURCE users collection, when they are one. */
  sourceUid: string | null
  /** The uid every target row is written against: target first, else source. */
  uid: string | null
}

let cached: OrgAdminIdentity | null = null

/**
 * The same target-first resolution for ANY email — used for the federation's
 * other admins (`ADDITIONAL_ORG_ADMIN_EMAILS`), who need exactly the uid the
 * primary admin needs and for exactly the same reason: a row written against a
 * login they do not use grants nothing.
 */
export async function resolveIdentity(email: string): Promise<OrgAdminIdentity> {
  let targetUid: string | null = null
  try {
    targetUid = (await targetAuth().getUserByEmail(email)).uid
  } catch (e: unknown) {
    if ((e as { code?: string }).code !== 'auth/user-not-found') throw e
  }
  const srcSnap = await sourceDb().collection('users').where('email', '==', email).limit(1).get()
  const sourceUid = srcSnap.empty ? null : srcSnap.docs[0].id
  return { email, targetUid, sourceUid, uid: targetUid ?? sourceUid }
}

export async function resolveOrgAdmin(cfg: MigrationConfig): Promise<OrgAdminIdentity> {
  if (cached && cached.email === cfg.orgAdminEmail) return cached

  const { targetUid, sourceUid } = await resolveIdentity(cfg.orgAdminEmail)

  cached = { email: cfg.orgAdminEmail, targetUid, sourceUid, uid: targetUid ?? sourceUid }

  if (!cached.uid) {
    console.warn(`  WARN: ${cfg.orgAdminEmail} is neither a target login nor a source user — org rows will carry no admin uid`)
  } else if (targetUid && sourceUid && targetUid !== sourceUid) {
    console.log(`  org admin ${cfg.orgAdminEmail}: target uid=${targetUid} (source uid=${sourceUid} — rows are remapped to the target login)`)
  } else {
    console.log(`  org admin ${cfg.orgAdminEmail}: uid=${cached.uid}${targetUid ? ' (target login)' : ' (from source users)'}`)
  }
  return cached
}

/** True when a source row keyed by this uid belongs to the admin AND must be re-keyed on the target. */
export function isRemappedAdminUid(admin: OrgAdminIdentity, sourceKeyedUid: string): boolean {
  return (
    admin.sourceUid !== null &&
    admin.targetUid !== null &&
    admin.sourceUid !== admin.targetUid &&
    sourceKeyedUid === admin.sourceUid
  )
}
