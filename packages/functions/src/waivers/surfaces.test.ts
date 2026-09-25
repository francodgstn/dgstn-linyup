import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RESERVED_SLUGS } from '@linyup/shared'
import { keepOwnTeam, waiverHashVerdict } from './export'

// THE SURFACES, ASSERTED AGAINST THEIR SOURCE.
//
// This file spans the functions/web boundary on purpose, exactly as
// `connect/commitSites.test.ts` does — and for the same reason: that boundary is
// where corrections stop travelling. A consent step is only as good as the
// SUBMITS it stands in front of, and this phase's declared likeliest silent miss
// is a terminal submit that nobody counted:
//
//   • `BookingForm`'s returning-member path books from `onVerified` and never
//     renders the details form at all, so anything hung off that form is not on
//     that path;
//   • the appointment rail's `autobooking` screen books the INSTANT a covered
//     member's code verifies, with a spinner and no confirm control whatsoever.
//
// Both had already spent the caller's verification code by the time the server
// could refuse, against a three-per-hour re-request budget. So the check below
// is per FILE and per SUBMIT, re-derived from the source rather than from a list
// somebody maintained by hand — and a surface that grows a new booking call
// without a gate in front of it fails the build.
//
// Run with: pnpm --filter @linyup/functions test

const WEB = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'src')

