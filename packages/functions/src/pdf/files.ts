// Storage I/O for the shared PDF rail — save a rendered document with its own
// sha256 alongside it, and read it back only once that sha256 is re-verified.
//
// WHY THE HASH. A rendered PDF is handed to an insurer or printed as a legal
// receipt; if the bytes Storage serves back ever differ from the bytes that
// were rendered — a bad upload, a bucket migration, cosmic-ray corruption —
// nobody downstream can tell just by looking at a PDF. Storing the sha256
// beside the object (on the caller's own document, not derived here) and
// checking it on every read turns silent corruption into a loud `data-loss`
// error instead.

import * as admin from 'firebase-admin'
import { createHash } from 'node:crypto'
import { HttpsError } from 'firebase-functions/v2/https'

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export interface SavedFile {
  path: string
  sha256: string
  bytes: number
}

/**
 * Upload `bytes` to `path` and return the reference a caller should persist
 * (path, sha256, byte count) so `readVerified` can check it back later.
 */
export async function saveWithSha256(
  path: string,
  bytes: Buffer,
  contentType: string,
  metadata?: Record<string, string>
): Promise<SavedFile> {
  const sha256 = sha256Hex(bytes)
  await admin
    .storage()
    .bucket()
    .file(path)
    .save(bytes, { contentType, resumable: false, metadata: { metadata } })
  return { path, sha256, bytes: bytes.length }
}

/** A rendered PDF is a receipt or an invoice, never a bulk export — refusing
 *  above this is a sanity ceiling, not a real-world limit. */
export const MAX_DOWNLOAD_BYTES = 6 * 1024 * 1024

/**
 * Download a previously saved file and verify it against the reference
 * (`bytes` checked before the download even starts, `sha256` after). Throws
 * `HttpsError('resource-exhausted', …)` above `MAX_DOWNLOAD_BYTES`, and
 * `HttpsError('data-loss', …)` — logging `[pdf] sha256 mismatch …` first — when
 * the downloaded bytes don't hash to what was recorded at save time.
 */
export async function readVerified(ref: SavedFile): Promise<Buffer> {
  if (ref.bytes > MAX_DOWNLOAD_BYTES) {
    throw new HttpsError(
      'resource-exhausted',
      `pdf: ${ref.path} is ${ref.bytes} bytes, over the ${MAX_DOWNLOAD_BYTES}-byte limit`
    )
  }
  const [buf] = await admin.storage().bucket().file(ref.path).download()
  const actual = sha256Hex(buf)
  if (actual !== ref.sha256) {
    console.error(`[pdf] sha256 mismatch for ${ref.path}: expected ${ref.sha256}, got ${actual}`)
    throw new HttpsError('data-loss', `pdf: ${ref.path} failed its integrity check`)
  }
  return buf
}

export interface DownloadResult {
  filename: string
  contentType: string
  base64: string
  bytes: number
}

/** Shape a buffer for a callable's response — base64 over the wire, never a
 *  Buffer (which JSON-serialises as `{type:'Buffer', data:[...]}`, unusable to
 *  a browser or the mobile app without re-decoding first). */
export function toDownloadResult(filename: string, contentType: string, buf: Buffer): DownloadResult {
  return { filename, contentType, base64: buf.toString('base64'), bytes: buf.length }
}
