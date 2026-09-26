import assert from 'node:assert/strict'
import { contactUpdateAuthMode } from './requestContactUpdate'

// Which proof authorizes a contact update request. The /contact-update page
// sends a code only when the visitor is NOT signed in as the link's contact,
// so a code arriving beside a session means the session is somebody else's —
// and trusting the session there wrote the request onto the wrong person.
describe('requestContactUpdate — auth mode', () => {
  it('a code wins over a session', () => {
    assert.equal(contactUpdateAuthMode({ codeId: 'c1', sessionContactId: 'parent' }), 'code')
  })

  it('a session alone is enough (Space, member app, /contact-update when signed in)', () => {
    assert.equal(contactUpdateAuthMode({ sessionContactId: 'member' }), 'session')
  })

  it('a code alone is the email-verification flow', () => {
    assert.equal(contactUpdateAuthMode({ codeId: 'c1' }), 'code')
  })

  it('neither is refused', () => {
    assert.equal(contactUpdateAuthMode({}), null)
    assert.equal(contactUpdateAuthMode({ codeId: '', sessionContactId: '' }), null)
  })
})
