import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// A RECEIPT IS AN ATTESTATION, NEVER A MONEY EVENT. Nothing in this folder may
// post to the finance journal, price through the payment resolver, or bump a
// counter with an increment — the number is an absolute value written inside
// the allocating transaction (pdf/numbering.ts), and `delivery.send_count` is
// written from the row just read. Read from the source, so a new file in the
// folder is covered without anyone remembering to list it.

const DIR = __dirname
const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.rules-test.ts'))
  .map((f) => [f, readFileSync(join(DIR, f), 'utf8').replace(/\r\n/g, '\n')] as const)

const FORBIDDEN: Array<[RegExp, string]> = [
  [/recordFinanceTransaction\(/, 'writes a finance journal row'],
  [/FieldValue\.increment\(/, 'increments a counter'],
  [/resolvePaymentOptions\(/, 'prices through the payment resolver'],
  [/createOneOffCheckoutSession\(/, 'starts a checkout'],
  [/stripe/i, 'touches Stripe'],
]

describe('tarif595 — a receipt is an attestation, never a money event', () => {
  it('reads the folder it is checking', () => {
    assert.ok(sources.some(([f]) => f === 'issue.ts'))
  })
  for (const [file, src] of sources) {
    for (const [re, what] of FORBIDDEN) {
      it(`${file} never ${what}`, () => {
        assert.ok(!re.test(src), `${file} ${what}`)
      })
    }
  }
  it('the number comes from allocateNumber inside the transaction, and only from there', () => {
    const issue = sources.find(([f]) => f === 'issue.ts')![1]
    assert.ok(/await allocateNumber\(tx, counterRef/.test(issue))
    assert.ok(!/counterRef\.(set|update)\(/.test(issue), 'the counter is only written through allocateNumber')
  })
})