function web(rel: string): string {
  const p = join(WEB, rel)
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

function count(src: string, needle: string): number {
  return src.split(needle).length - 1
}

// ─────────────────────────────────────────────────────────────────────────────

describe('THE SURFACE CENSUS — every terminal submit is behind the consent step', () => {
  // The owner of this list is the FILE column plus the SUBMITS column, and both
  // are checked below. Regenerate it by counting the calls to a booking callable
  // per file rather than by trusting these rows.
  const SURFACES: Array<{ file: string; submits: number; note: string }> = [
    {
      file: 'app/[locale]/(public)/public/[slug]/booking/BookingForm.tsx',
      submits: 2,
      note: 'onSubmitGuest (free + paid) and onVerified (the member path that never renders details)',
    },
    {
      file: 'components/booking/appointment/SlotBookingForm.tsx',
      submits: 3,
      note: 'onSubmitGuest, onVerifiedAppointment → autobooking, onMemberPay',
    },
    {
      file: 'app/[locale]/(public)/public/[slug]/waitlist/page.tsx',
      submits: 1,
      note: 'handleClaim; the payable hop carries the same acceptances into checkout',
    },
    {
      file: 'app/[locale]/(public)/public/[slug]/kiosk/WalkIn.tsx',
      submits: 1,
      note: 'the walk-in registration, gated like every other rail',
    },
  ]

  it('every surface resolves the requirement before it books', () => {
    for (const s of SURFACES) {
      const src = code(web(s.file))
      assert.ok(
        count(src, 'waiverGate.ensure(') >= 1,
        `${s.file} must call waiverGate.ensure before booking (${s.note})`
      )
      assert.ok(
        src.includes('useWaiverGate('),
        `${s.file} must own a gate rather than resolving inline`
      )
    }
  })

  it('every surface SENDS what it collected — a step that records nothing is theatre', () => {
    for (const s of SURFACES) {
      const src = code(web(s.file))
      assert.ok(
        count(src, 'waiverAcceptances') >= 1,
        `${s.file} must carry the ticks into its booking call`
      )
    }
  })

  it('BookingForm gates BOTH of its terminal submits, not just the one with a form', () => {
    const src = code(web(SURFACES[0].file))
    // Two `ensure` calls on the happy path plus two more in the recovery
    // branches, which re-present rather than printing a sentence with nothing
    // behind it. The floor is what matters: one per submit.
    assert.ok(count(src, 'waiverGate.ensure(') >= SURFACES[0].submits)
    // The member path is the one that never renders `details`. If its
    // interposition is ever removed, `bookSession` is called straight from
    // `onVerified` again and the refusal arrives after the code is spent.
    const verified = src.slice(src.indexOf('async function onVerified('))
    const gateAt = verified.indexOf('waiverGate.ensure(')
    const bookAt = verified.indexOf('bookSessionFn(')
    assert.ok(gateAt > -1, 'onVerified must resolve the requirement')
    assert.ok(gateAt < bookAt, 'onVerified must resolve BEFORE it calls bookSession')
  })

  it('the appointment picker gates the AUTOBOOKING path, which has no confirm control', () => {
    const src = code(web(SURFACES[1].file))
    assert.ok(count(src, 'waiverGate.ensure(') >= SURFACES[1].submits)
    const verified = src.slice(src.indexOf('async function onVerifiedAppointment('))
    const gateAt = verified.indexOf('waiverGate.ensure(')
    const bookAt = verified.indexOf('runMemberFreeBooking(')
    assert.ok(gateAt > -1, 'onVerifiedAppointment must resolve the requirement')
    assert.ok(
      gateAt < bookAt,
      'the step must be interposed BEFORE the spinner and the automatic booking'
    )
  })

  it('the queue JOIN asks for nothing — joining a queue is not a booking', () => {
    const src = code(web(SURFACES[0].file))
    const join = src.slice(src.indexOf('const onJoinWaitlist ='), src.indexOf('async function onVerified('))
    assert.equal(
      count(join, 'waiverGate.ensure('),
      0,
      'a signature taken at join belongs to a class the person may never be offered'
    )
  })
})

describe('NO RAIL DEFERS, AND THE KIOSK TOKEN STILL EARNS SOMETHING', () => {
  const fn = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

  // Two rails used to complete with a waiver outstanding. Both exceptions
  // existed only for a guardian's EMAILED signature, both are gone with it, and
  // the property that replaces them is simpler and checkable: no rail passes a
  // posture, because there is no posture to pass.
  it('no rail asks the gate for anything but the gate', () => {
    for (const rel of [
      'booking/index.ts',
      'booking/dropIn.ts',
      'booking/waitlist/claim.ts',
      'appointments/window.ts',
      'appointments/checkout.ts',
      'sessions/index.ts',
      'waivers/space.ts',
    ]) {
      assert.equal(count(code(fn(rel)), 'guardianPolicy'), 0, rel)
    }
  })

  it('and no booking in the product commits with a waiver unsigned', () => {
    // `BookingWaiverState` used to carry `outstanding`, produced by the claim
    // rail alone. Its removal is the checkable form of "every rail refuses".
    const shared = readFileSync(
      join(__dirname, '..', '..', '..', 'shared', 'src', 'types', 'waiver.ts'),
      'utf8'
    )
    assert.equal(shared.includes("| 'outstanding'"), false)
  })

  // THE SURVIVOR. The kiosk token no longer selects a gate behaviour — but it
  // still decides the one value a caller might want to CLAIM in an evidence
  // record, which is exactly why it must remain an identity rather than a
  // string off the request body.
  it('a verified pairing, and only that, may stamp `source: kiosk` on the ledger', () => {
    const src = code(fn('booking/index.ts'))
    assert.match(src, /const isKiosk = await isKioskDeviceForTeam\(request, data\.teamId\)/)
    assert.match(src, /source: isKiosk \? '' : ''/)
    assert.doesNotMatch(
      src,
      /const isKiosk = parseBookingSource/,
      'a client-supplied source string must never decide what a record claims'
    )
  })
})

describe("THE REFUSAL TABLE — every reason a visitor can hit has copy", () => {
  const libWaiver = web('lib/waiver.ts')
  const gateSrc = readFileSync(join(__dirname, 'gate.ts'), 'utf8')
  const en = JSON.parse(
    readFileSync(join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'messages', 'en.json'), 'utf8')
  ) as { Waiver: Record<string, string> }

  const clientReasons = [...libWaiver.matchAll(/^\s+'(waiver_[a-z_]+)',$/gm)].map((m) => m[1])

  it('the client table is not empty and every entry has a translated string', () => {
    assert.ok(clientReasons.length > 0)
    for (const reason of clientReasons) {
      assert.ok(
        en.Waiver[`reason_${reason}`],
        `reason_${reason} must have copy — the previous phase shipped a public surface rendering internal English because one refusal had none`
      )
    }
  })

  it('every reason the SERVER can raise is in the client table', () => {
    // Re-derived from the source of both throwing modules, so a new refusal that
    // nobody adds to the client table fails here rather than reaching a French
    // visitor as English prose.
    const serverReasons = new Set<string>()
    for (const m of gateSrc.matchAll(/reason:\s*'(waiver_[a-z_]+)'/g)) serverReasons.add(m[1])
    for (const m of gateSrc.matchAll(/\|\s*'(waiver_[a-z_]+)'/g)) serverReasons.add(m[1])
    for (const reason of serverReasons) {
      assert.ok(
        clientReasons.includes(reason),
        `${reason} is raised by the server and missing from WAIVER_REFUSAL_REASONS`
      )
    }
  })
})

