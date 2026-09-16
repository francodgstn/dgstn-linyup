import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apiAccessBlocked } from '@linyup/shared'

// THE BLOCK ON A DEMO TENANT — the predicate, and the two doors it must sit on.
//
// `Team.api_access_blocked` exists for the `/try` playground, whose owner login
// is public (scripts/seed-sandbox.ts sets it there and nowhere else). The block
// only works if it is asked at CREATION: mint no key, approve no grant, and no
// credential can exist for the principal resolver to accept later. A new
// creation path that forgets to ask is the one way this goes quietly wrong, so
// the call sites are pinned against the source here.
//
// Source is read with line endings normalised: a Windows checkout is CRLF and an
// anchor written with a bare \n would fail locally and pass in CI.

const SRC = __dirname
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')

describe('the public API block on a team', () => {
  describe('apiAccessBlocked', () => {
    it('is false for an ordinary studio — the field is absent on every team but a demo one', () => {
      assert.equal(apiAccessBlocked({}), false)
      assert.equal(apiAccessBlocked({ api_access_blocked: false }), false)
    })

    it('is false for a team that could not be read, so a missing document never opens a door', () => {
      assert.equal(apiAccessBlocked(undefined), false)
      assert.equal(apiAccessBlocked(null), false)
    })

    it('is true only for the flag itself', () => {
      assert.equal(apiAccessBlocked({ api_access_blocked: true }), true)
    })
  })

  describe('the doors that must ask it', () => {
    const doors: Array<{ file: string; what: string }> = [
      { file: 'keys.ts', what: 'createApiKey mints a key' },
      { file: 'oauth/consent.ts', what: 'approveOAuthAuthorization creates a grant' },
    ]

    for (const { file, what } of doors) {
      it(`${file}: ${what}, so it calls assertApiAccessAllowed`, () => {
        const src = read(file)
        assert.ok(
          /await assertApiAccessAllowed\(teamId\)/.test(src),
          `${file} creates a credential without asking whether the team is blocked`
        )
        // Beside the plugin gate, and never before membership is established.
        assert.ok(
          src.indexOf('assertPluginInstalled(teamId, API_CONNECTORS_PLUGIN_ID)') <
            src.indexOf('await assertApiAccessAllowed(teamId)'),
          `${file} should ask after the plugin gate, where the other refusals live`
        )
      })
    }

    it('revoking is never blocked — a door must always close', () => {
      const keys = read('keys.ts')
      const revoke = keys.slice(keys.indexOf('export const revokeApiKey'))
      assert.ok(revoke.length > 0, 'revokeApiKey not found')
      assert.ok(
        !revoke.includes('assertApiAccessAllowed'),
        'revokeApiKey must keep working on a blocked team, like it does without the plugin'
      )
    })
  })

  describe('the seeders', () => {
    const scripts = join(__dirname, '..', '..', '..', '..', 'scripts')
    const readScript = (name: string) => readFileSync(join(scripts, name), 'utf8').replace(/\r\n/g, '\n')

    it('the /try playground is blocked', () => {
      assert.ok(readScript('seed-sandbox.ts').includes('api_access_blocked: true'))
    })

    it('a lead tenant is not blocked, and installs the plugin so the demo can show it', () => {
      const lead = readScript('seed-lead.ts')
      assert.ok(!lead.includes('api_access_blocked'), 'a lead demo must be able to connect an app')
      assert.ok(lead.includes("{ id: 'api-connectors' }"))
    })
  })
})
