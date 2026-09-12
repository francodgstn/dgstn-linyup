import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { monthlyReceipt } from './fixtures/receipts'
import {
  QR_SHEET_CHUNK_CHARS,
  QR_SHEET_MAX_CODES,
  QrSheetTooLargeError,
  buildQrSheetChunks,
  chunkQrPayload,
  decodeQrSheetChunks,
  encodeQrPayload,
} from './qrSheet'
import { buildTarif595Xml } from './xml'

const FIXTURES = join(__dirname, 'fixtures')

describe('tarif595 QR sheet — the encoding the Forum sample uses', () => {
  it('the official 12-code sample decodes to its own XML with raw DEFLATE + base64 + space padding', () => {
    const chunks = (JSON.parse(readFileSync(join(FIXTURES, 'qr-sheet-sample-chunks.json'), 'utf8')) as string[]).filter(
      (c) => c.length > 100
    )
    assert.equal(chunks.length, QR_SHEET_MAX_CODES)
    assert.ok(chunks.every((c) => c.length === QR_SHEET_CHUNK_CHARS))
    const xml = decodeQrSheetChunks(chunks).toString('utf8')
    const original = readFileSync(join(FIXTURES, 'sample-G500_05_TP_KVG_de.xml'), 'utf8')
    // The sample PDF was generated from the same request as the sample XML but
    // in a separate run (its guid differs), so the proof is structural: a
    // complete invoice:request of the same size and the same patient.
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="no"?>'))
    assert.ok(xml.trimEnd().endsWith('</invoice:request>'))
    assert.equal(xml.length, original.length)
    assert.ok(xml.includes('<invoice:familyname>Muster-Meier</invoice:familyname>'))
  })

  it('round-trips our own XML through encode → chunk → decode', () => {
    const xml = buildTarif595Xml(monthlyReceipt())
    const chunks = buildQrSheetChunks(xml)
    assert.ok(chunks.length >= 1 && chunks.length <= QR_SHEET_MAX_CODES)
    assert.ok(chunks.every((c) => c.length === chunks[0].length), 'equal-length chunks')
    assert.ok(decodeQrSheetChunks(chunks).equals(xml))
  })

  it('a receipt of a few lines needs only a handful of codes', () => {
    assert.ok(buildQrSheetChunks(buildTarif595Xml(monthlyReceipt())).length <= 3)
  })

  it('splits evenly and pads the tail with spaces', () => {
    const payload = 'A'.repeat(QR_SHEET_CHUNK_CHARS * 2 + 10)
    const chunks = chunkQrPayload(payload)
    assert.equal(chunks.length, 3)
    assert.ok(chunks.every((c) => c.length === chunks[0].length))
    assert.ok(chunks[2].endsWith(' '))
    assert.equal(chunks.join('').trimEnd(), payload)
  })

  it('refuses beyond the twelve-code ceiling instead of truncating', () => {
    assert.throws(() => chunkQrPayload('B'.repeat(QR_SHEET_CHUNK_CHARS * 13)), QrSheetTooLargeError)
  })

  it('encodeQrPayload is raw deflate (no zlib header)', () => {
    const b = Buffer.from(encodeQrPayload(Buffer.from('<a/>'.repeat(50))), 'base64')
    assert.notEqual(b[0], 0x78, 'a zlib header would start with 0x78')
  })
})
