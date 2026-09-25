import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE DEAD ENDS — the places a real person could not get through, or got
// through when they should not have.
//
// Every case below was reachable by somebody who had done nothing wrong: a
// visitor pressing Confirm on an error screen, a claimant holding an offer the
// mirror had not caught up with, a member sent to Space by a door that refused
// them. They are grouped here rather than filed under whichever module
// happened to hold the line, because the shared property is the one that
// matters: a refusal that is accurate and offers no next step is still a defect
// on a booking path.
//
// Run with: pnpm --filter @linyup/functions test

const ROOT = join(__dirname, '..', '..', '..', '..')
const WEB = join(ROOT, 'apps', 'web', 'src')
const MOBILE = join(ROOT, 'apps', 'mobile', 'src')

function read(base: string, rel: string): string {
  const p = join(base, rel)
  assert.ok(existsSync(p), `expected ${rel} to exist`)
  return readFileSync(p, 'utf8')
}

const web = (rel: string) => read(WEB, rel)
const mobile = (rel: string) => read(MOBILE, rel)

/** Strip comments and string literals so a grep cannot match prose. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

function count(src: string, needle: string): number {
  return src.split(needle).length - 1
}

/** Every public surface that owns a gate and can be refused by a rail. */
const BOOKING_SURFACES = [
  'app/[locale]/(public)/public/[slug]/booking/BookingForm.tsx',
  'components/booking/appointment/SlotBookingForm.tsx',
  'app/[locale]/(public)/public/[slug]/waitlist/page.tsx',
  'app/[locale]/(public)/public/[slug]/kiosk/WalkIn.tsx',
  'app/[locale]/(public)/public/[slug]/signup/SignupForm.tsx',
] as const

// ─────────────────────────────────────────────────────────────────────────────

