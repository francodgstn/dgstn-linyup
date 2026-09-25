import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  waiverAppliesToActivity,
  waiverDoorCheckFor,
  waiverDoorCheckFromBookingState,
  type RequiredWaiverEntry,
  type WaiverSignerFacts,
  type WaiverSignerRole,
} from '@linyup/shared'
import {
  bookingWaiverStateFor,
  declarationFor,
  decideWaiverGate,
  parseWaiverSubmissions,
} from './gate'

// THE GATE, IN TWO HALVES.
//
// Half one is a matrix over the pure decision core: every acceptance state ×
// every version relationship, one assertion per row.
// It exists because the recurring defect in this area is a predicate reasoned
// about ONE SHAPE AT A TIME — a boundary case fixed on the rail where it was
// noticed and left standing on the four rails where it was not.
//
// Half two reads the SOURCE of every rail in the census and asserts the two
// ordering rules that no unit test can reach: the gate runs above the first
// contact write, and the acceptance is written with the commit. That is where
// the phase's stated likeliest failure lives — a fix applied to the entry points
// a document NAMED rather than every entry point that EXISTS — so the check is
// against the files, not against a list somebody maintained by hand.
//
// Run with: pnpm --filter @linyup/functions test

const DAY = 24 * 60 * 60 * 1000
const YEAR = 365 * DAY
const NOW = Date.UTC(2026, 7, 15, 10, 0, 0)

function ts(ms: number) {
  return {
    toDate: () => new Date(ms),
    toMillis: () => ms,
    seconds: Math.floor(ms / 1000),
    nanoseconds: 0,
  }
}

function entry(over: Partial<RequiredWaiverEntry> = {}): RequiredWaiverEntry {
  return {
    documentId: 'doc1',
    slug: 'liability-ab12',
    title: 'Liability release',
    current_version: 3,
    min_valid_version: 1,
    body_hash: 'hash-v3',
    mayIncludeMinors: false,
    validityMonths: null,
    scope: { appliesTo: 'all_bookings' },
    ...over,
  }
}

function signer(over: Partial<WaiverSignerFacts> = {}): WaiverSignerFacts {
  return {
    accepted_version: 3,
    accepted_at: ts(NOW - DAY) as unknown as WaiverSignerFacts['accepted_at'],
    valid_until: null,
    status: 'active',
    ...over,
  }
}

function submission(over: Partial<Parameters<typeof decideWaiverGate>[0]['submissions'][number]> = {}) {
  return {
    documentId: 'doc1',
    version: 3,
    bodyHash: 'hash-v3',
    intentId: 'nonce1',
    authoritativeHash: 'hash-v3',
    ...over,
  }
}

function decide(over: Partial<Parameters<typeof decideWaiverGate>[0]> = {}) {
  return decideWaiverGate({
    applicable: [entry()],
    signers: {},
    submissions: [],
    nowMs: NOW,
    ...over,
  })[0]
}

// ─────────────────────────────────────────────────────────────────────────────

describe('SCOPE — which waivers apply to what is being booked', () => {
  it('an all_bookings waiver applies to every rail, activity or not', () => {
    assert.equal(waiverAppliesToActivity({ appliesTo: 'all_bookings' }, 'act1'), true)
    assert.equal(waiverAppliesToActivity({ appliesTo: 'all_bookings' }, null), true)
  })

  it('an activity-scoped waiver applies only to its own activities', () => {
    const scope = { appliesTo: 'activities' as const, activityIds: ['act1', 'act2'] }
    assert.equal(waiverAppliesToActivity(scope, 'act2'), true)
    assert.equal(waiverAppliesToActivity(scope, 'act9'), false)
  })

  it('an UNKNOWN activity does not widen a narrowly-scoped waiver', () => {
    // "We could not tell which activity" must never silently become "ask for a
    // signature the studio never asked for". Every rail in the product resolves
    // an activity, so this is a floor rather than a live case — but the floor
    // has to fall on the side that does not invent a requirement.
    assert.equal(
      waiverAppliesToActivity({ appliesTo: 'activities', activityIds: ['act1'] }, null),
      false
    )
  })
})

