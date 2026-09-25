import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { kioskClaimForTeam } from './kioskSession'

// THE KIOSK IS AN IDENTITY, NOT A STRING.
//
// The defect this file exists to keep closed: `bookSession` selected a security
// behavior from `data.source`, an unauthenticated string off the request body.
// Adding `source: 'kiosk'` to a public payload bought it.
//
// The behavior it selected then (a waiver deferral) is gone with the mechanism
// that needed it. What it selects NOW is what an acceptance record and a booking
// row CLAIM about where they came from — so the same rule applies for the same
// reason: the one value a caller might want to claim in an evidence record is
// the one value they must not be able to fake into it.
//
// Half one is the predicate's matrix, including the headline case: an anonymous
// caller who says "kiosk" is not one. Half two reads `bookSession`'s source and
// asserts the condition is the caller's identity, because a unit test cannot
// reach a callable and this is the line that regressed.
//
// Run with: pnpm --filter @linyup/functions test

const TEAM = 'team-A'

describe('kioskClaimForTeam — only a minted pairing counts', () => {
  it('an ANONYMOUS caller is not a kiosk, whatever their payload says', () => {
    // The blocker, stated as a fixture. `source: 'kiosk'` lives in the request
    // BODY and never reaches this function, because the body is not an identity.
    assert.equal(kioskClaimForTeam(undefined, TEAM), null)
    assert.equal(kioskClaimForTeam(null, TEAM), null)
    assert.equal(kioskClaimForTeam({}, TEAM), null)
  })

  it('a CONTACT session is not a kiosk — the two token kinds never substitute', () => {
    assert.equal(kioskClaimForTeam({ contactId: 'c1', kioskTeam: TEAM }, TEAM), null)
  })

  it('a kiosk token for ANOTHER team is not a kiosk here', () => {
    assert.equal(kioskClaimForTeam({ kiosk: true, kioskTeam: 'team-B', kioskEpoch: 3 }, TEAM), null)
  })

  it('the `kiosk: true` marker is required, and truthiness is not enough', () => {
    assert.equal(kioskClaimForTeam({ kiosk: 'true', kioskTeam: TEAM, kioskEpoch: 1 }, TEAM), null)
    assert.equal(kioskClaimForTeam({ kiosk: 1, kioskTeam: TEAM, kioskEpoch: 1 }, TEAM), null)
  })

  it('a paired device carries its epoch through, for the revocation check', () => {
    assert.deepEqual(kioskClaimForTeam({ kiosk: true, kioskTeam: TEAM, kioskEpoch: 4 }, TEAM), {
      epoch: 4,
    })
  })

  it('a missing epoch reads as ZERO rather than as a wildcard', () => {
    // `lock.epoch` starts at 0, so "absent" must compare like any other value —
    // an epoch-less token that matched everything would survive every rotation.
    assert.deepEqual(kioskClaimForTeam({ kiosk: true, kioskTeam: TEAM }, TEAM), { epoch: 0 })
  })

  it('an empty teamId matches nothing', () => {
    assert.equal(kioskClaimForTeam({ kiosk: true, kioskTeam: '', kioskEpoch: 0 }, ''), null)
  })
})

describe('bookSession derives the deferral from the CALLER, not the payload', () => {
  const src = readFileSync(join(__dirname, '..', 'booking', 'index.ts'), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")

  it('the kiosk test is the verified pairing', () => {
    assert.match(code, /const isKiosk = await isKioskDeviceForTeam\(request, data\.teamId\)/)
  })

  it('`data.source` decides NOTHING but the attribution stamp, and cannot fake it', () => {
    // One survivor, and it is the dashboard label on the booking document. If a
    // second appears, something is reading an unauthenticated string to make a
    // decision again.
    const uses = code.split('parseBookingSource(data.source)').length - 1
    assert.equal(uses, 1, 'data.source may only feed the attribution field')
    assert.doesNotMatch(
      code,
      /const isKiosk = [^\n]*parseBookingSource/,
      'the verified pairing, never a body string, decides what the record claims'
    )
  })
})
