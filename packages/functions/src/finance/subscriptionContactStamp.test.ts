import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertFinanceInvariant, buildConnectChargeTxn, financeTxnId } from '@linyup/shared'

// THE FINANCE HALF OF THE SUBSCRIPTION FIRST CHARGE.
//
// A subscription's first payment used to land on the payments dashboard as
// "unassigned", because `handleCheckoutCompleted` could not resolve the
// PaymentIntent and skipped the whole stamping block — including
// `stampFinanceContact`. So the finance journal row for EVERY subscription first
// charge was missing its contact too — the Basil→Dahlia field migration, whose
// story lives in utils/stripe/objectShape.ts.
//
// Two things are pinned here, because they are the two ways that can regress:
//
//   1. THE MONEY IS NOT INVOLVED. The contact is metadata on a journal row, and
//      stamping it later cannot disturb `gross + stripe_fee + platform_fee ===
//      net`. Proven rather than asserted in prose: the same charge built with and
//      without a contact is money-identical, and `linkFinanceTxnContact` — the
//      only writer the stamp goes through — updates exactly one field.
//
//   2. THE STAMP IS STILL CALLED, on both orderings of the two events that carry
//      the answer. These are SOURCE assertions on purpose: the call sites live
//      inside connect/webhook.ts, which cannot be imported without pulling in
//      firebase-functions and a Stripe client, and the claim is about the call
//      sites, which is a property of the text. Same technique, and same reason,
//      as connect/commitSites.test.ts.
//
// Run with: pnpm --filter @linyup/functions test

const SRC = join(__dirname, '..')
function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

describe('a subscription first charge — the money', () => {
  const base = {
    teamId: 't1',
    paymentIntentId: 'pi_sub_first',
    amount: 8900,
    currency: 'chf',
    applicationFeeAmount: 62,
    fees: { stripeFee: 288, applicationFee: 62, net: 8550, balanceTxnId: 'txn_1' },
    kind: 'membership',
    description: 'Monthly Unlimited',
    occurredAtMs: Date.UTC(2026, 7, 15, 15, 53),
    eventId: 'evt_1',
  }

  it('holds the invariant whether or not the buyer is known yet', () => {
    // The row is written by payment_intent.succeeded, which on an invoice-
    // generated PaymentIntent carries no metadata at all — so contactId null is
    // the NORMAL first state of this row, not a broken one.
    const unassigned = buildConnectChargeTxn({ ...base, contactId: null })
    const assigned = buildConnectChargeTxn({ ...base, contactId: 'c1' })
    assertFinanceInvariant(unassigned)
    assertFinanceInvariant(assigned)
    assert.equal(unassigned.contact_id, null)
    assert.equal(assigned.contact_id, 'c1')
  })

  it('is money-identical with and without the contact', () => {
    const unassigned = buildConnectChargeTxn({ ...base, contactId: null })
    const assigned = buildConnectChargeTxn({ ...base, contactId: 'c1' })
    for (const field of ['id', 'gross', 'stripe_fee', 'platform_fee', 'net', 'category'] as const) {
      assert.equal(assigned[field], unassigned[field], field)
    }
  })

  it('is stamped on the id the checkout handler will look for', () => {
    // stampFinanceContact → linkFinanceTxnContact(teamId, financeTxnId(...)).
    // A drift between the id the PI handler WRITES and the id the checkout
    // handler STAMPS would look exactly like "the stamp silently did nothing".
    assert.equal(
      buildConnectChargeTxn({ ...base, contactId: null }).id,
      financeTxnId('connect', 'charge', 'pi_sub_first')
    )
  })
})

describe('a subscription first charge — the stamp', () => {
  it('linkFinanceTxnContact mutates contact_id and nothing else', () => {
    // The journal permits exactly ONE financial mutation (upgradeFees). This is
    // the guard that the metadata linkage never becomes a second one — which is
    // what would put a row through the invariant's back door.
    // LF-normalized — see the note in connect/dahliaReads.test.ts. The slice
    // below is anchored on a bare newline, and a CRLF checkout makes it miss.
    const journal = read('finance/journal.ts').replace(/\r\n/g, '\n')
    const fn = journal.slice(journal.indexOf('export async function linkFinanceTxnContact'))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    const updated = [...body.matchAll(/\.update\(\{([^}]*)\}\)/g)].map((m) => m[1].trim())
    assert.deepEqual(updated, ['contact_id: contactId'])
  })

  it('the subscription branch of the checkout handler still calls it', () => {
    // This is the line whose ABSENCE was the defect: the whole block sat behind
    // `if (latestPaymentIntentId)`, and latestPaymentIntentId was always null.
    const webhook = read('connect/webhook.ts')
    const branch = webhook.slice(
      webhook.indexOf("if (session.mode === 'subscription' && session.subscription)"),
      webhook.indexOf('async function handleProductCheckout')
    )
    assert.ok(branch.length > 0, 'subscription branch not found — has it been renamed?')
    assert.ok(
      branch.includes('await stampFinanceContact(team.teamId, latestPaymentIntentId, contactId)'),
      'the subscription first charge no longer stamps the finance journal'
    )
  })

  it('the payment_intent handler resolves the contact from the payment doc', () => {
    // The other ordering. `stampFinanceContact` only works when the journal row
    // already EXISTS; when checkout.session.completed lands first the stamp
    // no-ops (NOT_FOUND is swallowed), and this read is what stops the row being
    // created with a null contact and left that way until a backfill.
    const webhook = read('connect/webhook.ts')
    assert.ok(
      webhook.includes(
        "const knownContactId = md.contactId ?? (prior?.contactId as string | undefined) ?? null"
      ),
      'handlePaymentIntent no longer falls back to the payment doc for the contact'
    )
    assert.ok(
      webhook.includes('contactId: knownContactId,'),
      'the finance charge row is no longer built from the resolved contact'
    )
  })

  it('the payment doc write never overwrites what the checkout handler resolved', () => {
    // Both halves of the same lesson. `contactId: md.contactId ?? null` merged an
    // unconditional null over the contact the checkout handler had just written,
    // and `purpose: md.purpose ?? 'payment'` merged 'payment' over its
    // 'membership'. handleSubscription already learned this for its own identity
    // fields; these are the same rule, in the handler that had not.
    const webhook = read('connect/webhook.ts')
    assert.ok(
      webhook.includes('...(knownContactId ? { contactId: knownContactId } : {}),'),
      'handlePaymentIntent writes contactId unconditionally again — it can clobber the checkout handler'
    )
    assert.ok(
      webhook.includes(
        "purpose: md.purpose ?? (prior?.purpose as string | undefined) ?? 'payment',"
      ),
      "handlePaymentIntent defaults `purpose` again — it can overwrite the checkout handler's 'membership'"
    )
    assert.ok(
      !/^\s*contactId: md\.contactId \?\? null,$/m.test(webhook),
      'the unconditional `contactId: md.contactId ?? null` write is back'
    )
  })
})