describe('THE SELF-DECLARATION — recorded, never gated', () => {
  const flagged = entry({ mayIncludeMinors: true })
  const plain = entry()

  it('a flagged waiver records what the visitor said, and the OPTIONAL name with it', () => {
    assert.deepEqual(
      declarationFor(flagged, { signingAsGuardian: true, guardianName: '  Sabine   Meier ' }),
      { signingAsGuardian: true, guardianName: 'Sabine Meier' }
    )
    assert.deepEqual(declarationFor(flagged, { signingAsGuardian: true }), {
      signingAsGuardian: true,
      guardianName: '',
    })
    assert.deepEqual(declarationFor(flagged, { signingAsGuardian: false }), {
      signingAsGuardian: false,
      guardianName: '',
    })
  })

  // A declaration the step never SHOWED is not a declaration. An adults-only
  // studio whose waiver carries no minors flag must never end up with "a parent
  // signed" in its ledger because a client sent the field anyway.
  it('an UNFLAGGED waiver ignores the field entirely, however the payload arrives', () => {
    assert.deepEqual(
      declarationFor(plain, { signingAsGuardian: true, guardianName: 'Somebody Else' }),
      { signingAsGuardian: false, guardianName: '' }
    )
  })

  it('the name is BOUNDED and stripped of control characters — it lands on a legal record', () => {
    const hostile = `Anna\nBcc: victim@example.ch` + 'x'.repeat(500)
    const { guardianName } = declarationFor(flagged, {
      signingAsGuardian: true,
      guardianName: hostile,
    })
    assert.equal(guardianName.includes('\n'), false)
    assert.ok(guardianName.length <= 120)
  })

  it('a self-tick on a flagged waiver still RECORDS — the flag is a prompt, not a gate', () => {
    const step = decide({
      applicable: [flagged],
      submissions: [submission()],
    })
    assert.equal(step.outcome, 'record')
  })

  it('the booking stamp is a PROMPT: guardian first, then the plain check, then ok', () => {
    assert.equal(bookingWaiverStateFor([flagged], [{ signerRole: 'guardian' }]), 'guardian_declared')
    assert.equal(bookingWaiverStateFor([flagged], [{ signerRole: 'self' }]), 'check_participant')
    // A repeat booking on an existing signature records nothing and still asks
    // the studio to look, because the waiver is still one that may cover minors.
    assert.equal(bookingWaiverStateFor([flagged], []), 'check_participant')
    // …and a studio that never flags a waiver never sees a chip anywhere.
    assert.equal(bookingWaiverStateFor([plain], [{ signerRole: 'self' }]), 'ok')
    assert.equal(bookingWaiverStateFor([plain], []), 'ok')
  })

  // TWO SOURCES, ONE VOCABULARY. The session roster reads the LIVE signer row
  // (so a guardian signature given months ago is still precise there); the
  // printed manifest reads the booking's own stamp, because a booked row carries
  // no signer lookup. They are allowed to differ in PRECISION — a repeat booking
  // riding on an old guardian signature stamps `check_participant` — but never in
  // what the same facts mean, or the desk is told two different things about one
  // person.
  it('the live roster and the printed sheet agree on what the chip SAYS', () => {
    const cases: { entry: RequiredWaiverEntry; role: WaiverSignerRole }[] = [
      { entry: flagged, role: 'guardian' },
      { entry: flagged, role: 'self' },
      { entry: plain, role: 'guardian' },
      { entry: plain, role: 'self' },
    ]
    for (const { entry: e, role } of cases) {
      assert.equal(
        waiverDoorCheckFromBookingState(bookingWaiverStateFor([e], [{ signerRole: role }])),
        waiverDoorCheckFor({ signerRole: role, mayIncludeMinors: e.mayIncludeMinors }),
        `the two sources disagree for role=${role}, mayIncludeMinors=${e.mayIncludeMinors}`
      )
    }
  })
})