describe('THE CHIP — unknown renders NOTHING', () => {
  it('an absent state produces no chip, and `valid` produces no chip either', () => {
    const src = web('components/WaiverChip.tsx')
    assert.match(src, /if \(!shown\) return null/)
    // The tri-state the subscription badge on the same page already uses: a chip
    // that appears because a read failed is an accusation about somebody
    // standing at a door.
    assert.match(src, /if \(!state \|\| state === 'valid'\) return null/)
  })

  it('the printed form carries a STROKE and a word, never a fill', () => {
    const src = web('components/WaiverChip.tsx')
    const printBranch = src.slice(src.indexOf('if (print)'), src.indexOf('return (\n    <span'))
    assert.ok(!/bg-(amber|red|destructive)/.test(printBranch), 'a coloured pill prints as invisible text')
    assert.match(printBranch, /AlertTriangle/)
  })

  // THE DOOR CHECK'S PRINTED FORM, on the same constraint as its sibling: the
  // day sheet's backgrounds are forced transparent by globals.css and most
  // browsers drop background graphics anyway, so a filled pill prints as
  // invisible text.
  it('the DOOR CHECK also prints as a stroke and a word', () => {
    const src = web('components/WaiverChip.tsx')
    const fn = src.slice(src.indexOf('export function WaiverDoorCheckChip'))
    const printBranch = fn.slice(fn.indexOf('if (print)'), fn.indexOf('return (\n    <span'))
    assert.ok(!/bg-(sky|amber|red|destructive)/.test(printBranch), 'a coloured pill prints as invisible text')
    assert.match(printBranch, /UserCheck/)
  })

  // ONE RULE, TWO READERS. The roster reads the live signer row and the manifest
  // reads the booking's stamp; both must go through the shared derivation rather
  // than restate it, which is what `gate.test.ts` asserts they agree about.
  it('both chip surfaces derive the check from @linyup/shared, not from a local copy', () => {
    assert.match(code(web('hooks/useWaiverStates.ts')), /waiverDoorCheckFor\(/)
    assert.match(
      code(web('app/[locale]/(auth)/manifest/page.tsx')),
      /waiverDoorCheckFromBookingState\(/
    )
    // The session roster is the live one, so it must be reading the hook's map
    // rather than a booking stamp.
    assert.match(code(web('app/[locale]/(auth)/sessions/[id]/page.tsx')), /waiverRoster\.checks/)
  })
})

describe('THE SELF-DECLARATION IS REQUIRED, AND HAS NO DEFAULT', () => {
  // "Required" has to be CHECKABLE, or it is a label on a form. And "no default"
  // is the other half: the record attributes the answer to the person who
  // ticked, so the product must not supply one on their behalf.

  it('a flagged waiver is not satisfied locally until the visitor CHOOSES', () => {
    // The tick alone clears an unflagged waiver — the flag off changes nothing,
    // which is the point. A flagged one also needs an answer.
    assert.match(
      code(web('lib/waiver.ts')),
      /return item\.mayIncludeMinors \? choice !== null : true/
    )
  })

  it('no radio is preselected', () => {
    // `checked` is compared against the STORED choice, which starts undefined —
    // so neither radio is on until the visitor puts it there.
    assert.match(code(web('components/booking/WaiverStep.tsx')), /checked=\{choice === value\}/)
  })

  it('the surrounding Confirm is gated through the same predicate', () => {
    // The step does not own its own enabled-ness: `ready` on the gate does, and
    // it is what every surface's Confirm reads.
    assert.match(code(web('hooks/useWaiverGate.ts')), /waiverSatisfiedLocally\(/)
  })

  it('and it gates NOTHING on the server — the booking goes through either way', () => {
    // The flag is a prompt, not an enforcement. `decideWaiverGate` has no arm
    // that reads the declaration, and `declarationFor` only ever produces a
    // value to RECORD.
    const gate = code(readFileSync(join(__dirname, 'gate.ts'), 'utf8'))
    const decision = gate.slice(
      gate.indexOf('export function decideWaiverGate'),
      gate.indexOf('export function declarationFor')
    )
    assert.equal(decision.includes('signingAsGuardian'), false)
    assert.equal(decision.includes('guardianName'), false)
  })
})

describe('SPACE — a member can put a superseded signature right', () => {
  it('the Space signing path is NOT an attendance rail and says so', () => {
    const src = readFileSync(join(__dirname, 'space.ts'), 'utf8')
    assert.match(src, /NOT IN waivers\/gate\.ts's CENSUS/)
    // It composes the same pieces rather than re-deriving validity, which is the
    // whole reason it may sit outside the census without a second answer to
    // "does this tick count".
    for (const piece of [
      'loadWaiverPolicy',
      'decideWaiverGate',
      'resolveWaiverSubmissions',
      'recordWaiverEvents',
    ]) {
      assert.ok(code(src).includes(piece), `space.ts must compose ${piece}`)
    }
    assert.equal(count(code(src), 'enforceWaiverGate('), 0)
  })

  it('the gate census names it, so a reader who finds it has the reason beside it', () => {
    assert.match(readFileSync(join(__dirname, 'gate.ts'), 'utf8'), /waivers\/space\.ts/)
  })

  // THE DEAD END. Space resolved `applicableWaivers(policy, null)`, which
  // EXCLUDES an `activities`-scoped waiver — the right answer for a gate with no
  // activity in hand, and the wrong one here. Meanwhile `selfCheckIn` and the
  // mobile scanner refuse over exactly that waiver and attach a `signUrl`
  // pointing INTO Space. A member standing at a door was sent to the one surface
  // that could neither show nor sign the document refusing them, and there was
  // no other route: they need never have opened a booking form.
  it('it resolves the WHOLE policy, so an activity-scoped waiver is signable here', () => {
    const src = code(readFileSync(join(__dirname, 'space.ts'), 'utf8'))
    assert.ok(
      /applicable: RequiredWaiverEntry\[\] = await loadWaiverPolicy\(/.test(src),
      'the member portal answers for every required waiver, not only the all-bookings ones'
    )
    assert.equal(
      count(src, 'applicableWaivers('),
      0,
      'scoping to an activity that does not exist here is what made this a dead end'
    )
  })

  it('an untouched waiver does not refuse the ones the member DID sign', () => {
    // The widening makes "two outstanding documents, one of them signable by the
    // member" the ordinary shape rather than the rare one — a guardian-required
    // or age-unknown sibling would otherwise fail the whole call and record
    // nothing at all. Space is not a rail: an untouched waiver is simply still
    // outstanding, and the panel still shows it.
    const src = code(readFileSync(join(__dirname, 'space.ts'), 'utf8'))
    assert.match(
      src,
      /const submitted = submissions\.some\(\(s\) => s\.documentId === step\.details\.documentId\)\s*\n\s*if \(!submitted\) continue/
    )
    // …but a refusal about something they DID submit is still thrown, or a
    // member ticks a box and is told nothing happened.
    assert.ok(src.includes("throw new HttpsError('', ''"))
  })

  it('the surface asks for the same set, and the server honours it only for a session', () => {
    const card = code(
      web('app/[locale]/(public)/public/[slug]/space/SpaceWaiverCard.tsx')
    )
    assert.ok(card.includes("surface: ''"), 'the Space card must ask as the Space')
    const req = code(readFileSync(join(__dirname, 'requirement.ts'), 'utf8'))
    assert.match(
      req,
      /data\.surface === '' && caller\.proof === '' \? policy : scoped/,
      'the widening belongs to a signed-in member, not to any caller who asks'
    )
  })

  it('the refusal that sends a member here still points here', () => {
    // If this link is ever dropped, the surface above stops being the answer to
    // anything and the two halves of this fix come apart.
    const checkIn = code(readFileSync(join(__dirname, '..', 'sessions', 'index.ts'), 'utf8'))
    // LOCALE-PINNED since UX-97: the link is built with `localizedPublicUrl` so
    // the page answers in the studio's language rather than falling through to
    // English. What this test guards is the DESTINATION, not the builder — so it
    // matches the space route and the slug, and tolerates the locale argument
    // between them.
    assert.match(checkIn, /signUrl: localizedPublicUrl\([\s\S]{0,200}?teamSlug,\s*''/)
  })
})

describe('THE REQUIREMENT CALLABLE CHARGES AT THE TOP, ONCE, AND NEVER FOR THE ANSWER', () => {
  const src = readFileSync(join(__dirname, 'requirement.ts'), 'utf8')

  // Three cuts of this limiter, three failures, and the shape of each is worth
  // keeping in front of whoever edits it next:
  //   1. charge every call at 30/hour  → a gym, a school or a doorway tablet on
  //      one address could not read what it was being asked to sign;
  //   2. charge only the arm that recognised somebody → every returning walk-in
  //      IS that arm, so the doorway locked itself out after thirty people, and
  //      the counter was unreachable for a caller who supplied no address at all;
  //   3. this one: one unit, at the top, for an uncredentialed caller asking
  //      about a person. The disclosure is bounded by being withdrawn, not
  //      rationed — see the `ambiguousCaller` assertions below.
  it('charges once, before any query, and nothing at the bottom', () => {
    const c = code(src)
    const charge = c.indexOf('chargeWaiverResolve(')
    const firstRead = c.indexOf('loadWaiverPolicy(')
    assert.ok(charge > -1 && firstRead > -1)
    assert.ok(charge < firstRead, 'a spent IP must be refused before it costs a read')
    assert.equal(count(c, 'chargeWaiverResolve('), 1, 'one charge, or it is two rules')
    // The mechanism is reached ONLY through the model module: a direct call to
    // the raw limiter here is how the last two cuts grew a second rule.
    assert.equal(count(c, 'checkoutRateLimit('), 0)
    assert.equal(count(c, 'spendRateLimit('), 0)
  })

  it('the charge is decided by claims and by the request, never by the answer', () => {
    const c = code(src)
    const charge = c.indexOf('chargeWaiverResolve(')
    const resolveCaller = c.indexOf('resolveWaiverCaller(')
    assert.ok(
      charge < resolveCaller,
      'deciding after the caller resolves is deciding on who they turned out to be'
    )
    assert.match(c, /credential: waiverCallerCredential\(request, data\.teamId\)|credential,/)
    assert.match(c, /asksAboutAPerson:/)
  })

  it('the enumeration bit is GONE from every layer, not rationed', () => {
    // A ration on "does this address belong to somebody here" is still an
    // answer to it, and the field had no reader on either side of the wire.
    for (const [label, text] of [
      ['requirement.ts', src],
      ['caller.ts', readFileSync(join(__dirname, 'caller.ts'), 'utf8')],
      ['apps/web/src/lib/waiver.ts', web('lib/waiver.ts')],
      ['apps/web/src/hooks/useWaiverGate.ts', web('hooks/useWaiverGate.ts')],
    ] as const) {
      assert.equal(code(text).includes('ambiguousCaller'), false, label)
      assert.equal(code(text).includes('ambiguous:'), false, label)
    }
  })

  it('the conservative branch returns the same shape for a known and an unknown address', () => {
    // Byte-identical but for the address the caller themselves typed: whichever
    // it was is precisely the fact an enumerator came for.
    const caller = readFileSync(join(__dirname, 'caller.ts'), 'utf8')
    const returns = [...caller.matchAll(/return \{ contactId: null, proof: 'none'[^}]*\}/g)].map(
      (m) => m[0].replace(/email: \w+/, 'email: X')
    )
    assert.equal(returns.length, 2, 'the no-email and the no-match branch')
    assert.equal(returns[0], returns[1])
  })
})

describe('THE EXPORT — both queries, never merged, and NEITHER leaves the tenant', () => {
  const src = readFileSync(join(__dirname, 'export.ts'), 'utf8')

  // The defect: `identity_key` ran as an UNSCOPED collection-group query. A
  // collection group spans every tenant and an identity key is sha256(an email
  // address), so a manager at studio A exporting their own member received
  // studio B's members' signature rows — names, addresses, consent history —
  // printed into an artefact under studio A's letterhead.
  it('every collection-group pass filters on teamId FIRST', () => {
    const groups = [...src.matchAll(/collectionGroup\([^)]*\)([\s\S]{0,200})/g)].map((m) => m[1])
    assert.ok(groups.length > 0, 'the census must find the queries it is checking')
    for (const q of groups) {
      assert.match(
        q,
        /\.where\('teamId', '==', teamId\)/,
        'a collection group spans every tenant — the team filter is the boundary'
      )
    }
  })

  it('teamId is a REQUIRED parameter, so the unscoped call cannot be written', () => {
    assert.match(src, /field: 'contactId' \| 'identity_key',\s*value: string,\s*teamId: string/)
  })

  it('a manager at team A receives ZERO rows belonging to team B', () => {
    // Driven through the pure guard the query result passes on its way out, so
    // the cross-tenant case is asserted rather than assumed — and so a loosened
    // filter or a changed index still cannot print another studio's records.
    const rows = [
      { id: 'a1', data: { teamId: 'team-A', signer_name: 'Anna' } },
      { id: 'b1', data: { teamId: 'team-B', signer_name: 'Another studio member' } },
      { id: 'b2', data: { teamId: 'team-B', signer_name: 'Another studio member' } },
      { id: 'x1', data: {} },
    ]
    const kept = keepOwnTeam(rows, 'team-A')
    assert.deepEqual(
      kept.map((r) => r.id),
      ['a1']
    )
    assert.equal(
      kept.filter((r) => r.data.teamId === 'team-B').length,
      0,
      "another tenant's consent records must never reach this artefact"
    )
  })

  it('an unattributable row is dropped, never printed under a studio name', () => {
    assert.deepEqual(keepOwnTeam([{ id: 'x', data: {} }], 'team-A'), [])
  })

  it('runs the identity-key query for an operator and NEVER for a member', () => {
    assert.match(src, /loadEvents\('identity_key'/)
    // `self` is the member's own download. Handing them the identity-key rows
    // would show them a household's records under their own name.
    assert.match(src, /scope === 'operator' \? loadEvents\('identity_key'/)
  })

  it('renders the two sets in separate sections', () => {
    assert.match(src, /other_records_for_this_email/)
    assert.ok(
      src.indexOf('an email address is not a person') > -1 ||
        /email address is not a person/i.test(src),
      'the header must say that an email address is not a person'
    )
  })

  it('prints a hash verdict, and names the repair path on a mismatch', () => {
    assert.match(src, /hash_verdict/)
    assert.match(src, /verify-waiver-ledger/)
  })

  // The artefact stamped `version_missing` — an integrity ALARM, with "run the
  // checker" printed beside it — on every single row of the other-records
  // section, because that section was rendered against an empty version map. A
  // section of false alarms teaches its reader to ignore the one that is real.
  it('the verdict is a verdict: match, mismatch and missing are all reachable', () => {
    assert.equal(waiverHashVerdict({ bodyHash: 'h1' }, 'h1'), 'match')
    assert.equal(waiverHashVerdict({ bodyHash: 'h1' }, 'h2'), 'mismatch')
    assert.equal(waiverHashVerdict(null, 'h1'), 'version_missing')
  })

  it('the other-records rows are checked against the REAL versions, not an empty map', () => {
    assert.match(
      src,
      /versionsByDocument\.get\(e\.data\.documentId\) \?\? new Map\(\)/,
      'those documents’ versions are loaded so the verdict can say "match"'
    )
    assert.doesNotMatch(
      src,
      /toExportEvent\(e\.id, e\.data, otherTitles\.get\(e\.data\.documentId\) \?\? e\.data\.documentId, new Map\(\)\)/,
      'rendering a whole section against an empty map is the false alarm itself'
    )
    // The TEXT stays unmaterialised there, deliberately — that part was right.
    assert.match(src, /bodyHtml: null/)
  })
})

describe('THE RETIRED SIGNING ROUTE STAYS RETIRED', () => {
  it('the page is gone, and no route type names it', () => {
    const routes = readFileSync(
      join(__dirname, '..', '..', '..', 'shared', 'src', 'publicRoutes.ts'),
      'utf8'
    )
    assert.equal(routes.includes("'waiver'"), false, 'PublicRoutable must not name a page that does not exist')
    assert.equal(
      existsSync(join(WEB, 'app', '[locale]', '(public)', 'public', '[slug]', 'waiver')),
      false
    )
  })

  it('but the SLUG stays reserved — freeing it is a data decision, and irreversible', () => {
    // Safe today, and irreversible the moment one team claims it: re-reserving
    // the word later would mean renaming somebody's public URLs. This is the
    // only entry in RESERVED_SLUGS with no matching route, and it is deliberate.
    assert.ok(RESERVED_SLUGS.includes('waiver'))
  })
})

describe('AN ARCHIVED WAIVER SAYS SO — the badge, and the button behind it', () => {
  it('archiveWaiver writes `status`, which every surface reads archived-ness off', () => {
    // It wrote only `archived_at`, so an archived waiver kept rendering as
    // **Published** — over a live Publish button that `publishDocumentVersion`
    // then refused by name (`document_archived`). A control that is always an
    // error is worse than no control.
    const src = code(readFileSync(join(__dirname, 'publish.ts'), 'utf8'))
    const archive = src.slice(src.indexOf('export const archiveWaiver'))
    assert.match(archive, /status: '' as DocumentStatus/)
    assert.match(archive, /archived_at: FieldValue\.serverTimestamp\(\)/)
    // isPublic can only be true while published — the same clearing
    // `setDocumentStatus` does for every other kind.
    assert.match(archive, /isPublic: false/)
  })

  it('the page derives the state from both fields, so an old archive is not a lie', () => {
    const page = code(
      web('app/[locale]/(auth)/documents/[documentId]/page.tsx')
    )
    assert.match(page, /const isArchived = draft\.status === '' \|\| draft\.archived_at != null/)
    assert.match(page, /const isPublished = draft\.status === '' && !isArchived/)
  })
})

describe('A WAIVER DOCUMENT IS CALLABLE-ONLY — all three verbs, not two', () => {
  const rules = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'firestore.rules'),
    'utf8'
  ).replace(/\r\n/g, '\n')
  const block = (): string => {
    const start = rules.indexOf('match /documents/{documentId}')
    assert.notEqual(start, -1, 'expected a documents/{documentId} rules block')
    return rules.slice(start, rules.indexOf('match /versions/{versionId}', start))
  }

  it('create, update AND delete each exclude kind == waiver', () => {
    // The invariant said all three; the rule said two. A client-deletable waiver
    // draft orphans whatever the ledger already wrote under it — signup consent
    // lands on an UNPUBLISHED document — leaving rows whose only address begins
    // with a document that is gone.
    const b = block()
    for (const verb of ['allow create', 'allow update', 'allow delete']) {
      const i = b.indexOf(verb)
      assert.notEqual(i, -1, `expected ${verb} in the documents block`)
      const clause = b.slice(i, b.indexOf(';', i))
      assert.match(
        clause,
        /get\('kind', 'other'\) != 'waiver'/,
        `${verb} must exclude kind == 'waiver'`
      )
    }
  })

  it('and no callable deletes one either — archiving is the retire path', () => {
    const src = code(readFileSync(join(__dirname, 'publish.ts'), 'utf8'))
    assert.equal(src.includes('.delete('), false, 'no waiver callable may delete a document')
    assert.ok(src.includes('export const archiveWaiver'))
  })

  it('the page hides the control, so the rule is not a live button that always errors', () => {
    const page = code(web('app/[locale]/(auth)/documents/[documentId]/page.tsx'))
    assert.match(page, /!hasEverPublished && !isWaiver/)
  })
})

describe('A RENAME REACHES THE POLICY — the title the member reads is the entry’s', () => {
  const src = code(readFileSync(join(__dirname, 'publish.ts'), 'utf8'))
  const update = src.slice(src.indexOf('export const updateWaiver'), src.indexOf('coerceOutcome'))

  it('the fast path is chosen on what the ENTRY carries, not on content-vs-settings', () => {
    // `RequiredWaiverEntry` carries the title. Splitting on content-vs-settings
    // therefore let a rename skip the policy patch: every studio-side surface
    // showed the new name and the consent step showed the old one, until some
    // later publish happened to rewrite the entry.
    assert.match(update, /touchesPolicyEntry = touchesSettings \|\| nextTitle !== null/)
    assert.match(update, /if \(!touchesPolicyEntry\) \{/)
    // …and the old split is gone, not merely supplemented.
    assert.doesNotMatch(update, /if \(!touchesSettings\) \{\s*await doc\.ref\.update/)
  })

  it('the entry is built from the document AS PATCHED, not as read', () => {
    // policySourceFrom reads the pre-patch snapshot, so taking the fast path out
    // is only half the fix: without the overlay the transaction would faithfully
    // rewrite the stale title.
    assert.match(update, /nextTitle === null \? \{\} : \{ title: nextTitle \}/)
  })

  it('a body-only save still costs no policy read', () => {
    assert.match(update, /patch\.body = /)
    assert.ok(
      update.indexOf('patch.body = ') < update.indexOf('touchesPolicyEntry'),
      'the body arm must not set nextTitle'
    )
    assert.equal(
      (update.match(/nextTitle = /g) ?? []).length,
      1,
      'exactly one arm — the title arm — may set nextTitle'
    )
  })
})

describe('THE SIGNER’S ADDRESS IS THE SIGNER’S — not the subject’s, on the OTP rails', () => {
  const gate = code(readFileSync(join(__dirname, 'gate.ts'), 'utf8'))

  it('buildAcceptance READS signerEmail — a declared-and-unread field is worse than none', () => {
    assert.match(gate, /signerEmail: params\.signerEmail \|\| email \|\| ''/)
  })

  it('the identity key still binds to the SUBJECT, so a parent’s row never merges a child’s', () => {
    assert.match(gate, /identityKey: contactIdentityKey\(\{ email, contactId \}, sha256Hex\)/)
  })

  it('every rail that validates a code passes the address the code was mailed to', () => {
    // A record claiming `verified_code` beside the contact's own address asserts
    // a mailbox proof for whoever the booking is FOR — which on these three
    // rails is routinely somebody else.
    const rails: [string, RegExp][] = [
      ['../booking/index.ts', /signerEmail: verifiedSignerEmail/],
      ['../appointments/window.ts', /signerEmail: caller\.verifiedEmail/],
      ['../appointments/checkout.ts', /signerEmail: caller\.verifiedEmail/],
    ]
    for (const [rel, re] of rails) {
      assert.match(code(readFileSync(join(__dirname, rel), 'utf8')), re, rel)
    }
    // …and it comes off the CODE document, never off the request body.
    const resolver = code(readFileSync(join(__dirname, '..', 'appointments', 'booking.ts'), 'utf8'))
    assert.match(resolver, /verifiedEmail: \(\(cd\.email as string \| undefined\) \?\? ''\)/)
  })

  it('the caller resolver carries no such field, because its consumer writes none', () => {
    // `resolveWaiverRequirement` is read-only, so a `verifiedEmail` there would
    // have no reader at all.
    const caller = code(readFileSync(join(__dirname, 'caller.ts'), 'utf8'))
    assert.equal(caller.includes('verifiedEmail'), false)
  })
})

describe('THE SELF-DECLARATION REACHES THE TAB, AND IS LABELLED AS ONE', () => {
  it('the signer row copies signer_role off the winning event', () => {
    // The tab reads the signer row and never the events, so a fact that stops at
    // the event is a fact the studio is never shown.
    const accept = code(readFileSync(join(__dirname, 'accept.ts'), 'utf8'))
    assert.match(accept, /signer_role: event\.signer_role/)
  })

  it('a guardian row is printed as SELF-DECLARED, in the tab and in the export', () => {
    const raw = web('plugins/documents/WaiverSigners.tsx')
    assert.match(code(raw), /signer\.signer_role === ''/)
    // The key lives in a string literal, which `code()` blanks.
    assert.match(raw, /t\('roleSelfDeclared'\)/)
    for (const locale of ['en', 'de', 'fr', 'it']) {
      const messages = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'messages', `${locale}.json`),
        'utf8'
      )
      assert.ok(messages.includes('"roleSelfDeclared"'), `${locale}.json must carry the key`)
    }
    // And the artefact a lawyer reads says it in as many words, rather than
    // printing "guardian" as though something had checked.
    const exportSrc = readFileSync(join(__dirname, 'export.ts'), 'utf8')
    assert.match(exportSrc, /SELF-DECLARATION/)
    assert.match(exportSrc, /self-declaration made on the consent step/)
  })
})

describe('EXPORT BEFORE TEARDOWN (Q13)', () => {
  const root = join(__dirname, '..', '..', '..', '..')
  const lib = readFileSync(join(root, 'scripts', 'lib', 'exportConsentLedger.ts'), 'utf8')
  const reader = readFileSync(join(__dirname, 'consentExport.ts'), 'utf8')

  it('the sandbox/lead script paths export before recursiveDelete', () => {
    for (const rel of ['scripts/reset-sandbox-db.ts', 'scripts/seed-lead.ts']) {
      const c = code(readFileSync(join(root, rel), 'utf8'))
      assert.ok(c.includes('requireConsentExport('), `${rel} must export before it deletes`)
      assert.ok(
        c.indexOf('requireConsentExport(') < c.indexOf('recursiveDelete('),
        `${rel} must export BEFORE the first delete, not after`
      )
    }
  })

  // The two PRODUCTION paths that erase a real studio through purgeTeam — the
  // exact paths A4 found unguarded. The CLI writes to disk; the scheduled Cloud
  // Function has no disk and writes to GCS. Their delete primitive is purgeTeam,
  // not recursiveDelete.
  it('the CLI purge-team.ts exports (to disk) before the real purgeTeam', () => {
    const c = code(readFileSync(join(root, 'scripts', 'purge-team.ts'), 'utf8'))
    assert.ok(c.includes('requireConsentExport('), 'purge-team.ts must export before it deletes')
    assert.ok(
      c.indexOf('requireConsentExport(') < c.indexOf('purgeTeam(teamId!, false)'),
      'purge-team.ts must export BEFORE the real purgeTeam, not after'
    )
  })

  it('the scheduled purge exports (to GCS) before purgeTeam', () => {
    const c = code(readFileSync(join(__dirname, '..', 'dailyTasks', 'purgeScheduledTeams.ts'), 'utf8'))
    assert.ok(
      c.includes('requireTeamConsentExportToGcs('),
      'purgeScheduledTeams must export before it deletes'
    )
    assert.ok(
      c.indexOf('requireTeamConsentExportToGcs(') < c.indexOf('purgeTeam(teamId, false)'),
      'purgeScheduledTeams must export BEFORE purgeTeam, not after'
    )
  })

  // The ONE exemption, stated as explicitly as the inclusions: purgeUnverifiedSignups
  // only sweeps UNTOUCHED teams, which by definition hold no signature.
  it('purgeUnverifiedSignups NAMES its exemption and calls no exporter', () => {
    const src = readFileSync(join(__dirname, '..', 'dailyTasks', 'purgeUnverifiedSignups.ts'), 'utf8')
    assert.match(src, /WHY NO CONSENT EXPORT HERE/)
    assert.equal(code(src).includes('requireConsentExport('), false)
    assert.equal(code(src).includes('requireTeamConsentExportToGcs('), false)
  })

  it('a failed export REFUSES the run rather than proceeding on a guess', () => {
    // The scripts gate throws; the shared reader throws on a failed read; the GCS
    // gate does not catch its upload — a failure propagates to the scheduled
    // caller, which leaves the team scheduled and retries.
    assert.match(lib, /throw err/)
  })

  it('the ONE shared reader archives the four subcollections a signature is made of', () => {
    for (const name of ['versions', 'acceptances', 'signers', 'notices']) {
      assert.ok(reader.includes(`collection('${name}')`), `the archive must carry ${name}`)
    }
    // …and nothing that no longer exists: `guardian_requests` went with the
    // emailed-guardian mechanism, and a read of a collection nobody writes is a
    // read that quietly starts describing a shape the product does not have.
    assert.equal(reader.includes('guardian_requests'), false)
  })

  it('the fs exporter DELEGATES to the shared reader — no re-inlined read loop to drift', () => {
    assert.ok(lib.includes('readTeamConsentLedger('), 'the fs exporter must use the shared reader')
    // The read of the four subcollections must live in ONE place, not be copied
    // back into the script — that copy is exactly the drift this guards.
    assert.equal(lib.includes("collection('acceptances')"), false)
  })
})
