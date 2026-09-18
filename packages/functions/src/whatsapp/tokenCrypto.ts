// The studio's business token at rest. AES-256-GCM under one platform key
// (Secret Manager `whatsapp-token-key`), so a copy of the Firestore document —
// an export, a backup, a misrouted read — is not a working credential.
//
// The key string is hashed to 32 bytes rather than required to be exactly 32,
// so any long random value pasted into Secret Manager works.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

const VERSION = 'v1'

function keyBytes(key: string): Buffer {
  if (!key || key.length < 32) throw new Error('whatsapp token key must be at least 32 characters')
  return createHash('sha256').update(key, 'utf8').digest()
}

/** `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
export function encryptToken(plaintext: string, key: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv, tag, ciphertext].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
}

export function decryptToken(sealed: string, key: string): string {
  const [version, iv, tag, ciphertext] = sealed.split('.')
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error('unrecognised sealed whatsapp token')
  }
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
}