describe('THE MATRIX — every acceptance state, against a required waiver', () => {
  it('valid → satisfied, and NOTHING is recorded whatever payload arrived', () => {
    // The rule the first draft was silent on: when the gate computes `valid` the
    // acceptance write is a no-op. A surface that re-sends a tick out of
    // over-caution must not mint a second event row.
    const step = decide({ signers: { doc1: signer() }, submissions: [submission()] })
    assert.equal(step.outcome, 'satisfied')
  })

  it('never signed → waiver_required', () => {
    const step = decide()
    assert.equal(step.outcome, 'refuse')
    assert.equal(step.outcome === 'refuse' && step.details.reason, 'waiver_required')
  })

  it('revoked → refused, and re-signing works in the same request', () => {
    const revoked = { doc1: signer({ status: 'revoked' as const }) }
    assert.equal(decide({ signers: revoked }).outcome, 'refuse')
    assert.equal(decide({ signers: revoked, submissions: [submission()] }).outcome, 'record')
  })

  it('superseded by a require_resign publish → refused, and one more tick fixes it', () => {
    const signers = { doc1: signer({ accepted_version: 2 }) }
    const applicable = [entry({ min_valid_version: 3 })]
    assert.equal(decide({ applicable, signers }).outcome, 'refuse')
    assert.equal(decide({ applicable, signers, submissions: [submission()] }).outcome, 'record')
  })

  it('expired → refused; the comparison is against the STORED instant', () => {
    // Never arithmetic over a live `validityMonths`, which would let one field
    // edit retroactively re-date every signature a studio ever took.
    const expired = {
      doc1: signer({
        valid_until: ts(NOW - DAY) as unknown as WaiverSignerFacts['valid_until'],
      }),
    }
    const live = {
      doc1: signer({
        valid_until: ts(NOW + DAY) as unknown as WaiverSignerFacts['valid_until'],
      }),
    }
    assert.equal(decide({ signers: expired }).outcome, 'refuse')
    assert.equal(decide({ signers: live }).outcome, 'satisfied')
  })
})

describe('THE MID-PUBLISH RACE — a version published while the visitor was reading', () => {
  it('a SILENT publish does not invalidate the version they actually read', () => {
    // The floor did not move, so the tick counts — against version 2, the text
    // they saw. Recording it against 3 would claim they read text nobody showed
    // them, which is the one thing this design exists to prevent.
    const step = decide({
      applicable: [entry({ current_version: 3, min_valid_version: 1 })],
      submissions: [submission({ version: 2, bodyHash: 'hash-v2', authoritativeHash: 'hash-v2' })],
    })
    assert.equal(step.outcome, 'record')
    assert.equal(step.outcome === 'record' && step.submission.version, 2)
  })

  it('a REQUIRE_RESIGN publish refuses the stale tick, actionably', () => {
    const step = decide({
      applicable: [entry({ current_version: 3, min_valid_version: 3 })],
      submissions: [submission({ version: 2, bodyHash: 'hash-v2', authoritativeHash: 'hash-v2' })],
    })
    assert.equal(step.outcome, 'refuse')
    assert.equal(step.outcome === 'refuse' && step.details.reason, 'waiver_version_changed')
    // The refusal carries the version to re-present. A refusal a surface cannot
    // act on is a dead end, and on the returning-member path a dead end that has
    // already cost a verification code.
    assert.equal(step.outcome === 'refuse' && step.details.version, 3)
  })

  it('a hash that disagrees for the SAME version refuses rather than recording', () => {
    // Versions are immutable, so this state cannot legitimately exist. Recording
    // a signature against text the server cannot identify is worse than refusing.
    const step = decide({
      submissions: [submission({ bodyHash: 'tampered', authoritativeHash: 'hash-v3' })],
    })
    assert.equal(step.outcome, 'refuse')
    assert.equal(step.outcome === 'refuse' && step.details.reason, 'waiver_unavailable')
  })

  it('a version whose snapshot cannot be read refuses — the gate fails CLOSED', () => {
    const step = decide({
      submissions: [submission({ version: 2, bodyHash: 'hash-v2', authoritativeHash: null })],
    })
    assert.equal(step.outcome, 'refuse')
    assert.equal(step.outcome === 'refuse' && step.details.reason, 'waiver_unavailable')
  })

  it('a version ABOVE the current one is refused, not trusted', () => {
    const step = decide({ submissions: [submission({ version: 9 })] })
    assert.equal(step.outcome, 'refuse')
    assert.equal(step.outcome === 'refuse' && step.details.reason, 'waiver_version_changed')
  })
})

