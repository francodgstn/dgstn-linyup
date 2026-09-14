import * as assert from 'node:assert'
import {
  apiCredentialId,
  apiKeyDisplay,
  currentApiKeyEnvironment,
  mintApiKeySecret,
  parseApiKeySecret,
} from './keyFormat'

describe('api key format', () => {
  it('mints a secret it recognises, per environment', () => {
    const live = mintApiKeySecret('live')
    const test = mintApiKeySecret('test')
    assert.match(live, /^lyp_live_[0-9A-Za-z]{49}$/)
    assert.match(test, /^lyp_test_[0-9A-Za-z]{49}$/)
    assert.deepStrictEqual(parseApiKeySecret(live), { environment: 'live' })
    assert.deepStrictEqual(parseApiKeySecret(test), { environment: 'test' })
  })

  it('fits the all-zero and all-ones extremes into the fixed length', () => {
    for (const fill of [0x00, 0xff]) {
      const secret = mintApiKeySecret('test', (n) => Buffer.alloc(n, fill))
      assert.strictEqual(secret.length, 'lyp_test_'.length + 49)
      assert.ok(parseApiKeySecret(secret))
    }
  })

  it('refuses a typo, a truncation and a swapped environment by checksum alone', () => {
    const secret = mintApiKeySecret('live')
    const flipped = secret.slice(0, 20) + (secret[20] === 'a' ? 'b' : 'a') + secret.slice(21)
    assert.strictEqual(parseApiKeySecret(flipped), null)
    assert.strictEqual(parseApiKeySecret(secret.slice(0, -1)), null)
    assert.strictEqual(parseApiKeySecret(secret.replace('lyp_live_', 'lyp_test_')), null)
    assert.strictEqual(parseApiKeySecret(`Bearer ${secret}`), null)
  })

  it('never mints the same secret twice and hashes each to its own credential id', () => {
    const a = mintApiKeySecret('test')
    const b = mintApiKeySecret('test')
    assert.notStrictEqual(a, b)
    assert.match(apiCredentialId(a), /^[0-9a-f]{64}$/)
    assert.notStrictEqual(apiCredentialId(a), apiCredentialId(b))
  })

  it('shows the environment prefix, a few characters and the last four — never more', () => {
    const secret = mintApiKeySecret('live')
    const { prefix, last4 } = apiKeyDisplay(secret)
    assert.strictEqual(prefix, secret.slice(0, 'lyp_live_'.length + 4))
    assert.strictEqual(last4, secret.slice(-4))
  })

  it('mints live keys in production only', () => {
    assert.strictEqual(currentApiKeyEnvironment('linyup-prod'), 'live')
    assert.strictEqual(currentApiKeyEnvironment('linyup-staging'), 'test')
    assert.strictEqual(currentApiKeyEnvironment('demo-linyup'), 'test')
    assert.strictEqual(currentApiKeyEnvironment(undefined), 'test')
  })
})
