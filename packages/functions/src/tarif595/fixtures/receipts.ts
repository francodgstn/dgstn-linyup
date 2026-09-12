// Frozen receipt snapshots the pure-core tests render. Every value is fixed
// (guid, timestamp, addresses) so the expected XML beside them is stable.
// Identifiers are check-digit-valid but fictitious; the sample GLNs in the
// Forum's own examples are not check-digit-valid, which is why they are not
// reused here.

import type { Tarif595ReceiptDoc, Tarif595Line } from '@linyup/shared'
import type { Timestamp } from 'firebase-admin/firestore'

const ts = { seconds: 1_800_000_000, nanoseconds: 0 } as unknown as Timestamp

export function monthlyReceipt(overrides: Partial<Tarif595ReceiptDoc> = {}): Tarif595ReceiptDoc {
  const lines: Tarif595Line[] = [
    {
      record_id: 1,
      code: '1001',
      name: 'Training auf der Trainingsfläche, pro 1 Monat',
      quantity: 12,
      date_begin: '2027-01-15',
      unit_minor: 8900,
      amount_minor: 106800,
      vat_rate: 0,
    },
  ]
  return {
    id: 'r1'.padEnd(32, '0'),
    teamId: 'team-fixture',
    contact_id: 'contact-fixture',
    number: 'FIT-2027-00001',
    revision: 1,
    replaces: null,
    source: { kind: 'subscription', historyId: 'hist-1' },
    source_key: 'subscription:hist-1:2027-01-15:2028-01-14',
    status: 'issued',
    period: { from: '2027-01-15', to: '2028-01-14' },
    lines,
    totals: { amount_minor: 106800, vat_minor: 0 },
    language: 'de',
    modus: 'production',
    canton: 'ZH',
    biller: {
      gln: '7601001302112',
      zsr: 'Q123456',
      companyname: 'Studio Bewegung GmbH',
      postal: { street_name: 'Bahnhofstrasse', house_no: '12', zip: '8001', city: 'Zürich', country: 'CH' },
      phone: '044 123 45 67',
      email: 'hallo@studio-bewegung.ch',
    },
    provider: {
      gln: '7601001302112',
      gln_location: '7601001302112',
      zsr: 'Q123456',
      uid: null,
      companyname: 'Studio Bewegung GmbH',
      postal: { street_name: 'Bahnhofstrasse', house_no: '12', zip: '8001', city: 'Zürich', country: 'CH' },
      phone: '044 123 45 67',
      email: 'hallo@studio-bewegung.ch',
    },
    iban: 'CH9300762011623852957',
    vat_number: null,
    patient: {
      familyname: 'Muster-Meier',
      givenname: 'Petra',
      postal: { street_name: 'Musterstrasse', house_no: '5', zip: '6001', city: 'Luzern', country: 'CH' },
      email: 'petra@example.com',
      gender: 'female',
      sex: 'female',
      birthdate: '1986-02-28',
      ssn: '7569217076985',
      salutation: 'Frau',
    },
    guarantor: {
      familyname: 'Muster-Meier',
      givenname: 'Petra',
      postal: { street_name: 'Musterstrasse', house_no: '5', zip: '6001', city: 'Luzern', country: 'CH' },
      email: 'petra@example.com',
    },
    insurer: { gln: '7601003000012', name: 'Krankenkasse AG' },
    insured_number: '123.45.678-012',
    guid: 'f9f999ea1a3c404aa64a04327fc0aab2',
    request_timestamp: 1_800_000_000,
    request_date: '2027-01-20',
    files: null,
    delivery: { send_count: 0, emailed_at: null },
    created_at: ts,
    created_by: 'uid-manager',
    ...overrides,
  }
}

/** Three single-entry days + VAT-registered studio, no insurer known. */
export function attendanceReceipt(): Tarif595ReceiptDoc {
  const days = ['2027-03-02', '2027-03-09', '2027-03-16']
  const lines: Tarif595Line[] = days.map((d, i) => ({
    record_id: i + 1,
    code: '3039',
    name: 'Krafttraining Gruppe 1, pro 1 Lektion',
    quantity: 1,
    date_begin: d,
    unit_minor: 2500,
    amount_minor: 2500,
    vat_rate: 8.1,
  }))
  return monthlyReceipt({
    id: 'r2'.padEnd(32, '0'),
    number: 'FIT-2027-00002',
    source: { kind: 'attendance', activityId: 'act-pilates' },
    source_key: 'attendance:act-pilates:2027-03-01:2027-03-31',
    period: { from: '2027-03-01', to: '2027-03-31' },
    lines,
    totals: { amount_minor: 7500, vat_minor: 562 },
    vat_number: 'CHE123456789',
    insurer: null,
    insured_number: null,
    guid: '0f0e0d0c0b0a09080706050403020100',
  })
}
