import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The per-tenant exemption from the environment's TEST_MODE redirect.
//
// TEST_MODE redirects EVERY message in an environment to one inbox and
// deliberately bypasses the per-tenant policy. That is right for a staging
// environment full of real imported addresses, and wrong for the one studio a
// real person has been asked to test — who then never receives what they
// trigger. `MessagingPolicy.ignoreTestMode` is the hole in that guard, and
// these pin the properties that make it safe to have.
// Run with: pnpm --filter @linyup/functions test

const SRC = join(__dirname, '..')
const ADMIN = join(__dirname, '..', '..', '..', '..', 'apps', 'admin', 'src')
const read = (base: string, rel: string) => readFileSync(join(base, rel), 'utf8')
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const MAIL = code(read(SRC, 'mail/mailService.ts'))
const SMS = code(read(SRC, 'mail/smsService.ts'))
const ACTIONS = code(read(ADMIN, 'app/(dashboard)/accounts/[type]/[id]/actions.ts'))
const CARD = code(read(ADMIN, 'app/(dashboard)/accounts/[type]/[id]/messaging-policy-card.tsx'))

describe('the exemption is OFF unless a policy says otherwise', () => {
  it('both services require the field to be exactly true — absent, null and falsy do not exempt', () => {
    for (const [name, src] of [['mail', MAIL], ['sms', SMS]] as const) {
      assert.match(
        src,
        /const bypassTestMode = testMode && policy\?\.ignoreTestMode === true/,
        `${name}: the exemption must be an explicit === true on the policy`,
      )
    }
  })

  it('it can only ever narrow the test-mode branch, never widen delivery on its own', () => {
    // Without TEST_MODE there is nothing to exempt from: the flag is ANDed with
    // it, so a stray `ignoreTestMode` in production changes nothing at all.
    for (const src of [MAIL, SMS]) {
      assert.match(src, /testMode && policy\?\.ignoreTestMode/)
      assert.doesNotMatch(src, /if \(policy\?\.ignoreTestMode\)\s*\{/, 'never read on its own')
    }
  })
})

describe('what the exemption does NOT bypass', () => {
  it('mail: an exempt tenant still goes through the synthetic guard, its own policy and suppression', () => {
    // The exempt path is the ELSE branch — the same one every non-test send
    // takes — so it inherits all three layers rather than skipping to the send.
    assert.match(MAIL, /if \(testMode && !bypassTestMode\) \{[\s\S]*?\} else \{/)
    const elseBranch = MAIL.slice(MAIL.indexOf('} else {', MAIL.indexOf('bypassTestMode')))
    assert.match(elseBranch, /isSyntheticEmail/)
    assert.match(elseBranch, /applyEmailPolicy\(recipients, policy, envDefaultMode\(\)\)/)
    assert.match(elseBranch, /isSuppressed/)
  })

  it('sms: the same — an exempt tenant is still decided by its policy and the suppression list', () => {
    assert.match(SMS, /if \(testMode && !bypassTestMode\) \{/)
    const elseBranch = SMS.slice(SMS.indexOf('} else {', SMS.indexOf('bypassTestMode')))
    assert.match(elseBranch, /applySmsPolicy\(recipient, policy, envDefaultMode\(\)\)/)
    assert.match(elseBranch, /isPhoneSuppressed/)
  })

  it('the policy is resolved ONCE, above the branch that depends on it', () => {
    // Two resolutions would be two reads and, worse, two answers.
    assert.equal((MAIL.match(/await resolveMessagingPolicy\(/g) ?? []).length, 1)
    assert.equal((SMS.match(/await resolveMessagingPolicy\(/g) ?? []).length, 1)
  })

  it('and says so out loud — an exemption that delivers silently is the one nobody notices', () => {
    assert.match(MAIL, /console\.warn\([\s\S]*?ignoreTestMode[\s\S]*?real recipients may be reached/)
    assert.match(SMS, /console\.warn\([\s\S]*?ignoreTestMode[\s\S]*?real number may be reached/)
  })
})

describe('who may set it', () => {
  it('the /try playground can never be exempted — those teams have public shared logins', () => {
    assert.match(
      ACTIONS,
      /if \(input\.ignoreTestMode && entityId\.startsWith\('sandbox-'\)\) \{[\s\S]*?return \{ ok: false/,
    )
  })

  it('is written only when true, so an absent field keeps meaning "no exemption"', () => {
    assert.match(ACTIONS, /\.\.\.\(input\.ignoreTestMode \? \{ ignoreTestMode: true \} : \{\}\)/)
  })

  it('the console offers it only while TEST_MODE is on, and asks a second time before turning it on', () => {
    assert.match(CARD, /env\?\.testMode && !entityId\.startsWith\('sandbox-'\)/)
    assert.match(CARD, /ignoreTestMode &&\s*saved\?\.ignoreTestMode !== true &&\s*!window\.confirm\(/)
  })
})
