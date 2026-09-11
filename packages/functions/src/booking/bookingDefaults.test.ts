import * as assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { resolveAutoConfirm } from '@linyup/shared'

// THE BOOKING DEFAULTS (2026-09-11): a booking confirms itself and an upcoming
// session is bookable unless the studio says otherwise. Being outside the
// booking calendar, or needing the studio's approval, is the exception a
// studio sets on purpose — never the state a class, a seed or an import lands
// in by default. These pin the two resolvers a default lives in.

describe('resolveAutoConfirm', () => {
  it('an unset field is ON for BOTH kinds — a class no longer waits for approval by default', () => {
    assert.strictEqual(resolveAutoConfirm({ type: 'class' }), true)
    assert.strictEqual(resolveAutoConfirm({ type: 'appointment' }), true)
    assert.strictEqual(resolveAutoConfirm({}), true)
  })

  it('an explicit value is the answer, whatever the kind', () => {
    assert.strictEqual(resolveAutoConfirm({ type: 'class', autoConfirm: false }), false)
    assert.strictEqual(resolveAutoConfirm({ type: 'appointment', autoConfirm: false }), false)
    assert.strictEqual(resolveAutoConfirm({ type: 'class', autoConfirm: true }), true)
  })
})

// The migration transform lives outside this workspace's module resolution
// (scripts/ resolves `@linyup/shared` through tsconfig.scripts.json, which this
// runner does not load — see statusVocabulary.test.ts for the same seam), so
// the rule is pinned by reading the SOURCE, the way orgTierRails.test.ts does.
describe('migration: transformSession.allowBooking', () => {
  function repoRoot(): string {
    let dir = process.cwd()
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
      dir = path.dirname(dir)
    }
    throw new Error('repo root not found above ' + process.cwd())
  }
  const src = fs.readFileSync(
    path.join(repoRoot(), 'scripts/migration/transforms/sessions.ts'),
    'utf8'
  )

  it('no longer derives the door from whether the old portal ever took a booking', () => {
    // The rule that closed every upcoming class nobody had happened to book.
    assert.ok(
      !src.includes('out.allowBooking = !!(src.portal_bookings_count'),
      'allowBooking is derived from portal_bookings_count again — an imported studio\'s upcoming classes would all be closed'
    )
  })

  it('opens an upcoming session and keeps a past or cancelled one closed', () => {
    assert.ok(
      src.includes('out.allowBooking = !cancelled && startMs != null && startMs >= Date.now()'),
      'the allowBooking rule changed shape — re-pin it here, and keep past + cancelled closed'
    )
  })
})
