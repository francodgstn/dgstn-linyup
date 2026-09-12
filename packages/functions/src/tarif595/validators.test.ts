import assert from 'node:assert/strict'
import {
  creditorReferenceFor,
  formatAhv,
  formatIban,
  formatTarif595Number,
  formatVatNumber,
  isQrIban,
  isValidAhv,
  isValidChIban,
  isValidCreditorReference,
  isValidGln,
  isValidVatNumber,
  isValidZsr,
  normalizeVatNumber,
  tarif595GenderSex,
  tarif595ReceiptId,
  tarif595SourceKey,
  validateLegalProfile,
  validateTarif595Config,
  type StudioLegalProfile,
  type Tarif595Config,
} from '@linyup/shared'
import { sha256Hex } from '../utils/crypto'

// The shared package has no test runner, so its pure validators are pinned here.

describe('legal profile — IBAN, QR-IBAN, VAT, creditor reference', () => {
  it('accepts the SIX example IBAN in either layout and rejects a wrong check digit', () => {
    assert.ok(isValidChIban('CH93 0076 2011 6238 5295 7'))
    assert.ok(isValidChIban('CH9300762011623852957'))
    assert.ok(!isValidChIban('CH9300762011623852958'))
    assert.ok(!isValidChIban('DE89370400440532013000'), 'only CH/LI')
  })
  it('recognises a QR-IBAN by its IID range', () => {
    assert.ok(isQrIban('CH44 3199 9123 0008 8901 2'))
    assert.ok(!isQrIban('CH93 0076 2011 6238 5295 7'))
  })
  it('formats in groups of four', () => {
    assert.equal(formatIban('CH9300762011623852957'), 'CH93 0076 2011 6238 5295 7')
  })
  it('VAT numbers: print layout ↔ electronic layout', () => {
    assert.equal(normalizeVatNumber('CHE-123.456.789 MWST'), 'CHE123456789')
    assert.ok(isValidVatNumber('CHE-123.456.789 TVA'))
    assert.ok(!isValidVatNumber('123456789'))
    assert.equal(formatVatNumber('CHE123456789', 'de'), 'CHE-123.456.789 MWST')
    assert.equal(formatVatNumber('CHE123456789', 'fr'), 'CHE-123.456.789 TVA')
  })
  it('creditor reference: RF check digits validate', () => {
    const ref = creditorReferenceFor('FIT-2027-00001')
    assert.ok(/^RF[0-9]{2}FIT202700001$/.test(ref), ref)
    assert.ok(isValidCreditorReference(ref))
    assert.ok(isValidCreditorReference('RF18 5390 0754 7034'))
    assert.ok(!isValidCreditorReference('RF19 5390 0754 7034'))
  })
  it('validateLegalProfile names every missing field and the checksum failures', () => {
    const issues = validateLegalProfile({ legal_name: '', iban: 'CH9300762011623852958', qr_iban: 'CH9300762011623852957' })
    const by = Object.fromEntries(issues.map((i) => [i.path, i.code]))
    assert.equal(by['legal_name'], 'required')
    assert.equal(by['postal.zip'], 'required')
    assert.equal(by['canton'], 'required')
    assert.equal(by['iban'], 'checksum')
    assert.equal(by['qr_iban'], 'pattern', 'a valid plain IBAN is not a QR-IBAN')
    const ok: StudioLegalProfile = {
      legal_name: 'Studio Bewegung GmbH',
      postal: { street_name: 'Bahnhofstrasse', house_no: '12', zip: '8001', city: 'Zürich', country: 'CH' },
      canton: 'ZH',
      iban: 'CH9300762011623852957',
    }
    assert.deepEqual(validateLegalProfile(ok), [])
  })
})

