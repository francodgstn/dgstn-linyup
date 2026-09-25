import assert from 'node:assert/strict'
import {
  contactIdentityKey,
  promoIdentityKey,
  waiverAcceptanceState,
  type WaiverAcceptanceEvent,
  type WaiverSignerState,
} from '@linyup/shared'
import { sha256Hex } from '../utils/crypto'
import { acceptanceIdFor, nextSignerRow } from './accept'

// THE THREE OPERATIONS THE PREVIOUS DESIGN COULD NOT EXPRESS.
//
// One document per acceptance, at a deterministic id derived from the
// RELATIONSHIP — (contact, document, version) — written with `.create()`, gives
// immutability and takes three things away:
//
//   1. RE-SIGNING is unrepresentable. Someone who revoked and later re-accepts
//      the SAME version produces the same id; `.create()` refuses, and a
//      `.set()` would rewrite the original timestamp, IP and text hash —
//      destroying the evidence the `.create()` existed to protect.
//   2. EXPIRY has nowhere to live. A lapsed acceptance renewed at the same
//      version is the same collision.
//   3. REVOCATION has nowhere to live. Revoking means the row's MEANING changed
//      while its FACTS did not, and a write-once row cannot express that.
//
// The resolution is the finance journal's, applied to consent: append-only
// EVENT rows whose id contains the event's own NONCE, plus ONE mutable
// current-state row. This file exists to prove all three are now expressible,
// and that the double-submit idempotency they cost nothing was not lost.
//
// Run with: pnpm --filter @linyup/functions test

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 0, 10, 9, 0, 0)

function ts(ms: number) {
  return {
    toDate: () => new Date(ms),
    toMillis: () => ms,
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1e6,
  }
}

const OWNER = {
  teamId: 'team1',
  documentId: 'doc1',
  contactId: 'contactA',
  contactName: 'Nils Meier',
  contactEmail: 'familie-meier@example.ch',
}

function event(
  overrides: Partial<WaiverAcceptanceEvent> & { version: number; atMs: number }
): WaiverAcceptanceEvent {
  const { atMs, ...rest } = overrides
  return {
    teamId: OWNER.teamId,
    documentId: OWNER.documentId,
    body_hash: 'hash-v' + rest.version,
    kind: 'accepted',
    contactId: OWNER.contactId,
    identity_key: 'e_abc',
    signer_role: 'self',
    signer_name: 'Nils Meier',
    signer_email: 'familie-meier@example.ch',
    signer_email_verified_by: 'none',
    subject_name: 'Nils Meier',
    subject_email: 'familie-meier@example.ch',
    validity_months_at_signing: null,
    valid_until: null,
    method: 'click_wrap',
    accepted_at: ts(atMs),
    ip: '198.51.100.7',
    user_agent: 'test',
    locale: 'de',
    source: 'booking',
    booking_ref: null,
    intent_id: 'intent-' + atMs,
    revoked_by: null,
    revoked_reason: null,
    revokes_acceptance_id: null,
    created_at: ts(atMs),
    ...rest,
  }
}

/** Apply one event to the current row the way accept.ts's write phase does:
 *  the event row is ALWAYS a fact; the signer row moves only when the event
 *  strictly improves it. */
function apply(
  row: WaiverSignerState | null,
  e: WaiverAcceptanceEvent
): { row: WaiverSignerState | null; wrote: boolean; acceptanceId: string } {
  const acceptanceId = acceptanceIdFor({
    documentId: e.documentId,
    version: e.version,
    contactId: e.contactId,
    intentId: e.intent_id,
  })
  const next = nextSignerRow(row, e, acceptanceId, OWNER)
  return { row: next ?? row, wrote: next !== null, acceptanceId }
}

