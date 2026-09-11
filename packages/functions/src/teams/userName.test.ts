import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { userFullName } from '@linyup/shared'

// A staff user's name, and the fallback each surface is allowed. The bug this
// pins: `users/{uid}` from an import carries firstname/lastname and no
// `displayName`, and two readers looked only at `displayName` — so the Coaches
// page showed an email and the PUBLIC coach roster showed a uid.
// Run with: pnpm --filter @linyup/functions test

const SRC = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('userFullName', () => {
  it('prefers the name fields an import actually fills in', () => {
    assert.equal(userFullName({ firstname: 'Anna', lastname: 'Bucci' }), 'Anna Bucci')
    assert.equal(userFullName({ firstname: 'Anna', lastname: 'Bucci', displayName: 'ab' }), 'Anna Bucci')
  })

  it('falls back to displayName, and to nothing at all', () => {
    assert.equal(userFullName({ displayName: 'Ash' }), 'Ash')
    assert.equal(userFullName({ firstname: '  ', displayName: ' Ash ' }), 'Ash')
    assert.equal(userFullName({}), null)
    assert.equal(userFullName(null), null)
    assert.equal(userFullName({ firstname: '', lastname: '', displayName: '   ' }), null)
  })

  it('copes with a half-filled name — 3 of HMD\'s 45 users have no lastname', () => {
    assert.equal(userFullName({ firstname: 'Anna' }), 'Anna')
    assert.equal(userFullName({ lastname: 'Bucci' }), 'Bucci')
  })

  it('never invents an email or a uid — the caller owns its own last resort', () => {
    assert.equal(userFullName({ displayName: null, firstname: null, lastname: null }), null)
  })
})

describe('the two surfaces that read it, and their different fallbacks', () => {
  it('the Coaches page falls back to the email — staff looking at their own team', () => {
    const src = code(read('teams/listTeamMembers.ts'))
    assert.match(src, /displayName: userFullName\(u as UserNameFields \| null\)/)
    assert.doesNotMatch(src, /u\?\.displayName as string/, 'the displayName-only read is gone')
    // The email still rides alongside, which is what the page shows as the muted
    // second line and as its own fallback when there is no name.
    assert.match(src, /email: \(u\?\.email as string \| undefined\) \?\? null/)
  })

  it('the PUBLIC coach roster falls back to the uid and NEVER to the email', () => {
    const src = code(read('sync/syncTeamCoachesPublicProfile.ts'))
    assert.match(src, /const name = userFullName\(u as UserNameFields \| null\) \?\? uid/)
    assert.doesNotMatch(src, /u\?\.email|\.email as string/, 'a public roster must not leak a staff email')
  })
})
