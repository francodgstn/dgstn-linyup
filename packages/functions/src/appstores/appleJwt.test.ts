import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mintAscJwt, normalisePrivateKey } from './appleJwt'

// The App Store Connect JWT, pinned against real crypto.
//
// Two failures this exists to stop, both of which surface as an opaque 401 from
// Apple that reads as "your key is wrong" rather than "your encoding is wrong":
//
//  1. A DER signature. Node's default `sign()` returns a variable-length DER
//     structure; JOSE mandates the fixed 64-byte raw R‖S that
//     `dsaEncoding: 'ieee-p1363'` produces. Nothing in the type system stops
//     you dropping that option.
//  2. A mangled PEM. A .p8 pasted through a form or a .env file loses its
//     newlines, so the single-line base64 form is accepted too — and that
//     branch has no other way to be checked, because the failure is silent
//     until Apple refuses the token.
//
// Run with: pnpm --filter @linyup/functions test

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const BASE64 = Buffer.from(PEM).toString('base64')

function parts(jwt: string) {
  const [h, p, s] = jwt.split('.')
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p!, 'base64url').toString()),
    signature: Buffer.from(s!, 'base64url'),
    signingInput: `${h}.${p}`,
  }
}

describe('mintAscJwt', () => {
  it('produces a JOSE-format ES256 signature Apple can verify', () => {
    const { signature, signingInput } = parts(
      mintAscJwt({ keyId: 'ABC1234567', issuerId: 'issuer-uuid', privateKeyPem: PEM }),
    )
    // 64 bytes exactly — DER would be ~70-72 and variable.
    assert.equal(signature.length, 64)
    assert.ok(
      verify('sha256', Buffer.from(signingInput), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature),
    )
  })

  it('carries the header and claims App Store Connect requires', () => {
    const { header, payload } = parts(
      mintAscJwt({ keyId: 'ABC1234567', issuerId: 'issuer-uuid', privateKeyPem: PEM }),
    )
    assert.equal(header.alg, 'ES256')
    assert.equal(header.typ, 'JWT')
    // The key id travels in the HEADER and the issuer in the CLAIMS. Swapping
    // them yields a structurally valid JWT that Apple rejects.
    assert.equal(header.kid, 'ABC1234567')
    assert.equal(payload.iss, 'issuer-uuid')
    assert.equal(payload.aud, 'appstoreconnect-v1')
  })

  it('stays inside Apple’s 20-minute ceiling', () => {
    const { payload } = parts(
      mintAscJwt({ keyId: 'k', issuerId: 'i', privateKeyPem: PEM }),
    )
    assert.ok(payload.exp - payload.iat <= 20 * 60)
    assert.ok(payload.exp > payload.iat)
  })

  it('accepts the key as a single line of base64, not just as a PEM', () => {
    const fromPem = parts(mintAscJwt({ keyId: 'k', issuerId: 'i', privateKeyPem: PEM }))
    const fromB64 = parts(mintAscJwt({ keyId: 'k', issuerId: 'i', privateKeyPem: BASE64 }))
    // Same key, so both must verify against the same public half. (The
    // signatures themselves differ — ECDSA is randomised.)
    for (const p of [fromPem, fromB64]) {
      assert.ok(
        verify('sha256', Buffer.from(p.signingInput), { key: publicKey, dsaEncoding: 'ieee-p1363' }, p.signature),
      )
    }
  })
})

describe('normalisePrivateKey', () => {
  it('passes a PEM through untouched but for surrounding whitespace', () => {
    assert.equal(normalisePrivateKey(`\n  ${PEM}  \n`), PEM.trim())
  })

  it('decodes a base64 blob back to the PEM', () => {
    assert.equal(normalisePrivateKey(BASE64), PEM)
  })
})
