import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { bookingIsLiveForMember, memberCanCancel } from './myBookings'

// WHAT THE MEMBER PORTAL SAYS SHE HAS BOOKED.
//
// The defect these pin (UX-10): the Space listed the TEAM's upcoming public
// session mirrors with `type == 'session'` and probed each for her booking.
// Appointments are mirrored as `type == 'appointment_session'`, so no
// appointment could ever match — she held a paid 1:1 and the portal said "You
// have no upcoming bookings." Nothing failed; a filter simply excluded a whole
// kind, silently, on the one surface she would use to cancel.
//
// The replacement reads HER bookings server-side, so the two ways that shape
// comes back are (a) a predicate quietly dropping a row and (b) the ordering
// field being absent from a booking a writer produces — the query's index is
// SPARSE, so a booking without `joinedAt` is not in it and is invisible here.
// Both are asserted, and (b) is re-derived from the source rather than trusted
// to a comment.
//
// THE DERIVATION SPANS THE functions/web BOUNDARY, like
// `connect/commitSites.test.ts` and for the same reason: that boundary is where
// corrections stop traveling. Walking `packages/functions/src` alone declared
// this closed while the staff "Add contact" dialog on the session detail page —
// a direct client write, with no server seam to mount a guard on — created
// bookings with no `joinedAt` at all. They showed on the session roster (the
// one reader that does not sort) and on no other screen in the product.
//
// Pure — no Firestore. Run: pnpm --filter @linyup/functions test

const REPO_ROOT = join(__dirname, '../../../..')

/** Every place a booking document can be written from. */
const BOOKING_WRITER_ROOTS = [
  join(REPO_ROOT, 'packages/functions/src'),
  join(REPO_ROOT, 'apps/web/src'),
]

/** Every non-test .ts/.tsx file under the roots above. */
function sourceFiles(dirs: string[] = BOOKING_WRITER_ROOTS): string[] {
  const out: string[] = []
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...sourceFiles([full]))
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
    }
  }
  return out
}

const asPosix = (p: string) => relative(REPO_ROOT, p).split(sep).join('/')

describe('WHICH DOCUMENTS ARE BOOKINGS SHE HOLDS', () => {
  it('an ordinary booking is hers, with or without a status', () => {
    assert.equal(bookingIsLiveForMember({}), true)
    assert.equal(bookingIsLiveForMember({ status: 'pending' }), true)
    assert.equal(bookingIsLiveForMember({ status: 'confirmed' }), true)
    // Paid, gift-carded, credit-covered — all ordinary bookings by now.
    assert.equal(bookingIsLiveForMember({ status: 'confirmed', payment_status: 'paid' }), true)
    assert.equal(bookingIsLiveForMember({ status: 'confirmed', payment_status: 'gift_card' }), true)
  })

  it('a canceled or rebooked document is not a seat she holds HERE', () => {
    assert.equal(bookingIsLiveForMember({ status: 'cancelled' }), false)
    // 'rebooked' moved the seat to another session, which has its own document.
    assert.equal(bookingIsLiveForMember({ status: 'rebooked' }), false)
  })

  it('an unpaid hold is a checkout in flight, not a booking', () => {
    // Deliberately NOT `bookingHoldsSeat`, which is true here: that predicate
    // answers a capacity question, and a live hold really does occupy the seat.
    // It is still not something to tell her she has — the webhook either
    // confirms it (and the next load shows it) or it lapses.
    assert.equal(
      bookingIsLiveForMember({
        status: 'pending',
        payment_status: 'required',
        expires_at: { toMillis: () => Date.now() + 10 * 60_000 },
      }),
      false
    )
  })

  it('an unclaimed waitlist offer belongs to the waitlist surface, not this one', () => {
    assert.equal(bookingIsLiveForMember({ status: 'pending', waitlist_claim: true }), false)
    // …but a claim that was taken up is an ordinary booking and comes back.
    assert.equal(
      bookingIsLiveForMember({ status: 'confirmed', waitlist_claim: true, payment_status: 'paid' }),
      true
    )
  })

  it("a coach's private blocked time is never anybody's booking", () => {
    assert.equal(bookingIsLiveForMember({ status: 'confirmed', blocked_time: true }), false)
  })
})

