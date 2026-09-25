import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'

// THE PUBLIC-SURFACE IDENTITY CENSUS — every route under `/public/{slug}/*`,
// and how it learns WHO is in front of it.
//
// It spans the functions/web boundary for the same reason `waivers/surfaces.test.ts`
// and `connect/commitSites.test.ts` do: that boundary is where corrections stop
// traveling. Run with: pnpm --filter @linyup/functions test
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `PublicContactAuthProvider` is mounted at the team root (`[slug]/layout.tsx`),
// so a signed-in contact's session is in context on EVERY public surface, and
// the session's ID token rides on every callable any of them makes. A surface
// that does not read it is not neutral about identity — it is WRONG about it,
// silently, because the server is not:
//
//   `resolveAppointmentCaller` (and `bookSession`, and the promo resolver)
//   checks the contact session FIRST and returns before it looks at anything in
//   the request body. So a surface that renders a guest form to a signed-in
//   contact collects details the server discards, quotes a price the server does
//   not charge, and — on the appointment rail as shipped until this census —
//   routed a covered member into `createAppointmentCheckout`, which refused
//   `{ reason: 'covered' }` and was rendered to them as "This slot is no longer
//   available." That is a hard block on the studio's own subscribers, and it
//   was found by reading ONE file that a bug report happened to name.
//
// The report named one surface. This census names them all, and is re-derived
// from the route tree rather than from a list somebody maintained by hand, so a
// NEW public surface that forgets the session fails the build instead of
// shipping with the same defect.
//
// ── WHAT COUNTS AS CONSUMING ────────────────────────────────────────────────
// The route's OWN component tree must call `usePublicContactAuth` (or the Space
// back-compat alias `useSpaceAuth`). Inheriting the sign-in pill from the layout
// does NOT count: the pill shows a name in the corner, which is not the same as
// the surface knowing who it is booking for. Only relative imports inside the
// `[slug]` tree are followed — shared `@/components` are surface-agnostic by
// construction, and following the layout would make every route pass for free.

const WEB = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'src')
const SLUG_ROOT = join(WEB, 'app', '[locale]', '(public)', 'public', '[slug]')

/** Strip comments so a grep cannot match prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Strip comments AND string literals — for greps whose needle could otherwise
 *  be satisfied by a quoted name rather than by a call. */
function code(src: string): string {
  return stripComments(src)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** Every `page.tsx` under the tenant root, named by its route segment path
 *  ('' for the tenant root itself). */
function routes(dir: string = SLUG_ROOT): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routes(full))
    else if (entry.name === 'page.tsx') {
      out.push(relative(SLUG_ROOT, dir).split(sep).join('/'))
    }
  }
  return out.sort()
}

/** Resolve a relative import specifier to a file inside the `[slug]` tree. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = join(dirname(fromFile), spec)
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    join(base, 'index.tsx'),
    join(base, 'index.ts'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** The route's own component tree: its page plus everything it pulls in by
 *  relative path, transitively. Layouts are deliberately excluded. */
function treeOf(route: string): string[] {
  const entry = join(SLUG_ROOT, ...(route ? route.split('/') : []), 'page.tsx')
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const next = resolveLocal(file, m[1])
      if (next) queue.push(next)
    }
  }
  return [...seen]
}

function consumesSession(route: string): boolean {
  return treeOf(route).some((f) => {
    const src = code(readFileSync(f, 'utf8'))
    return src.includes('usePublicContactAuth(') || src.includes('useSpaceAuth(')
  })
}

