import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { XML50_GLN_NO_RECIPIENT, XML50_GLN_PRIVATE_DEBITOR } from '@linyup/shared'
import { attendanceReceipt, monthlyReceipt } from './fixtures/receipts'
import { buildTarif595Xml, buildTarif595XmlString, esc, xmlMoney } from './xml'

// Snapshot tests: the generated XML is compared byte-for-byte with the checked-in
// expected file. Set UPDATE_TARIF595_SNAPSHOTS=1 to rewrite the expected files
// after an intentional change — and validate them against
// fixtures/generalInvoiceRequest_500.xsd before committing (scripts/validate-
// tarif595-xml.py, or xmllint --schema where installed).
const FIXTURES = join(__dirname, 'fixtures')
const UPDATE = process.env.UPDATE_TARIF595_SNAPSHOTS === '1'

function snapshot(name: string, actual: string): void {
  const file = join(FIXTURES, `${name}.expected.xml`)
  if (UPDATE || !existsSync(file)) {
    writeFileSync(file, actual, 'utf8')
    return
  }
  const expected = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(actual, expected, `${name}.expected.xml differs — set UPDATE_TARIF595_SNAPSHOTS=1 if intended`)
}

describe('tarif595 xml — snapshots against the checked-in expected files', () => {
  it('monthly subscription, insurer known', () => {
    snapshot('receipt-monthly', buildTarif595XmlString(monthlyReceipt()))
  })
  it('attendance, VAT-registered, no insurer', () => {
    snapshot('receipt-attendance', buildTarif595XmlString(attendanceReceipt()))
  })
})

describe('tarif595 xml — structural pins', () => {
  const monthly = buildTarif595XmlString(monthlyReceipt())
  const attendance = buildTarif595XmlString(attendanceReceipt())

  it('is the invoice namespace with the schema location and the frozen guid', () => {
    assert.ok(monthly.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="no"?><invoice:request '))
    assert.ok(monthly.includes('xmlns:invoice="http://www.forum-datenaustausch.ch/invoice"'))
    assert.ok(monthly.includes('guid="f9f999ea1a3c404aa64a04327fc0aab2"'))
    assert.ok(monthly.includes('language="de" modus="production"'))
  })

  it('transport goes to the insurer when known, else to the non-recipient constant', () => {
    assert.ok(monthly.includes('<invoice:transport from="7601001302112" to="7601003000012"/>'))
    assert.ok(attendance.includes(`to="${XML50_GLN_NO_RECIPIENT}"`))
  })

  it('the receipt number is the request_id; the timestamp and date are the frozen ones', () => {
    assert.ok(monthly.includes('request_timestamp="1800000000" request_date="2027-01-20T00:00:00" request_id="FIT-2027-00001"'))
  })

  it('Tiers Garant, role other / place company, law VVG with the insured number, prevention', () => {
    assert.ok(monthly.includes('<invoice:body role="other" place="company">'))
    assert.ok(monthly.includes('<invoice:tiers_garant>'))
    assert.ok(monthly.includes('<invoice:law type="VVG" insured_id="123.45.678-012"/>'))
    assert.ok(attendance.includes('<invoice:law type="VVG"/>'))
    assert.ok(monthly.includes('canton="ZH" treatment="ambulatory" reason="prevention"'))
    assert.ok(monthly.includes('date_begin="2027-01-15" date_end="2028-01-14"'))
  })

  it('the debitor is the guarantor with the private-person pseudo GLN', () => {
    assert.ok(monthly.includes(`<invoice:debitor gln="${XML50_GLN_PRIVATE_DEBITOR}"><invoice:person>`))
  })

  it('the patient carries gender, sex, birthdate and the AHV number in digits', () => {
    assert.ok(monthly.includes('<invoice:patient gender="female" sex="female" birthdate="1986-02-28" ssn="7569217076985">'))
  })

  it('the balance says paid in full: prepaid = amount, due = 0, and the pay-in slip is the without-amount form', () => {
    assert.ok(monthly.includes('<invoice:balance currency="CHF" amount="1068.00" amount_prepaid="1068.00" amount_due="0.00">'))
    assert.ok(monthly.includes('<invoice:esrQRRed subtype="esrQRRedplus" iban="CH9300762011623852957">'))
  })

  it('VAT: a zero row when exempt; the number and the contained VAT when registered', () => {
    assert.ok(monthly.includes('<invoice:vat vat="0.00"><invoice:vat_rate vat_rate="0" amount="1068.00" vat="0.00"/></invoice:vat>'))
    assert.ok(attendance.includes('<invoice:vat vat="5.62" vat_number="CHE123456789"><invoice:vat_rate vat_rate="8.1" amount="75.00" vat="5.62"/></invoice:vat>'))
  })

  it('every line is a `service` on tariff 595 with unit_factor 1 and a midnight dateTime', () => {
    const services = monthly.match(/<invoice:service /g) ?? []
    assert.equal(services.length, 1)
    assert.ok(
      monthly.includes(
        '<invoice:service record_id="1" tariff_type="595" code="1001" name="Training auf der Trainingsfläche, pro 1 Monat" session="1" quantity="12" date_begin="2027-01-15T00:00:00" provider_id="7601001302112" responsible_id="7601001302112" unit="89.00" unit_factor="1" amount="1068.00" vat_rate="0"/>'
      )
    )
    assert.equal((attendance.match(/<invoice:service /g) ?? []).length, 3)
    assert.ok(!monthly.includes('service_ex'))
  })

  it('the provider block carries gln + gln_location and the ZSR', () => {
    assert.ok(monthly.includes('<invoice:provider_gln gln="7601001302112" gln_location="7601001302112">'))
    assert.ok(monthly.includes('<invoice:provider_zsr zsr="Q123456">'))
    assert.ok(monthly.includes('<invoice:biller_zsr zsr="Q123456">'))
  })

  it('the element order is the schema sequence', () => {
    const order = [
      '<invoice:processing>',
      '<invoice:payload ',
      '<invoice:invoice ',
      '<invoice:body ',
      '<invoice:prolog>',
      '<invoice:tiers_garant>',
      '<invoice:billers>',
      '<invoice:debitor ',
      '<invoice:providers>',
      '<invoice:patient ',
      '<invoice:guarantor>',
      '<invoice:partners/>',
      '<invoice:balance ',
      '<invoice:esrQRRed ',
      '<invoice:law ',
      '<invoice:treatment ',
      '<invoice:services>',
    ]
    let last = -1
    for (const tag of order) {
      const i = monthly.indexOf(tag)
      assert.ok(i > last, `${tag} out of order`)
      last = i
    }
  })

  it('escapes attribute and text values', () => {
    assert.equal(esc('Fit & "Fun" <GmbH>'), 'Fit &amp; &quot;Fun&quot; &lt;GmbH&gt;')
    assert.equal(xmlMoney(106800), '1068.00')
    assert.equal(xmlMoney(5), '0.05')
  })

  it('returns UTF-8 bytes of the same string', () => {
    assert.equal(buildTarif595Xml(monthlyReceipt()).toString('utf8'), monthly)
  })
})
