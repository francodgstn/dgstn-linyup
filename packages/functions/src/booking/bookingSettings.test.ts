import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPastBookingCutoff } from '@linyup/shared'
import { bookingSettingsFrom } from './bookingSettings'

// ONE store for the booking settings, and the cutoff that lives in it.
//
// The regression this file exists to stop: the cutoff used to be read from a
// team-doc MIRROR (`teams/{id}.settings.booking`) that a manager-role member was
// not allowed to write, while the public booking page read the public_profile
// copy she COULD write. So the page hid the late slots and every booking
// callable happily took them — the one setting whose entire purpose is to say
// *no* silently said yes (UX-6). Both halves are pinned here: the reader, and
// the absence of any second reader.
//
// Pure — no Firestore. Run: pnpm --filter @linyup/functions test

const MIN = 60_000
const start = Date.UTC(2026, 5, 15, 18, 0, 0)
/** A stand-in for a Timestamp — toMillis() is all the cutoff predicate reads. */
const ts = (ms: number) => ({ toMillis: () => ms }) as never

/** The shape `snap.data()` returns for teams/{id}/public_profile/{id}. */
const publicProfile = (bookingSettings: unknown) => ({
  type: 'team',
  slug: 'demo',
  name: 'Demo Studio',
  bookingSettings,
})

describe('bookingSettingsFrom', () => {
  it('reads the settings off the team public_profile document', () => {
    const settings = bookingSettingsFrom(
      publicProfile({ flowType: 'activity-first', windowMonths: 2, cutoffMinutes: 60 })
    )
    assert.equal(settings.cutoffMinutes, 60)
    assert.equal(settings.windowMonths, 2)
  })

  it('a missing document, field or non-object value means "nothing configured"', () => {
    assert.deepEqual(bookingSettingsFrom(undefined), {})
    assert.deepEqual(bookingSettingsFrom({}), {})
    assert.deepEqual(bookingSettingsFrom(publicProfile(null)), {})
    assert.deepEqual(bookingSettingsFrom(publicProfile('60')), {})
    // An array is an object to `typeof`, and would hand every reader
    // `undefined` fields that read as "no cutoff" — refuse it explicitly.
    assert.deepEqual(bookingSettingsFrom(publicProfile([])), {})
  })

  it('does NOT fall back to the deleted team-doc mirror', () => {
    // The exact shape the mirror used to have, in the exact place a reader
    // would have found it. There is no fallback: the mirror is gone.
    assert.deepEqual(bookingSettingsFrom({ settings: { booking: { cutoffMinutes: 60 } } }), {})
  })
})

describe('the cutoff, read from the one store', () => {
  it('refuses a booking inside the cutoff', () => {
    const { cutoffMinutes } = bookingSettingsFrom(publicProfile({ cutoffMinutes: 60 }))
    // 30 minutes before an 18:00 class, with a 60-minute cutoff.
    assert.equal(isPastBookingCutoff(ts(start), cutoffMinutes, start - 30 * MIN), true)
  })

  it('allows a booking outside it', () => {
    const { cutoffMinutes } = bookingSettingsFrom(publicProfile({ cutoffMinutes: 60 }))
    assert.equal(isPastBookingCutoff(ts(start), cutoffMinutes, start - 90 * MIN), false)
  })

  it('an unconfigured studio has no cutoff (today’s behavior)', () => {
    const { cutoffMinutes } = bookingSettingsFrom(undefined)
    assert.equal(isPastBookingCutoff(ts(start), cutoffMinutes, start - 1), false)
  })

  it('a cutoff left ONLY on the old mirror stops nothing — which is the bug, made loud', () => {
    const { cutoffMinutes } = bookingSettingsFrom({ settings: { booking: { cutoffMinutes: 60 } } })
    assert.equal(cutoffMinutes, undefined)
    assert.equal(isPastBookingCutoff(ts(start), cutoffMinutes, start - 30 * MIN), false)
  })
})

// ── No second reader ────────────────────────────────────────────────────────
// A store is only single if nothing else reads the old one. This reads the
// SOURCE, and spans the functions/web boundary on purpose (the same reason
// commitSites.test.ts does): a repoint applied in one package does not travel to
// the other, and the web copy is what re-hydrates the form the studio trusts.

const SRC = join(__dirname, '..')
const ROOT = join(SRC, '..', '..', '..')

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** Comments stripped: the modules explain the deleted mirror BY NAME, and
 *  counting prose as a read is exactly the confusion to avoid. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** Every rail that decides whether a booking is inside the cutoff, plus the two
 *  admin surfaces that show the settings. Named, not counted. */
const READERS = [
  'packages/functions/src/booking/index.ts',
  'packages/functions/src/booking/dropIn.ts',
  'packages/functions/src/booking/waitlist/join.ts',
  'packages/functions/src/booking/waitlist/claim.ts',
  'packages/functions/src/booking/waitlist/promote.ts',
  'apps/web/src/app/[locale]/(auth)/settings/booking/page.tsx',
  'apps/web/src/app/[locale]/(auth)/offer/activities/page.tsx',
]

describe('nothing reads the team-doc mirror anymore', () => {
  for (const rel of READERS) {
    it(`${rel} reads the one store`, () => {
      const source = code(read(rel))
      // `settings.booking` in any shape: the dotted path, the bracket form, and
      // the `?.booking` step off a `settings` object that every old reader used.
      assert.equal(/settings\.booking\b/.test(source), false, 'dotted mirror path')
      assert.equal(/settings\??\.\s*\[?['"]booking['"]/.test(source), false, 'bracket mirror path')
      assert.equal(
        /settings[^\n]*\)\s*\?\.\s*booking\b/.test(source),
        false,
        'cast-then-step mirror read'
      )
    })
  }

  it('the functions rails go through the shared helper', () => {
    for (const rel of READERS.filter((r) => r.startsWith('packages/functions'))) {
      const source = code(read(rel))
      assert.ok(
        /loadBookingSettings\(|bookingSettingsFrom\(/.test(source),
        `${rel} must read via booking/bookingSettings.ts`
      )
    }
  })
})