describe('NO RAIL DEFERS — one behaviour on every door', () => {
  // Two rails used to COMPLETE with a waiver outstanding: the waitlist claim
  // (one offer, ever, against a 72-hour emailed guardian link) and a PIN-paired
  // kiosk (a tablet with an idle timer). Both exceptions existed for the same
  // thing — a signature only somebody else could give — and both are gone with
  // it. The consent step is completable by the person standing there, so the
  // gate has exactly two outcomes for an unsatisfied waiver and neither is
  // "carry on".
  it('the decision has no arm that admits an unsigned caller', () => {
    const outcomes = new Set(
      [
        decide(),
        decide({ submissions: [submission()] }),
        decide({ signers: { doc1: signer() } }),
        decide({ applicable: [entry({ mayIncludeMinors: true })] }),
      ].map((step) => step.outcome)
    )
    assert.deepEqual([...outcomes].sort(), ['record', 'refuse', 'satisfied'])
  })

  it('an unsigned waiver refuses whatever the waiver is flagged as', () => {
    for (const applicable of [[entry()], [entry({ mayIncludeMinors: true })]]) {
      const step = decide({ applicable })
      assert.equal(step.outcome, 'refuse')
      assert.equal(step.outcome === 'refuse' && step.details.reason, 'waiver_required')
    }
  })

  it('and no rail can ask for a different posture — there is no parameter to pass', () => {
    const gate = readFileSync(join(__dirname, 'gate.ts'), 'utf8')
    assert.equal(gate.includes('guardianPolicy'), false)
    assert.equal(gate.includes("outcome: 'defer'"), false)
  })
})

describe('SEVERAL REQUIRED WAIVERS — decided independently, refused as a whole', () => {
  it('one signed and one not refuses on the unsigned one', () => {
    const steps = decideWaiverGate({
      applicable: [entry(), entry({ documentId: 'doc2', body_hash: 'h2' })],
      signers: { doc1: signer() },
      submissions: [],
      nowMs: NOW,
    })
    assert.equal(steps[0].outcome, 'satisfied')
    assert.equal(steps[1].outcome, 'refuse')
    assert.equal(steps[1].outcome === 'refuse' && steps[1].details.documentId, 'doc2')
  })

  it('two ticks in one request record two events', () => {
    const steps = decideWaiverGate({
      applicable: [entry(), entry({ documentId: 'doc2', body_hash: 'h2' })],
      signers: {},
      submissions: [
        submission(),
        submission({ documentId: 'doc2', bodyHash: 'h2', authoritativeHash: 'h2', intentId: 'n2' }),
      ],
      nowMs: NOW,
    })
    assert.deepEqual(
      steps.map((s) => s.outcome),
      ['record', 'record']
    )
  })
})

