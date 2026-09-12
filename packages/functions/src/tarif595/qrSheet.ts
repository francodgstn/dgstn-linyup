// Tarif 595 — the QR-code sheet ("Barcodeblatt") encoding. PURE.
//
// The insurer scans the sheet instead of OCR-ing the form, so the whole XML
// rides in the codes. The encoding was VERIFIED by decoding the Forum's own
// "Beispiel mit 12 QR-Code" sample (fixtures/qr-sheet-sample-chunks.json,
// qrSheet.test.ts round-trips it):
//
//   XML bytes → raw DEFLATE (no zlib header — inflateRaw, windowBits −15;
//   "Kompressionsmethode DEFLATE/zlib … höchsten Kompressionslevel")
//   → Base64 → padded with SPACES to a multiple of the chunk length
//   → split into N equal chunks, N ≤ 12 → one QR code per chunk, error
//   correction M, numbered "QR-Code n".
//
// The chunk length is the sample's (1262 characters); a version-40 QR at
// level M holds more, but matching the reference implementation is what a
// scanner in an insurer's mail room has been tested against. A receipt with
// a handful of lines compresses to a few kilobytes and needs two or three
// codes; the 12-code ceiling is the standard's, and exceeding it is refused
// rather than silently truncated.

import { deflateRawSync, inflateRawSync } from 'node:zlib'

export const QR_SHEET_MAX_CODES = 12
export const QR_SHEET_CHUNK_CHARS = 1262

export function encodeQrPayload(xml: Buffer): string {
  return deflateRawSync(xml, { level: 9 }).toString('base64')
}

export class QrSheetTooLargeError extends Error {
  constructor(public readonly needed: number) {
    super(`QR sheet: the XML needs ${needed} codes; the standard allows ${QR_SHEET_MAX_CODES}`)
  }
}

/** Equal-length chunks, the last padded with spaces (as the reference sheet does). */
export function chunkQrPayload(base64: string, maxCodes = QR_SHEET_MAX_CODES, chunkChars = QR_SHEET_CHUNK_CHARS): string[] {
  const count = Math.max(1, Math.ceil(base64.length / chunkChars))
  if (count > maxCodes) throw new QrSheetTooLargeError(count)
  const len = Math.ceil(base64.length / count)
  const padded = base64.padEnd(len * count, ' ')
  const chunks: string[] = []
  for (let i = 0; i < count; i++) chunks.push(padded.slice(i * len, (i + 1) * len))
  return chunks
}

export function buildQrSheetChunks(xml: Buffer): string[] {
  return chunkQrPayload(encodeQrPayload(xml))
}

/** The inverse — what the insurer's scanner does. Used by tests and by the
 *  dev-time self-check; never by the issue path. */
export function decodeQrSheetChunks(chunks: readonly string[]): Buffer {
  const base64 = chunks.join('').trimEnd()
  return inflateRawSync(Buffer.from(base64, 'base64'))
}
