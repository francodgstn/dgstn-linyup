// Tests for the shared alert resolver. It lives in `packages/shared`, which has
// no test runner — same reason `contactFilter.test.ts` and `paymentOptions.test.ts`
// sit here.
//
// The cases below are the three predicates this file replaced, and the bugs each
// of them had. Every one of them was reachable in the shipped product.

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  alertSchedule,
  readAlert,
  alertIsFired,
  alertIsActive,
  type RawContactAlert,
} from '@linyup/shared'

/** A Firestore Timestamp, near enough for a pure resolver. */
function ts(d: Date) {
  return {
    toDate: () => d,
    toMillis: () => d.getTime(),
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
  }
}

const NOW = new Date('2026-08-29T12:00:00Z')
const YESTERDAY = new Date('2026-08-28T12:00:00Z')
const NEXT_YEAR = new Date('2027-08-29T12:00:00Z')
const TEN_DAYS_AGO = new Date('2026-08-19T12:00:00Z')

describe('contact alerts — the two document shapes', () => {
  it('reads the FLAT shape the studio UI and the migration write', () => {
    const raw: RawContactAlert = { schedule_type: 'datetime', schedule_value: ts(YESTERDAY) }
    assert.equal(alertSchedule(raw).type, 'datetime')
    assert.equal(alertSchedule(raw).at?.getTime(), YESTERDAY.getTime())
  })

  it('reads the NESTED shape bookSession and the automation engine write', () => {
    const raw: RawContactAlert = { schedule: { type: 'datetime', value: ts(YESTERDAY) } }
    assert.equal(alertSchedule(raw).type, 'datetime')
    assert.equal(alertSchedule(raw).at?.getTime(), YESTERDAY.getTime())
  })

  it('THE MOBILE BUG: a studio-authored alert is no longer unreadable', () => {
    // Mobile read `schedule.value` only, with a `|| 'datetime'` type fallback.
    // A flat alert therefore became datetime/undefined -> Invalid Date -> every
    // comparison false -> it never appeared, whatever show_in_app said.
    const studioAuthored: RawContactAlert = {
      schedule_type: 'sessions_countdown',
      schedule_value: 10,
      show_in_app: true,
    }
    const schedule = alertSchedule(studioAuthored)
    assert.equal(schedule.type, 'sessions_countdown')
    assert.equal(schedule.sessions, 10)
    assert.equal(alertIsFired(studioAuthored, { totalSessions: 10, now: NOW }), true)
  })

  it('normalizes either shape to the same canonical alert', () => {
    const flat = readAlert('a', { schedule_type: 'always', message: 'hi', show_in_app: true })
    const nested = readAlert('a', { schedule: { type: 'always' }, message: 'hi', show_in_app: true })
    assert.equal(flat.schedule_type, nested.schedule_type)
    assert.equal(flat.message, nested.message)
    assert.equal(flat.show_in_app, nested.show_in_app)
  })
})

describe('contact alerts — alertIsFired', () => {
  it('`always` fires on creation and stays fired', () => {
    const raw: RawContactAlert = { schedule_type: 'always' }
    assert.equal(alertIsFired(raw, { now: NOW }), true)
    assert.equal(alertIsFired(raw, { now: NEXT_YEAR }), true)
    assert.equal(alertIsFired(raw, { totalSessions: 0, now: NOW }), true)
  })

  it('`datetime` fires once the instant has passed, and STAYS fired', () => {
    const past: RawContactAlert = { schedule_type: 'datetime', schedule_value: ts(YESTERDAY) }
    const future: RawContactAlert = { schedule_type: 'datetime', schedule_value: ts(NEXT_YEAR) }
    assert.equal(alertIsFired(past, { now: NOW }), true)
    assert.equal(alertIsFired(future, { now: NOW }), false)
  })

  it('drops the mobile ±7-day window in BOTH directions', () => {
    // It hid an alert a week after it fired and showed one a week early.
    const old: RawContactAlert = { schedule_type: 'datetime', schedule_value: ts(TEN_DAYS_AGO) }
    assert.equal(alertIsFired(old, { now: NOW }), true, 'a fired alert does not expire on its own')

    const soon = new Date('2026-09-02T12:00:00Z') // 4 days out — inside the old window
    const upcoming: RawContactAlert = { schedule_type: 'datetime', schedule_value: ts(soon) }
    assert.equal(alertIsFired(upcoming, { now: NOW }), false, 'not fired until it fires')
  })

  it('`sessions_countdown` counts TOTAL sessions, not sessions remaining', () => {
    // Mobile read the same number as "remaining" (`value <= 1`) and never looked
    // at total_sessions, so an alert set for the 10th session was simply never
    // shown, while one set for session 1 was shown to everyone immediately.
    const raw: RawContactAlert = { schedule_type: 'sessions_countdown', schedule_value: 10 }
    assert.equal(alertIsFired(raw, { totalSessions: 9, now: NOW }), false)
    assert.equal(alertIsFired(raw, { totalSessions: 10, now: NOW }), true)
    assert.equal(alertIsFired(raw, { totalSessions: 11, now: NOW }), true)

    const one: RawContactAlert = { schedule_type: 'sessions_countdown', schedule_value: 1 }
    assert.equal(alertIsFired(one, { totalSessions: 0, now: NOW }), false)
  })

  it('an absent total_sessions counts as zero', () => {
    const raw: RawContactAlert = { schedule_type: 'sessions_countdown', schedule_value: 1 }
    assert.equal(alertIsFired(raw, { now: NOW }), false)
  })

  it('a malformed alert cannot fire, rather than firing by accident', () => {
    assert.equal(alertIsFired({ schedule_type: 'datetime' }, { now: NOW }), false)
    assert.equal(alertIsFired({ schedule_type: 'sessions_countdown' }, { totalSessions: 99 }), false)
    assert.equal(alertIsFired({ schedule_type: 'nonsense' }, { totalSessions: 99 }), false)
    assert.equal(alertIsFired({}, { totalSessions: 99 }), false)
  })
})

