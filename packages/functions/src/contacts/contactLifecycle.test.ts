import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONTACT_LIFECYCLES,
  CONTACT_CSV_COLUMNS,
  contactAttentionReasons,
  contactLifecycle,
  isLiveContact,
  isRosterContact,
  type ContactFilterSubject,
} from '@linyup/shared'

// Fixtures for the ONE lifecycle predicate — where a contact stands with the
// studio — and source pins on every server seam that must read it. The bucket
// this exists for is EXTERNAL: somebody who trains here without being looked
// after (a partner-app drop-in, a former member who still comes now and then).
// Run with: pnpm --filter @linyup/functions test

const FN = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(FN, rel), 'utf8')

const STAMP = { seconds: 1_750_000_000, nanoseconds: 0 }

describe('contactLifecycle — the order', () => {
  it('a bare document is active — the markers are opt-in', () => {
    assert.equal(contactLifecycle({}), 'active')
    assert.equal(contactLifecycle({ archived_at: null, deleted_at: null }), 'active')
    assert.equal(contactLifecycle({ external: false, provisional: false }), 'active')
  })

  it('each marker alone names its bucket', () => {
    assert.equal(contactLifecycle({ external: true }), 'external')
    assert.equal(contactLifecycle({ provisional: true }), 'provisional')
    assert.equal(contactLifecycle({ archived_at: STAMP }), 'archived')
    assert.equal(contactLifecycle({ deleted_at: STAMP }), 'deleted')
    assert.equal(contactLifecycle({ anonymized_at: STAMP }), 'deleted')
  })

  it('the first match wins, so a document carrying two markers answers the same everywhere', () => {
    assert.equal(contactLifecycle({ external: true, archived_at: STAMP }), 'archived')
    assert.equal(contactLifecycle({ external: true, deleted_at: STAMP }), 'deleted')
    assert.equal(contactLifecycle({ external: true, provisional: true }), 'provisional')
    assert.equal(contactLifecycle({ archived_at: STAMP, deleted_at: STAMP }), 'deleted')
  })

  it('lists every bucket once, roster first', () => {
    assert.deepEqual([...CONTACT_LIFECYCLES], ['active', 'external', 'provisional', 'archived', 'deleted'])
  })
})

describe('the two questions', () => {
  it('LIVE — may book, attend, sign in: everyone not deleted or archived, externals and leads included', () => {
    assert.equal(isLiveContact({}), true)
    assert.equal(isLiveContact({ external: true }), true)
    assert.equal(isLiveContact({ provisional: true }), true)
    assert.equal(isLiveContact({ archived_at: STAMP }), false)
    assert.equal(isLiveContact({ deleted_at: STAMP }), false)
  })

  it('ROSTER — looked after: active and leads, and NOT the external. That one difference is the whole bucket', () => {
    assert.equal(isRosterContact({}), true)
    assert.equal(isRosterContact({ provisional: true }), true)
    assert.equal(isRosterContact({ external: true }), false)
    assert.equal(isRosterContact({ archived_at: STAMP }), false)
    assert.equal(isRosterContact({ deleted_at: STAMP }), false)
  })
})

describe('an external is never waiting on the studio', () => {
  // Every reason at once — the fixture that would top the attention queue.
  const everything: ContactFilterSubject = {
    alerts_count: 2,
    pending_signup: true,
    acquisition_stage: 'trial_booked',
    lead_acknowledged: false,
    active_subscriptions: [{ subscription_type_id: 'plan-a', cancelling: true }],
    subscription_type_id: 'plan-b',
    coaching_overdue_count: 1,
    total_sessions: 3,
    last_session_at: { seconds: 1_700_000_000, nanoseconds: 0 },
    last_checkin_at: { seconds: 1_700_000_000, nanoseconds: 0 },
  }
  const now = 1_760_000_000_000

  it('the same person on the roster has every reason', () => {
    const reasons = contactAttentionReasons(everything, { nowMs: now })
    assert.ok(reasons.length >= 7, `expected the full list, got ${reasons.join(',')}`)
  })

  it('marked external, none — a stored alert stays on their page and off the queue', () => {
    assert.deepEqual(contactAttentionReasons({ ...everything, external: true }, { nowMs: now }), [])
  })
})

describe('the seams — every server path that must tell an external apart', () => {
  it('the roster helper narrows in memory, because `external` is present only when true and its absence cannot be queried', () => {
    const src = read('utils/contacts.ts')
    assert.match(src, /\.filter\(isRosterContact\)/, 'getActiveContacts must narrow by isRosterContact')
  })

  it('an invitation to everyone goes to the roster', () => {
    const src = read('events/index.ts')
    assert.match(src, /filter\(\(d\) => isRosterContact\(d\.data\(\)\)\)/)
    assert.doesNotMatch(src, /contactsSnap\.docs\.map/, 'the send loop must iterate the narrowed list, not the raw snapshot')
  })

  it('automations skip an external on the same line as archived — the sweep, the preview, and both per-contact triggers', () => {
    for (const rel of [
      'utils/automationEngine.ts',
      'automation/previewAutomationRule.ts',
      'automation/onContactWrite.ts',
      'automation/onMemberPaymentWrite.ts',
    ]) {
      const src = read(rel)
      assert.match(
        src,
        /\.archived_at \|\| \w+\.external\)/,
        `${rel}: the archived guard must also skip external`,
      )
    }
  })

  it('archiving an external is not a lost trial', () => {
    const src = read('analytics/index.ts')
    assert.match(src, /!oldData\.external &&\s*\(oldData\.acquisition_stage === 'trial_booked'/)
  })

  it('completing the signup form is the ONE act that brings an external back — both finalize branches clear it', () => {
    const src = read('auth/completeSignup.ts')
    const clears = src.match(/external: FieldValue\.delete\(\)/g) ?? []
    const sinceClears = src.match(/external_since: FieldValue\.delete\(\)/g) ?? []
    assert.equal(clears.length, 2, 'both merge branches of completeSignup clear `external`')
    assert.equal(sinceClears.length, 2, 'both merge branches of completeSignup clear `external_since`')
  })

  it('a purchase never clears it — the Connect webhook does not touch the field', () => {
    assert.doesNotMatch(read('connect/webhook.ts'), /external(_since)?:/)
  })

  it('an external still counts toward the contact cap — the cap helper reads the LIVE count on purpose', () => {
    const src = read('utils/contactCap.ts')
    assert.doesNotMatch(src, /external/, 'the cap counts records held, not people looked after')
  })

  it('the export carries the marker beside archived_at', () => {
    const i = CONTACT_CSV_COLUMNS.indexOf('external_since')
    assert.ok(i > 0)
    assert.equal(CONTACT_CSV_COLUMNS[i + 1], 'archived_at')
  })
})
