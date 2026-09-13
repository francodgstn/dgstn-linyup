import assert from 'node:assert/strict'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { optionalContactSessionFromRequest } from './contactSession'

// Build a minimal CallableRequest with the given auth token claims + data body.
function req(
  token: Record<string, unknown> | null,
  data: unknown = {},
): CallableRequest<unknown> {
  return {
    data,
    auth: token ? { uid: 'contact:abc', token } : undefined,
  } as unknown as CallableRequest<unknown>
}

describe('optionalContactSessionFromRequest', () => {
  // Read the clock when each test RUNS, not when the file loads. Mocha loads
  // every test file before running any, and a cold ts-node compile of the
  // suite can outlast a minute — a load-time `future` is then already past.
  const future = () => Date.now() + 60_000
  const past = () => Date.now() - 60_000

  it('returns the contactId + teamId from a live session token', () => {
    const r = req({ contactId: 'c1', teamId: 't1', sessionExpires: future() })
    assert.deepEqual(optionalContactSessionFromRequest(r), { contactId: 'c1', teamId: 't1' })
  })

  it('returns null for an anonymous (no auth) caller', () => {
    assert.equal(optionalContactSessionFromRequest(req(null)), null)
  })

  it('returns null when the session is expired', () => {
    const r = req({ contactId: 'c1', teamId: 't1', sessionExpires: past() })
    assert.equal(optionalContactSessionFromRequest(r), null)
  })

  it('returns null when the token lacks contactId/teamId claims', () => {
    assert.equal(optionalContactSessionFromRequest(req({ sessionExpires: future() })), null)
  })

  it('NEVER reads a contactId from the request body (anti-spoofing)', () => {
    // A caller passing a contactId in the body but holding no session must not be
    // treated as that contact.
    const r = req(null, { authenticatedContactId: 'victim', contactId: 'victim' })
    assert.equal(optionalContactSessionFromRequest(r), null)
  })

  it('never mistakes a kiosk token for a contact session', () => {
    // A kiosk tablet signs in as a DEVICE and namespaces its team as `kioskTeam`
    // precisely so it can never be read as a contact. bookSession/bookAppointment
    // read request.auth now, so a kiosk caller must still fall through to the guest
    // path. Guards against anyone renaming kioskTeam -> teamId. See kiosk/index.ts.
    const r = req({ kiosk: true, kioskTeam: 't1', kioskEpoch: 1 })
    assert.equal(optionalContactSessionFromRequest(r), null)
  })

  it('ignores a body contactId even alongside a session (session wins)', () => {
    const r = req(
      { contactId: 'real', teamId: 't1', sessionExpires: future() },
      { contactId: 'victim', authenticatedContactId: 'victim' },
    )
    assert.deepEqual(optionalContactSessionFromRequest(r), { contactId: 'real', teamId: 't1' })
  })
})
