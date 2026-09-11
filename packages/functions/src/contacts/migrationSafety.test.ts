import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Source pins on the HMD migration's PRODUCTION safety: the activation list, the
// collision guard, the org admin's target login, and the licence re-sync. The
// script lives outside this package's rootDir, so it is pinned by reading it —
// the same way the lifecycle census pins the server seams.
// Run with: pnpm --filter @linyup/functions test

const ROOT = join(__dirname, '..', '..', '..', '..', 'scripts')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
// Source with comments stripped, so a pin asserts on CODE and a doesNotMatch
// cannot be satisfied by prose. `//` is only a comment when it does not follow a
// colon — otherwise every `https://…` line is truncated at the scheme, which
// silently hid the URL these pins are about and would let a doesNotMatch pass
// for a line nobody read.
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const CLI = read('migrate-hmd.ts')
const AUTH = read('migration/passes/00-auth-users.ts')
const SETUP = read('migration/passes/00-setup.ts')
const USERS = read('migration/passes/01-users.ts')
const SUBS = read('migration/passes/11-team-subcollections.ts')
const ACTIVATION = read('migration/passes/15-activation.ts')
const AFFILIATIONS = read('migration/passes/16-affiliations.ts')
const ORG_ADMIN = read('migration/orgAdmin.ts')