describe('AN EMPTY LIST BECAUSE WE FAILED TO LOAD IS NOT "NOTHING REQUIRED"', () => {
  const hook = code(web('hooks/useWaiverGate.ts'))

  // `[].every(…)` is `true`. So for as long as `ready` was derived from the
  // list alone, a requirement callable that FAILED presented an error screen
  // with a live Confirm — and pressing it re-entered the submit, got the same
  // `true` from the second pass, and sent the booking to a rail that refused it.
  it('`ready` is false unless a server answer was stored AND the last attempt succeeded', () => {
    assert.match(
      hook,
      /const ready = useMemo\(\s*\(\) =>\s*resolved &&\s*error === null &&/,
      'the two facts an empty list cannot express must both be in the expression'
    )
  })

  it('the synchronous second pass carries the same guard, off the refs', () => {
    assert.match(hook, /resolvedRef\.current &&\s*errorRef\.current === null &&/)
  })

  it('`resolved` turns true in exactly ONE place — where a server answer is stored', () => {
    assert.equal(count(hook, 'resolvedRef.current = true'), 1)
    assert.equal(count(hook, 'setResolved(true)'), 1)
  })

  it('every surface uses the GUARDED value, never a bare predicate over the list', () => {
    // The two rails that used to defer had their own predicate and their own
    // hole; both now gate on the same `ready`, which carries the guard. A bare
    // `.every(…)` over an empty list is `true` — a live Confirm on an error
    // screen, which is where this whole block came from.
    for (const rel of [
      'app/[locale]/(public)/public/[slug]/kiosk/WalkIn.tsx',
      'app/[locale]/(public)/public/[slug]/waitlist/page.tsx',
    ]) {
      const src = code(web(rel))
      assert.ok(src.includes('waiverGate.ready'), `${rel} must use the guarded value`)
      assert.equal(
        count(src, 'waiverSatisfiedLocally('),
        0,
        `${rel} must not call the unguarded predicate — over an empty list it is true`
      )
    }
  })

  it('the step offers a RETRY, because a blocking message with no way out is a dead end', () => {
    const step = web('components/booking/WaiverStep.tsx')
    const errorBranch = step.slice(step.indexOf('if (gate.error)'), step.indexOf('if (gate.loading'))
    assert.match(errorBranch, /gate\.refresh\(\)/, 'the error state must be actionable')
    assert.match(errorBranch, /tCommon\('errorRetry'\)/)
  })
})

describe('A STALE-EMPTY MIRROR IS RECOVERABLE — the server outranks the mirror', () => {
  const hook = code(web('hooks/useWaiverGate.ts'))

  // `TeamPublicProfile.required_waivers` is a world-readable rendering hint and
  // can be briefly stale-EMPTY. When it is, `applies` is false, `ensure()`
  // returns "clear" from its first line, the rail refuses `waiver_required` —
  // and the surface's own recovery branch called `ensure()` again, got the same
  // "clear", and printed a sentence with no step behind it.
  it('the gate can be forced live by a server refusal', () => {
    assert.match(hook, /const recover = useCallback\(/)
    assert.match(hook, /if \(!waiverRefusalReason\(err\)\) return false/)
    assert.match(hook, /forcedRef\.current = true/)
    assert.match(hook, /const applies = !!teamId && \(\(requiredWaivers\?\.length \?\? 0\) > 0 \|\| forced\)/)
  })

  it('`reset()` does NOT clear it — the mirror being wrong is a fact about the TENANT', () => {
    const reset = hook.slice(hook.indexOf('const reset = useCallback('))
    const body = reset.slice(0, reset.indexOf('}, [])'))
    assert.equal(count(body, 'setForced'), 0)
  })

  it('every surface recovers through it, and none re-asks `ensure` after a refusal', () => {
    for (const rel of BOOKING_SURFACES) {
      const src = code(web(rel))
      assert.ok(
        count(src, 'waiverGate.recover(') >= 1,
        `${rel} must recover a waiver refusal through the gate, not by re-asking ensure`
      )
    }
  })

  it('the recovery branches no longer sit behind `applies`', () => {
    // Every `ensure(` left in these files is a HAPPY-path interposition; the
    // recovery ones are `recover(`. If a recovery branch is ever written back as
    // reset+ensure, the stale-empty case silently becomes a dead end again.
    //
    // The numbers count HAPPY-PATH ENTRIES into a terminal submit, which is not
    // quite the same as counting submits: a submit reachable from two places
    // needs a gate in front of each, or the second way in is ungated.
    // THREE entries on the class form: `onSubmitGuest`, `onVerified` (the OTP
    // path) and `onSubmitMember`. The third arrived with the contact-session fix
    // of 2026-08-23 — a signed-in member pressing Confirm on the member screen,
    // which, like the picker's equivalent, has no verification moment to hang a
    // gate off. Without its own `ensure(` that Confirm would book with no
    // consent step in front of it.
    const bookingForm = code(web(BOOKING_SURFACES[0]))
    assert.equal(count(bookingForm, 'waiverGate.ensure('), 3, 'one per entry, no more')
    assert.equal(count(bookingForm, 'waiverGate.reset()'), 1, 'only the flow reset survives')
    // The picker has three terminal submits and FOUR ways into them:
    // `onSubmitGuest`, `onMemberPay`, and two entries to `runMemberFreeBooking`
    // — `onVerifiedAppointment`'s autobooking path (a covered member's code has
    // just verified) and `onMemberBook` (a signed-in contact pressing Confirm on
    // the member screen, which has no verification moment to hang off). The
    // second entry arrived with the contact-session fix; before it, that Confirm
    // would have booked with no consent step in front of it.
    const picker = code(web(BOOKING_SURFACES[1]))
    assert.equal(count(picker, 'waiverGate.ensure('), 4, 'one per entry, no more')

    // ONE `reset()` on the picker, and it is the IDENTITY TEARDOWN, not a
    // recovery. The two are opposites and the count alone cannot tell them
    // apart — which is why this used to assert 0 and would have blocked the
    // teardown from ever being written correctly.
    //   • recovery-as-reset is the hazard: it re-asks `ensure()`, gets the same
    //     "clear" from a stale-empty mirror, and restores the dead end.
    //   • the teardown is required: on an identity change, consent gathered for
    //     the person who just stopped being signed in must not survive into the
    //     next `ensure()`. `dismiss()` only hides the step and keeps `items`,
    //     `ticks` and `choices` — on an immutable acceptance ledger, reusing
    //     them would attribute one person's consent to another.
    assert.equal(count(picker, 'waiverGate.reset()'), 1, 'the identity teardown, and only it')

    // The distinction, enforced rather than asserted: a reset that is followed
    // closely by an `ensure(` IS the recovery shape this describes.
    const resetAt = picker.indexOf('waiverGate.reset()')
    const after = picker.slice(resetAt, resetAt + 400)
    assert.ok(
      !after.includes('waiverGate.ensure('),
      'a reset() followed by ensure() is a recovery branch — use recover() instead'
    )
  })
})

describe('SPACE CAN RESOLVE THE REFUSAL IT IS NOMINATED FOR', () => {
  const src = web('app/[locale]/(public)/public/[slug]/space/SpaceWaiverCard.tsx')
  const c = code(src)

  // `selfCheckIn` and the mobile scanner REFUSE over a waiver and send the
  // member here with a `signUrl`. So every row this panel shows has to be one
  // the member can finish here — it had two that were not: a date-of-birth
  // question, and rows that said "a parent or guardian must sign this one" with
  // no control beside them and no route to one. Both are gone with the machinery
  // that produced them, and this is what keeps them gone.
  it('every outstanding row is signable HERE — no row is a dead end', () => {
    // Exactly two actions exist, and only one of them is outstanding.
    const lib = code(web('lib/waiver.ts'))
    assert.match(lib, /export type WaiverStepAction = '' \| ''/)
    // The panel offers the control for the outstanding one, and no other branch
    // routes a member anywhere else.
    assert.match(src, /item\.action === 'sign_self' && \(/)
    assert.equal(c.includes('needsSomebodyElse'), false)
    assert.equal(c.includes('asksBirthdate'), false)
  })

  it('the self-declaration is asked here too, and rides with the tick', () => {
    // A member sent here by a door must be able to complete the SAME step the
    // booking surfaces show, or Space is once again the place that cannot help.
    assert.match(c, /item\.mayIncludeMinors && \(/)
    assert.match(src, /t\('signerChoiceLabel'\)/)
    assert.match(c, /waiverAcceptancePayload\(items, ticks, choices, guardianNames\)/)
  })

  it('the row says what state it is in, so a row with no control is never mute', () => {
    assert.match(src, /tSpace\('waiverStateSuperseded'\)/)
    assert.match(src, /tSpace\('waiverStateSigned'/)
  })
})

describe('MOBILE STOPS TELLING A MEMBER TO RETRY A WAIVER', () => {
  // The phase gates `bookSession` and wrote the refusal mapper, and then wired
  // it to the scanner only. Both mobile booking rails collapsed every refusal
  // into what is now `Agenda.bookFailed` / `Attendance.bookFailed` ("Failed to
  // book session. Please try again.") — an instruction that can never work,
  // offered forever, over a document the member was never shown.
  const RAILS = [
    'components/profile/SessionAgendaCard.tsx',
    'components/AttendanceCalendar.tsx',
  ] as const

  // A KEY, NOT THE SENTENCE. This pinned the English literal until the member
  // app gained i18n, at which point the string moved into the catalog and this
  // guard broke — correctly, but for a reason that had nothing to do with what
  // it protects. What it protects is the ORDER: a waiver refusal must be mapped
  // before the rail falls back to "try again". The key is the stable name of
  // that fallback; `pnpm i18n:check` is what proves the key still resolves to
  // real copy in all four locales, which is not this test's job.
  const GENERIC = "t('bookFailed')"

  it('every rail that calls bookSession maps the refusal FIRST', () => {
    for (const rel of RAILS) {
      const src = mobile(rel)
      assert.ok(
        code(src).includes('FirestoreService.bookSession('),
        `${rel} must be a booking rail`
      )
      const handler = src.slice(src.indexOf('const handleBook ='))
      const mapped = handler.indexOf('waiverRefusal(')
      const generic = handler.indexOf(GENERIC)
      assert.ok(mapped > -1, `${rel} must map a waiver refusal`)
      assert.ok(generic > -1, `${rel} keeps its generic sentence for everything else`)
      assert.ok(mapped < generic, `${rel} must decide before it prints the generic sentence`)
    }
  })

  it('and offers the signing page when the server sent one', () => {
    for (const rel of RAILS) {
      const src = code(mobile(rel))
      assert.ok(src.includes('waiver.signUrl'), `${rel} must offer the link when there is one`)
      assert.ok(src.includes('Linking.openURL(url)'), rel)
    }
  })

  it('the verb matches the rail — "check in" on a Book button is the wrong sentence', () => {
    const util = mobile('utils/waiverRefusal.ts')
    assert.match(util, /context: WaiverRefusalContext = 'checkin'/)
    // Two DIFFERENT keys, chosen by context — the point survived translation
    // even though the words moved into the catalog. Asserting the words here
    // would only re-pin English, which is the mistake this file already made
    // once; `pnpm i18n:check` owns whether the keys resolve.
    assert.match(util, /const verb = context === 'booking' \? t\('verbBooking'\) : t\('verbCheckin'\)/)
    for (const rel of RAILS) {
      assert.match(mobile(rel), /waiverRefusal\(tWaiver, error, 'booking'\)/, rel)
    }
    // …and the scanner, which really is a check-in, still passes no context and
    // so takes the default.
    assert.match(mobile('screens/ProfileScreen.tsx'), /waiverRefusal\(tWaiver, err\)/)
  })
})