describe('tarif595 — GLN, ZSR, AHV', () => {
  it('GLN: GS1 check digit', () => {
    assert.ok(isValidGln('7601001302112'))
    assert.ok(isValidGln('2006666666008'))
    assert.ok(!isValidGln('7601001302113'))
    assert.ok(!isValidGln('7611234567890'), "the Forum sample's dummy GLN")
    assert.ok(!isValidGln('760100130211'))
  })
  it('ZSR: a letter and six digits', () => {
    assert.ok(isValidZsr('Q123456'))
    assert.ok(!isValidZsr('q123456'))
    assert.ok(!isValidZsr('Q12345'))
  })
  it('AHV: the federal example passes in either layout; the print layout is dotted', () => {
    assert.ok(isValidAhv('756.9217.0769.85'))
    assert.ok(isValidAhv('7569217076985'))
    assert.ok(!isValidAhv('756.9217.0769.86'))
    assert.ok(!isValidAhv('7559217076985'), 'must start with 756')
    assert.equal(formatAhv('7569217076985'), '756.9217.0769.85')
  })
  it('receipt numbers and ids', () => {
    assert.equal(formatTarif595Number('595', 2027, 7), '595-2027-00007')
    assert.equal(tarif595SourceKey({ kind: 'subscription', historyId: 'h1' }, '2027-01-01', '2027-12-31'), 'subscription:h1:2027-01-01:2027-12-31')
    const id = tarif595ReceiptId(sha256Hex, 't', 'c', 'subscription:h1:2027-01-01:2027-12-31', 1)
    assert.equal(id.length, 32)
    assert.equal(id, tarif595ReceiptId(sha256Hex, 't', 'c', 'subscription:h1:2027-01-01:2027-12-31', 1), 'deterministic')
    assert.notEqual(id, tarif595ReceiptId(sha256Hex, 't', 'c', 'subscription:h1:2027-01-01:2027-12-31', 2))
  })
  it('gender/sex pair for the patient', () => {
    assert.deepEqual(tarif595GenderSex('M', null), { gender: 'male', sex: 'male' })
    assert.deepEqual(tarif595GenderSex('F', null), { gender: 'female', sex: 'female' })
    assert.equal(tarif595GenderSex('other', null), null)
    assert.deepEqual(tarif595GenderSex('other', 'female'), { gender: 'diverse', sex: 'female' })
    assert.equal(tarif595GenderSex(undefined, null), null)
  })
})

describe('tarif595 — config validation', () => {
  const exists = (code: string) => ['1001', '3037', '9999'].includes(code)
  const base: Tarif595Config = {
    language: 'de',
    modus: 'production',
    biller: { gln: '7601001302112', zsr: 'Q123456' },
    provider: { gln: '7601001302112', gln_location: '7601001302112', zsr: 'Q123456' },
    numbering: { prefix: '595' },
    offerings: { 'subscription:abc': { position: '1001', unit: 'month' } },
  }
  it('a complete config has no issues', () => {
    assert.deepEqual(validateTarif595Config(base, { positionExists: exists }), [])
  })
  it('reports checksum, pattern, unknown position, missing entries and missing 9999 text', () => {
    const issues = validateTarif595Config(
      {
        ...base,
        biller: { gln: '7601001302113', zsr: 'q1' },
        numbering: { prefix: 'too-long-prefix' },
        offerings: {
          'subscription:a': { position: '0000', unit: 'month' },
          'activity:b': { position: '1001', unit: 'entry' },
          'course:c': { position: '9999', unit: 'flat' },
          'bogus': { position: '1001', unit: 'flat' },
        },
      },
      { positionExists: exists }
    )
    const by = Object.fromEntries(issues.map((i) => [i.path, i.code]))
    assert.equal(by['biller.gln'], 'checksum')
    assert.equal(by['biller.zsr'], 'pattern')
    assert.equal(by['numbering.prefix'], 'pattern')
    assert.equal(by['offerings.subscription:a.position'], 'unknown_position')
    assert.equal(by['offerings.activity:b.entries'], 'required')
    assert.equal(by['offerings.course:c.customName'], 'required')
    assert.equal(by['offerings.bogus'], 'pattern')
  })
  it('no offerings at all is its own issue', () => {
    const issues = validateTarif595Config({ ...base, offerings: {} }, { positionExists: exists })
    assert.deepEqual(issues, [{ path: 'offerings', code: 'no_offerings' }])
  })
})