describe('the acceptance id — keyed on the EVENT, not on the relationship', () => {
  const base = { documentId: 'doc1', version: 4, contactId: 'contactA', intentId: 'nonce-1' }

  it('a DOUBLE-SUBMIT of one tick is one row', () => {
    assert.equal(acceptanceIdFor(base), acceptanceIdFor({ ...base }))
  })

  it('RE-SIGNING AFTER REVOCATION is a second row — same version, new nonce', () => {
    // This is the exact collision that deadlocked the previous design.
    assert.notEqual(acceptanceIdFor(base), acceptanceIdFor({ ...base, intentId: 'nonce-2' }))
  })

  it('RE-SIGNING AFTER A require_resign PUBLISH is a second row — new version', () => {
    assert.notEqual(acceptanceIdFor(base), acceptanceIdFor({ ...base, version: 5 }))
  })

  it('RENEWING AFTER EXPIRY is a second row — same version, new nonce', () => {
    assert.notEqual(acceptanceIdFor(base), acceptanceIdFor({ ...base, intentId: 'renewal' }))
  })

  it('different people and different documents never collide', () => {
    assert.notEqual(acceptanceIdFor(base), acceptanceIdFor({ ...base, contactId: 'contactB' }))
    assert.notEqual(acceptanceIdFor(base), acceptanceIdFor({ ...base, documentId: 'doc2' }))
  })

  it('is a stable, id-safe string', () => {
    const id = acceptanceIdFor(base)
    assert.match(id, /^a_[0-9a-f]{32}$/)
    assert.equal(id, acceptanceIdFor(base))
  })
})

describe('the round trip: accept → revoke → accept → require_resign → accept', () => {
  // Every operation the previous design could not express, in one sequence,
  // with the gate's answer checked at each step.
  it('produces four accepted events, one revoked event, rounds 3, and the right refusals', () => {
    const ids: string[] = []
    let row: WaiverSignerState | null = null
    let floor = 0

    // 1 — first signature at v3.
    let step = apply(row, event({ version: 3, atMs: T0, intent_id: 'i1' }))
    row = step.row
    ids.push(step.acceptanceId)
    assert.equal(step.wrote, true)
    assert.equal(row!.rounds, 1)
    assert.equal(row!.status, 'active')
    assert.equal(waiverAcceptanceState({ min_valid_version: floor }, row, T0 + 1), 'valid')

    // 2 — a manager revokes. The accepted event is untouched; the row's MEANING
    //     changed while its FACTS did not, which is the third impossible case.
    step = apply(
      row,
      event({ version: 3, atMs: T0 + DAY, kind: 'revoked', intent_id: 'i2', revoked_by: 'uid-mgr' })
    )
    row = step.row
    ids.push(step.acceptanceId)
    assert.equal(step.wrote, true)
    assert.equal(row!.status, 'revoked')
    assert.equal(row!.rounds, 1, 'a revocation is not a round')
    assert.equal(row!.accepted_version, 3, 'the revoked row keeps what it was revoking')
    assert.equal(waiverAcceptanceState({ min_valid_version: floor }, row, T0 + DAY + 1), 'revoked')

    // 3 — the member re-signs the SAME version. Same relationship, new nonce.
    step = apply(row, event({ version: 3, atMs: T0 + 2 * DAY, intent_id: 'i3' }))
    row = step.row
    ids.push(step.acceptanceId)
    assert.equal(step.wrote, true)
    assert.equal(row!.rounds, 2)
    assert.equal(row!.status, 'active')
    assert.equal(row!.revoked_at, null, 'the revoked round leaves no trace on the current row')
    assert.equal(row!.revoked_by, null)
    assert.equal(waiverAcceptanceState({ min_valid_version: floor }, row, T0 + 2 * DAY + 1), 'valid')

    // 4 — a require_resign publish of v4. ZERO signer rows written; one number
    //     moves, and supersession is derived from it.
    const rowBeforePublish = row
    floor = 4
    assert.equal(
      waiverAcceptanceState({ min_valid_version: floor }, row, T0 + 3 * DAY),
      'superseded'
    )
    assert.equal(row, rowBeforePublish, 'the publish wrote no signer row')

    // 5 — the member signs v4.
    step = apply(row, event({ version: 4, atMs: T0 + 4 * DAY, intent_id: 'i4' }))
    row = step.row
    ids.push(step.acceptanceId)
    assert.equal(step.wrote, true)
    assert.equal(row!.rounds, 3)
    assert.equal(row!.accepted_version, 4)
    assert.equal(waiverAcceptanceState({ min_valid_version: floor }, row, T0 + 4 * DAY + 1), 'valid')

    // Five events, five distinct append-only rows — nothing was overwritten.
    assert.equal(new Set(ids).size, ids.length)
  })

  it('expiry renews at the same version and the renewal is its own row', () => {
    const validUntil = T0 + 30 * DAY
    let row: WaiverSignerState | null = null

    let step = apply(
      row,
      event({
        version: 3,
        atMs: T0,
        intent_id: 'first',
        validity_months_at_signing: 1,
        valid_until: ts(validUntil),
      })
    )
    row = step.row
    const firstId = step.acceptanceId
    assert.equal(waiverAcceptanceState({ min_valid_version: 0 }, row, validUntil + 1), 'expired')

    step = apply(
      row,
      event({
        version: 3,
        atMs: validUntil + DAY,
        intent_id: 'renewal',
        validity_months_at_signing: 1,
        valid_until: ts(validUntil + 31 * DAY),
      })
    )
    row = step.row
    assert.notEqual(step.acceptanceId, firstId, 'the renewal is a second row, not a rewrite')
    assert.equal(row!.rounds, 2)
    assert.equal(
      waiverAcceptanceState({ min_valid_version: 0 }, row, validUntil + DAY + 1),
      'valid'
    )
  })
})

