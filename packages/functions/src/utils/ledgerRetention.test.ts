import * as assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Timestamp } from 'firebase-admin/firestore'
import { LEDGER_EXPIRES_AT_FIELD, LEDGER_RETENTION_DAYS, ledgerExpiresAt } from '@linyup/shared'
import { ledgerExpiry, withLedgerExpiry } from './ledgerRetention'

// ONE retention policy, and the TTL declarations that enforce it must name
// exactly the ledgers it names — a policy with no declaration never deletes,
// and a declaration with no policy deletes rows nothing stamps.

const DAY_MS = 86_400_000

describe('ledger retention', () => {
  it('every ledger has a positive retention', () => {
    for (const [ledger, days] of Object.entries(LEDGER_RETENTION_DAYS)) {
      assert.ok(days > 0, `${ledger} retention must be positive`)
    }
  })

  it('expires `days` after the row date, and from now when no date is given', () => {
    const from = new Date(2026, 0, 1, 12)
    assert.strictEqual(
      ledgerExpiresAt('mail_sends', from).getTime(),
      from.getTime() + LEDGER_RETENTION_DAYS.mail_sends * DAY_MS,
    )
    const before = Date.now()
    const stamp = ledgerExpiry('automation_logs')
    assert.ok(stamp instanceof Timestamp)
    assert.ok(stamp.toMillis() >= before + LEDGER_RETENTION_DAYS.automation_logs * DAY_MS)
  })

  it('withLedgerExpiry stamps beside the row and leaves the row alone', () => {
    const row = { type: 'payment_received', message: 'x' }
    const stamped = withLedgerExpiry('activity_log', row)
    assert.strictEqual(stamped.type, 'payment_received')
    assert.ok(stamped.expires_at instanceof Timestamp)
    assert.strictEqual('expires_at' in row, false)
  })

  it('firestore.index.json declares a TTL on exactly the ledgers the policy names', () => {
    const indexes = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../firestore.index.json'), 'utf8'),
    ) as { fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; ttl?: boolean }> }
    const declared = indexes.fieldOverrides
      .filter((f) => f.ttl === true)
      .map((f) => {
        assert.strictEqual(f.fieldPath, LEDGER_EXPIRES_AT_FIELD, `${f.collectionGroup} TTL must key on ${LEDGER_EXPIRES_AT_FIELD}`)
        return f.collectionGroup
      })
      .sort()
    assert.deepStrictEqual(declared, Object.keys(LEDGER_RETENTION_DAYS).sort())
  })
})
