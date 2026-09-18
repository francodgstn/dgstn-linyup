// EVERY WRITER OF A LEDGER ROW OUTSIDE THE APP STAMPS `expires_at`.
//
// The app's writers go through utils/ledgerRetention.ts and are covered by
// ledgerRetention.test.ts. The seeders and the HMD migration write ledger rows
// STRAIGHT TO FIRESTORE with the Admin SDK, bypassing those writers — so this
// is the other half of the same guarantee, and it spans the scripts/functions
// boundary on purpose (CLAUDE.md: that boundary is where corrections stop
// travelling).
//
// The failure it guards is SILENT in every direction: an unstamped row raises
// no error, fails no other test, and simply never expires. Nothing on any
// screen says a ledger is immortal.
//
// It reads the SOURCE rather than running a seeder, because running one needs
// an emulator. So it asserts the CAUSE structurally — the write site names
// `expires_at` — rather than sampling an outcome (CLAUDE.md, "A guard that
// SAMPLES a race is not a guard").
import * as assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

/** The write sites, named — never a count (CLAUDE.md). Each entry is a file and
 *  the ledger collection whose rows it writes. */
const SEED_LEDGER_WRITERS: { file: string; collection: string }[] = [
  { file: 'scripts/seed-emulator.ts', collection: 'activity_log' },
  { file: 'scripts/seed-sandbox.ts', collection: 'activity_log' },
  { file: 'scripts/seed-lead.ts', collection: 'activity_log' },
  { file: 'scripts/seed-staging.ts', collection: 'activity_log' },
  { file: 'scripts/lib/fixtures/automations.ts', collection: 'automation_logs' },
  { file: 'scripts/migration/transforms/activity-log.ts', collection: 'activity_log' },
]

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

describe('ledger rows written by scripts carry a TTL stamp', () => {
  it('every known writer stamps expires_at through the shared helper', () => {
    for (const { file, collection } of SEED_LEDGER_WRITERS) {
      const src = read(file)
      assert.ok(
        src.includes('ledgerExpiry('),
        `${file} writes ${collection} rows but never calls ledgerExpiry — those rows never expire`,
      )
      assert.ok(
        src.includes(`ledgerExpiry('${collection}'`),
        `${file} must stamp the ${collection} ledger by name, so the right retention applies`,
      )
      assert.ok(
        src.includes('expires_at'),
        `${file} does not write an expires_at field`,
      )
    }
  })

  it('no writer hardcodes a retention window instead of reading the policy', () => {
    // A mirrored `90` or `548` is the copy that drifts the day the policy moves.
    for (const { file } of SEED_LEDGER_WRITERS) {
      assert.doesNotMatch(
        read(file),
        /expires_at[^\n]*\b(90|548)\b/,
        `${file} appears to hardcode a retention window on the expires_at line`,
      )
    }
  })

  it('the helper derives the window from @linyup/shared, not from a local constant', () => {
    const helper = read('scripts/lib/ledgerExpiry.ts')
    assert.ok(
      helper.includes("from '@linyup/shared'") && helper.includes('ledgerExpiresAt'),
      'scripts/lib/ledgerExpiry.ts must compute the stamp from the shared policy',
    )
  })

  // THE CONTACT COUNTER is the sibling gap, and the same shape: a seeder writes
  // contacts straight to Firestore, so neither of the counter's live writers
  // (the trackContacts delta trigger, the nightly reconciler) has run for them.
  // Pinned here because the local failure is a CONFIDENT WRONG NUMBER rather
  // than a blank — trackContacts runs in the emulator and its increment() on a
  // missing document creates it at 1.
  it('every seeder that writes contacts also stamps the contact counter', () => {
    for (const rel of [
      'scripts/seed-emulator.ts',
      'scripts/seed-sandbox.ts',
      'scripts/seed-lead.ts',
      'scripts/seed-staging.ts',
      'scripts/migration/passes/18-contact-counters.ts',
    ]) {
      assert.ok(
        read(rel).includes('writeTeamContactCounter('),
        `${rel} seeds contacts but never stamps teams/{id}/counters/contacts`,
      )
    }
  })

  it('the counter helper counts the way the nightly reconciler counts', () => {
    // The value a seed writes and the value the nightly job would later write
    // must never disagree — a second definition of "live" is worse than none.
    const helper = read('scripts/lib/contactCounter.ts')
    for (const clause of ["where('teamId', '==', teamId)", "where('deleted_at', '==', null)", "where('archived_at', '==', null)", '.count()']) {
      assert.ok(
        helper.includes(clause),
        `scripts/lib/contactCounter.ts must use ${clause}, as countActiveContacts does`,
      )
    }
    // Absolute, never a delta — the rule both real writers follow. Comments are
    // stripped first: this file's header QUOTES the trigger's own
    // `set({ live: increment(1) }, …)` to explain what it is not doing, and
    // matching prose instead of code is how a source-reading pin fails wrongly.
    const code = helper
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
      })
      .join('\n')
    assert.doesNotMatch(
      code,
      /increment\(/,
      'the seeder counter must write an ABSOLUTE value, never an increment',
    )
  })

  // THE ONE THAT CATCHES A NEW SEEDER. The list above is maintained by hand, so
  // this re-derives the writer set from the source and fails when a file writes
  // a ledger collection without being listed — the way the list goes stale.
  it('no unlisted script writes a ledger collection', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    const ledgers = ['activity_log', 'automation_logs', 'mail_sends', 'notifications', 'api_usage']
    // Files that WRITE a row: a `.collection('<ledger>')` or a subcollection
    // constant assignment, excluding the teardown lists and the backfill itself.
    const out = execSync(
      `grep -rlE "collection\\\\((['\\"])(${ledgers.join('|')})\\\\1\\\\)|_SUBCOLLECTION = '(${ledgers.join('|')})'" scripts/ --include=*.ts || true`,
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    const found = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // The backfill is the repair pass, not a writer of new rows; the teardown
      // script names the collections only to delete them.
      .filter((f) => f !== 'scripts/backfill-ledger-ttl.ts' && f !== 'scripts/reset-sandbox-db.ts')
    const listed = new Set(SEED_LEDGER_WRITERS.map((w) => w.file))
    const unlisted = found.filter((f) => !listed.has(f))
    assert.deepStrictEqual(
      unlisted,
      [],
      `these scripts write a ledger collection but are not in SEED_LEDGER_WRITERS, so nothing checks that they stamp expires_at: ${unlisted.join(', ')}`,
    )
  })
})