describe('WHETHER THE CANCEL BUTTON IS A PROMISE', () => {
  const now = Date.UTC(2026, 7, 17, 12, 0, 0)
  const soon = now + 3 * 60 * 60_000
  const base = {
    hasToken: true,
    startMs: soon,
    nowMs: now,
    autoConfirm: true,
    sessionCancelled: false,
  }

  it('a pending booking on a future session cancels', () => {
    assert.equal(memberCanCancel({ ...base, bookingStatus: 'pending' }), true)
    // Absent status reads as pending everywhere, including in cancelBooking.
    assert.equal(memberCanCancel({ ...base }), true)
  })

  it("'confirmed' cancels on an auto-confirming session and NOT on one that checks people in", () => {
    // The exact re-key cancelBooking applies: where the studio confirms at the
    // door, 'confirmed' means checked in, and that stays locked.
    assert.equal(memberCanCancel({ ...base, bookingStatus: 'confirmed', autoConfirm: true }), true)
    assert.equal(memberCanCancel({ ...base, bookingStatus: 'confirmed', autoConfirm: false }), false)
  })

  it('a started session, a missing token and an already-canceled booking all refuse', () => {
    assert.equal(memberCanCancel({ ...base, startMs: now - 60_000 }), false)
    assert.equal(memberCanCancel({ ...base, hasToken: false }), false)
    assert.equal(memberCanCancel({ ...base, bookingStatus: 'cancelled' }), false)
  })

  it('a session the studio called off offers nothing to cancel', () => {
    assert.equal(memberCanCancel({ ...base, bookingStatus: 'pending', sessionCancelled: true }), false)
  })
})

describe('THE ORDERING FIELD IS ON EVERY BOOKING THAT GETS WRITTEN', () => {
  // `getMyBookings` orders her bookings by `joinedAt`, and the composite index
  // behind that query is sparse: a booking document written without the field
  // is not in the index and never reaches her list. That is the same silent
  // omission as the `type == 'session'` filter this replaced, so the writer set
  // is re-derived here instead of being remembered.
  //
  // `booking_token:` is the marker for a booking-document literal — it is
  // written by every rail that creates one and by nothing else.
  const writers = sourceFiles().filter((file) => readFileSync(file, 'utf8').includes('booking_token:'))

  it('finds the rails that write bookings at all', () => {
    // Named, not counted: a claim about "the seven writers" would rot the
    // moment somebody adds a rail. These have to be among them, and the
    // per-file assertion below covers whatever else the derivation turns up.
    // The last one is the client write — it is listed by name because it is the
    // one this derivation used to be blind to.
    const found = writers.map(asPosix)
    for (const expected of [
      'packages/functions/src/booking/index.ts',
      'packages/functions/src/booking/dropIn.ts',
      'packages/functions/src/appointments/window.ts',
      'apps/web/src/app/[locale]/(auth)/sessions/[id]/page.tsx',
    ]) {
      assert.ok(
        found.includes(expected),
        `${expected} writes bookings; the writer-set derivation missed it`
      )
    }
  })

  for (const file of writers) {
    it(`${asPosix(file)} stamps joinedAt`, () => {
      assert.match(
        readFileSync(file, 'utf8'),
        /joinedAt/,
        'a booking written without `joinedAt` is absent from the sparse index ' +
          "`getMyBookings` orders on, so it silently never appears in the member's own list"
      )
    })
  }
})

describe('THE CALLER IS THE SESSION, AND THE TEAM IS CHECKED AGAINST IT', () => {
  const src = readFileSync(join(__dirname, 'myBookings.ts'), 'utf8')

  it('identity comes from requireContactSessionForTeam, never from the body', () => {
    assert.match(src, /requireContactSessionForTeam\(request, teamId\)/)
    assert.equal(
      /data\.contactId|request\.data.*contactId/.test(src),
      false,
      'a contactId in the request body would make this an enumerator for every ' +
        "contact of the team — the body may name the SURFACE's team and nothing else"
    )
  })

  it('the query is scoped to her, and ordered by the field the index carries', () => {
    assert.match(src, /\.where\('teamId', '==', teamId\)/)
    assert.match(src, /\.where\('contact', '==', contactId\)/)
    assert.match(src, /\.orderBy\('joinedAt', 'desc'\)/)
  })
})
