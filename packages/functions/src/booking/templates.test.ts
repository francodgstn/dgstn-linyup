import assert from 'node:assert/strict'
import {
  buildBookingConfirmationEmail,
  buildClassBookingConfirmationMail,
  instructionsBox,
} from './templates'

describe('instructionsBox', () => {
  it('escapes studio-authored HTML', () => {
    const html = instructionsBox('<script>alert(1)</script>', 'en')
    assert.ok(!html.includes('<script>'))
    assert.ok(html.includes('&lt;script&gt;'))
  })

  it('turns bare URLs into links', () => {
    const html = instructionsBox('Sign here: https://www.signwell.com/new_doc/abc/', 'en')
    assert.ok(html.includes('<a href="https://www.signwell.com/new_doc/abc/"'))
  })

  it('converts newlines to <br>', () => {
    const html = instructionsBox('line one\nline two', 'en')
    assert.ok(html.includes('line one<br>line two'))
  })

  it('uses the localized heading', () => {
    assert.ok(instructionsBox('x', 'de').includes('Wichtig'))
    assert.ok(instructionsBox('x', 'it').includes('Importante'))
  })
})

describe('buildBookingConfirmationEmail', () => {
  const base = {
    firstname: 'Priya',
    teamName: 'SWIMLI',
    activityName: 'Beginners Squad',
    sessionStart: new Date('2026-07-15T17:30:00Z'),
    sessionEnd: new Date('2026-07-15T18:15:00Z'),
    locationName: 'Schwamendingen Pool',
  }

  it('renders the instructions block when provided', () => {
    const { html, text } = buildBookingConfirmationEmail({
      ...base,
      instructions: 'IMPORTANT!\nPlease sign the Service Agreement: https://example.com/doc',
    })
    assert.ok(html.includes('Important'))
    assert.ok(html.includes('IMPORTANT!'))
    assert.ok(html.includes('<a href="https://example.com/doc"'))
    assert.ok(text.includes('IMPORTANT!'))
  })

  it('omits the block when instructions are absent or blank', () => {
    const without = buildBookingConfirmationEmail(base).html
    const blank = buildBookingConfirmationEmail({ ...base, instructions: '   ' }).html
    // The "Important" heading only appears when a non-blank note is set.
    assert.ok(!without.includes('>Important<'))
    assert.ok(!blank.includes('>Important<'))
  })

  it('names the amount only when the booking was paid for', () => {
    assert.ok(!buildBookingConfirmationEmail(base).html.includes('Paid:'))
    const paid = buildBookingConfirmationEmail({
      ...base,
      paid: { amount: 25, currency: 'chf' },
    }).html
    assert.ok(paid.includes('<strong>Paid:</strong> CHF 25.00'))
  })

  it('invites the booker into the Space when a link is given', () => {
    assert.ok(!buildBookingConfirmationEmail(base).html.includes('member area'))
    const html = buildBookingConfirmationEmail({
      ...base,
      spaceUrl: 'https://linyup.com/public/swimli/space',
    }).html
    assert.ok(html.includes('href="https://linyup.com/public/swimli/space"'))
  })

  it('only claims an attached invite when one is attached', () => {
    assert.ok(!buildBookingConfirmationEmail(base).html.includes('.ics'))
    assert.ok(
      buildBookingConfirmationEmail({ ...base, calendarAttached: true }).html.includes('.ics')
    )
  })
})

describe('buildClassBookingConfirmationMail', () => {
  const base = {
    firstname: 'Priya',
    lastname: 'Menon',
    teamName: 'SWIMLI',
    activityName: 'Beginners Squad',
    sessionStart: new Date('2026-07-15T17:30:00Z'),
    sessionEnd: new Date('2026-07-15T18:15:00Z'),
    locationName: 'Schwamendingen Pool',
    bookingId: 'sess1-contact1',
    attendeeName: 'Priya Menon',
    attendeeEmail: 'priya@example.com',
  }

  it('attaches a calendar invite — the class rail had none on either path', () => {
    const mail = buildClassBookingConfirmationMail(base)
    assert.equal(mail.attachments.length, 1)
    assert.equal(mail.attachments[0].filename, 'booking.ics')
    assert.match(mail.attachments[0].contentType, /^text\/calendar/)
    const ics = mail.attachments[0].content
    assert.ok(ics.startsWith('BEGIN:VCALENDAR'))
    assert.ok(ics.includes('SUMMARY:Beginners Squad'))
    assert.ok(ics.includes('DTSTART:20260715T173000Z'))
    // Stable per booking, so a re-sent invite updates one calendar entry.
    assert.ok(ics.includes('UID:booking-sess1-contact1@linyup.com'))
    assert.ok(ics.includes('ATTENDEE;CN="Priya Menon";RSVP=FALSE:mailto:priya@example.com'))
  })

  it('falls back to a Linyup organizer when the studio published no address', () => {
    const ics = buildClassBookingConfirmationMail(base).attachments[0].content
    assert.ok(ics.includes('ORGANIZER;CN="SWIMLI":mailto:noreply@linyup.com'))
    const own = buildClassBookingConfirmationMail({
      ...base,
      organizerEmail: 'hello@swimli.ch',
    }).attachments[0].content
    assert.ok(own.includes('mailto:hello@swimli.ch'))
  })

  it('subjects the mail identically whatever the tender was', () => {
    assert.equal(
      buildClassBookingConfirmationMail(base).subject,
      buildClassBookingConfirmationMail({ ...base, paid: { amount: 25, currency: 'CHF' } }).subject
    )
    assert.equal(buildClassBookingConfirmationMail(base).subject, 'Booking Confirmed – Beginners Squad')
  })
})