// ── THE REASONS ─────────────────────────────────────────────────────────────
// A route may decline to read the session — but the reason has to be WRITTEN
// DOWN and has to be about how that route identifies its visitor instead. An
// entry that turns out to be false (the route does consume it, or the route no
// longer exists) fails this file, so these cannot rot into folklore.
const REASONS: Record<string, string> = {
  '':
    'The bio-link root is a link menu — it books, buys and shows nothing. The ' +
    'sign-in pill from the layout is the whole of its identity story.',
  appointments:
    'A redirect shim since the funnels merged: it forwards its query to /booking, ' +
    'where an appointment is a step rather than a route of its own. There is no ' +
    'visitor to identify on a redirect.',
  'appointments/cancel':
    'The `?token=` in the appointment\'s own confirmation mail IS the identity, and ' +
    '`cancelBooking` accepts nothing else. A session would be a second, weaker answer ' +
    'to a question the token already answers exactly.',
  'contact-update':
    'Runs its OWN email→code round trip (sendContactVerificationCode + verifyContactCode) ' +
    'against the `?contactId=` in the mailed link. NOT a clean reason and recorded as ' +
    'such: a contact who is already signed in is still made to fetch a code. Closing it ' +
    'means deciding whether `verifyContactCode` accepts a session as proof, which is a ' +
    'change to that callable and not to this surface.',
  documents:
    'Publishes world-readable document summaries. Nothing on it is per-person, so there ' +
    'is no identity for it to be wrong about.',
  'documents/[documentSlug]':
    'Same as its index — a published document, world-readable, identical for everyone.',
  events:
    'Lists PUBLISHED event summaries from the world-readable public_profile mirrors. An ' +
    'event is either published for everyone or absent for everyone, so nothing on this ' +
    'page is per-person and there is no identity for it to be wrong about. Attending is ' +
    'not transacted here: RSVP runs off the `?token=` in the invitation mail.',
  'events/[eventId]':
    'Same as its index — one published event and its program, world-readable and ' +
    'identical for everyone. The mirror deliberately carries no per-person field (and no ' +
    'internal note), so a session could not change a single thing it renders.',
  'events/[eventId]/print':
    'The printable sheet of the same world-readable mirror. Paper has no session, and the ' +
    'page renders exactly what the detail route does for every visitor.',
  kiosk:
    'The entrance tablet holds a DEVICE-pairing session (KioskLock), not a contact one, ' +
    'and deliberately shows no contact identity: it is a shared screen in a doorway, ' +
    'where "signed in as" is a privacy leak rather than a courtesy. Its walk-in rail ' +
    'books guests through `bookSession` with `source: kiosk`.',
  'manage-booking':
    'The `?token=` in the booking\'s own mail is the identity; `getBookingByToken` / ' +
    '`cancelBooking` / the reschedule take nothing else.',
  'trial-booking':
    'A redirect shim: the route forwards to `/booking` with its query intact. It renders ' +
    'no UI of its own. (`TrialBookingForm.tsx` still sits in this directory and is ' +
    'reachable from no route — see the note in docs/open-defects.md.)',
  'course-waitlist':
    'The same answer as its class sibling below, for the same reason: the offer/entry ' +
    'token in the course queue mail is the identity, and which token matched is what ' +
    'decides whether the holder may take the place or only look at the line. A ' +
    'contact session would be a second, weaker answer to a question the token ' +
    'already answers exactly, and somebody who queued from the public shop has none.',
  waitlist:
    'The offer/entry token in the queue mail is the identity — see the file header: ' +
    '"The token in their mail is their whole identity here." A session cannot widen it ' +
    'and must not narrow it.',
}