describe('THE UNTRUSTED PAYLOAD', () => {
  it('an untickedbox is not a signature', () => {
    assert.deepEqual(
      parseWaiverSubmissions([
        { documentId: 'd', version: 1, bodyHash: 'h', intentId: 'i', accepted: false },
      ]),
      []
    )
    assert.deepEqual(
      parseWaiverSubmissions([{ documentId: 'd', version: 1, bodyHash: 'h', intentId: 'i' }]),
      []
    )
  })

  it('malformed entries are DROPPED, so the gate refuses in the ordinary way', () => {
    const parsed = parseWaiverSubmissions([
      { documentId: '', version: 1, bodyHash: 'h', intentId: 'i', accepted: true },
      { documentId: 'd', version: 0, bodyHash: 'h', intentId: 'i', accepted: true },
      { documentId: 'd', version: 1.5, bodyHash: 'h', intentId: 'i', accepted: true },
      { documentId: 'd', version: 1, bodyHash: '', intentId: 'i', accepted: true },
      { documentId: 'd', version: 1, bodyHash: 'h', intentId: '', accepted: true },
      'nonsense',
      null,
      { documentId: 'ok', version: 2, bodyHash: 'h', intentId: 'i', accepted: true },
    ])
    assert.deepEqual(
      parsed.map((p) => p.documentId),
      ['ok']
    )
  })

  it('the self-declaration is coerced, and an absent one is not a guardian claim', () => {
    const [row] = parseWaiverSubmissions([
      {
        documentId: 'd',
        version: 1,
        bodyHash: 'h',
        intentId: 'i',
        accepted: true,
        signingAsGuardian: 'yes',
        guardianName: 42,
      },
    ])
    assert.equal(row.signingAsGuardian, false, 'anything but `true` is not a declaration')
    assert.equal(row.guardianName, null)

    const [plain] = parseWaiverSubmissions([
      { documentId: 'd', version: 1, bodyHash: 'h', intentId: 'i', accepted: true },
    ])
    assert.equal(plain.signingAsGuardian, false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// HALF TWO — the census, asserted against the source
// ═════════════════════════════════════════════════════════════════════════════

const SRC = join(__dirname, '..')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** CODE only. The census header in gate.ts names every rail in prose, and
 *  counting those mentions as call sites is exactly the confusion this file
 *  removes. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function countCalls(source: string, name: string): number {
  const re = new RegExp(`(?<!function\\s)\\b${name}\\(`, 'g')
  return (source.match(re) ?? []).length
}

/**
 * EVERY `.ts` under packages/functions/src, as paths relative to it and with
 * forward slashes, so the result can be compared against the census rows above.
 *
 * A census guard that searches a hand-written roster of files cannot discover a
 * file that is not on it — which is the only failure worth guarding. Tests and
 * the gate's own module are excluded because a call site in either is not a
 * rail: `waivers/gate.ts` DECLARES `enforceWaiverGate`, and a test may name it
 * freely.
 */
function allSources(): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel)
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        if (rel !== 'waivers/gate.ts') out.push(rel)
      }
    }
  }
  walk(SRC, '')
  assert.ok(out.length > 100, 'the walk found suspiciously few sources')
  return out
}

/** Index of the first occurrence in CODE, with the offsets of the original
 *  string preserved so two markers can be ordered against each other. */
function at(source: string, needle: string): number {
  const blanked = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length))
  const i = blanked.indexOf(needle)
  assert.notEqual(i, -1, `expected to find \`${needle}\` in code`)
  return i
}

