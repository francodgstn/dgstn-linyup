import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONTACT_LINK_DEFAULT_TTL_MINUTES,
  CONTACT_LINK_MAX_TTL_MINUTES,
  CONTACT_LINK_MIN_TTL_MINUTES,
  clampContactLinkTtl,
} from '@linyup/shared'

const SRC = readFileSync(join(__dirname, 'contactUpdateLinks.ts'), 'utf8')
const RULES = readFileSync(join(__dirname, '..', '..', '..', '..', 'firestore.rules'), 'utf8')

describe('contact update links — the window', () => {
  it('defaults to the short window when nothing is asked for', () => {
    assert.equal(clampContactLinkTtl(undefined), CONTACT_LINK_DEFAULT_TTL_MINUTES)
    assert.equal(clampContactLinkTtl(null), CONTACT_LINK_DEFAULT_TTL_MINUTES)
    assert.equal(clampContactLinkTtl(Number.NaN), CONTACT_LINK_DEFAULT_TTL_MINUTES)
    assert.equal(CONTACT_LINK_DEFAULT_TTL_MINUTES, 5)
  })

  it('CLAMPS rather than refuses — a link is handed over in person, and an out-of-range number is a UI bug, not a reason to leave the coach standing there with nothing', () => {
    assert.equal(clampContactLinkTtl(0), CONTACT_LINK_MIN_TTL_MINUTES)
    assert.equal(clampContactLinkTtl(-99), CONTACT_LINK_MIN_TTL_MINUTES)
    assert.equal(clampContactLinkTtl(60 * 24 * 30), CONTACT_LINK_MAX_TTL_MINUTES)
    assert.equal(CONTACT_LINK_MAX_TTL_MINUTES, 1440)
  })

  it('keeps a value inside the window exactly', () => {
    assert.equal(clampContactLinkTtl(15), 15)
    assert.equal(clampContactLinkTtl(480), 480)
    assert.equal(clampContactLinkTtl(1440), 1440)
  })
})

describe('contact update links — what the stored document gives away', () => {
  // The token is never stored, so these two properties are what stand between a
  // database dump and a set of working links. Both are one line of code and
  // neither has a runtime symptom if it regresses.
  it('addresses the document by a HASH of the token, never the token', () => {
    assert.ok(
      /\.doc\(sha256\(token\)\)/.test(SRC),
      'the link document id must be sha256(token) — storing the token makes a dump of this collection a set of live links'
    )
    assert.ok(
      !/\btoken,\s*$/m.test(SRC.split('batch.set(')[1] ?? ''),
      'the token must not be written as a field on the document'
    )
  })

  it('SALTS the OTP hash with the token — six digits is otherwise an enumerable space', () => {
    assert.ok(
      SRC.includes('sha256(`${token}:${otp}`)') && SRC.includes('sha256(`${token}:${supplied}`)'),
      'mint and verify must both hash the OTP together with the token'
    )
    // The property that salting buys, stated as arithmetic: the same code under
    // two different tokens must not collide.
    const otp = '123456'
    const a = createHash('sha256').update(`tok-a:${otp}`).digest('hex')
    const b = createHash('sha256').update(`tok-b:${otp}`).digest('hex')
    assert.notEqual(a, b)
  })

  it('is denied to every client by firestore.rules', () => {
    const block = RULES.split('match /contact_update_links/{tokenHash} {')[1]
    assert.ok(block, 'firestore.rules must carry a contact_update_links block')
    assert.match(
      block.split('}')[0],
      /allow read, write: if false;/,
      'a readable copy is a list of live links; a writable one extends your own grant'
    )
  })
})

describe('contact update links — the rules that are only visible in the source', () => {
  it('re-checks the grant in BOTH public callables — submit never trusts that resolve ran', () => {
    const resolve = SRC.split('export const resolveContactUpdateLink')[1] ?? ''
    const submit = SRC.split('export const submitContactUpdateLink')[1] ?? ''
    assert.ok(resolve.includes('await loadLink('), 'resolve must validate the token')
    assert.ok(
      submit.includes('await loadLink('),
      'submit must re-validate independently: a caller can post to it directly'
    )
  })

  it('counts a wrong OTP BEFORE refusing it, so a burst of guesses cannot outrun the cap', () => {
    const guard = SRC.split('otp_invalid')[0]
    assert.ok(
      guard.includes("attempts: FieldValue.increment(1)"),
      'the attempt counter must be written before the refusal is thrown'
    )
  })

  it('does NOT refuse an email that already belongs to another contact', () => {
    // THE DELIBERATE DIVERGENCE FROM hmd-lineup, and the one most likely to be
    // "fixed" back by somebody porting its rule across. Linyup supports one
    // address reaching several contacts on purpose (`login_emails`, cap 5,
    // resolved by loginCandidates) — a parent with two children in the club is
    // the ordinary case. Rejecting the collision would block them at the door.
    const emailBlock = SRC.split('const submittedEmail')[1] ?? ''
    const beforeWrite = emailBlock.split('patch.email = submittedEmail')[0]
    assert.ok(
      !/throw new HttpsError/.test(beforeWrite),
      'a duplicate address must be recorded and reported, never refused — see login_emails'
    )
    assert.ok(
      emailBlock.includes('sharedWith'),
      'the collision must still be recorded so the studio can see it'
    )
  })

  it('never writes an empty email over a stored one', () => {
    assert.ok(
      SRC.includes('if (submittedEmail && submittedEmail !== currentEmail)'),
      'an absent or unchanged address must leave the stored one alone'
    )
  })

  it('routes the non-identity fields through the shared narrowing writer', () => {
    assert.ok(
      SRC.includes('buildContactFieldPatch({'),
      'phone/birthdate/address/custom:* must go through booking/contactFields.ts, which owns the Timestamp and address-map shapes and the empty-never-blanks rule'
    )
  })

  it('is the only writer of the links collection', () => {
    // Cheap census: nothing outside this module may create or revoke a grant.
    const root = join(__dirname, '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const text = readFileSync(p, 'utf8')
          if (
            text.includes('CONTACT_UPDATE_LINKS_COLLECTION') &&
            !p.endsWith(join('contacts', 'contactUpdateLinks.ts'))
          ) {
            offenders.push(p)
          }
        }
      }
    }
    walk(root)
    assert.deepEqual(offenders, [], `only contactUpdateLinks.ts may touch the grants: ${offenders.join(', ')}`)
  })
})
