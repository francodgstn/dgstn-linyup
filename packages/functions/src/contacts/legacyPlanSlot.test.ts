import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE LEGACY PLAN SLOT — every place that writes it, pinned against the source.
//
// A contact's non-Stripe plan lives in ONE slot today: `subscription_type_id`
// and its siblings on the contact document. docs/multi-plan-holdings.md
// replaces that slot with a list of plans, in phases. Until the last phase
// removes it, the one way the work can quietly go backwards is a NEW writer of
// the slot, added somewhere nobody is looking. This file is phase 0: the census
// that makes a new writer fail the build.
//
// ── WHAT COUNTS AS A SITE ───────────────────────────────────────────────────
// It reads SOURCE, not modules, in every tracked place that can write a
// document: the functions package (src and scripts), the web, admin and member
// apps, and the root scripts. `packages/shared` is left out on purpose — it is
// types and pure functions and writes nothing. Test files are left out too.
// After comments are stripped, a SITE is:
//   • a slot field as an object-literal key (`subscription_type_id: …`, quoted
//     or not — a `?:` type member is not one);
//   • a slot field assigned (`obj.subscription_type_id = …`, `obj['…'] = …`);
//   • a call to `writeContactSubscriptionFields`.
// Only TRACKED files are read (`git ls-files`), so the gitignored lead profiles
// a developer machine carries cannot make a local run disagree with CI.
//
// ── WHY EVERY FILE IS LISTED, NOT ONLY THE WRITERS ──────────────────────────
// The field names are not the slot's alone. A booking records which plan
// priced it; credit grants, plan purchases, partner visits and payment rows name
// their plan type; history rows and `active_subscriptions` entries copy it; type
// annotations spell it. A scan cannot tell those from a write to the contact, so
// a person classified each file once:
//   • `sites`   — every site the scan finds in the file. Asserted exact.
//   • `writers` — snippets of the sites that write the CONTACT's slot. Each is
//                 asserted present, so a writer that moves or goes is noticed.
// A new file with a site, or a changed total, fails until it is classified
// here — which is exactly the moment to ask whether it writes the slot.
//
// ── WHEN IT IS DONE ─────────────────────────────────────────────────────────
// Phase 5 of the design ends with every `writers` list empty. The entries that
// are not the slot stay: those documents keep their field.
//
// ── WHAT IT CANNOT SEE ──────────────────────────────────────────────────────
// A shorthand property (`{ subscription_type_id }`), a computed key, or a field
// path assembled from a variable. None exist today; a reviewer catches the next.
//
// Run with: pnpm --filter @linyup/functions test

/** The worktree root: contacts → src → functions → packages → root. */
const ROOT = join(__dirname, '..', '..', '..', '..')

/** Every tracked place a document can be written from. */
const SCAN_ROOTS = [
  'packages/functions/src',
  'packages/functions/scripts',
  'apps/web/src',
  'apps/admin/src',
  'apps/mobile/src',
  'scripts',
]

/** The slot: every field `writeContactSubscriptionFields` owns on the contact. */
const SLOT_FIELDS = [
  'subscription_type_id',
  'subscription_type_name',
  'subscription_price_id',
  'subscription_recurrence',
  'subscription_amount',
  'subscription_expires_at',
  'subscription_source_ref',
  'subscription_type_updated_at',
]