describe('the precedence rule — the event row is always a fact, the signer row is not', () => {
  function signed(version: number, atMs: number, rounds = 1): WaiverSignerState {
    return {
      teamId: OWNER.teamId,
      documentId: OWNER.documentId,
      contactId: OWNER.contactId,
      accepted_version: version,
      accepted_at: ts(atMs),
      valid_until: null,
      acceptance_id: 'a_existing',
      rounds,
      signer_role: 'self',
      signer_name: 'Nils Meier',
      signer_email: 'familie-meier@example.ch',
      signer_email_verified_by: 'none',
      status: 'active',
      revoked_at: null,
      revoked_by: null,
      contact_name: OWNER.contactName,
      contact_email: OWNER.contactEmail,
      updated_at: ts(atMs),
    }
  }

  it('a LATE SUBMIT for v4 does not downgrade a row already at v5', () => {
    // A tab opened at 09:00 holding v4; at 10:00 the studio publishes v5 as
    // require_resign and the member re-signs in Space; at 10:05 the stale tab
    // submits. Under an unconditional .set() the row falls back to v4 and the
    // member is superseded — blocked by a signature that was valid five minutes
    // earlier.
    const row = signed(5, T0 + 60 * 60 * 1000, 3)
    const step = apply(row, event({ version: 4, atMs: T0 + 65 * 60 * 1000, intent_id: 'req-1' }))
    assert.equal(step.wrote, false, 'the signer row was left alone')
    assert.equal(step.row!.accepted_version, 5)
    assert.equal(step.row!.rounds, 3)
  })

  it('a REVOCATION is never undone by an acceptance TICKED before it', () => {
    // A manager revokes at 10:00:00 while a drop-in acceptance ticked at
    // 09:59:59 is still in flight and lands afterwards. On the paid rails the
    // first design wrote outside any transaction, so Firestore's
    // optimistic-concurrency detection would not even have flagged it.
    //
    // NOTE WHAT THIS PINS ABOUT THE INSTANT: `accepted_at` is the moment of the
    // TICK, captured once before the transaction, NOT the moment the write
    // commits. Stamped at commit time instead, a Firestore retry of this very
    // acceptance would re-stamp it past the revocation and undo it — the exact
    // sequence this test exists to forbid.
    const revokedAt = T0 + 60 * 60 * 1000
    const row: WaiverSignerState = {
      ...signed(3, T0),
      status: 'revoked',
      revoked_at: ts(revokedAt),
      revoked_by: 'uid-mgr',
    }
    const step = apply(row, event({ version: 3, atMs: revokedAt - 1000, intent_id: 'stale' }))
    assert.equal(step.wrote, false)
    assert.equal(step.row!.status, 'revoked')
  })

  it('a stale acceptance at a HIGHER version still loses to a later revocation', () => {
    // The version clause must not be allowed to jump the revocation clause: a
    // v5 tick from 09:59:59 does not resurrect a row revoked at 10:00:00.
    const revokedAt = T0 + 60 * 60 * 1000
    const row: WaiverSignerState = {
      ...signed(3, T0),
      status: 'revoked',
      revoked_at: ts(revokedAt),
      revoked_by: 'uid-mgr',
    }
    const step = apply(row, event({ version: 5, atMs: revokedAt - 1000, intent_id: 'stale-v5' }))
    assert.equal(step.wrote, false)
    assert.equal(step.row!.status, 'revoked')
  })

  it('a genuine re-sign AFTER a revocation instant does apply', () => {
    const revokedAt = T0 + 60 * 60 * 1000
    const row: WaiverSignerState = {
      ...signed(3, T0),
      status: 'revoked',
      revoked_at: ts(revokedAt),
      revoked_by: 'uid-mgr',
    }
    // Same version, later than the revocation — the member ticked again.
    const step = apply(row, event({ version: 3, atMs: revokedAt + DAY, intent_id: 'fresh' }))
    assert.equal(step.wrote, true)
    assert.equal(step.row!.status, 'active')
    assert.equal(step.row!.rounds, 2)
  })

  it('an identical replayed acceptance at the same instant does not bump rounds', () => {
    const row = signed(3, T0)
    const step = apply(row, event({ version: 3, atMs: T0, intent_id: 'same' }))
    assert.equal(step.wrote, false, 'not strictly later, so not an improvement')
    assert.equal(step.row!.rounds, 1)
  })

  it('a HIGHER version always applies, even from an older-looking clock', () => {
    const row = signed(3, T0 + DAY)
    const step = apply(row, event({ version: 4, atMs: T0 + DAY + 1, intent_id: 'v4' }))
    assert.equal(step.wrote, true)
    assert.equal(step.row!.accepted_version, 4)
  })

  it('a revocation applies even with no prior signature — but writes NO row', () => {
    // Nothing to revoke. Minting a row here would invent a signature-shaped
    // object that never existed; the gate already answers `none`.
    const step = apply(null, event({ version: 3, atMs: T0, kind: 'revoked', intent_id: 'r' }))
    assert.equal(step.wrote, false)
    assert.equal(step.row, null)
  })

  it('rounds is absolute, from the read row — never an increment', () => {
    let row: WaiverSignerState | null = signed(3, T0, 7)
    row = apply(row, event({ version: 4, atMs: T0 + DAY, intent_id: 'a' })).row
    assert.equal(row!.rounds, 8)
    row = apply(row, event({ version: 5, atMs: T0 + 2 * DAY, intent_id: 'b' })).row
    assert.equal(row!.rounds, 9)
  })

  it('the notice pointer is carried across a full-object signer write', () => {
    // It has no writer in this phase (the notify outcome is deferred), and
    // carrying it is what stops a later reader concluding that notice state
    // "may as well" live on the signer row.
    const row: WaiverSignerState = { ...signed(3, T0), latest_notice_id: 'waiver-notice-doc1-v3-contactA' }
    const step = apply(row, event({ version: 4, atMs: T0 + DAY, intent_id: 'n' }))
    assert.equal(step.wrote, true)
    assert.equal(step.row!.latest_notice_id, 'waiver-notice-doc1-v3-contactA')
  })
})

