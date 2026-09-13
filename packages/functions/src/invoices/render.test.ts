import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  DEFAULT_INVOICE_SETTINGS,
  invoiceId,
  invoiceLangOf,
  resolveInvoiceSettings,
  validateInvoiceSettings,
} from '@linyup/shared'
import { sha256Hex } from '../utils/crypto'
import { openInvoice, vatQrrInvoice } from './fixtures/invoices'
import { renderInvoicePdf } from './render'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length

describe('invoices render — one sheet with the QR-bill payment part', function () {
  this.timeout(20_000)

  it('is a one-page PDF and renders identically twice', async () => {
    const inv = openInvoice()
    const pdf = await renderInvoicePdf(inv)
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    assert.equal(pageCount(pdf), 1)
    assert.equal(sha(await renderInvoicePdf(inv)), sha(pdf))
  })

  it('renders the VAT + QR-IBAN variant in every language', async () => {
    for (const language of ['de', 'fr', 'it', 'en'] as const) {
      const pdf = await renderInvoicePdf({ ...vatQrrInvoice(), language })
      assert.ok(pdf.length > 5_000, language)
    }
  })
})

describe('invoice settings and ids', () => {
  it('defaults apply when the doc is missing or partial', () => {
    assert.deepEqual(resolveInvoiceSettings(null), { ...DEFAULT_INVOICE_SETTINGS, footer_text: null, language: null })
    assert.equal(resolveInvoiceSettings({ prefix: 'bad prefix' }).prefix, 'INV')
    assert.equal(resolveInvoiceSettings({ prefix: 'R', due_days: 14 }).due_days, 14)
  })
  it('validateInvoiceSettings names bad prefix and out-of-range due days', () => {
    const by = Object.fromEntries(validateInvoiceSettings({ prefix: 'toolongprefix', due_days: 400 }).map((i) => [i.path, i.code]))
    assert.equal(by.prefix, 'pattern')
    assert.equal(by.due_days, 'range')
    assert.deepEqual(validateInvoiceSettings({ prefix: 'INV', due_days: 30 }), [])
  })
  it('the id is deterministic in (team, contact, requestKey)', () => {
    const a = invoiceId(sha256Hex, 't', 'c', 'k1')
    assert.equal(a.length, 32)
    assert.equal(a, invoiceId(sha256Hex, 't', 'c', 'k1'))
    assert.notEqual(a, invoiceId(sha256Hex, 't', 'c', 'k2'))
  })
  it('language falls back to German', () => {
    assert.equal(invoiceLangOf('en'), 'en')
    assert.equal(invoiceLangOf('rm'), 'de')
  })
})