describe('THE CENSUS — every rail that admits a caller calls the ONE gate', () => {
  // Regenerated from the write sites, not from the callable names:
  //   grep -rn "collection('participants')\|collection('bookings')\|
  //             collection('attendees')\|PARTICIPANTS_SUBCOLLECTION" \
  //        packages/functions/src apps/web/src apps/mobile/src
  const GATED = [
    'booking/index.ts', // bookSession
    'booking/dropIn.ts', // createDropInCheckout (+ the gift-card full-cover branch)
    'appointments/window.ts', // bookAppointment
    'appointments/checkout.ts', // createAppointmentCheckout
    'booking/waitlist/claim.ts', // claimWaitlistSeat
    'sessions/index.ts', // selfCheckIn — refuse only
  ]

  // "…and nothing else does" is NOT this test's claim — it is the tree-walking
  // test at the bottom of this block. This one checks the count per gated rail
  // and pins the named exemptions at their own paths.
  it('each gated rail calls enforceWaiverGate exactly once', () => {
    for (const f of GATED) {
      assert.equal(countCalls(code(read(f)), 'enforceWaiverGate'), 1, f)
    }
    // A rail that grew a SECOND gate call would be resolving the requirement
    // twice, and two resolutions of the same question are how they start
    // disagreeing.
    const others = [
      'booking/waitlist/join.ts',
      'appointments/staffBooking.ts',
      'contacts/index.ts',
      'events/index.ts',
      'events/addEventCheckin.ts',
      'connect/webhook.ts',
    ]
    for (const f of others) {
      assert.equal(countCalls(code(read(f)), 'enforceWaiverGate'), 0, `${f} is exempt by decision`)
    }
  })

  it('the exemptions are as explicit as the inclusions, at their own sites', () => {
    // A set is only enumerated when both halves are written down. Each of these
    // is a live attendance path that a reader WILL find, and finding it without
    // a reason beside it reads as an oversight.
    assert.match(read('contacts/index.ts'), /TAKES NO WAIVER, and the omission is a decision/)
    assert.match(read('booking/index.ts'), /TAKES NO WAIVER, deliberately/)
    const census = read('waivers/gate.ts')
    for (const name of [
      'rebookSession',
      'joinWaitlist',
      'checkInContact',
      'createStaffAppointment',
      'selfCheckIn',
      'addEventCheckin',
      'handleEventInvitationResponse',
      'promote.ts',
    ]) {
      assert.ok(census.includes(name), `the census must name ${name}`)
    }
  })

  it('no rail OUTSIDE the census has wired the gate in — searched over the whole tree', () => {
    // The failure this catches is the one that cost the previous phase three
    // rounds: a new rail doing the right thing and never being added to the
    // list, which reads as safe and quietly makes the census wrong.
    //
    // It only catches that if the search is over the FILES, not over a list of
    // files somebody maintained by hand. The first cut searched a fixed roster
    // of fifteen paths, so a gate call in a file nobody had thought of — which
    // is the entire failure being guarded against — was invisible to the guard
    // that claimed to find it. `allSources()` walks packages/functions/src.
    const callers = allSources().filter((f) => countCalls(code(read(f)), 'enforceWaiverGate') > 0)
    assert.deepEqual(
      callers.sort(),
      [...GATED].sort(),
      'a file calls enforceWaiverGate without a row in the census in waivers/gate.ts'
    )
  })
})

describe('RULE 1 — the gate refuses ABOVE the first contact write', () => {
  it('bookSession gates before it resolves or creates a contact', () => {
    const src = read('booking/index.ts')
    const gate = at(src, 'enforceWaiverGate({')
    assert.ok(gate < at(src, 'newContactRef.set('), 'above the guest contact create')
    assert.ok(gate < at(src, 'exactMatch.ref.update('), 'above the funnel stamp')
    assert.ok(gate < at(src, 'trial_used_at: FieldValue.serverTimestamp()'), 'above the trial stamp')
  })

  it('createDropInCheckout gates above the contact create AND every reservation', () => {
    // Earlier than every other gate on this callable, deliberately: its
    // refusals otherwise sit below a minted contact, a drawn-down gift card and
    // a consumed promo use.
    const src = read('booking/dropIn.ts')
    const gate = at(src, 'enforceWaiverGate({')
    assert.ok(gate < at(src, "db.collection('contacts').doc()"), 'above the contact create')
    assert.ok(gate < at(src, 'reserveGiftCardDrawdown('), 'above the gift-card drawdown')
    assert.ok(gate < at(src, 'reservePromoRedemption('), 'above the promo use')
    assert.ok(gate < at(src, 'startOneOffCheckout('), 'above Stripe')
  })

  it('both appointment rails gate above resolveOrCreateAppointmentContact', () => {
    for (const f of ['appointments/window.ts', 'appointments/checkout.ts']) {
      const src = read(f)
      assert.ok(at(src, 'enforceWaiverGate({') < at(src, 'resolveOrCreateAppointmentContact({'), f)
    }
    const checkout = read('appointments/checkout.ts')
    assert.ok(at(checkout, 'enforceWaiverGate({') < at(checkout, 'startOneOffCheckout('))
  })

  it('the claim gates before its commit transaction opens', () => {
    const src = read('booking/waitlist/claim.ts')
    assert.ok(at(src, 'enforceWaiverGate({') < at(src, 'db.runTransaction('))
  })

  it('selfCheckIn refuses before the participant batch, and writes no acceptance', () => {
    const src = read('sessions/index.ts')
    assert.ok(at(src, 'enforceWaiverGate({') < at(src, 'batch.set(participantRef'))
    // A check-in collects no tick, so there is nothing to record. Inventing one
    // would put a signature nobody gave into a compliance ledger.
    assert.equal(countCalls(code(src), 'recordWaiverEvents'), 0)
    assert.equal(countCalls(code(src), 'planWaiverLedgerWrites'), 0)
  })
})

