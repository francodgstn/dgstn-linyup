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

  it('an affiliation row mirrors LIVE-ness, not roster membership — an external holding the federation\'s licence is still on its books', () => {
    const trigger = read('sync/syncAffiliationContactLive.ts')
    const create = read('affiliations/index.ts')
    // TWO WRITERS, ONE QUESTION. The trigger owns the transitions (liveness
    // changes on the contact and touches no affiliation), the callable stamps a
    // row created for somebody already archived. Let them disagree and the
    // organisation's count changes by itself on that contact's next write.
    assert.match(trigger, /return !!data && isLiveContact\(data\)/)
    assert.match(create, /contact_live: isLiveContact\(contactData\)/)
    // Comments stripped: the trigger's own header ARGUES the choice by naming
    // the predicate it rejected, and that paragraph is the reason to keep.
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(
      code(trigger),
      /isRosterContact/,
      'the federation counts its own members whether or not the studio looks after them',
    )
  })

  it('the export carries the marker beside archived_at', () => {
    const i = CONTACT_CSV_COLUMNS.indexOf('external_since')
    assert.ok(i > 0)
    assert.equal(CONTACT_CSV_COLUMNS[i + 1], 'archived_at')
  })
})

describe('the HMD migration — where the old "external" type lands', () => {
  // The transform lives outside this package's rootDir, so it is pinned by
  // reading its source, the way the census above pins the server seams.
  const MIG = join(__dirname, '..', '..', '..', '..', 'scripts', 'migration', 'transforms')
  const contacts = readFileSync(join(MIG, 'contacts.ts'), 'utf8')
  const leaderboard = readFileSync(join(MIG, 'leaderboard.ts'), 'utf8')

  it("type: 'external' → the lifecycle bucket, stamped from created_at", () => {
    assert.match(contacts, /hmdType === 'external'\)\s*\{[\s\S]*?out\.external = true[\s\S]*?out\.external_since = milestoneTs/)
  })

  it('never joined — an external gets a stage only for what they did, and no tag', () => {
    const branch = contacts.slice(contacts.indexOf("hmdType === 'external')"), contacts.indexOf('} else {', contacts.indexOf("hmdType === 'external')")))
    assert.doesNotMatch(branch, /'joined'/, 'joined is a claim about THIS club')
    assert.doesNotMatch(branch, /converted_at/)
    assert.match(branch, /if \(hasAttended\)[\s\S]*?'trial_attended'/)
    assert.doesNotMatch(contacts, /tags\.push\('external'\)|includes\('external'\)/, 'the tag is gone — the bucket is the record')
  })

  it('a stage-less external carries no "stage updated" stamp', () => {
    assert.match(contacts, /if \(out\.acquisition_stage\) out\.acquisition_stage_updated_at = milestoneTs/)
  })

  it("an archived contact's licence is coerced to expired, like a deleted one — and no live plan is claimed for either", () => {
    assert.match(contacts, /const isGone = out\.deleted_at != null \|\| out\.archived_at != null/)
    assert.match(contacts, /const statusId = isGone \? 'expired' : statusRaw/)
    assert.match(contacts, /if \(!isGone\) \{\s*out\.active_subscriptions = \[/)
    assert.doesNotMatch(contacts, /\bisDeleted\b/, 'the narrower test must not survive beside the wider one')
  })

  it('the imported licence carries that same liveness, so an ex-member leaves the federation queue with them', () => {
    assert.match(contacts, /contact_live: !isGone/)
  })

  it('the leaderboard entry says what the contact says: external scored ⇒ trial_attended, never joined', () => {
    assert.match(leaderboard, /type === 'trial' \|\| type === 'external' \? 'trial_attended' : 'joined'/)
  })
})