describe('contact alerts — alertIsActive', () => {
  it('an archived alert is dismissed, however fired it is', () => {
    const raw: RawContactAlert = { schedule_type: 'always', archived_at: ts(YESTERDAY) }
    assert.equal(alertIsFired(raw, { now: NOW }), true)
    assert.equal(alertIsActive(raw, { now: NOW }), false)
  })

  it('archiving is the ONLY end an `always` alert has', () => {
    const live: RawContactAlert = { schedule_type: 'always', archived_at: null }
    assert.equal(alertIsActive(live, { now: NEXT_YEAR }), true)
  })
})

// ─── The mobile mirror ───────────────────────────────────────────────────────
//
// `apps/mobile` cannot import `@linyup/shared` (no dependency, no Metro
// resolution for it), so the resolver is hand-copied into
// `apps/mobile/src/utils/contactAlerts.ts` — the same concession
// `goalContract.ts` and `waiverRefusal.ts` already make.
//
// A hand copy is EXACTLY how this bug happened the first time: mobile's
// predicate was a copy that drifted, and nothing noticed. So the copy is
// pinned. The mirror is gone since 2026-09 (the app depends on @linyup/shared
// and re-exports the resolver); the block below now pins that it STAYS gone.

const ROOT = join(__dirname, '..', '..', '..', '..')
const MOBILE_RESOLVER = join(ROOT, 'apps', 'mobile', 'src', 'utils', 'contactAlerts.ts')

/** One exported function, comments and formatting removed. */
function fnBody(src: string, name: string): string | null {
  const start = src.indexOf(`export function ${name}(`)
  if (start < 0) return null
  let end = src.indexOf('\nexport ', start + 1)
  if (end < 0) end = src.length
  return src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '')
    .replace(/;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('the mobile app cannot drift from the shared resolver', () => {
  // Until 2026-09 apps/mobile carried a hand-mirrored COPY of the resolver and
  // this block pinned the copy byte-for-byte to the original. The copy is gone:
  // the app depends on @linyup/shared and re-exports the three predicates that
  // decide whether an alert FIRES. So the invariant is no longer "the copies
  // match" but "there is no copy" — a local implementation of any of the
  // three would be the drift re-appearing, and this is what fails it.
  const mobile = readFileSync(MOBILE_RESOLVER, 'utf8')

  it('re-exports the fire predicates from @linyup/shared', () => {
    assert.match(
      mobile,
      /export\s*\{[^}]*\balertSchedule\b[^}]*\}\s*from\s*'@linyup\/shared'/,
      'alertSchedule must be re-exported from @linyup/shared, not reimplemented'
    )
    for (const name of ['alertIsFired', 'alertIsActive']) {
      assert.match(
        mobile,
        new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'@linyup\\/shared'`),
        `${name} must be re-exported from @linyup/shared, not reimplemented`
      )
    }
  })

  it('defines no local implementation of them', () => {
    for (const name of ['alertSchedule', 'alertIsFired', 'alertIsActive']) {
      assert.equal(fnBody(mobile, name), null, `${name} is implemented locally in apps/mobile — that is the drift coming back`)
    }
  })

  // `readAlert` is the one deliberate local wrapper: it adds `alert_type`,
  // which AlertsCard reads for its icon, on top of the shared reader — so the
  // two-document-shape logic still lives in exactly one place.
  it('readAlert wraps the shared reader rather than re-parsing the document', () => {
    assert.match(mobile, /sharedReadAlert\(id,\s*raw\)/)
    assert.doesNotMatch(mobile, /schedule_type\s*\?\?\s*raw\.schedule\?\.type/)
  })
})
