import { readFileSync } from 'node:fs'
import { getApp } from 'firebase-admin/app'
import type { UserImportRecord, HashAlgorithmType } from 'firebase-admin/auth'
import type { MigrationConfig } from '../config'
import { sourceAuth, targetAuth, sourceDb, EXCLUDED_SOURCE_TEAMS, matchesTeamSample } from '../config'

const PAGE_SIZE = 1000

// ─── Identity Toolkit API types ───────────────────────────────────────────────

interface IdentityUser {
  localId:          string
  email?:           string
  emailVerified?:   boolean
  displayName?:     string
  phoneNumber?:     string
  photoUrl?:        string
  passwordHash?:    string   // base64
  salt?:            string   // base64
  providerUserInfo?: Array<{
    providerId:   string
    rawId:        string
    email?:       string
    displayName?: string
    photoUrl?:    string
  }>
  customAttributes?: string
  disabled?:        boolean
}

interface HashConfig {
  algorithm:     string
  signerKey:     string   // base64
  saltSeparator: string   // base64
  rounds:        number
  memoryCost:    number
}

interface BatchGetResponse {
  users?:         IdentityUser[]
  nextPageToken?: string
  hashConfig?:    HashConfig
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * THE PROJECT'S SCRYPT PARAMETERS, from the endpoint that actually has them.
 *
 * Two different things are needed to re-create a password on the target: the
 * PER-USER hash + salt, and the PROJECT's signer key / salt separator / rounds /
 * memory cost. They come from two different APIs, and this pass asked only the
 * first — `v1 …/accounts:batchGet` returns `{kind, users, nextPageToken}` and no
 * `hashConfig`, whatever the caller's permissions. So the fallback branch below
 * fired on every run: 47 HMD accounts carried a hash and a salt, and every one
 * of them would have been created on the target WITHOUT A PASSWORD, silently,
 * behind a warning that blamed the source project.
 *
 * The config lives on `v2 …/projects/{id}/config` → `signIn.hashConfig`, gated
 * by `firebaseauth.configs.getHashConfig` — i.e. the source service account
 * needs **Firebase Authentication Admin** on the SOURCE project. A 403 here is
 * therefore the one failure worth reading aloud: it names the exact grant, and
 * it is the difference between "everyone keeps their password" and "every owner
 * needs a reset link on day 0".
 *
 * The signer key is a SECRET and is never logged — not in the success line, not
 * in the error. Only whether it arrived.
 */
async function fetchHashConfig(
  projectId: string,
  credential: { getAccessToken(): Promise<{ access_token: string }> },
): Promise<HashConfig | undefined> {
  const { access_token } = await credential.getAccessToken()
  const res = await fetch(`https://identitytoolkit.googleapis.com/v2/projects/${projectId}/config`, {
    headers: { Authorization: `Bearer ${access_token}` },
  })

  if (!res.ok) {
    const hint =
      res.status === 403
        ? ` — grant the source service account the 'Firebase Authentication Admin' role on project '${projectId}' (permission firebaseauth.configs.getHashConfig)`
        : ''
    console.warn(`  WARN: could not read the project hash config (HTTP ${res.status})${hint}`)
    return undefined
  }

  const body = (await res.json()) as { signIn?: { hashConfig?: HashConfig } }
  const hc = body.signIn?.hashConfig
  // A config missing its signer key cannot re-create a password; treating it as
  // present would hand `importUsers` an empty key and fail the whole batch.
  if (!hc?.signerKey || !hc.algorithm) {
    console.warn('  WARN: the project hash config carries no signer key — passwords cannot be migrated')
    return undefined
  }
  console.log(`  hash config: ${hc.algorithm}, rounds=${hc.rounds}, memoryCost=${hc.memoryCost}`)
  return hc
}

async function fetchSourceUsers(sourceCredsPath: string): Promise<{
  users: IdentityUser[]
  hashConfig: HashConfig | undefined
}> {
  const creds     = JSON.parse(readFileSync(sourceCredsPath, 'utf8')) as { project_id: string }
  const projectId = creds.project_id

  // Borrow the access token from the already-initialised source app credential
  const credential = getApp('source').options.credential as {
    getAccessToken(): Promise<{ access_token: string }>
  }

  const allUsers: IdentityUser[]   = []
  // The authoritative source, asked once. The per-page read below stays as a
  // fallback: it costs nothing, and an API that starts returning it there again
  // would be honoured without a change here.
  let hashConfig: HashConfig | undefined = await fetchHashConfig(projectId, credential)
  let pageToken:  string | undefined

  do {
    const { access_token } = await credential.getAccessToken()

    const params = new URLSearchParams({ maxResults: String(PAGE_SIZE) })
    if (pageToken) params.set('nextPageToken', pageToken)

    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:batchGet?${params}`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    )

    if (!res.ok) {
      throw new Error(`Identity Toolkit API ${res.status}: ${await res.text()}`)
    }

    const data = (await res.json()) as BatchGetResponse
    allUsers.push(...(data.users ?? []))
    if (!hashConfig && data.hashConfig) hashConfig = data.hashConfig
    pageToken = data.nextPageToken
  } while (pageToken)

  return { users: allUsers, hashConfig }
}

// ─── the activation list ──────────────────────────────────────────────────────

/**
 * The uids that belong to a LIVE club: every `team_members` row of every club
 * named on `--live`. A dormant club's members get no login on the target until
 * their wave — see `MigrationConfig.live`.
 */
async function liveMemberUids(cfg: MigrationConfig): Promise<Set<string>> {
  const src = sourceDb()
  const clubs = (await src.collection('teams').get()).docs.filter(
    (d) => !EXCLUDED_SOURCE_TEAMS.includes(d.id),
  )
  const nameOf = (d: { data(): Record<string, unknown> }) => String(d.data().name ?? '')
  const unmatched = (cfg.live ?? []).filter(
    (want) => !clubs.some((d) => matchesTeamSample([want], d.id, nameOf(d))),
  )
  if (unmatched.length > 0) {
    console.error(`\n❌ --live named ${unmatched.length} club(s) that do not exist in the source: ${unmatched.join(', ')}`)
    process.exit(1)
  }
  const uids = new Set<string>()
  for (const club of clubs) {
    if (!matchesTeamSample(cfg.live, club.id, nameOf(club))) continue
    const members = await src.collection('teams').doc(club.id).collection('team_members').get()
    members.docs.forEach((m) => uids.add(m.id))
    console.log(`  live: ${nameOf(club)} — ${members.size} member login(s)`)
  }
  return uids
}

// ─── the collision guard ──────────────────────────────────────────────────────

interface Collision { email: string; sourceUid: string; targetUid: string }

/**
 * A source account whose EMAIL already exists on the target under a DIFFERENT
 * uid is not imported. `importUsers` does not refuse it — it either creates a
 * second account for the same address or fails the record, depending on the
 * project's one-account-per-email setting — and neither is what anyone wants
 * for a person who already has a Linyup login (the org admin, on production).
 * Same uid is fine: `importUsers` replaces it, which is what makes re-runs
 * idempotent.
 */
async function withoutEmailCollisions(
  users: IdentityUser[],
): Promise<{ keep: IdentityUser[]; collisions: Collision[] }> {
  const tgt = targetAuth()
  const byEmail = new Map<string, string>() // target email (lower) → target uid
  const withEmail = users.filter((u) => !!u.email)
  for (let i = 0; i < withEmail.length; i += 100) {
    const chunk = withEmail.slice(i, i + 100)
    const found = await tgt.getUsers(chunk.map((u) => ({ email: u.email! })))
    for (const t of found.users) if (t.email) byEmail.set(t.email.toLowerCase(), t.uid)
  }
  const keep: IdentityUser[] = []
  const collisions: Collision[] = []
  for (const u of users) {
    const targetUid = u.email ? byEmail.get(u.email.toLowerCase()) : undefined
    if (targetUid && targetUid !== u.localId) {
      collisions.push({ email: u.email!, sourceUid: u.localId, targetUid })
    } else {
      keep.push(u)
    }
  }
  return { keep, collisions }
}

// ─── pass ─────────────────────────────────────────────────────────────────────

export async function pass00AuthUsers(cfg: MigrationConfig): Promise<void> {
  console.log('Pass 0b: auth users')

  // Reads only, so a dry run performs them: the activation filter and the
  // collision guard ARE the pre-flight, and a dry run that skipped them would
  // report nothing about the one thing a production import can get wrong.
  const { users: sourceUsers, hashConfig } = await fetchSourceUsers(cfg.sourceCredsPath)
  const active = sourceUsers.filter((u) => !u.disabled)
  console.log(`  fetched ${active.length} active users from source (hashes: ${!!hashConfig})`)

  let candidates = active
  if (cfg.live?.length) {
    const liveUids = await liveMemberUids(cfg)
    const adminEmail = cfg.orgAdminEmail.toLowerCase()
    candidates = active.filter(
      (u) => liveUids.has(u.localId) || (u.email ?? '').toLowerCase() === adminEmail,
    )
    console.log(`  activation list (${cfg.live.join(', ')}): ${candidates.length} of ${active.length} accounts belong to a live club or the org admin`)
  }

  const { keep, collisions } = await withoutEmailCollisions(candidates)
  for (const c of collisions) {
    console.warn(`  COLLISION ${c.email}: already on the target as uid=${c.targetUid} (source uid=${c.sourceUid}) — not imported; rows keyed by the source uid are re-keyed by the passes that write them`)
  }

  if (cfg.dryRun) {
    const withPassword = keep.filter((u) => !!u.passwordHash).length
    console.log(
      `  [dry-run] would import ${keep.length} account(s) — ${withPassword} keeping their password` +
        `${hashConfig ? '' : ' (NO — the hash config is missing, they would need a reset)'}; ` +
        `${collisions.length} collision(s) skipped; ${active.length - candidates.length} outside the activation list`,
    )
    return
  }

  const tgt = targetAuth()
  let totalImported = 0
  let totalSkipped  = collisions.length
  let totalErrored  = 0

  // Chunk into batches of 1000 (importUsers limit)
  for (let i = 0; i < keep.length; i += PAGE_SIZE) {
    const chunk = keep.slice(i, i + PAGE_SIZE)

    if (hashConfig) {
      // Full import with SCRYPT hashes — preserves original passwords
      const records: UserImportRecord[] = chunk.map((u) => ({
        uid:           u.localId,
        email:         u.email,
        emailVerified: u.emailVerified ?? false,
        displayName:   u.displayName,
        phoneNumber:   u.phoneNumber,
        photoURL:      u.photoUrl,
        disabled:      false,
        customClaims:  u.customAttributes ? JSON.parse(u.customAttributes) : undefined,
        providerData:  u.providerUserInfo?.map((p) => ({
          uid:         p.rawId,
          providerId:  p.providerId,
          email:       p.email,
          displayName: p.displayName,
          photoURL:    p.photoUrl,
        })),
        ...(u.passwordHash ? { passwordHash: Buffer.from(u.passwordHash, 'base64') } : {}),
        ...(u.salt         ? { passwordSalt: Buffer.from(u.salt,         'base64') } : {}),
      }))

      const result = await tgt.importUsers(records, {
        hash: {
          algorithm:     hashConfig.algorithm as HashAlgorithmType,
          key:           Buffer.from(hashConfig.signerKey,     'base64'),
          saltSeparator: Buffer.from(hashConfig.saltSeparator, 'base64'),
          rounds:        hashConfig.rounds,
          memoryCost:    hashConfig.memoryCost,
        },
      })
      totalImported += records.length - result.errors.length
      totalErrored  += result.errors.length
      for (const e of result.errors) {
        console.warn(`  WARN uid=${records[e.index]?.uid}: ${e.error.message}`)
      }
    } else {
      // No hash config returned — fall back to createUser() without password
      for (const u of chunk) {
        try {
          await tgt.createUser({
            uid:           u.localId,
            email:         u.email,
            emailVerified: u.emailVerified ?? false,
            displayName:   u.displayName,
            phoneNumber:   u.phoneNumber,
            photoURL:      u.photoUrl,
          })
          totalImported++
        } catch (e: unknown) {
          const code = (e as { code?: string }).code
          if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
            totalSkipped++
          } else {
            console.warn(`  WARN uid=${u.localId}: ${(e as Error).message}`)
            totalErrored++
          }
        }
      }
    }
  }

  console.log(`  → imported ${totalImported}, skipped ${totalSkipped}, errored ${totalErrored}`)
  if (!hashConfig) {
    const withPassword = keep.filter((u) => !!u.passwordHash).length
    console.warn(
      `  WARN: no hash config — ${withPassword} of ${keep.length} imported account(s) carry a password hash ` +
        `that cannot be re-created without it, so they were created WITHOUT a password and must reset it to sign in. ` +
        `See fetchHashConfig above for the grant that fixes this.`,
    )
  }
}
