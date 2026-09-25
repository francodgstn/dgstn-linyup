import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildParticipantDoc, bookingContactId } from '@linyup/shared'

// THE ATTENDANCE ROW HAS ONE SHAPE AND ITS COUNTER HAS ONE WRITER.
//
// UX-18 found four surfaces confirming a booking and writing four different
// documents for it: different id, different `fullname` order, two of them
// without `checkedInAt` or `checkedInBy` at all, one without `confirmed_at`,
// one skipping `conversions_count`, one leaving the contact's
// `pending_bookings_count` standing. `participants_count` had three blind
// client increments and no server writer; `total_sessions` had a server writer
// that read a field nothing writes.
//
// Numbers in prose rot, so the census is re-derived from the SOURCE here rather
// than restated. This file spans the functions/web boundary on purpose, exactly
// as `connect/commitSites.test.ts` and `waivers/surfaces.test.ts` do — that
// boundary is where corrections stop traveling, and every one of the
// divergences above lived on the web side of it.
//
// Run with: pnpm --filter @linyup/functions test

const WEB = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'src')
const FN = join(__dirname, '..')

function read(base: string, rel: string): string {
  const p = join(base, rel)
  assert.ok(existsSync(p), `expected ${rel} to exist`)
  return readFileSync(p, 'utf8')
}