describe('HMD migration — a real project never gets a full import without an activation list', () => {
  it('refuses a full, non-dry run against --target-creds when --live is absent; the emulator and a dry run are exempt', () => {
    assert.match(
      code(CLI),
      /if \(isFullRun && !targetEmulator && !\(values\['dry-run'\] \?\? false\) && !cfg\.live\?\.length\) \{[\s\S]*?process\.exit\(1\)/,
    )
  })

  it('activation closes every full run that has --live, and never runs without one', () => {
    assert.match(code(CLI), /if \(\(!only && cfg\.live\?\.length\) \|\| only === 'activation'\) await pass15Activation\(cfg\)/)
    const body = code(ACTIVATION)
    assert.match(body, /if \(!cfg\.live\?\.length\) \{[\s\S]*?return/)
    assert.ok(
      body.indexOf('if (!cfg.live?.length)') < body.indexOf("policy(ORG_ID, 'live'"),
      'the org policy must not be written before the --live check',
    )
  })

  it('the licence re-sync is never part of a full run', () => {
    assert.match(code(CLI), /if \(only === 'affiliations'\)\s+await pass16Affiliations\(cfg, teamIds\)/)
    assert.doesNotMatch(code(CLI), /!only \|\| only === 'affiliations'/)
  })
})

describe('the auth pass — logins only for live clubs, never a duplicated email', () => {
  it('filters to members of a live club plus the org admin when --live is given', () => {
    assert.match(code(AUTH), /if \(cfg\.live\?\.length\) \{[\s\S]*?liveMemberUids\(cfg\)[\s\S]*?liveUids\.has\(u\.localId\) \|\| \(u\.email \?\? ''\)\.toLowerCase\(\) === adminEmail/)
  })

  it('reads live membership from the SOURCE team_members of the named clubs', () => {
    assert.match(code(AUTH), /collection\('teams'\)\.doc\(club\.id\)\.collection\('team_members'\)\.get\(\)/)
  })

  it('skips an email that exists on the target under a different uid, and imports only what survives', () => {
    assert.match(code(AUTH), /if \(targetUid && targetUid !== u\.localId\) \{\s*collisions\.push/)
    assert.match(code(AUTH), /for \(let i = 0; i < keep\.length; i \+= PAGE_SIZE\)/)
    assert.doesNotMatch(code(AUTH), /active\.slice\(i, i \+ PAGE_SIZE\)/, 'the import loop must iterate the guarded list')
  })

  it('the SCRYPT config is read from the v2 project config — v1 batchGet does not return it, whatever the caller may', () => {
    const body = code(AUTH)
    assert.match(body, /identitytoolkit\.googleapis\.com\/v2\/projects\/\$\{projectId\}\/config/)
    assert.match(body, /body\.signIn\?\.hashConfig/)
    // Asked BEFORE the paging loop: the per-page read stays only as a fallback,
    // and must not overwrite the authoritative answer.
    assert.ok(
      body.indexOf('await fetchHashConfig(projectId, credential)') < body.indexOf('accounts:batchGet'),
      'the config is fetched before the user pages',
    )
    assert.match(body, /if \(!hashConfig && data\.hashConfig\) hashConfig = data\.hashConfig/)
  })

  it('a config without a signer key is refused rather than handed to importUsers as an empty key', () => {
    assert.match(code(AUTH), /if \(!hc\?\.signerKey \|\| !hc\.algorithm\) \{[\s\S]*?return undefined/)
  })

  it('the signer key is a secret and is never logged — only whether it arrived', () => {
    const logs = code(AUTH).match(/console\.(log|warn|error)\([\s\S]*?\)\n/g) ?? []
    for (const line of logs) {
      assert.doesNotMatch(line, /signerKey|saltSeparator\b(?!:)/, `a log line must not print the key: ${line.slice(0, 90)}`)
    }
  })

  it('a 403 names the exact grant, because that is the difference between keeping a password and resetting it', () => {
    assert.match(code(AUTH), /res\.status === 403[\s\S]*?Firebase Authentication Admin[\s\S]*?firebaseauth\.configs\.getHashConfig/)
  })

  it('a dry run performs the census (the reads) and imports nothing', () => {
    const body = code(AUTH)
    const fetchAt = body.indexOf('await fetchSourceUsers(cfg.sourceCredsPath)')
    const dryAt = body.indexOf('if (cfg.dryRun) {')
    assert.ok(fetchAt > 0 && dryAt > fetchAt, 'the source fetch and the collision guard run before the dry-run return')
    assert.match(body.slice(dryAt), /return\s*\}\s*const tgt = targetAuth\(\)/)
  })
})

describe('the org admin — the login they will actually type', () => {
  it('is resolved from the TARGET auth first, the source users second', () => {
    // ONE resolver for every email — the primary admin and the federation's
    // other admins ask it the same way, so the order is pinned once, here.
    const body = code(ORG_ADMIN)
    const targetAt = body.indexOf('targetAuth().getUserByEmail(email)')
    const sourceAt = body.indexOf("collection('users').where('email', '==', email)")
    assert.ok(targetAt > 0 && sourceAt > 0, 'both lookups live in resolveIdentity')
    assert.ok(targetAt < sourceAt, 'the target login is asked first')
    assert.match(body, /uid: targetUid \?\? sourceUid/)
  })

  it('every pass that writes a row in their name goes through the resolver', () => {
    assert.match(code(SETUP), /const adminUid = \(await resolveOrgAdmin\(cfg\)\)\.uid/)
    assert.match(code(SUBS), /const admin = await resolveOrgAdmin\(cfg\)/)
    assert.doesNotMatch(code(SETUP), /where\('email', '==', cfg\.orgAdminEmail\)/, 'no private source lookup survives')
    assert.doesNotMatch(code(SUBS), /where\('email', '==', cfg\.orgAdminEmail\)/, 'no private target-users lookup survives')
  })

  it('their source membership row is re-keyed to the target login, and their source profile is skipped', () => {
    assert.match(code(SUBS), /isRemappedAdminUid\(admin, d\.id\) && admin\.targetUid[\s\S]*?\.doc\(admin\.targetUid\)[\s\S]*?userId: admin\.targetUid/)
    assert.match(code(USERS), /if \(isRemappedAdminUid\(admin, d\.id\)\) \{[\s\S]*?continue/)
  })
})

describe('activation — messaging policies', () => {
  it('iterates the SOURCE club list, never the target teams collection', () => {
    const body = code(ACTIVATION)
    assert.match(body, /src\.collection\('teams'\)\.get\(\)/)
    assert.doesNotMatch(body, /tgt\.collection\('teams'\)\.get\(\)/)
  })

  it('writes live for the named clubs and the org, silent for every other club', () => {
    const body = code(ACTIVATION)
    assert.match(body, /policy\(ORG_ID, 'live'/)
    assert.match(body, /isLive\s*\?\s*policy\(d\.id, 'live'/)
    assert.match(body, /:\s*policy\(d\.id, 'silent'/)
  })

  it('fails loudly on a live name that matches no club', () => {
    assert.match(code(ACTIVATION), /if \(unmatched\.length > 0\) \{[\s\S]*?process\.exit\(1\)/)
  })
})

describe('affiliations re-sync — the migration\'s rows only', () => {
  it('re-derives rows through the same transform pass 05 uses', () => {
    assert.match(code(AFFILIATIONS), /transformContact\(d\.data\(\) as Record<string, unknown>, sourceTypeNames\)/)
    assert.match(code(AFFILIATIONS), /transformed\[AFFILIATIONS_OUTPUT_KEY\]/)
  })

  it('touches only the positional ids, deleting the stale ones and nothing with a generated id', () => {
    const body = code(AFFILIATIONS)
    assert.match(body, /\.startAt\(prefix\)\s*\.endAt\(`\$\{prefix\}\\uf8ff`\)/)
    assert.match(body, /if \(!Number\.isInteger\(idx\) \|\| idx < affs\.length\) continue\s*bw\.delete\(row\.ref\)/)
  })

  it('never writes affiliation_summary — onAffiliationWrite is its one writer', () => {
    assert.doesNotMatch(code(AFFILIATIONS), /affiliation_summary/)
  })

  it('skips a contact the target has never seen rather than orphaning rows under it', () => {
    assert.match(code(AFFILIATIONS), /if \(!\(await contactRef\.get\(\)\)\.exists\) \{ missing\+\+; continue \}/)
  })
})

describe("the federation's admins", () => {
  const CONFIG = read('migration/config.ts')

  it('an org admin who did not run the migration is a standing fact, not a flag', () => {
    assert.match(code(CONFIG), /ADDITIONAL_ORG_ADMIN_EMAILS: string\[\] = \[/)
    assert.match(code(SETUP), /for \(const email of ADDITIONAL_ORG_ADMIN_EMAILS\)/)
  })

  it('resolves their TARGET login, like the primary admin — a row against an unused uid grants nothing', () => {
    assert.match(code(SETUP), /const who = await resolveIdentity\(email\)/)
    assert.match(code(read('migration/orgAdmin.ts')), /export async function resolveIdentity\(email: string\)/)
  })

  it('never overwrites an existing row, so a role changed in the app survives a re-run', () => {
    assert.match(code(SETUP), /if \(\(await ref\.get\(\)\)\.exists\) \{[\s\S]*?continue/)
  })

  it('skips the primary admin rather than writing their row twice', () => {
    assert.match(code(SETUP), /if \(email\.toLowerCase\(\) === cfg\.orgAdminEmail\.toLowerCase\(\)\) continue/)
  })
})

describe('the federation card and the partner plans — what the org can see, and what lets a visitor in', () => {
  const TRANSFORM = read('migration/transforms/contacts.ts')
  const SUBS_TRANSFORM = read('migration/transforms/subscriptions.ts')
  const PASS05 = read('migration/passes/05-contacts.ts')

  it("membership_status is ORG-issued — the one row the org-visibility rule admits — and there is no org_membership_status", () => {
    const body = code(TRANSFORM)
    assert.match(body, /pushAffiliation\(out\.membership_status, 'org', ORG_CLUB_TYPE, out\.membership_expiration\)/)
    assert.doesNotMatch(body, /pushAffiliation\(out\.org_membership_status/)
    assert.doesNotMatch(body, /'team', TEAM_CLUB_TYPE/)
    assert.match(body, /if \(issuer === 'org'\) doc\.org_id = ORG_ID/)
  })

  it("the type is HMD's own card, by id, key and label — not a generic club membership", () => {
    const setup = code(SETUP)
    assert.match(setup, /id: 'hmd-affiliation',\s*key: 'hmd-affiliation',\s*label: 'HMD Affiliation'/)
    assert.match(
      code(TRANSFORM),
      /ORG_CLUB_TYPE = \{ id: 'hmd-affiliation', key: 'hmd-affiliation', label: 'HMD Affiliation' \}/,
    )
  })

  it('expires on 1 September — the federation-wide reset, not a per-member clock, and nothing auto-renews', () => {
    const setup = code(SETUP)
    assert.match(setup, /validity_mode: 'fixed_date'/)
    assert.match(setup, /reset_month_day: '09-01'/)
    assert.doesNotMatch(setup, /default_validity_months/)
  })

  it('no team-local "Club membership" type is seeded beside it any more', () => {
    assert.doesNotMatch(code(PASS05), /default_issuer: 'team'/)
    assert.match(code(PASS05), /affiliations_enabled: true/)
  })

  it('ONE partner matcher, read by the type copy and by the holder\'s row', () => {
    assert.match(code(SUBS_TRANSFORM), /export function isPartnerSourceType\(/)
    assert.match(code(SUBS), /sub === 'subscription_types' && isPartnerSourceType\([\s\S]*?source: 'aggregator'/)
    assert.match(code(TRANSFORM), /if \(isPartnerSourceType\(srcTypeName\) && !isGone\) \{[\s\S]*?status:\s*'active'/)
  })

  it('a partner holder\'s live row is honest about money: amount 0, no recurrence, and never for the archived', () => {
    const branch = code(TRANSFORM).slice(code(TRANSFORM).indexOf('isPartnerSourceType(srcTypeName)'))
    assert.match(branch, /recurrence:\s*null/)
    assert.match(branch, /amount:\s*0/)
  })
})