describe('RULE 2 — the acceptance is written WITH the commit', () => {
  it('the free rails plan inside the transaction and commit inside it', () => {
    // Not after it. Post-commit on bookSession is the zone where the partner
    // ledger and the contact alert swallow their own failures, and an
    // acceptance that can fail while the seat succeeds is an evidence hole.
    for (const f of ['booking/index.ts', 'booking/waitlist/claim.ts', 'appointments/booking.ts']) {
      const src = code(read(f))
      assert.equal(countCalls(src, 'planWaiverLedgerWrites'), 1, f)
      assert.equal(countCalls(src, 'commitWaiverLedgerWrites'), 1, f)
    }
  })

  it('the plan is made in the READ phase, before the first write of its transaction', () => {
    const src = read('booking/index.ts')
    assert.ok(at(src, 'planWaiverLedgerWrites(') < at(src, 'commitWaiverLedgerWrites('))
    assert.ok(at(src, 'commitWaiverLedgerWrites(') < at(src, 'tx.set(bookingRef'))
  })

  it('the paid rails write before Stripe, in their own transaction', () => {
    for (const f of ['booking/dropIn.ts', 'appointments/checkout.ts']) {
      const src = read(f)
      assert.equal(countCalls(code(src), 'recordWaiverEvents'), 1, f)
      assert.ok(at(src, 'recordWaiverEvents(') < at(src, 'startOneOffCheckout('), f)
    }
  })

  it('the shared appointment transaction takes the ledger only from the FREE path', () => {
    // It is shared with the paid checkout's hold and the webhook's re-acquire,
    // neither of which may mint an acceptance: the checkout already wrote one
    // before Stripe, and the webhook is a confirm.
    // Every transaction the free path runs carries the ledger: the one-date
    // booking, and a basket's holding phase (whose first date records it once).
    // Counted as calls against mentions, so a free-path call added WITHOUT a
    // ledger fails here rather than committing a seat with no signature.
    const freePath = code(read('appointments/window.ts'))
    const calls = countCalls(freePath, 'runAppointmentSlotTransaction')
    assert.ok(calls >= 1, 'the free path books through the shared transaction')
    assert.equal((freePath.match(/\bwaiverLedger:/g) ?? []).length, calls)
    for (const f of ['appointments/checkout.ts', 'appointments/staffBooking.ts', 'connect/webhook.ts']) {
      assert.equal(code(read(f)).includes('waiverLedger'), false, `${f} must not pass a ledger`)
    }
  })
})

