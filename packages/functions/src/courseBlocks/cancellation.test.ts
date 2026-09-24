import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCourseCancellationEmail, refundableRows, type PaymentRowLike } from './cancel'

// CANCELLING A WHOLE COURSE.
//
// Two things are pinned here, and they fail in opposite directions.
//
// The REFUND LIST is money the studio is about to hand back by hand, so every
// rule in it costs somebody real money when it is wrong: offering a voided row
// invents a payment, offering the full amount on a partly-refunded one hands
// back more than was taken, and listing a row the refund callable will turn
// down sends the studio round a loop it cannot finish.
//
// The ORDERING inside the cancellation is pinned STRUCTURALLY, against the
// source, because its defect has no failing state a behaviour test could
// sample: `notify: false` reaching only one of the two teardown paths means the
// members are mailed a hundred and seventeen times instead of once, and only on
// courses long enough to take the background path. That is a shape, not a
// timing, so it is asserted as a shape.
//
// Run with: pnpm --filter @linyup/functions test

const row = (id: string, fields: Record<string, unknown>): PaymentRowLike => ({
  id,
  get: (f: string) => fields[f],
})

describe('the refund list a cancelled course hands the studio', () => {
  it('offers a succeeded payment, in minor units, with whoever paid it', () => {
    const rows = refundableRows([
      row('pi_1', {
        status: 'succeeded',
        amount: 36400,
        currency: 'chf',
        contactId: 'contact-a',
        email: 'a@example.com',
      }),
    ])
    assert.deepEqual(rows, [
      {
        contactId: 'contact-a',
        email: 'a@example.com',
        paymentId: 'pi_1',
        refundableAmount: 36400,
        currency: 'chf',
      },
    ])
  })

  it('never offers a voided row: a void says the money never arrived', () => {
    const rows = refundableRows([
      row('pi_void', { status: 'succeeded', amount: 36400, voided_at: { seconds: 1 } }),
    ])
    assert.deepEqual(rows, [])
  })

  it('offers only the REMAINDER of a partly-refunded payment', () => {
    // Handing back the gross a second time is the expensive direction, and the
    // refund callable would refuse it, so the studio would only find out at the
    // last click.
    const rows = refundableRows([
      row('pi_part', {
        status: 'partially_refunded',
        amount: 36400,
        amount_refunded: 10000,
        currency: 'chf',
      }),
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].refundableAmount, 26400)
  })

  it('drops a fully-refunded payment rather than offering nothing to refund', () => {
    const rows = refundableRows([
      row('pi_done', { status: 'partially_refunded', amount: 36400, amount_refunded: 36400 }),
    ])
    assert.deepEqual(rows, [])
  })

  it('drops a status the refund rail would turn down', () => {
    // `refundMemberPayment` acts on 'succeeded' and 'partially_refunded' only.
    const rows = refundableRows([
      row('pi_pending', { status: 'requires_payment_method', amount: 36400 }),
      row('pi_failed', { status: 'failed', amount: 36400 }),
      row('pi_none', { amount: 36400 }),
    ])
    assert.deepEqual(rows, [])
  })

  it('reads BOTH spellings of the contact link, and keeps an unassigned row', () => {
    // The Connect webhook writes `contactId`; the manual rail's older rows carry
    // `contact_id`. A row with neither is still money that was taken.
    const rows = refundableRows([
      row('pi_new', { status: 'succeeded', amount: 100, contactId: 'c1' }),
      row('pi_old', { status: 'succeeded', amount: 100, contact_id: 'c2' }),
      row('pi_anon', { status: 'succeeded', amount: 100 }),
    ])
    assert.deepEqual(
      rows.map((r) => r.contactId),
      ['c1', 'c2', null]
    )
  })
})

