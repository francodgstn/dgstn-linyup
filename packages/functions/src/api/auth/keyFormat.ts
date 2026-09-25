// ─── API key secrets — minting, recognizing, hashing ─────────────────────────
//
// docs/public-api.md → "API keys". A secret looks like
//
//   lyp_live_<43 base62: 32 random bytes><6 base62: checksum>
//
// The environment prefix tells a reader (and a secret scanner) what they found;
// the checksum lets a typo or a truncated paste be refused without a database
// read. Neither is a security property — the 32 random bytes are. The secret is
// never stored: `apiCredentialId` is the id of the document that authenticates it.

import * as crypto from 'crypto'
import {
  API_KEY_DISPLAY_CHARS,
  API_KEY_PREFIX_LIVE,
  API_KEY_PREFIX_TEST,
  type ApiKeyEnvironment,
} from '@linyup/shared'
import { sha256Hex } from '../../utils/crypto'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SECRET_BYTES = 32
/** 62^43 > 2^256, so 32 bytes always fit. */
const BODY_LENGTH = 43
const CHECKSUM_LENGTH = 6
const SECRET_PATTERN = new RegExp(
  `^lyp_(live|test)_([0-9A-Za-z]{${BODY_LENGTH}})([0-9A-Za-z]{${CHECKSUM_LENGTH}})$`
)

/** The only project that mints `lyp_live_` keys. */
const PRODUCTION_PROJECT_ID = 'linyup-prod'

function toBase62(bytes: Buffer, length: number): string {
  const base = BigInt(62)
  let n = BigInt(`0x${bytes.toString('hex') || '0'}`)
  let out = ''
  while (n > BigInt(0)) {
    out = BASE62[Number(n % base)] + out
    n /= base
  }
  return out.padStart(length, '0').slice(-length)
}

function checksum(prefixAndBody: string): string {
  return toBase62(crypto.createHash('sha256').update(prefixAndBody, 'utf8').digest().subarray(0, 8), CHECKSUM_LENGTH)
}

export function apiKeyPrefixFor(environment: ApiKeyEnvironment): string {
  return environment === 'live' ? API_KEY_PREFIX_LIVE : API_KEY_PREFIX_TEST
}

export function currentApiKeyEnvironment(
  projectId: string | undefined = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT
): ApiKeyEnvironment {
  return projectId === PRODUCTION_PROJECT_ID ? 'live' : 'test'
}

export function mintApiKeySecret(
  environment: ApiKeyEnvironment,
  randomBytes: (size: number) => Buffer = crypto.randomBytes
): string {
  const head = `${apiKeyPrefixFor(environment)}${toBase62(randomBytes(SECRET_BYTES), BODY_LENGTH)}`
  return `${head}${checksum(head)}`
}

/** Is this string shaped like a key we minted, checksum included? */
export function parseApiKeySecret(raw: string): { environment: ApiKeyEnvironment } | null {
  const match = SECRET_PATTERN.exec(raw)
  if (!match) return null
  const [, env, body, sum] = match
  const head = `lyp_${env}_${body}`
  if (checksum(head) !== sum) return null
  return { environment: env === 'live' ? 'live' : 'test' }
}

/** The `api_credentials` document id for a presented secret. */
export function apiCredentialId(secret: string): string {
  return sha256Hex(secret)
}

/** What the owner sees instead of the secret. */
export function apiKeyDisplay(secret: string): { prefix: string; last4: string } {
  const prefixLength = secret.indexOf('_', 4) + 1
  return {
    prefix: secret.slice(0, prefixLength + API_KEY_DISPLAY_CHARS),
    last4: secret.slice(-4),
  }
}