describe('THE INVARIANTS THAT ARE GREPS', () => {
  const waiverFiles = [
    'waivers/gate.ts',
    'waivers/accept.ts',
    'waivers/requirement.ts',
    'waivers/publish.ts',
  ]

  it('W1 — no waiver code path reserves, releases or holds anything', () => {
    // The checkable form of the invariant is about IDENTIFIERS, not prose: this
    // area is full of the words "liability release" and "the row holds", and a
    // case-insensitive text grep over comments reports those forever. Comments
    // and string literals are stripped first, so what is left is code.
    for (const f of waiverFiles) {
      const src = code(read(f)).replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''")
      const hits = src.match(/\b\w*(?:[Rr]eserve|[Rr]elease|[Hh]old)\w*\b/g) ?? []
      assert.deepEqual(hits, [], `${f} must contain no reservation machinery`)
    }
  })

  it('W1 — `rounds` has exactly one writer and is never an increment', () => {
    const accept = read('waivers/accept.ts')
    assert.equal((code(accept).match(/rounds:/g) ?? []).length, 1)
    for (const f of waiverFiles) {
      assert.equal(read(f).includes('rounds: FieldValue.increment'), false, f)
    }
  })

  it('W8/W28 — no acceptance is created without its ref being read first', () => {
    const accept = code(read('waivers/accept.ts'))
    assert.ok(accept.includes('tx.get(acceptanceRef)'), 'the read-then-skip must be structural')
    // And it must be structural rather than a caught error: the journal's
    // `.create()` + catch-gRPC-6 idiom works only OUTSIDE a transaction, and an
    // implementer told to follow it will write the uncatchable version.
    for (const f of waiverFiles) {
      assert.equal(/catch[\s\S]{0,120}code === 6/.test(read(f)), false, f)
    }
  })

  it('W8 — the signer row has exactly one writer, and it is a tx.set', () => {
    const accept = code(read('waivers/accept.ts'))
    assert.equal(countCalls(accept, 'tx.set'), 1)
    assert.ok(accept.includes('tx.set(plan.signerRef, plan.signer)'))
    // Nowhere else may even build a signer reference for a write. The gate's own
    // use is a read, through getAll.
    const gate = code(read('waivers/gate.ts'))
    assert.equal(countCalls(gate, 'waiverSignerRef'), 1)
    assert.ok(gate.includes('.getAll('))
  })

  it('W6 — authorization never reads the public display mirror', () => {
    // `TeamPublicProfile.required_waivers` fails OPEN (the sync skips any id
    // whose summary is missing and writes the array anyway). The gate reads the
    // policy document, which fails CLOSED.
    // CODE, not prose: `loadWaiverPolicy`'s docblock names the mirror precisely
    // in order to say that it is the thing not being read.
    for (const f of [...waiverFiles, ...['booking/index.ts', 'booking/dropIn.ts']]) {
      assert.equal(code(read(f)).includes('required_waivers'), false, f)
    }
    assert.ok(code(read('waivers/gate.ts')).includes('WAIVER_POLICY_SUBCOLLECTION'))
  })

  it('W10 — one predicate: nothing outside the shared module compares the floor', () => {
    for (const f of [...waiverFiles, 'booking/index.ts', 'booking/dropIn.ts', 'sessions/index.ts']) {
      const src = code(read(f))
      // `min_valid_version` may be PASSED to the predicate; it may not be
      // compared to anything.
      assert.equal(/min_valid_version\s*[<>=]/.test(src), false, f)
    }
  })

  it('an unbound acceptance fails LOUDLY rather than naming nobody', () => {
    // The guest rails build the acceptance above the contact write and rebind it
    // after. A rail that forgot would otherwise write evidence at the empty id,
    // in the one collection whose whole value is naming somebody.
    const accept = code(read('waivers/accept.ts'))
    assert.ok(accept.includes('if (!input.contactId)'))
    for (const f of ['booking/index.ts', 'booking/dropIn.ts', 'appointments/window.ts', 'appointments/checkout.ts']) {
      assert.equal(countCalls(code(read(f)), 'attachWaiverContact'), 1, `${f} must rebind`)
    }
  })

  it('W11 — nothing reads the session token`s email claim to identify a signer', () => {
    for (const f of waiverFiles) {
      assert.equal(read(f).includes('token.email'), false, f)
    }
  })

  it('W21 — the price pipeline is untouched by anything waiver-shaped', () => {
    const checkout = read('connect/checkout.ts')
    const hits = (checkout.match(/waiver/gi) ?? []).length
    // Only the two rate-limit bucket constants and the paragraph that explains
    // why they are the only waiver-shaped identifiers permitted on the money path.
    assert.ok(checkout.includes("WAIVER_CHECK_RATE_LIMIT_BUCKET = 'waiver-check'"))
    // The second bucket left with the emailed-guardian mechanism it belonged to.
    // A constant nothing spends is a constant somebody re-uses for the wrong
    // thing, and this module is the money path.
    assert.equal(checkout.includes('WAIVER_GUARDIAN_RATE_LIMIT_BUCKET'), false)
    assert.ok(hits > 0 && hits < 20, 'no waiver LOGIC may appear in the money path')
    assert.equal(code(checkout).includes('enforceWaiverGate'), false)
  })
})
