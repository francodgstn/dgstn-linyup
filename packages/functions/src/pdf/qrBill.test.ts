import assert from 'node:assert/strict'
import { isValidCreditorReference, type StructuredPostal } from '@linyup/shared'
import { attachQrBill, buildQrrReference, qrBillData, qrrCheckDigit } from './qrBill'
import { withPdf } from './document'

const postal = (over: Partial<StructuredPostal> = {}): StructuredPostal => ({
  street_name: 'Musterstrasse',
  house_no: '7',
  zip: '1234',
  city: 'Musterstadt',
  country: 'CH',
  ...over,
})

describe('qrrCheckDigit', () => {
  it('matches the SIX worked example', () => {
    // "21 00000 00003 13947 14300 09017" -> body (first 26 digits) + check digit 7.
    const body = '21000000000313947143000901'
    assert.equal(qrrCheckDigit(body), 7)
  })
})

describe('buildQrrReference', () => {
  it('produces a 27-digit reference ending in the correct check digit', () => {
    const ref = buildQrrReference('TAR-2026-00042')
    assert.equal(ref.length, 27)
    assert.match(ref, /^[0-9]{27}$/)
    const body = ref.slice(0, 26)
    const check = Number(ref.slice(26))
    assert.equal(check, qrrCheckDigit(body))
  })

  it('left-pads a short document number with zeros', () => {
    const ref = buildQrrReference('1')
    assert.equal(ref, `${'0'.repeat(25)}1${qrrCheckDigit(`${'0'.repeat(25)}1`)}`)
  })
})

describe('qrBillData', () => {
  it('chooses QRR when a QR-IBAN is given', () => {
    const { data, referenceType } = qrBillData({
      creditor: { name: 'Studio SA', postal: postal(), iban: 'CH4431999123000889012', qrIban: 'CH4431999123000889012' },
      debtor: null,
      amountMinor: null,
      documentNumber: 'TAR-2026-00042',
      language: 'de',
    })
    assert.equal(referenceType, 'QRR')
    assert.equal(data.reference?.length, 27)
    assert.equal(data.creditor.account, 'CH4431999123000889012')
  })

  it('chooses SCOR for a plain IBAN, with a valid RF reference', () => {
    const { data, referenceType } = qrBillData({
      creditor: { name: 'Studio SA', postal: postal(), iban: 'CH9300762011623852957' },
      debtor: null,
      amountMinor: null,
      documentNumber: 'TAR-2026-00042',
      language: 'de',
    })
    assert.equal(referenceType, 'SCOR')
    assert.ok(data.reference?.startsWith('RF'))
    assert.equal(isValidCreditorReference(data.reference as string), true)
    assert.equal(data.creditor.account, 'CH9300762011623852957')
  })

  it('omits amount when amountMinor is null, includes it otherwise', () => {
    const base = {
      creditor: { name: 'Studio SA', postal: postal(), iban: 'CH9300762011623852957' },
      debtor: null,
      documentNumber: 'TAR-2026-00042',
      language: 'de' as const,
    }
    const withoutAmount = qrBillData({ ...base, amountMinor: null })
    assert.equal(withoutAmount.data.amount, undefined)

    const withAmount = qrBillData({ ...base, amountMinor: 199475 })
    assert.equal(withAmount.data.amount, 1994.75)
  })

  it('includes the debtor when given, omits it when null', () => {
    const base = {
      creditor: { name: 'Studio SA', postal: postal(), iban: 'CH9300762011623852957' },
      amountMinor: null,
      documentNumber: 'TAR-2026-00042',
      language: 'de' as const,
    }
    const withDebtor = qrBillData({ ...base, debtor: { name: 'Peter Muster', postal: postal({ house_no: '1' }) } })
    assert.equal(withDebtor.data.debtor?.name, 'Peter Muster')

    const withoutDebtor = qrBillData({ ...base, debtor: null })
    assert.equal(withoutDebtor.data.debtor, undefined)
  })
})

describe('attachQrBill', () => {
  it('draws the payment part onto a PDFKit document without throwing', async () => {
    const buf = await withPdf(
      (doc) => {
        const { referenceType } = attachQrBill(doc, {
          creditor: { name: 'Studio SA', postal: postal(), iban: 'CH9300762011623852957' },
          debtor: { name: 'Peter Muster', postal: postal({ house_no: '1' }) },
          amountMinor: 199475,
          documentNumber: 'TAR-2026-00042',
          language: 'de',
        })
        assert.equal(referenceType, 'SCOR')
      },
      { creationDate: new Date('2026-01-01T00:00:00Z') }
    )
    assert.equal(buf.subarray(0, 4).toString('ascii'), '%PDF')
  })
})
