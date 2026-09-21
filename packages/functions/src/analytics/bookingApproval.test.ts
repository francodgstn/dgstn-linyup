import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bookingCallsForApproval } from './bookingApproval'

describe('bookingCallsForApproval', () => {
  it('says YES to a booking with no status at all', () => {
    // The case the whole module exists for: `bookSession` omits `status`
    // entirely on a class that does not auto-confirm, so this is what almost
    // every seat awaiting approval actually looks like on disk.
    assert.equal(bookingCallsForApproval({ teamId: 't', contact: 'c' }), true)
  })

  it('says yes to an explicit pending, no to a confirmed one', () => {
    assert.equal(bookingCallsForApproval({ status: 'pending' }), true)
    assert.equal(bookingCallsForApproval({ status: 'confirmed' }), false)
  })

  it('says no to every status that is not waiting on anybody', () => {
    for (const status of ['confirmed', 'cancelled', 'no_show', 'rebooked']) {
      assert.equal(bookingCallsForApproval({ status }), false, status)
    }
  })

  it('says no to a waitlist claim, whose claim window decides it', () => {
    // It carries no status either — an ordinary-looking booking, which is
    // exactly why it has to be excluded by name rather than by status.
    assert.equal(bookingCallsForApproval({ waitlist_claim: true }), false)
  })

  it('says no to a seat the studio entered itself', () => {
    assert.equal(bookingCallsForApproval({ source: 'staff' }), false)
    // …and yes to the two sources that come from outside.
    assert.equal(bookingCallsForApproval({ source: 'online' }), true)
    assert.equal(bookingCallsForApproval({ source: 'kiosk' }), true)
  })
})

describe('the booking notification is wired to the predicate', () => {
  // A SOURCE-READING PIN, and the thing it guards is a regression that would be
  // invisible: `trackBookings` notifying on every created booking rather than
  // on the ones needing approval floods the studio's inbox, and nothing about a
  // full inbox fails a test. Asserting the CAUSE — that the write sits behind
  // this predicate — rather than sampling the symptom.
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

  it("guards the notification with the predicate, not with the event alone", () => {
    assert.match(
      source,
      /activityEvent === 'booking_created' && bookingCallsForApproval\(bookingData\)/,
      'trackBookings must gate the booking_pending notification on bookingCallsForApproval'
    )
  })

  it('writes it through the one notification writer', () => {
    assert.match(source, /createTeamNotification\(teamId, \{[\s\S]*?type: 'booking_pending'/)
  })
})
