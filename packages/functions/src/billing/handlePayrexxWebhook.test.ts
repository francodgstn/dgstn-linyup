import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { verifyPayrexxSignature } from './handlePayrexxWebhook'

// The Payrexx webhook FAILS CLOSED: with no signing secret configured it refuses
// the delivery and writes nothing. It used to warn and record anyway, which let
// anyone who knew a teamId forge a confirmed payment.
//
// Run with: pnpm --filter @linyup/functions test

const SECRET = 'payrexx-signing-secret'
const BODY = '{"transaction":{"id":1,"status":"confirmed","mode":"LIVE"}}'
const RAW = Buffer.from(BODY)
const sign = (body: string | Buffer, secret: string) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex')

describe('verifyPayrexxSignature', () => {
  it('accepts an HMAC-SHA256 hex signature made with the configured secret', () => {
    assert.deepEqual(verifyPayrexxSignature(RAW, sign(BODY, SECRET), SECRET), { ok: true })
  })

  it('REFUSES when no secret is configured — even with a well-formed signature', () => {
    // The forged-payload case: an HMAC keyed with '' is computable by anyone, so
    // a blank secret must never be treated as "verification skipped".
    for (const secret of [undefined, '', '   ']) {
      const r = verifyPayrexxSignature(RAW, sign(BODY, ''), secret)
      assert.deepEqual(r, { ok: false, reason: 'no_signing_secret' }, `secret=${JSON.stringify(secret)}`)
    }
  })

  it('reports the missing secret before the missing header', () => {
    assert.deepEqual(verifyPayrexxSignature(RAW, undefined, undefined), {
      ok: false,
      reason: 'no_signing_secret',
    })
  })

  it('rejects a missing header', () => {
    assert.deepEqual(verifyPayrexxSignature(RAW, undefined, SECRET), {
      ok: false,
      reason: 'missing_signature',
    })
    assert.deepEqual(verifyPayrexxSignature(RAW, '', SECRET), {
      ok: false,
      reason: 'missing_signature',
    })
  })

  it('rejects a signature made with a different secret', () => {
    assert.deepEqual(verifyPayrexxSignature(RAW, sign(BODY, 'wrong'), SECRET), {
      ok: false,
      reason: 'invalid_signature',
    })
  })

  it('rejects non-hex and truncated headers', () => {
    assert.deepEqual(verifyPayrexxSignature(RAW, 'not-hex-at-all', SECRET), {
      ok: false,
      reason: 'invalid_signature',
    })
    assert.deepEqual(verifyPayrexxSignature(RAW, sign(BODY, SECRET).slice(0, 32), SECRET), {
      ok: false,
      reason: 'invalid_signature',
    })
  })

  it('rejects when the body differs by a single byte', () => {
    assert.deepEqual(verifyPayrexxSignature(Buffer.from(BODY + ' '), sign(BODY, SECRET), SECRET), {
      ok: false,
      reason: 'invalid_signature',
    })
  })
})

describe('handlePayrexxWebhook wiring', () => {
  // Windows checkouts are CRLF; normalise before reading positions.
  const source = fs
    .readFileSync(path.join(__dirname, 'handlePayrexxWebhook.ts'), 'utf8')
    .replace(/\r\n/g, '\n')
  const handler = source.slice(source.indexOf('export const handlePayrexxWebhook'))

  it('verifies before it matches a contact, writes a payment or journals', () => {
    const verifyAt = handler.indexOf('verifyPayrexxSignature(')
    assert.ok(verifyAt > 0, 'the handler must call verifyPayrexxSignature')
    for (const mutation of ['resolveSingleContact(', 'runTransaction(', 'recordFinanceTransaction(']) {
      const at = handler.indexOf(mutation)
      assert.ok(at > verifyAt, `${mutation} must come after signature verification`)
    }
  })

  it('has no "skip verification" branch left', () => {
    assert.ok(!/skipping verification/i.test(source))
  })
})