describe('THE PUBLIC-SURFACE IDENTITY CENSUS', () => {
  const ALL = routes()

  it('the tree is enumerated, not listed — and it found the surfaces we know about', () => {
    // A floor, not an equality: the point of deriving the list is that a new
    // route appears here without anybody editing this file.
    assert.ok(ALL.length >= 15, `expected the public route tree, found ${ALL.length}`)
    // The website is a catch-all route since it gained pages (site/[[...path]]).
    for (const known of ['appointments', 'booking', 'shop', 'signup', 'site/[[...path]]', 'space']) {
      assert.ok(ALL.includes(known), `${known} must be in the census`)
    }
  })

  it('every public route either READS the contact session or says why it does not', () => {
    const unexplained = ALL.filter((r) => !consumesSession(r) && !(r in REASONS))
    assert.deepEqual(
      unexplained,
      [],
      `these public routes ignore the signed-in contact and give no reason: ${unexplained.join(', ')}. ` +
        'Either consume usePublicContactAuth in the route\'s own tree, or add an entry to REASONS ' +
        'stating how the route identifies its visitor instead.'
    )
  })

  it('no reason is stale — each names a route that exists and really does not consume it', () => {
    for (const route of Object.keys(REASONS)) {
      const entry = join(SLUG_ROOT, ...(route ? route.split('/') : []), 'page.tsx')
      assert.ok(existsSync(entry), `REASONS names '${route}', which is not a route`)
      assert.equal(
        consumesSession(route),
        false,
        `REASONS still excuses '${route}', but it now reads the contact session — delete the entry`
      )
    }
  })

  it('every reason is a SENTENCE about identity, not a shrug', () => {
    for (const [route, reason] of Object.entries(REASONS)) {
      assert.ok(reason.length > 60, `the reason for '${route}' is too short to be one`)
      assert.match(
        reason,
        /token|identity|device|per-person|world-readable|redirect|code/i,
        `the reason for '${route}' must name the mechanism it uses instead`
      )
    }
  })

  // A SOURCE-DERIVED ASSERTION THAT PASSES ON AN EMPTY STRING IS NOT AN
  // ASSERTION. `/*` written inside a `//` comment — say a route glob like
  // `/public/{slug}` followed by a star — opens a block comment that the
  // stripper below happily runs to the next `*/`, hundreds of lines later. The
  // needles then vanish along with the code, and every check in this file goes
  // green while checking nothing. It happened while this census was being
  // written, which is why the guard is here and not in a comment.
  it('comment stripping does not swallow the file it is checking', () => {
    for (const rel of [
      ['booking', 'BookingForm.tsx'],
      ['shop', 'ShopHome.tsx'],
    ]) {
      const raw = readFileSync(join(SLUG_ROOT, ...rel), 'utf8')
      assert.ok(
        stripComments(raw).length > raw.length * 0.4,
        `${rel.join('/')}: stripping comments removed most of the file — a stray '/*' has ` +
          'opened a block comment, and every source-derived check on this file is vacuous'
      )
    }
  })

  // THE REGRESSION THIS CENSUS WAS BUILT AROUND.
  //
  // The appointment rail was the one surface that derived no identity at all
  // while the session's token rode on every callable it made. It is not a route
  // any more — an appointment is a step of the booking funnel — so the check
  // follows it to the funnel and to the rail itself, which is where the guest
  // form and the member screen now live.
  it('the APPOINTMENT rail reads the session — it was the one surface that did not', () => {
    assert.ok(
      consumesSession('booking'),
      'the booking funnel must consume usePublicContactAuth: the provider wraps it, its ' +
        'token is already on every callable it makes, and the server resolves the caller ' +
        'from that token before it reads anything this surface sends.'
    )
    const rail = code(
      readFileSync(
        join(WEB, 'components', 'booking', 'appointment', 'SlotBookingForm.tsx'),
        'utf8'
      )
    )
    assert.ok(
      rail.includes('usePublicContactAuth('),
      'the appointment booking rail must read the session too: it is the screen that ' +
        'asks for details, and asking a contact the server has already recognized is the ' +
        'defect this census was built around'
    )
  })

  it('and it does not offer a signed-in contact a guest form or a second sign-in', () => {
    // Comments only — these two needles CONTAIN string literals, so the
    // literal-stripping form would erase the thing being asserted.
    const src = stripComments(
      readFileSync(
        join(WEB, 'components', 'booking', 'appointment', 'SlotBookingForm.tsx'),
        'utf8'
      )
    )
    // The guest form and the sign-in offer live behind the SAME derived fork,
    // so neither can be shown to somebody the server already recognizes.
    assert.match(
      src,
      /if \(caller\.kind !== 'guest'\)/,
      'the member screen must be selected by the derived caller'
    )
    assert.match(
      src,
      /const caller = resolveBookingCaller\(\{/,
      'the caller must be DERIVED each render. A stored flag reads one render stale, ' +
        'which on a ref-driven sticky bar is long enough to submit.'
    )
    // The precedence itself moved into the shared model when the class funnel
    // started sharing it, so it is asserted THERE. Splitting the guarantee
    // without following it is how a census stops guaranteeing anything.
    const model = stripComments(
      readFileSync(
        join(WEB, 'components', 'booking', 'identity', 'bookingCaller.ts'),
        'utf8'
      )
    )
    assert.match(
      model,
      /if \(isAuthenticated && sessionContact\) \{[\s\S]*?return \{\s*kind: 'session'/,
      'session FIRST, the same precedence resolveAppointmentCaller uses: it returns ' +
        'from the session branch before it reads authenticatedContactId or contactDetails'
    )
    assert.match(
      model,
      /return verified \?\? GUEST/,
      'an OTP result outranks a guest and nothing outranks a session'
    )
  })

  // THE CLASS RAIL HAD THE SAME DEFECT, one surface over, and it was found the
  // same way — by a studio hitting it in production (2026-08-23). BookingForm
  // consumed the session for PRICING and for the summary card, so it passed the
  // census's own test above while still sending a signed-in member with a valid
  // subscription to fetch an emailed code.
  it('the CLASS rail routes a signed-in contact past both identity doors', () => {
    const src = stripComments(readFileSync(join(SLUG_ROOT, 'booking', 'BookingForm.tsx'), 'utf8'))

    assert.match(
      src,
      /if \(signedIn\) return 'member'/,
      "nextStepAfterSession must return 'member' for a signed-in contact BEFORE it " +
        "considers the gate: 'who' offers to treat a member as a newcomer and 'returning' " +
        'asks them to prove they are themselves, and neither is a question the server needs ' +
        'answered (bookSession reads the caller off the contact-session token).'
    )

    // The rule lives in ONE function; the value it needs must reach every call
    // of it, or the click path and the deep-link path diverge — which is the
    // exact failure the function's own header was written to prevent.
    const calls = [...code(src).matchAll(/nextStepAfterSession\(/g)].length
    const callsWithSession = [
      ...code(src).matchAll(/nextStepAfterSession\([^)]*isAuthenticated[^)]*\)/g),
    ].length
    assert.ok(calls > 1, 'expected several call sites to guard')
    assert.equal(
      callsWithSession,
      calls - 1, // the definition itself matches the needle too
      'every nextStepAfterSession call must pass the signed-in flag'
    )
  })
})
