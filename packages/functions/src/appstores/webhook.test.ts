import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { ATTENTION_VERSION_STATES } from '@linyup/shared'
import { parseAscWebhookEvent, verifyAscSignature } from './webhook'

// The App Store Connect webhook contract, pinned against Apple's documented
// payloads.
//
// Run with: pnpm --filter @linyup/functions test

const SECRET = 'a-secret-phrase'
const sign = (body: string, secret = SECRET) =>
  `hmacsha256=${crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`

describe('verifyAscSignature', () => {
  const body = '{"data":{"type":"x","id":"1"}}'
  const raw = Buffer.from(body)

  it('accepts Apple’s hmacsha256= prefixed header', () => {
    assert.deepEqual(verifyAscSignature(raw, sign(body), SECRET), { ok: true })
  })

  it('REJECTS a bare hex digest with no scheme', () => {
    // The single most likely way this file gets broken: someone compares the
    // whole header against a bare digest, or strips the prefix on the sending
    // side. Apple always sends the scheme; without it we do not know what was
    // hashed, so this must fail rather than guess.
    const bare = sign(body).split('=')[1]!
    const r = verifyAscSignature(raw, bare, SECRET)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'bad_scheme')
  })

  it('names an unrecognised scheme so a format change is diagnosable', () => {
    const r = verifyAscSignature(raw, 'sha512=deadbeef', SECRET)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'bad_scheme')
    assert.equal(r.ok === false && r.detail, 'sha512')
  })

  it('rejects a signature made with a different secret', () => {
    const r = verifyAscSignature(raw, sign(body, 'wrong-secret'), SECRET)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'mismatch')
  })

  it('rejects when the body differs by a single byte', () => {
    const r = verifyAscSignature(Buffer.from(body + ' '), sign(body), SECRET)
    assert.equal(r.ok, false)
  })

  it('rejects a missing header rather than treating it as unsigned-but-fine', () => {
    const r = verifyAscSignature(raw, undefined, SECRET)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'missing')
  })

  it('tolerates surrounding whitespace and upper-case hex', () => {
    const hex = sign(body).split('=')[1]!
    assert.deepEqual(verifyAscSignature(raw, ` hmacsha256 = ${hex.toUpperCase()} `, SECRET), {
      ok: true,
    })
  })

  it('hashes the RAW bytes, not a re-serialization of the parsed body', () => {
    // Apple signs the bytes on the wire. JSON.stringify(req.body) round-trips
    // to different whitespace, so an HMAC over it matches nothing — this pins
    // that the raw buffer is what gets hashed.
    const pretty = JSON.stringify(JSON.parse(body), null, 2)
    assert.notEqual(pretty, body)
    assert.equal(verifyAscSignature(Buffer.from(pretty), sign(body), SECRET).ok, false)
  })
})

describe('parseAscWebhookEvent', () => {
  it('reads a version-state change, Apple’s documented shape', () => {
    const e = parseAscWebhookEvent({
      data: {
        type: 'appStoreVersionAppVersionStateUpdated',
        id: '7c813492-9516-4c79-903e-224effdd57ac',
        version: 1,
        attributes: {
          newValue: 'READY_FOR_REVIEW',
          oldValue: 'PREPARE_FOR_SUBMISSION',
          timestamp: '2025-04-16T05:00:52.745Z',
        },
        relationships: {
          instance: { data: { type: 'appStoreVersions', id: 'ad7e6298-2570-4ca6-b3cc-f81788e40bdc' } },
        },
      },
    })
    assert.ok(e)
    assert.equal(e.kind, 'version_state')
    assert.equal(e.oldValue, 'PREPARE_FOR_SUBMISSION')
    assert.equal(e.newValue, 'READY_FOR_REVIEW')
    assert.equal(e.instanceType, 'appStoreVersions')
    assert.equal(e.occurredAtIso, '2025-04-16T05:00:52.745Z')
    assert.match(e.summary, /PREPARE_FOR_SUBMISSION → READY_FOR_REVIEW/)
    assert.equal(e.needsAttention, false)
  })

  it('flags the states where WE are the blocker', () => {
    for (const state of ATTENTION_VERSION_STATES) {
      const e = parseAscWebhookEvent({
        data: {
          type: 'appStoreVersionAppVersionStateUpdated',
          id: `id-${state}`,
          attributes: { newValue: state },
        },
      })
      assert.equal(e?.needsAttention, true, `${state} should need attention`)
    }
  })

  it('reads a build-upload change, whose value is `newState` not `newValue`', () => {
    // Two names for the same idea across event types. Reading only `newValue`
    // would store null here — no error, no failing call, just a blank cell.
    const e = parseAscWebhookEvent({
      data: {
        type: 'buildUploadStateUpdated',
        id: '7c813492',
        attributes: { newState: 'PROCESSING' },
        relationships: { instance: { data: { type: 'buildUploads', id: 'ad7e6298' } } },
      },
    })
    assert.equal(e?.kind, 'build_state')
    assert.equal(e?.newValue, 'PROCESSING')
  })

  it('treats both beta-feedback submissions as attention, and says which', () => {
    const crash = parseAscWebhookEvent({
      data: { type: 'betaFeedbackCrashSubmissionCreated', id: 'a', attributes: {} },
    })
    const shot = parseAscWebhookEvent({
      data: { type: 'betaFeedbackScreenshotSubmissionCreated', id: 'b', attributes: {} },
    })
    assert.equal(crash?.kind, 'beta_feedback')
    assert.equal(shot?.kind, 'beta_feedback')
    assert.equal(crash?.needsAttention, true)
    assert.equal(shot?.needsAttention, true)
    assert.match(crash!.summary, /crash/i)
    assert.doesNotMatch(shot!.summary, /crash/i)
  })

  it('KEEPS an event type it has never heard of', () => {
    // Apple ships new event types; a handler that dropped them would lose
    // deliveries silently, and a ping/test event would vanish too. Unknown is
    // stored as `other` carrying Apple's own type string.
    const e = parseAscWebhookEvent({
      data: { type: 'somethingAppleAddedLater', id: 'z', attributes: { timestamp: '2026-01-01T00:00:00Z' } },
    })
    assert.equal(e?.kind, 'other')
    assert.equal(e?.vendorType, 'somethingAppleAddedLater')
    assert.equal(e?.summary, 'somethingAppleAddedLater')
    assert.equal(e?.needsAttention, false)
  })

  it('returns null only when the envelope itself is unusable', () => {
    assert.equal(parseAscWebhookEvent({}), null)
    assert.equal(parseAscWebhookEvent({ data: { type: 'x' } }), null) // no id
    assert.equal(parseAscWebhookEvent({ data: { id: 'x' } }), null) // no type
    assert.equal(parseAscWebhookEvent(null), null)
  })

  it('leaves occurredAtIso null when the payload carries no timestamp', () => {
    // buildUploadStateUpdated has none in Apple's example. The caller stamps
    // receipt time rather than inventing an occurrence time.
    const e = parseAscWebhookEvent({
      data: { type: 'buildUploadStateUpdated', id: 'q', attributes: { newState: 'VALID' } },
    })
    assert.equal(e?.occurredAtIso, null)
  })
})
