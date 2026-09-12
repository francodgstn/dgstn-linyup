import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// AN INVOICE IS A CLAIM, NOT A MONEY EVENT. Nothing in this folder posts to the
// finance journal or bumps a counter with an increment; the ONE money write is
// markInvoicePaid's call into the shared manual-payment writer, which owns the
// journal row exactly as the Record-payment dialog's path does. The number is
// an absolute value written inside the allocating transaction (pdf/numbering.ts).

const DIR = __dirname
const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('.rules-test.'))
  .map((f) => [f, readFileSync(join(DIR, f), 'utf8').replace(/\r\n/g, '\n')] as const)

describe('invoices — a claim, not a money event', () => {
  it('reads the folder it is checking', () => {
    assert.ok(sources.some(([f]) => f === 'create.ts'))
  })
  for (const [file, src] of sources) {
    it(`${file} never writes a journal row, increments a counter, prices through the resolver or touches Stripe`, () => {
      assert.ok(!/recordFinanceTransaction\(/.test(src), `${file} writes a finance journal row`)
      assert.ok(!/FieldValue\.increment\(/.test(src), `${file} increments a counter`)
      assert.ok(!/resolvePaymentOptions\(/.test(src), `${file} prices through the resolver`)
      assert.ok(!/stripe/i.test(src), `${file} touches Stripe`)
    })
  }
  it('the ONLY money write is markInvoicePaid → writeManualPaymentEvent, keyed by the invoice id', () => {
    for (const [file, src] of sources) {
      const calls = (src.match(/writeManualPaymentEvent\(/g) ?? []).length
      if (file === 'markPaid.ts') {
        assert.equal(calls, 1)
        assert.ok(/idempotencyKey: `invoice-\$\{invoiceId\}`/.test(src), 'the payment is keyed by the invoice id so a retry is a no-op')
      } else {
        assert.equal(calls, 0, `${file} records a payment`)
      }
    }
  })
  it('the number comes from allocateNumber inside the transaction, and only from there', () => {
    const create = sources.find(([f]) => f === 'create.ts')![1]
    assert.ok(/await allocateNumber\(tx, counterRef/.test(create))
    assert.ok(!/counterRef\.(set|update)\(/.test(create))
  })
})