describe('the one mail a cancelled course sends', () => {
  it('names the course, not the lesson, and says who cancelled it', () => {
    const mail = buildCourseCancellationEmail({
      firstname: 'Lena',
      teamName: 'Swimatic',
      courseName: 'Level 2 Seepferd',
      paid: false,
    })
    assert.ok(mail.subject.includes('Level 2 Seepferd'))
    assert.ok(mail.html.includes('Swimatic'))
    assert.ok(mail.text.includes('Lena'))
  })

  it('tells a payer the studio will be in touch, and PROMISES NO REFUND', () => {
    // Whether money comes back, and in what shape, is the studio's policy. A
    // mail that commits them to a refund is a commitment this code cannot make,
    // and a member holding that mail is entitled to hold them to it.
    const paid = buildCourseCancellationEmail({
      firstname: 'Lena',
      teamName: 'Swimatic',
      courseName: 'Level 2 Seepferd',
      paid: true,
    })
    assert.ok(paid.text.includes('in touch'))
    for (const promise of ['refund', 'Refund', 'refunded', 'money back']) {
      assert.ok(!paid.html.includes(promise), `the mail must not promise "${promise}"`)
      assert.ok(!paid.text.includes(promise), `the mail must not promise "${promise}"`)
    }
  })

  it('says nothing about money to somebody who paid nothing', () => {
    const free = buildCourseCancellationEmail({
      firstname: 'Lena',
      teamName: 'Swimatic',
      courseName: 'Taster week',
      paid: false,
    })
    assert.ok(!free.text.includes('in touch'))
  })
})

describe('the ordering, asserted against the source', () => {
  // CRLF-normalised: a Windows checkout stores these files with \r\n, and a bare
  // newline anchor would pass in CI and fail on a laptop.
  const read = (rel: string) =>
    readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')
  const cancel = read('courseBlocks/cancel.ts')
  const teardown = read('sessions/teardown.ts')

  it('suppresses the per-lesson mail on BOTH teardown paths', () => {
    // The inline path passes it positionally, the background path stores it on
    // the job. Matched on ANY receiver rather than one spelling: a pin that
    // required `params.notify` would pass against the very edit it exists to
    // catch.
    assert.match(cancel, /notify:\s*false/, 'the background job must be minted with notify: false')
    // The inline call, whatever it is spread across: `doc.data()` puts a `)`
    // inside the argument list, so the anchor is the closing triple rather than
    // "everything up to the first bracket".
    const INLINE_CALL = /cancelSingleSession\([\s\S]*?false,\s*false,\s*false\s*\)/
    assert.match(
      cancel,
      INLINE_CALL,
      'the inline path must pass markAsException, preMarked and notify as false'
    )
    // And the pin can fail: the seven-argument call, which is what this looked
    // like before the suppression existed, is NOT matched.
    assert.ok(
      !INLINE_CALL.test(
        'await cancelSingleSession(db, doc.id, doc.ref, doc.data(), teamData, false, false)'
      ),
      'the pin must reject a call that omits the notify argument'
    )
  })

  it('shuts the door BEFORE it touches a single lesson', () => {
    // Order is the whole design: a place sold into a course whose lessons are
    // being deleted is the one outcome nothing downstream repairs.
    const doorIdx = cancel.indexOf("status: 'cancelled'")
    const teardownIdx = cancel.indexOf('countTeardownScope')
    assert.ok(doorIdx > 0 && teardownIdx > 0)
    assert.ok(doorIdx < teardownIdx, 'the status flip must precede the teardown')
  })

  it('keeps the counter write above the suppression, and the mail below it', () => {
    // The suppression is allowed to remove NEWS, never FACTS. Every
    // `pending_bookings_count` decrement, the waitlist close and the deletes all
    // still happen when a course is cancelled; only the message is somebody
    // else's to send. Pinned by position, since a suppression that drifted above
    // the counter loop would silently strand every member's counter.
    const counterIdx = teardown.indexOf('pending_bookings_count: FieldValue.increment(-1)')
    const suppressIdx = teardown.indexOf('notify ? bookings : []')
    const mailIdx = teardown.indexOf('buildCancellationEmail({')
    assert.ok(counterIdx > 0 && suppressIdx > 0 && mailIdx > 0)
    assert.ok(counterIdx < suppressIdx, 'the counter must be settled before the mail is suppressed')
    assert.ok(suppressIdx < mailIdx, 'the suppression must sit above every mail')
  })

  it('takes the PAID exception with it, so a course buyer is not mailed twice', () => {
    // A course's buyers are precisely the paid seats, and `cancelSingleSession`
    // mails those whatever the studio's toggle says. Emptying the list rather
    // than skipping past the block is what disarms that exception; gating only
    // `cancellationEmailsEnabled` would have left every payer mailed per lesson.
    assert.match(teardown, /let bookingsToNotify = notify \? bookings : \[\]/)
    assert.match(teardown, /notify && \(bookingsToNotify\.length > 0 \|\| offerHolders\.length > 0\)/)
  })
})
