import assert from 'node:assert/strict'
import { leadDemoMarkerOf, leadDemoUrlLabel } from '@linyup/shared'

// The lead-demo disclaimer's public shape (Team.lead_demo → TeamPublicProfile).
// A real studio must never get the bar, and the official URL is an href on every
// public page, so only an https link may reach it.
// Run: pnpm --filter @linyup/functions test  (build @linyup/shared first).

describe('leadDemoMarkerOf', () => {
  it('is null for a real studio (absent, null, or not an object)', () => {
    assert.equal(leadDemoMarkerOf(undefined), null)
    assert.equal(leadDemoMarkerOf(null), null)
    assert.equal(leadDemoMarkerOf(false), null)
    assert.equal(leadDemoMarkerOf('https://x.ch'), null)
  })

  it('keeps an https official URL', () => {
    assert.deepEqual(leadDemoMarkerOf({ official_url: 'https://www.swimatic.ch' }), {
      official_url: 'https://www.swimatic.ch',
    })
  })

  it('marks the tenant but drops a URL that is not a plain https link', () => {
    for (const bad of ['http://x.ch', 'javascript:alert(1)', 'https://x.ch/"onmouseover=1', '', 42, null]) {
      assert.deepEqual(leadDemoMarkerOf({ official_url: bad }), { official_url: null }, String(bad))
    }
    assert.deepEqual(leadDemoMarkerOf({}), { official_url: null })
  })
})

describe('leadDemoUrlLabel', () => {
  it('shows the host the way a visitor reads it', () => {
    assert.equal(leadDemoUrlLabel('https://www.swimatic.ch'), 'swimatic.ch')
    assert.equal(leadDemoUrlLabel('https://swimliclub.com/'), 'swimliclub.com')
    assert.equal(leadDemoUrlLabel('https://studio.ch/de'), 'studio.ch/de')
  })
})