describe('one definition of "the same person"', () => {
  it('the promo identity key and the waiver identity key are byte-identical', () => {
    // They must be: two hashers that disagree by so much as an encoding would
    // mean a promo cap and a consent export disagreed about who somebody is.
    const cases = [
      { email: 'Anna.Mueller@Example.CH ', contactId: 'c1' },
      { email: null, contactId: 'c2' },
      { email: '', contactId: 'c3' },
    ]
    for (const input of cases) {
      assert.equal(contactIdentityKey(input, sha256Hex), promoIdentityKey(input, sha256Hex))
    }
  })

  it('normalizes the address before hashing, and falls back to the contact id', () => {
    assert.equal(
      contactIdentityKey({ email: ' Anna@Example.CH ', contactId: 'c1' }, sha256Hex),
      contactIdentityKey({ email: 'anna@example.ch', contactId: 'c9' }, sha256Hex)
    )
    assert.equal(contactIdentityKey({ email: null, contactId: 'c2' }, sha256Hex), 'c_c2')
  })

  it('a shared household mailbox gives a parent and a child the SAME key', () => {
    // Which is precisely why the signer row is keyed on contactId and this is
    // only ever a secondary, separately-labeled query.
    const mother = contactIdentityKey(
      { email: 'familie-meier@example.ch', contactId: 'mother' },
      sha256Hex
    )
    const child = contactIdentityKey(
      { email: 'familie-meier@example.ch', contactId: 'child' },
      sha256Hex
    )
    assert.equal(mother, child)
  })
})
