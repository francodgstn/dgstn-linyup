/**
 * Stamp `expires_at` on every ledger row written before the field existed, so
 * Firestore's TTL policies can retire them.
 *
 * ── WHY IT IS NEEDED ────────────────────────────────────────────────────────
 * A TTL policy deletes a document when the instant in its `expires_at` field
 * has passed. A document WITHOUT the field is never touched — so the writers
 * now stamping it (packages/functions/src/utils/ledgerRetention.ts) only cover
 * rows written from that deploy on, and every row before it would sit in the
 * ledger forever, exactly as before. This pass stamps the backlog.
 *
 * Retention comes from ONE place — `LEDGER_RETENTION_DAYS` in @linyup/shared —
 * and is counted from the row's own date (`created_at`, `triggered_at`, or the
 * contact timeline's `timestamp`), so an old row expires when it would have had
 * the policy always existed. A row with no usable date is counted from now.
 * Rows already past their expiry are stamped like any other: the TTL service
 * deletes them on its own schedule (within about 72 hours), and this script
 * deliberately does not delete anything itself.
 *
 * ── ORDER OF OPERATIONS (this matters) ──────────────────────────────────────
 *  1. Deploy the functions that stamp new rows AND carry the platform mail
 *     total forward (mail/mailMetrics.ts), and let `capturePlatformMetrics` run
 *     at least once — its first run seeds `sent_cumulative` from the WHOLE
 *     ledger, which must still be whole.
 *  2. Run this script with --apply.
 *  3. Deploy the `ttl: true` field overrides in firestore.index.json (the
 *     regular `firebase deploy --only firestore:indexes`). Deletions begin
 *     within 24 hours of the policy going active.
 *
 * ── WHAT IT READS / WRITES ──────────────────────────────────────────────────
 * One collection-group scan per ledger, paged; one single-field `update()` per
 * row that lacks the field, batched 400 to a commit. It never rewrites a row
 * that already carries `expires_at`, so it is re-runnable and idempotent.
 *
 * Auth: gcloud Application Default Credentials (ADC), like the other scripts.
 * Against the emulator, set FIRESTORE_EMULATOR_HOST and use the demo project.
 *
 * Usage:
 *   tsx scripts/backfill-ledger-ttl.ts --project linyup-staging [--ledger mail_sends] [--apply]
 *
 * Without --apply it only reports what it would write.
 */

import { parseArgs } from 'node:util'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import {
  LEDGER_EXPIRES_AT_FIELD,
  LEDGER_RETENTION_DAYS,
  ledgerExpiresAt,
  type LedgerCollection,
} from '@linyup/shared'

/** One scan page. */
const PAGE = 1000
/** Firestore's batch limit is 500; leave headroom. */
const BATCH = 400

/** The field each ledger dates its rows by. The contact timeline
 *  (`contacts/{id}/activity_log`) and the studio feed (`teams/{id}/activity_log`)
 *  share a collection group but not a field name, so both are tried. */
const DATE_FIELDS: Record<LedgerCollection, readonly string[]> = {
  activity_log: ['created_at', 'timestamp'],
  mail_sends: ['created_at'],
  automation_logs: ['triggered_at'],
  notifications: ['created_at'],
}

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    ledger: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
})

if (!values.project) {
  console.error('❌ --project is required (e.g. --project linyup-staging, or demo-linyup for the emulator)')
  process.exit(1)
}
const ledgers = Object.keys(LEDGER_RETENTION_DAYS) as LedgerCollection[]
if (values.ledger && !ledgers.includes(values.ledger as LedgerCollection)) {
  console.error(`❌ --ledger must be one of: ${ledgers.join(', ')}`)
  process.exit(1)
}

admin.initializeApp({ credential: applicationDefault(), projectId: values.project })
const db = admin.firestore()

function rowDate(data: FirebaseFirestore.DocumentData, fields: readonly string[]): Date | null {
  for (const f of fields) {
    const v = data[f] as unknown
    if (v instanceof Timestamp) return v.toDate()
    if (v && typeof (v as { toDate?: unknown }).toDate === 'function') return (v as { toDate(): Date }).toDate()
  }
  return null
}

async function backfill(ledger: LedgerCollection) {
  const stats = { scanned: 0, stamped: 0, alreadyStamped: 0, undated: 0, alreadyExpired: 0 }
  const now = new Date()
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
  let batch = db.batch()
  let inBatch = 0

  const flush = async () => {
    if (inBatch === 0) return
    if (values.apply) await batch.commit()
    batch = db.batch()
    inBatch = 0
  }

  for (;;) {
    let q = db.collectionGroup(ledger).orderBy(FieldPath.documentId()).limit(PAGE)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    if (snap.empty) break

    for (const doc of snap.docs) {
      stats.scanned++
      const data = doc.data()
      if (data[LEDGER_EXPIRES_AT_FIELD] != null) {
        stats.alreadyStamped++
        continue
      }
      const dated = rowDate(data, DATE_FIELDS[ledger])
      if (!dated) stats.undated++
      const expiresAt = ledgerExpiresAt(ledger, dated ?? now)
      if (expiresAt.getTime() <= now.getTime()) stats.alreadyExpired++
      batch.update(doc.ref, { [LEDGER_EXPIRES_AT_FIELD]: Timestamp.fromDate(expiresAt) })
      inBatch++
      stats.stamped++
      if (inBatch >= BATCH) await flush()
    }

    cursor = snap.docs[snap.docs.length - 1]
    if (snap.size < PAGE) break
  }
  await flush()

  console.log(
    `   ${ledger}: ${values.apply ? 'stamped' : 'would stamp'} ${stats.stamped} of ${stats.scanned} row(s)` +
      ` (${stats.alreadyStamped} already stamped; ${stats.undated} undated → counted from now;` +
      ` ${stats.alreadyExpired} already past the ${LEDGER_RETENTION_DAYS[ledger]}-day window)`,
  )
}

async function main() {
  console.log(
    `\n🔧 Ledger TTL backfill on '${values.project}'${values.ledger ? ` (${values.ledger} only)` : ''} ${
      values.apply ? '(APPLY)' : '(dry-run)'
    }\n`,
  )
  for (const ledger of ledgers) {
    if (values.ledger && ledger !== values.ledger) continue
    await backfill(ledger)
  }
  if (!values.apply) console.log('\n   Re-run with --apply to write.\n')
}

main().catch((err) => {
  console.error('❌ backfill failed:', err)
  process.exit(1)
})
