import assert from 'node:assert/strict'
import { decryptToken, encryptToken } from './tokenCrypto'

describe('whatsapp token encryption', () => {
  const key = 'k'.repeat(40)

  it('round-trips', () => {
    const sealed = encryptToken('EAAJB-secret', key)
    assert.ok(!sealed.includes('EAAJB'))
    assert.equal(decryptToken(sealed, key), 'EAAJB-secret')
  })

  it('never produces the same ciphertext twice', () => {
    assert.notEqual(encryptToken('same', key), encryptToken('same', key))
  })

  it('refuses the wrong key and a tampered value', () => {
    const sealed = encryptToken('EAAJB-secret', key)
    assert.throws(() => decryptToken(sealed, 'x'.repeat(40)))
    const parts = sealed.split('.')
    parts[3] = Buffer.from('tampered').toString('base64url')
    assert.throws(() => decryptToken(parts.join('.'), key))
  })

  it('refuses a short key', () => {
    assert.throws(() => encryptToken('x', 'short'))
  })
})
