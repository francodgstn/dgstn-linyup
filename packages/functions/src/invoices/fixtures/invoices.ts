// Frozen invoice snapshots the pure tests render. Fixed values so the output is stable.
import type { InvoiceDoc } from '@linyup/shared'
import type { Timestamp } from 'firebase-admin/firestore'

const ts = { seconds: 1_800_000_000, nanoseconds: 0 } as unknown as Timestamp

export function openInvoice(overrides: Partial<InvoiceDoc> = {}): InvoiceDoc {
  return {
    id: 'i1'.padEnd(32, '0'),
    teamId: 'team-fixture',
    contact_id: 'contact-fixture',
    number: 'INV-2026-00001',
    status: 'open',
    creditor: {
      legal_name: 'Studio Bewegung GmbH',
      postal: { street_name: 'Bahnhofstrasse', house_no: '12', zip: '8001', city: 'Zürich', country: 'CH' },
      iban: 'CH9300762011623852957',
      qr_iban: null,
      vat_number: null,
      phone: '044 123 45 67',
      email: 'hallo@studio-bewegung.ch',
    },
    debtor: {
      familyname: 'Muster-Meier',
      givenname: 'Petra',
      postal: { street_name: 'Musterstrasse', house_no: '5', zip: '6001', city: 'Luzern', country: 'CH' },
      email: 'petra@example.com',
    },
    line_item: { kind: 'subscription', subscriptionTypeId: 'type-1', label: 'Jahresabo' },
    description: 'Jahresabo 2027',
    amount_minor: 106800,
    vat_rate: 0,
    vat_minor: 0,
    currency: 'CHF',
    issued_on: '2026-09-13',
    due_on: '2026-10-13',
    reference: { type: 'SCOR', value: 'RF76INV202600001' },
    message: null,
    footer_text: 'Zahlbar innert 30 Tagen. Vielen Dank!',
    language: 'de',
    request_timestamp: 1_800_000_000,
    files: null,
    delivery: { send_count: 0, emailed_at: null },
    paid: null,
    created_at: ts,
    created_by: 'uid-manager',
    ...overrides,
  }
}

/** VAT-registered studio with a QR-IBAN → QRR reference, French. */
export function vatQrrInvoice(): InvoiceDoc {
  return openInvoice({
    id: 'i2'.padEnd(32, '0'),
    number: 'INV-2026-00002',
    creditor: {
      ...openInvoice().creditor,
      qr_iban: 'CH4431999123000889012',
      vat_number: 'CHE123456789',
    },
    amount_minor: 7500,
    vat_rate: 8.1,
    vat_minor: 562,
    reference: { type: 'QRR', value: '000000000000000002026000022' },
    language: 'fr',
    message: 'Merci pour votre confiance',
  })
}