const FIELDS = SLOT_FIELDS.join('|')
const KEY = new RegExp(`(?<![\\w.?])['"]?(?:${FIELDS})['"]?\\s*:(?!:)`, 'g')
const ASSIGN = new RegExp(`\\.(?:${FIELDS})\\s*=(?!=)|\\[['"](?:${FIELDS})['"]\\]\\s*=(?!=)`, 'g')
const WRITER_CALL = /(?<!function\s)\bwriteContactSubscriptionFields\s*\(/g

/** CODE only, line endings normalised — a comment that quotes a slot write is
 *  documentation, and counting it is the confusion this file exists to remove. */
function code(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

function countSites(source: string): number {
  const c = code(source)
  return (
    (c.match(KEY) ?? []).length + (c.match(ASSIGN) ?? []).length + (c.match(WRITER_CALL) ?? []).length
  )
}

/** Runs of spaces and tabs collapsed, so an aligned `out.a   = b` matches `out.a = b`. */
const squash = (s: string) => s.replace(/[ \t]+/g, ' ')

function trackedSources(): string[] {
  const listing = execFileSync('git', ['ls-files', '--', ...SCAN_ROOTS], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return listing
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.(test|rules-test|d)\.tsx?$/.test(f))
}

interface CensusEntry {
  sites: number
  /** Snippets of the sites that write the CONTACT's plan slot. Empty = none do. */
  writers: string[]
  /** What the sites are. */
  note: string
}

const CENSUS: Record<string, CensusEntry> = {
  // ── functions ─────────────────────────────────────────────────────────────
  'packages/functions/src/analytics/index.ts': {
    sites: 2,
    writers: [],
    note: 'type annotations on active_subscriptions entries',
  },
  'packages/functions/src/appointments/checkout.ts': {
    sites: 1,
    writers: [],
    note: 'the booking records which membership priced it',
  },
  'packages/functions/src/appointments/staffBooking.ts': {
    sites: 1,
    writers: [],
    note: 'the booking document',
  },
  'packages/functions/src/appointments/window.ts': {
    sites: 1,
    writers: [],
    note: 'the booking records which benefit priced it',
  },
  'packages/functions/src/automation/onContactWrite.ts': {
    sites: 1,
    writers: [],
    note: 'a type annotation',
  },
  'packages/functions/src/billing/handlePayrexxWebhook.ts': {
    sites: 2,
    writers: ['contactUpdate.subscription_type_id = subscriptionTypeId'],
    note: 'the payment_events row names its plan; the contact update overwrites the slot id, not its name',
  },
  'packages/functions/src/billing/handleTeamStripeWebhook.ts': {
    sites: 3,
    writers: [
      'update.subscription_type_id = typeId',
      'update.subscription_type_id = extracted.subscriptionTypeId',
    ],
    note: 'the payment_events row names its plan; both contact updates overwrite the slot id, not its name',
  },
  'packages/functions/src/booking/index.ts': {
    sites: 4,
    writers: [],
    note: 'booking attribution, the usage window, the partner visit',
  },
  'packages/functions/src/booking/waitlist/claim.ts': {
    sites: 4,
    writers: [],
    note: 'the usage window, the claimed booking, the partner visit',
  },
  'packages/functions/src/connect/updatePayment.ts': {
    sites: 1,
    writers: [],
    note: "the payment row's plan link",
  },
  'packages/functions/src/connect/webhook.ts': {
    sites: 4,
    writers: ['writeContactSubscriptionFields(db, contactId, {'],
    note: 'a credit grant and a booking name their plan; the membership write goes through the shared writer, for one-off purchases AND every active subscription event',
  },
  'packages/functions/src/contacts/grantCredits.ts': {
    sites: 2,
    writers: [],
    note: 'the credit grant document',
  },
  'packages/functions/src/contacts/planCallables.ts': {
    sites: 16,
    writers: ['subscription_type_id: plan.subscriptionTypeId', 'subscription_type_id: null'],
    note: "the staff plan callables' bridge: set to the plan given, cleared when nothing open still holds it",
  },
  'packages/functions/src/contacts/planGrants.ts': {
    sites: 6,
    writers: [],
    note: "plan grant rows name their plan; nothing here writes the contact's slot",
  },
  'packages/functions/src/ops/demoTenant.ts': {
    sites: 4,
    writers: ['subscription_type_id: SUBSCRIPTION_TYPE_ID'],
    note: "the review studio's demo contacts (the slot, as the bridge) and the plan grant each one is given",
  },
  'packages/functions/src/payments/effects.ts': {
    sites: 11,
    writers: [
      'subscription_type_id: fields.subscriptionTypeId',
      'update.subscription_amount = fields.amountMajor',
      'writeContactSubscriptionFields(db, contactId, {',
    ],
    note: 'the shared writer and its call from applyPaymentEffects; the credit grant document names its plan',
  },
  'packages/functions/src/payments/planPurchases.ts': {
    sites: 1,
    writers: [],
    note: 'the buy-once allowance row',
  },
  'packages/functions/src/payments/recordManualPayment.ts': {
    sites: 1,
    writers: [],
    note: 'the payment_events row',
  },
  'packages/functions/src/payments/reversal.ts': {
    sites: 8,
    writers: ['subscription_type_id: FieldValue.delete()'],
    note: 'a refund clears the slot the refunded payment wrote',
  },
  'packages/functions/src/sync/onContactSubscriptionChange.ts': {
    sites: 4,
    writers: [],
    note: 'subscription history rows',
  },
  'packages/functions/src/sync/onCreditGrantWrite.ts': {
    sites: 3,
    writers: [],
    note: 'credit_summary entries',
  },
  'packages/functions/src/utils/automationEngine.ts': {
    sites: 1,
    writers: [],
    note: 'a type annotation',
  },

  // ── web ───────────────────────────────────────────────────────────────────
  'apps/web/src/app/[locale]/(public)/public/[slug]/space/SpaceMembershipCard.tsx': {
    sites: 2,
    writers: [],
    note: 'a display object',
  },

  // ── scripts ───────────────────────────────────────────────────────────────
  'scripts/lib/fixtures/money.ts': {
    sites: 2,
    writers: [],
    note: 'a type, a read',
    // WAS 3. The third was a seeded `line_item`, which spelled its ids the way
    // Firestore spells them at the TOP level of a payment — so a key that only
    // ever named a PaymentLineItem field was counted here as if it named the
    // contact's plan slot. `PaymentLineItem.subscriptionTypeId` is camelCase and
    // always was; the seed was simply wrong, and nothing read what it wrote.
    // Neither remaining site is a writer: the slot is read here, never set.
  },
  'scripts/lib/fixtures/subscriptionHistory.ts': {
    sites: 6,
    writers: [],
    note: 'subscription history rows',
  },
  'scripts/migration/transforms/contacts.ts': {
    sites: 10,
    writers: ['out.subscription_type_id = match.typeId'],
    note: 'the HMD contact transform writes the slot; its active_subscriptions entries are not the slot',
  },
  'scripts/repair-hmd-subscriptions.ts': {
    sites: 20,
    writers: ["subscription_type_id: ''", 'patch.subscription_amount = r.amount'],
    note: 'patches and clears the contact slot; its active_subscriptions entries and history rows are not the slot',
  },
  'scripts/seed-emulator.ts': {
    sites: 5,
    writers: ['subscription_type_id: subAssign.subId'],
    note: 'seeded contacts',
  },
  'scripts/seed-lead.ts': {
    sites: 10,
    writers: ['subscription_recurrence: sub.recurrence'],
    note: 'lead contacts; the credit grant and credit_summary entries are not the slot',
  },
  'scripts/seed-sandbox.ts': {
    sites: 6,
    writers: ['subscription_recurrence: sub.recurrence'],
    note: 'sandbox contacts',
  },
  'scripts/seed-staging.ts': {
    sites: 6,
    writers: ['subscription_recurrence: sub.recurrence'],
    note: 'staging contacts',
  },
}

describe('THE LEGACY PLAN SLOT — every writer, pinned (docs/multi-plan-holdings.md, phase 0)', () => {
  const files = trackedSources()
  const sources = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
  const found = new Map<string, number>()
  for (const [f, src] of sources) {
    const n = countSites(src)
    if (n > 0) found.set(f, n)
  }

  it('reads the real tree, not an empty listing', () => {
    // A `git ls-files` that silently returns nothing would pass every check below.
    assert.ok(files.some((f) => f.startsWith('packages/functions/src/')), 'no functions sources listed')
    assert.ok(files.some((f) => f.startsWith('apps/web/src/')), 'no web sources listed')
    assert.ok(files.some((f) => f.startsWith('scripts/')), 'no root scripts listed')
  })

  it('every file with a slot-field site is classified in the census', () => {
    const unclassified = [...found.keys()].filter((f) => !(f in CENSUS)).sort()
    assert.deepEqual(
      unclassified,
      [],
      `New slot-field sites. Classify each file in CENSUS — does it write the CONTACT's plan slot, or another document that shares the field name?\n  ${unclassified.map((f) => `${f} (${found.get(f)})`).join('\n  ')}`
    )
  })

  it('…with exactly the number of sites the census records', () => {
    const drifted = Object.entries(CENSUS)
      .filter(([f, e]) => (found.get(f) ?? 0) !== e.sites)
      .map(([f, e]) => `${f}: census ${e.sites}, source ${found.get(f) ?? 0}`)
    assert.deepEqual(
      drifted,
      [],
      `Site counts moved. Re-check whether a slot writer was added or removed, then update CENSUS:\n  ${drifted.join('\n  ')}`
    )
  })

  it('every recorded writer is still in its file', () => {
    const missing: string[] = []
    for (const [f, e] of Object.entries(CENSUS)) {
      const src = sources.get(f)
      if (src === undefined) continue // reported by the count check above
      const body = squash(code(src))
      for (const snippet of e.writers) {
        if (!body.includes(squash(snippet))) missing.push(`${f}: ${snippet}`)
      }
    }
    assert.deepEqual(
      missing,
      [],
      `A recorded slot writer is gone or has changed shape. If it was removed on purpose, drop it from CENSUS:\n  ${missing.join('\n  ')}`
    )
  })

  it('the shared slot writer is called only where the census names it as a writer', () => {
    const callers = [...sources]
      .filter(([, src]) => (code(src).match(WRITER_CALL) ?? []).length > 0)
      .map(([f]) => f)
    const unnamed = callers.filter(
      (f) => !(CENSUS[f]?.writers ?? []).some((s) => s.startsWith('writeContactSubscriptionFields('))
    )
    assert.deepEqual(unnamed, [], `writeContactSubscriptionFields called from an unnamed file:\n  ${unnamed.join('\n  ')}`)
  })

  it('and the count is capable of failing', () => {
    assert.equal(countSites('const x = 1'), 0)
    assert.equal(countSites("await ref.update({ subscription_type_id: id, 'subscription_amount': 1 })"), 2)
    assert.equal(countSites('update.subscription_expires_at = null'), 1)
    assert.equal(countSites('writeContactSubscriptionFields(db, id, fields)'), 1)
    assert.equal(countSites('export async function writeContactSubscriptionFields(db: Db) {}'), 0)
    assert.equal(countSites('interface C { subscription_type_id?: string }'), 0)
    assert.equal(countSites('// subscription_type_id: commented out'), 0)
    assert.equal(countSites('if (a.subscription_type_id === b) {}'), 0)
  })
})