/** Strip comments and string literals so a grep cannot match prose. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

// Every file that WRITES a `sessions/{id}/participants/{contactId}` document.
// Re-derive with:
//   grep -rln "PARTICIPANTS_SUBCOLLECTION\|collection('participants')" \
//     apps/web/src packages/functions/src
// and keep only the sites that SET rather than read.
const PARTICIPANT_WRITERS: Array<{ base: string; rel: string; what: string }> = [
  {
    base: WEB,
    // Was `bookings/page.tsx`; the confirm/cancel/no-show actions were extracted
    // into this hook so the bookings LIST and the contact detail's Bookings tab
    // share one implementation. The writer moved — it did not multiply.
    rel: 'hooks/useBookingActions.ts',
    what: 'the shared booking actions (bookings list + contact bookings tab)',
  },
  {
    base: WEB,
    rel: 'app/[locale]/(auth)/sessions/[id]/page.tsx',
    what: 'the session detail confirm AND the manual add',
  },
  { base: FN, rel: 'sessions/index.ts', what: 'selfCheckIn (kiosk QR)' },
  { base: FN, rel: 'contacts/index.ts', what: 'checkInContact (coach scans a member)' },
]

describe('THE ATTENDANCE ROW — one builder, four writers', () => {
  it('every writer builds the row through buildParticipantDoc', () => {
    for (const { base, rel, what } of PARTICIPANT_WRITERS) {
      const src = code(read(base, rel))
      assert.ok(
        src.includes('buildParticipantDoc('),
        `${what} (${rel}) must build its participant row through the shared builder`
      )
    }
  })

  it('nobody hand-rolls the row beside the builder', () => {
    // `checkedInBy` is the field a hand-rolled row cannot omit and still be a
    // roster entry, so it is the cheapest tell. Every occurrence outside the
    // builder's own argument object is a second shape.
    for (const { base, rel, what } of PARTICIPANT_WRITERS) {
      const src = code(read(base, rel))
      const total = src.split('checkedInBy:').length - 1
      const viaBuilder = src.split(/buildParticipantDoc\(\{[\s\S]*?\}\)/g).length - 1
      assert.ok(
        total <= viaBuilder,
        `${what} (${rel}) writes checkedInBy ${total}× but calls the builder ${viaBuilder}× — a row is being hand-rolled`
      )
    }
  })

  it('the builder puts the contact id in the row, both spellings, and sorts by lastname', () => {
    const row = buildParticipantDoc({
      contactId: 'c1',
      sessionId: 's1',
      who: { firstname: 'Ada', lastname: 'Lovelace' },
      checkedInBy: 'booking-confirm',
      checkedInAt: 'NOW',
      fromBooking: true,
    })
    assert.equal(row.contact, 'c1')
    // The seed scripts have always written `contactId`; carrying both means a
    // reader of either spelling resolves, which is what the trigger's dead read
    // needed and never had.
    assert.equal(row.contactId, 'c1')
    assert.equal(row.fullname, 'Lovelace Ada')
    assert.equal(row.checkedInAt, 'NOW')
    assert.equal(row.confirmedFromBooking, true)
  })

  it('a row with no name is still a row — never the string "undefined"', () => {
    const row = buildParticipantDoc({
      contactId: 'c1',
      sessionId: 's1',
      who: {},
      checkedInBy: 'manual',
      checkedInAt: 0,
    })
    assert.equal(row.fullname, '')
    assert.equal(row.firstname, '')
    assert.equal(row.avatar_url, null)
    // Absent unless it really came from a booking — the roster shows a caption
    // off this field.
    assert.equal('confirmedFromBooking' in row, false)
  })

  it('the attendance row lands on the CONTACT id, never the booking id', () => {
    assert.equal(bookingContactId({ id: 'bk1', contact: 'c9' }), 'c9')
    // Server-created bookings are keyed BY the contact id, so the fallback is
    // the same value — but the fallback is what a hand-made booking relies on.
    assert.equal(bookingContactId({ id: 'c9' }), 'c9')
  })
})

describe('participants_count — ONE writer', () => {
  const trigger = code(read(FN, 'analytics/index.ts'))

  it('is written by trackSessionParticipants, as an ABSOLUTE recount', () => {
    assert.match(
      trigger,
      /participants_count: partsSnap\.size/,
      'the trigger must write the counted size, not a delta'
    )
  })

  it('is never incremented, anywhere, by anyone', () => {
    // The blind increments lived on the web side: add, confirm and remove each
    // wrote their own delta, so a double-clicked remove drove the number
    // negative and a QR check-in — which never incremented at all — left a full
    // class reading zero attendance.
    const suspects = [
      { base: WEB, rel: 'app/[locale]/(auth)/sessions/[id]/page.tsx' },
      { base: WEB, rel: 'app/[locale]/(auth)/bookings/page.tsx' },
      { base: WEB, rel: 'hooks/useBookingActions.ts' },
      { base: FN, rel: 'sessions/index.ts' },
      { base: FN, rel: 'contacts/index.ts' },
      { base: FN, rel: 'analytics/index.ts' },
    ]
    for (const { base, rel } of suspects) {
      const src = code(read(base, rel))
      assert.doesNotMatch(
        src,
        /participants_count:\s*(FieldValue\.)?increment\(/,
        `${rel} increments participants_count — the trigger owns that number absolutely`
      )
    }
  })

  it('resolves the contact from the DOCUMENT ID, which is the invariant every reader uses', () => {
    // This read was `participantData.contactId`, and nothing in the product has
    // ever written that field — only the seed scripts. The trigger therefore
    // worked in a seeded emulator and returned on line one in production,
    // taking `total_sessions`, `last_session_at`, the trial_attended promotion
    // and provisional materialization down with it.
    assert.match(
      trigger,
      /const contactId =\s*\n?\s*participantId \|\|/,
      'the participant document id is the contact id — resolve it first'
    )
  })

  it('total_sessions still has exactly one writer, and it is this trigger', () => {
    // The fix above turned a dead writer live. It must not have acquired a
    // sibling in the process.
    const writers = [
      'analytics/index.ts',
      'sessions/index.ts',
      'contacts/index.ts',
      'booking/index.ts',
    ].filter((rel) => /total_sessions:\s*(FieldValue\.)?increment\(/.test(code(read(FN, rel))))
    assert.deepEqual(writers, ['analytics/index.ts'])
  })

  it('last_session_at only moves forward — decided inside a transaction', () => {
    // It was written as whichever row's trigger ran last. An import delivers
    // years of rows in any order, and contacts who trained last week came out
    // "Stopped" with a last session years old. The rule itself is unit-tested
    // in lastSession.test.ts; this pins that the trigger asks it, in a tx.
    assert.match(trigger, /runTransaction\(/, 'the contact update must run in a transaction')
    assert.match(trigger, /advancesLastSession\(/, 'last_session_at must go through advancesLastSession')
    assert.doesNotMatch(
      trigger,
      /counterUpdate\.last_session_at\s*=\s*sessionStart/,
      'an unconditional last_session_at write is back — the last trigger to run would decide it again'
    )
  })
})

describe('CONFIRMING A BOOKING — the same fields, whichever page you are on', () => {
  // The four confirm surfaces. Two are callables, two are client writes; that
  // split is fine, writing different documents is not.
  const CONFIRM_SURFACES: Array<{ base: string; rel: string; what: string }> = [
    // The bookings list and the contact detail's Bookings tab both confirm
    // through this ONE hook — that is why there is no third entry for the tab.
    { base: WEB, rel: 'hooks/useBookingActions.ts', what: 'the shared booking actions' },
    { base: WEB, rel: 'app/[locale]/(auth)/sessions/[id]/page.tsx', what: 'session detail' },
    { base: FN, rel: 'sessions/index.ts', what: 'selfCheckIn' },
    { base: FN, rel: 'contacts/index.ts', what: 'checkInContact' },
  ]

  for (const { base, rel, what } of CONFIRM_SURFACES) {
    it(`${what} stamps confirmed_at, the conversion and the contact's pending count`, () => {
      const src = code(read(base, rel))
      assert.match(src, /confirmed_at:/, `${what} must record WHEN it confirmed`)
      assert.match(
        src,
        /conversions_count:\s*(FieldValue\.)?increment\(1\)/,
        `${what} must count the conversion`
      )
      assert.match(
        src,
        /pending_bookings_count:\s*(FieldValue\.)?increment\(-1\)/,
        `${what} must clear the contact's pending booking`
      )
      assert.match(
        src,
        /confirmClearedHoldFields\(/,
        `${what} must settle the hold markers the same way as the others`
      )
    })
  }
})

describe('ADDING A KNOWN PERSON TO A CLASS TAKES A SEAT', () => {
  // There is no staff class-booking callable — `createStaffAppointment` has no
  // class twin — so the session detail dialog is the ONLY admin door into a
  // class for someone who already exists. It used to write the attendance row
  // alone, and a booking is what occupies a seat: `bookingHoldsSeat` counts
  // bookings, `trackBookings` recounts `bookings_count` from them, and every
  // capacity gate reads that number. Six manual adds left a six-seat class
  // advertising six free seats.
  const src = code(read(WEB, 'app/[locale]/(auth)/sessions/[id]/page.tsx'))

  it('the manual add writes a booking as well as the attendance row', () => {
    assert.match(src, /status: ''[\s\S]{0,400}?buildParticipantDoc\(/)
  })

  it('and it does not write bookings_count itself — trackBookings owns it', () => {
    // `pending_bookings_count` is a different number, on the contact, and IS
    // written here — hence the lookbehind rather than a bare substring.
    assert.doesNotMatch(src, /(?<!pending_)bookings_count:/)
  })
})
