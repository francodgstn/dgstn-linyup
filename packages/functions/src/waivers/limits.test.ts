import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WAIVER_RESOLVE_LIMIT_PER_HOUR,
  waiverCredentialForTeam,
  waiverResolveCosts,
  waiverResolveExceeded,
} from './limits'

// THE ABUSE MODEL, DRIVEN RATHER THAN READ.
//
// Two rounds of this limiter shipped a rule that was only visible by tracing
// which branch reached which counter, and both were wrong in a way a reader
// could not see: one charged everybody and locked a doorway out of its own
// booking path, the next charged almost nobody. So every rule the model states
// is a fixture here, exercised as a SCENARIO — a doorway, an enumerator —
// rather than asserted as a constant, because the constants were never the part
// that was wrong.
//
// THE MAIL HALF IS GONE, AND THE REST IS NOT. The counters that bounded an
// unauthenticated mail sender left with the emailed-guardian mechanism they
// bounded. The survivor — `resolveWaiverRequirement` — is still public, still
// unauthenticated, and still resolves a caller by email+name against `contacts`:
// removing the mail axis removed neither the volume axis nor the enumeration
// one, and the doorway regression below is what a round that forgets that
// produces.
//
// Run with: pnpm --filter @linyup/functions test

const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')

/** Strip comments and string literals so a grep cannot match prose. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// ── The hour, as the counter actually sees it ───────────────────────────────
// One in-memory stand-in for `spendRateLimit`, shared by every scenario below,
// so a scenario spends the same shape of counter the callable does: one bucket
// per (prefix, subject), incremented, compared against a ceiling.
function hour() {
  const counters = new Map<string, number>()
  return {
    spend(prefix: string, subject: string): number {
      const key = `${prefix}:${subject}`
      const next = (counters.get(key) ?? 0) + 1
      counters.set(key, next)
      return next
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('A SHARED-NAT DOORWAY IS NOT LOCKED OUT OF ITS OWN BOOKING PATH', () => {
  // A kiosk at a busy class, a gym behind one NAT, a studio's front desk. Per-IP
  // is the wrong axis for all three, and the ceiling that serves them is sized
  // for the doorway rather than for a probe budget.

  it('200 walk-ins in one hour, two identity calls each, all pass', () => {
    const h = hour()
    let refused = 0
    for (let walkIn = 0; walkIn < 200; walkIn += 1) {
      for (let call = 0; call < 2; call += 1) {
        const cost = waiverResolveCosts({ credential: null, asksAboutAPerson: true })
        assert.equal(cost, true, 'a walk-in typing their address IS asking about a person')
        if (waiverResolveExceeded(h.spend('waiver-check', '1.2.3.4'))) refused += 1
      }
    }
    assert.equal(refused, 0)
    assert.equal(400 <= WAIVER_RESOLVE_LIMIT_PER_HOUR, true)
  })

  it("the studio's own PAIRED tablet spends nothing at all", () => {
    // The one doorway that can prove it is one. `unlockKiosk` mints the claim
    // after a timing-safe PIN comparison, so this is not a string off a body.
    const credential = waiverCredentialForTeam(
      { kiosk: true, kioskTeam: 'team-a', kioskEpoch: 3 },
      'team-a',
      Date.now()
    )
    assert.equal(credential, 'kiosk_device')
    for (let i = 0; i < 5000; i += 1) {
      assert.equal(waiverResolveCosts({ credential, asksAboutAPerson: true }), false)
    }
  })

  it('a returning member recognized by name and address costs NOTHING extra', () => {
    // The previous cut charged exactly this shape, because `guest_match` was
    // read as "we disclosed something". Every returning walk-in at a doorway is
    // a guest match, so the doorway locked itself out after thirty of them.
    // Nothing in the charge decision can see the proof at all now: it is taken
    // from the REQUEST, before the caller is resolved.
    const decided = code(src('requirement.ts'))
    assert.ok(
      decided.indexOf('chargeWaiverResolve(') < decided.indexOf('resolveWaiverCaller('),
      'the charge must be decided before anybody is recognized'
    )
    assert.equal(count(decided, 'caller.proof'), 1, 'only the Space widening reads the proof')
  })

  it('a signed-in member is exempt, and an EXPIRED session is not', () => {
    const now = 1_800_000_000_000
    assert.equal(
      waiverCredentialForTeam(
        { contactId: 'c1', teamId: 'team-a', sessionExpires: now + 60_000 },
        'team-a',
        now
      ),
      'contact_session'
    )
    assert.equal(
      waiverCredentialForTeam(
        { contactId: 'c1', teamId: 'team-a', sessionExpires: now - 1 },
        'team-a',
        now
      ),
      null,
      'a seven-day token must not buy an unbounded eighth day'
    )
    // Another team's session, and a kiosk paired with another team, are both
    // strangers here.
    assert.equal(
      waiverCredentialForTeam({ contactId: 'c1', teamId: 'team-b' }, 'team-a', now),
      null
    )
    assert.equal(
      waiverCredentialForTeam({ kiosk: true, kioskTeam: 'team-b' }, 'team-a', now),
      null
    )
    // And a bare body claim is not a credential, because there is no body here.
    assert.equal(waiverCredentialForTeam({ contactId: 'c1' }, 'team-a', now), null)
  })
})

describe('AN ENUMERATOR IS BOUNDED, AND IS ANSWERED NOTHING', () => {
  it('the probe is charged whatever the answer turns out to be', () => {
    // A miss and a hit cost the same unit. Charging only the hits (the previous
    // cut) meant an enumerator paid for their successes and probed for free.
    const h = hour()
    let answered = 0
    for (let i = 0; i < 1000; i += 1) {
      const cost = waiverResolveCosts({ credential: null, asksAboutAPerson: true })
      assert.equal(cost, true)
      if (!waiverResolveExceeded(h.spend('waiver-check', '9.9.9.9'))) answered += 1
    }
    assert.equal(answered, WAIVER_RESOLVE_LIMIT_PER_HOUR)
  })

  it('an OTP pair is an identity question too, and is charged like one', () => {
    // `authenticatedContactId` + `verificationCodeId` reads a code row and a
    // contact. It is not a token we minted, so it buys no exemption.
    assert.match(code(src('requirement.ts')), /data\.authenticatedContactId && data\.verificationCodeId/)
  })

  it('and the bit an enumerator came for is not returned by any layer', () => {
    // The strongest bound available: the question is not answered, so there is
    // nothing left to ration. Asserted across the wire in surfaces.test.ts too.
    assert.equal(code(src('requirement.ts')).includes('ambiguous'), false)
    assert.equal(code(src('caller.ts')).includes('ambiguous'), false)
  })
})

describe('A CALLER WHO SUPPLIES NO IDENTITY IS NOT CHARGED FOR IT', () => {
  it('asking about nobody costs nothing, credential or not', () => {
    for (const credential of [null, 'contact_session', 'kiosk_device'] as const) {
      assert.equal(waiverResolveCosts({ credential, asksAboutAPerson: false }), false)
    }
  })

  it('the acquisition path — a brand-new guest before they type anything', () => {
    // The visitor who opens a booking form at a waiver tenant and reads the
    // release. That call runs no query about any person and is answered out of
    // the studio's own published text, which D2 already serves world-readable.
    assert.equal(waiverResolveCosts({ credential: null, asksAboutAPerson: false }), false)
  })

  it('the exposure that follows is NAMED at the site, not discovered later', () => {
    // A flood of exactly that shape is bounded by nothing here. That is a
    // choice, and a choice with a consequence has to be written down where the
    // next reader stands, or the round after this one "fixes" it by charging
    // everybody again.
    const model = src('limits.ts')
    assert.match(model, /EXPOSURE THIS ACCEPTS/)
    assert.match(model, /bounded by nothing here, deliberately/)
  })
})

describe('THE MODEL IS STATED ONCE, AND THE CALLABLE REACHES IT THROUGH ONE DOOR', () => {
  it('the paragraph exists where the next reader will stand', () => {
    const model = src('limits.ts')
    assert.match(model, /══ THE MODEL ═/)
    // The three costs and the three axes, each named in the one paragraph.
    for (const phrase of [
      'no answer',
      'per-IP hourly ceiling',
      'per-IP ceiling outright',
    ]) {
      assert.ok(model.includes(phrase), `the model must state: ${phrase}`)
    }
  })

  it('the public callable does not talk to the raw limiter behind its back', () => {
    const c = code(src('requirement.ts'))
    assert.equal(count(c, 'spendRateLimit('), 0, 'it must go through waivers/limits.ts')
    assert.equal(count(c, 'checkoutRateLimit('), 0)
  })

  it('NO PUBLIC WAIVER PATH SENDS MAIL, so no waiver path carries a mail budget', () => {
    // The mint was a PUBLIC mail-sending primitive that sent AS the studio, and
    // three of this file's counters existed for it alone. They left with it, and
    // the checkable form of "they are not coming back by accident" is that no
    // path a visitor can reach sends anything.
    const model = src('limits.ts')
    for (const name of [
      'emailHash',
      'MAX_GUARDIAN_MAILS',
      'GUARDIAN_MINT_LIMIT',
      'guardianMailVerdict',
      'spendGuardianMailBudget',
      'WAIVER_GUARDIAN_RATE_LIMIT_BUCKET',
    ]) {
      assert.equal(model.includes(name), false, `${name} belongs to a mechanism that is gone`)
    }
    for (const f of ['requirement.ts', 'gate.ts', 'accept.ts', 'space.ts', 'publish.ts']) {
      assert.equal(code(src(f)).includes('sendEmail('), false, `${f} must send no mail`)
    }
  })

  it('the ONE sender is manager-gated and bounded by a list, not by a counter', () => {
    // `requestWaiverAcceptance` does send mail — a manager asking somebody to
    // sign. It is not the mint returning: there is no public entry point to
    // ration, so it takes no rate-limit bucket at all. What bounds it is the
    // caller (a manager of the team) and the size of one call.
    const c = code(src('request.ts'))
    assert.ok(c.includes('sendEmail('), 'the ask must actually send')
    assert.match(c, /await assertManager\(request\.auth\.uid, teamId\)/)
    assert.equal(count(c, 'spendRateLimit('), 0)
    assert.equal(count(c, 'checkoutRateLimit('), 0)
    assert.ok(c.includes('MAX_WAIVER_REQUEST_RECIPIENTS'), 'one call must be bounded')
    // And it writes NO ledger row: a request is not a signature.
    for (const writer of ['recordWaiverEvent', 'planWaiverLedgerWrite', 'commitWaiverLedgerWrite']) {
      assert.equal(c.includes(writer), false, `a request must not write the ledger (${writer})`)
    }
  })

  it('W21 still holds — no waiver LOGIC followed the counter onto the money path', () => {
    const checkout = readFileSync(join(__dirname, '..', 'connect', 'checkout.ts'), 'utf8')
    const hits = (checkout.match(/waiver/gi) ?? []).length
    assert.ok(hits > 0 && hits < 20, 'only the one bucket constant and its reasoning')
    // The counters generalized (a subject key, not only an IP) and the waiver
    // SIZES stayed out. A ceiling in this module would be a number about mail
    // living on the money path, which is the shape W21 forbids.
    for (const name of ['MAIL_PER', 'MINT_LIMIT', 'RESOLVE_LIMIT', 'emailHash']) {
      assert.equal(checkout.includes(name), false, `${name} belongs to waivers/limits.ts`)
    }
    assert.ok(checkout.includes('export function rateLimitKey'), 'the subject is nameable')
    assert.ok(checkout.includes('export async function spendRateLimit'))
  })
})
