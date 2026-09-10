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
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

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
    const body = code(ORG_ADMIN)
    assert.ok(body.indexOf('targetAuth().getUserByEmail(cfg.orgAdminEmail)') < body.indexOf("collection('users').where('email', '==', cfg.orgAdminEmail)"))
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
