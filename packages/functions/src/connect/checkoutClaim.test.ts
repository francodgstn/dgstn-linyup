import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Source-level gates for the four findings this lane closed. They read the
// TypeScript SOURCE rather than importing it — importing connect/* pulls in
// firebase-functions and the Stripe client, and every claim below is a property
// of the text (a census, a builder choice, a deleted union member).

const SRC = join(__dirname, '..')
const ROOT = join(SRC, '..', '..', '..')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}
function readRoot(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}
/** CODE only — these files document their own grep recipes in prose, and a
 *  census that counted its own recipe would be the confusion it exists to
 *  remove. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

// ─── UX-97 ───────────────────────────────────────────────────────────────────

describe('EVERY EMAILED PUBLIC LINK IS LOCALE-PINNED', () => {
  // The mail is written in the studio's language and the page it opens is not:
  // `localePrefix: 'as-needed'` falls through to cookie → Accept-Language → 'en',
  // and public surfaces never write that cookie. UX-32 fixed the booking chain
  // and added the builders; UX-97 finished the census. This is that census, run
  // rather than written down — a new call site that reaches for the unprefixed
  // builder fails here instead of shipping an English page to a German member.
  it('no call site builds a public URL from getHostingUrl() without a locale', () => {
    const offenders: string[] = []
    for (const file of tsFilesUnder(SRC)) {
      const src = code(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
      if (/(?<!localized)(?:publicUrl|publicSubUrl)\(getHostingUrl\(\)/i.test(src)) {
        offenders.push(file.slice(SRC.length + 1).replace(/\\/g, '/'))
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'use localizedPublicUrl / localizedPublicSubUrl with the recipient language'
    )
  })

  it('the default locale stays unprefixed, so English links are byte-identical', () => {
    // Pinned in @linyup/shared's own test too; repeated here because THIS is the
    // property that made the sweep above safe to do in one pass.
    const shared = readRoot('packages/shared/src/publicRoutes.ts')
    assert.match(shared, /DEFAULT_PUBLIC_LOCALE: PublicLocale = 'en'/)
    assert.match(shared, /if \(normalized === DEFAULT_PUBLIC_LOCALE\) return ''/)
  })
})

// ─── UX-87 ───────────────────────────────────────────────────────────────────

describe('A MOUNTED TRIGGER IS A FIRED TRIGGER', () => {
  it('contact_updated is gone from the union — nothing fired it', () => {
    const engine = read('utils/automationEngine.ts')
    assert.doesNotMatch(engine, /'contact_updated'/)
  })

  it('both referrals triggers are fired from server code', () => {
    const events = code(read('referrals/events.ts'))
    assert.match(events, /'plugin:referrals:referral_created'/)
    assert.match(events, /'plugin:referrals:referral_rewarded'/)
    // ONE owner. The point of referrals/events.ts is that the fire lives beside
    // the census in its header; a second fire elsewhere would put the two out of
    // step exactly the way the manifest and the engine were.
    assert.match(code(read('booking/index.ts')), /fireReferralCreated\(/)
    assert.match(code(read('referrals/index.ts')), /fireReferralRewarded\(/)
  })

  it('the referrals manifest declares no trigger that nothing fires', () => {
    const manifest = code(readRoot('apps/web/src/plugins/referrals/manifest.ts'))
    const declared = [...manifest.matchAll(/id: '(plugin:referrals:[a-z_]+)'/g)].map((m) => m[1])
    const fired = code(read('referrals/events.ts'))
    assert.ok(declared.length > 0, 'the manifest still declares referral triggers')
    for (const id of declared) {
      assert.ok(fired.includes(`'${id}'`), `${id} is mounted but never fired`)
    }
  })
})

// ─── UX-88 ───────────────────────────────────────────────────────────────────

describe('THE BUYER IS SIGNED IN FROM THE CHECKOUT THEY PAID FOR', () => {
  const claim = read('connect/claimCheckoutSession.ts')

  it('the success URL carries Stripe’s session-id template variable', () => {
    const checkout = code(read('connect/checkout.ts'))
    assert.match(checkout, /successUrl: opts\?\.successUrl \?\?[\s\S]{0,120}CHECKOUT_SESSION_ID_PARAM/)
    // SUCCESS ONLY. A cancelled checkout identifies nobody and took no money.
    assert.doesNotMatch(checkout, /cancelUrl:[^\n]*CHECKOUT_SESSION_ID/)
  })

  it('the session is minted through buildContactSession, never assembled', () => {
    // The claims { contactId, teamId, sessionExpires } are what firestore.rules
    // and storage.rules check. A session built anywhere else is a session the
    // rules were not written against.
    assert.match(code(claim), /buildContactSession\(/)
    assert.match(code(claim), /allowedEmail: email/)
  })

  it('it refuses rather than throws, so a paid buyer always sees their receipt', () => {
    const body = code(claim)
    assert.match(body, /status: 'unavailable'/)
    assert.match(body, /status: 'pending'/)
  })

  it('signed in is reported separately from joined', () => {
    // A shop or drop-in buyer's contact commonly has NO acquisition stage
    // (UX-82/83), so the receipt page must not be able to infer membership from
    // the fact that it managed to sign somebody in.
    assert.match(code(claim), /joined: c\.acquisition_stage === 'joined'/)
    assert.match(code(claim), /pendingSignup: c\.pending_signup === true/)
  })

  it('the callable is exported, so it exists at runtime', () => {
    assert.match(read('index.ts'), /export \{ claimCheckoutSession \}/)
  })

  it('its rate-limit bucket is denied to clients', () => {
    const rules = readRoot('firestore.rules')
    assert.match(rules, /match \/checkout_claim_attempts\/\{bucketId\} \{\n\s*allow read: if false;\n\s*allow write: if false;/)
  })
})

// ─── The `contact` vs `contactId` spelling, READER side ──────────────────────
//
// UX-89's root cause is OWNED ELSEWHERE: `trackSessionParticipants` read
// `participantData.contactId` off a row every writer spells `contact`, which is
// what silenced `total_sessions`, `last_session_at` and the trial-attended
// promotion — a sibling lane resolves that from the document id and pins it in
// `analytics/attendanceWriters.test.ts`. THIS is the same spelling mistake one
// collection over, on the reader side: the contact detail's bookings tab
// filtered a bookings collection-group query on `contactId`.
//
// `bookingContactId` (@linyup/shared) is the settled answer to the question for
// bookings — `booking.contact || booking.id`.

describe('A CONTACT’S BOOKINGS ARE FOUND BY THE FIELD BOOKINGS CARRY', () => {
  it('every writer stores the contact id as `contact`, not `contactId`', () => {
    const booking = code(read('booking/index.ts'))
    assert.match(booking, /contact: contactId,/)
  })

  it('the contact detail filters on it, ordered to match the deployed index', () => {
    const page = code(readRoot('apps/web/src/app/[locale]/(auth)/contacts/[id]/page.tsx'))
    // Scoped to the bookings query itself. The `participants` collection group
    // one file over DOES carry `contactId` (analytics/index.ts writes it), so a
    // blanket ban on that string would fail on correct code.
    // The path is a constant since the Part 1 §7 sweep (SESSION_BOOKINGS_SUBCOLLECTION);
    // the literal spelling is kept so an older checkout still matches.
    const bookingsQuery =
      /collectionGroup\(db, (?:'bookings'|SESSION_BOOKINGS_SUBCOLLECTION)\)[\s\S]{0,300}/.exec(page)?.[0]
    assert.ok(bookingsQuery, 'the bookings collection-group query is still there')
    assert.match(bookingsQuery!, /where\('contact', '==', contactId\)/)
    assert.doesNotMatch(bookingsQuery!, /where\('contactId'/)
  })

  it('the index that serves it is deployed', () => {
    const indexes = JSON.parse(readRoot('firestore.index.json')) as {
      indexes: { collectionGroup: string; fields: { fieldPath: string }[] }[]
    }
    const wanted = ['teamId', 'contact', 'joinedAt']
    const found = indexes.indexes.some(
      (i) =>
        i.collectionGroup === 'bookings' &&
        i.fields.length === wanted.length &&
        i.fields.every((f, n) => f.fieldPath === wanted[n])
    )
    assert.ok(found, 'bookings (teamId, contact, joinedAt DESC) must stay in firestore.index.json')
  })
})
