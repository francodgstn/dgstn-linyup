import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE ALWAYS-ON POSTURE, ASSERTED AGAINST THE SOURCE.
//
// A receipt for money is not a preference: the confirmation for a booking
// somebody PAID for carries the manage-booking link and the only invitation into
// the member area, so a studio switching it off would strand the buyer rather
// than quieten a mail. The asymmetry that follows — FREE bookings keep the
// `booking_confirmation` toggle, PAID ones have no toggle at all — is exactly
// the kind of thing a later reader "tidies" into one flag, which is how UX-76
// happened in the first place. Prose cannot stop that; this file can.
//
// It reads the TypeScript SOURCE rather than importing the modules: importing
// the webhook pulls in firebase-functions and the Stripe client, and the claim
// under test is about which gate a call site consults, which is a property of
// the text. Same technique as connect/commitSites.test.ts.

const SRC = join(__dirname, '..')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** CODE only — the module headers below discuss `systemEmailEnabledFor` at
 *  length, and counting prose as a call site is the confusion this avoids. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('the PAID booking confirmation is always on', () => {
  const paid = read('booking/paidConfirmation.ts')

  it('consults no system-email toggle, ever', () => {
    assert.equal(
      /systemEmailEnabled/.test(code(paid)),
      false,
      'booking/paidConfirmation.ts must not gate on a SystemEmailKey — see its header'
    )
  })

  it('says WHY in its header, so the next reader does not tidy it away', () => {
    assert.ok(paid.includes('ALWAYS ON'), 'the posture must be stated')
    assert.ok(
      paid.includes('booking/waitlist/notify.ts'),
      'the header must point at the precedent it follows'
    )
  })

  it('is idempotent through the mail_sends ledger, keyed to the tender', () => {
    assert.ok(/idempotencyKey:\s*`paid-booking-/.test(paid), 'the send must carry a ledger key')
    assert.ok(paid.includes('tenderRef'), 'the key must be per payment, not per person-and-class')
  })

  it('carries the manage link, the Space link and a calendar invite', () => {
    assert.ok(paid.includes("'manage-booking'"))
    assert.ok(paid.includes("'space'"))
    // The `.ics` comes with the shared builder — one attachment path for the
    // free and paid class confirmations both.
    assert.ok(paid.includes('buildClassBookingConfirmationMail'))
  })
})

describe('every rail that takes money for a CLASS sends it', () => {
  // Named, not counted: the two are the Stripe drop-in confirm and the
  // gift-card full cover (the tender is the only difference between them).
  const SENDERS: Record<string, string> = {
    'connect/webhook.ts': 'handleDropInCheckout',
    'booking/dropIn.ts': 'createDropInCheckout (gift-card full cover)',
  }

  it('both call the shared sender', () => {
    for (const [file, what] of Object.entries(SENDERS)) {
      assert.ok(
        code(read(file)).includes('sendPaidBookingConfirmation('),
        `${file} (${what}) must send the receipt`
      )
    }
  })
})

describe('the PAID appointment confirms too, and ignores the same toggle', () => {
  // The appointment rail states the identical rule in a different shape: ONE
  // sender serves both tenders, so the split is an argument (`wasPaidFor`) rather
  // than a module. Pinned because the shape makes it easy to "simplify" back into
  // a single unconditional toggle read — which is what UX-77 found.
  const emails = read('appointments/emails.ts')

  it('the gate short-circuits on the paid arm', () => {
    assert.ok(
      /p\.wasPaidFor \|\|\s*\(await systemEmailEnabledFor\(p\.teamId, 'booking_confirmation'\)\)/.test(
        code(emails)
      ),
      'appointments/emails.ts must let a PAID appointment past booking_confirmation'
    )
  })

  it('says WHY in its header, and points at the class-rail precedent', () => {
    assert.ok(emails.includes('ALWAYS ON'), 'the posture must be stated')
    assert.ok(
      emails.includes('booking/paidConfirmation.ts'),
      'the header must point at the rule it inherits'
    )
  })

  it('every caller answers the tender question explicitly', () => {
    // Named, not counted — the three settlement rails an appointment can arrive
    // on. A new one that forgets the argument fails to compile; one that passes a
    // wrong constant is caught by reading this list beside the code.
    const CALLERS: Record<string, string> = {
      'appointments/window.ts': 'wasPaidFor: false', // bookAppointment refuses payable callers
      'appointments/staffBooking.ts': 'wasPaidFor: plan_.recordPaymentNow', // cash over the counter
      'connect/webhook.ts': 'wasPaidFor: true', // Stripe has already been paid
    }
    for (const [file, expected] of Object.entries(CALLERS)) {
      assert.ok(
        code(read(file)).includes(expected),
        `${file} must pass ${expected} to sendAppointmentBookingEmails`
      )
    }
  })
})

describe('the FREE path keeps its toggle — the asymmetry is the design', () => {
  it('bookSession still honors booking_confirmation', () => {
    const src = read('booking/index.ts')
    assert.ok(
      /systemEmailEnabledFor\(data\.teamId, 'booking_confirmation'\)/.test(src),
      'the free booking confirmation must stay switchable'
    )
    assert.ok(
      src.includes('free-is-switchable') || src.includes('Free-is-switchable'),
      'and the code must say that the asymmetry is deliberate'
    )
  })
})
