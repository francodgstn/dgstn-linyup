import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE LEGACY PLAN SLOT — gone, and pinned so it stays gone.
//
// A contact's non-Stripe plan used to live in ONE slot: `subscription_type_id`
// and its siblings on the contact document. docs/multi-plan-holdings.md
// replaced it with a list of plans (`held_plans`, built from plan grants and
// Stripe subscriptions), and phase 5 removed every writer and reader of the
// slot. The one way that can quietly go backwards is a NEW write of a slot
// field onto a contact, added somewhere nobody is looking. This census makes
// any new site fail the build until a person has said what it writes.
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
// ── WHY EVERY FILE IS LISTED ────────────────────────────────────────────────
// The field names are not the slot's alone. A booking records which plan
// priced it; plan grants, credit grants, plan purchases, partner visits and
// payment rows name their plan type; history rows and `active_subscriptions`
// entries copy it; type annotations spell it. A scan cannot tell those from a
// write to the contact, so a person classified each file once, with `sites` —
// every site the scan finds in it, asserted exact — and a note saying what the
// sites are. None of them is the contact. A new file with a site, or a changed
// total, fails until it is classified here — which is exactly the moment to
// ask whether it writes a contact's plan field. If it does, it is a defect:
// the contact's plans are its plan grants.
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

/** The slot: every field the removed `writeContactSubscriptionFields` owned on the contact. */
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

/** CODE only, line endings normalized — a comment that quotes a slot write is
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
  /** What the sites are — never the contact. */
  note: string
}

const CENSUS: Record<string, CensusEntry> = {
  // ── functions ─────────────────────────────────────────────────────────────
  'packages/functions/src/appointments/checkout.ts': {
    sites: 1,
    note: 'the booking records which membership priced it',
  },
  'packages/functions/src/appointments/staffBooking.ts': {
    sites: 1,
    note: 'the booking document',
  },
  'packages/functions/src/appointments/window.ts': {
    sites: 1,
    note: 'the booking records which benefit priced it',
  },
  'packages/functions/src/billing/handlePayrexxWebhook.ts': {
    sites: 1,
    note: 'the payment_events row names its plan',
  },
  'packages/functions/src/billing/handleTeamStripeWebhook.ts': {
    sites: 1,
    note: 'the payment_events row names its plan',
  },
  'packages/functions/src/booking/index.ts': {
    sites: 4,
    note: 'booking attribution, the usage window, the partner visit',
  },
  'packages/functions/src/booking/waitlist/claim.ts': {
    sites: 4,
    note: 'the usage window, the claimed booking, the partner visit',
  },
  'packages/functions/src/connect/updatePayment.ts': {
    sites: 1,
    note: "the payment row's plan link",
  },
  'packages/functions/src/connect/webhook.ts': {
    sites: 3,
    note: 'a credit grant and a booking name their plan',
  },
  'packages/functions/src/contacts/grantCredits.ts': {
    sites: 2,
    note: 'the credit grant document',
  },
  'packages/functions/src/contacts/planGrants.ts': {
    sites: 6,
    note: "plan grant rows name their plan; nothing here writes the contact's slot",
  },
  'packages/functions/src/payments/effects.ts': {
    sites: 2,
    note: 'the credit grant document',
  },
  'packages/functions/src/payments/planPurchases.ts': {
    sites: 1,
    note: 'the buy-once allowance row',
  },
  'packages/functions/src/payments/recordManualPayment.ts': {
    sites: 1,
    note: 'the payment_events row',
  },
  'packages/functions/src/sync/onContactSubscriptionChange.ts': {
    sites: 4,
    note: 'subscription history rows',
  },
  'packages/functions/src/sync/onCreditGrantWrite.ts': {
    sites: 3,
    note: 'credit_summary entries',
  },
  'packages/functions/src/utils/automationEngine.ts': {
    sites: 1,
    note: 'a type annotation',
  },

  // ── web ───────────────────────────────────────────────────────────────────
  'apps/web/src/app/[locale]/(public)/public/[slug]/space/SpaceMembershipCard.tsx': {
    sites: 2,
    note: 'a display object',
  },

  // ── scripts ───────────────────────────────────────────────────────────────
  'scripts/lib/fixtures/money.ts': {
    sites: 1,
    note: "a type over a seeded plan grant's fields",
  },
  'scripts/lib/fixtures/subscriptionHistory.ts': {
    sites: 6,
    note: 'subscription history rows',
  },
  'scripts/seed-lead.ts': {
    sites: 4,
    note: 'the credit grant and credit_summary entries',
  },
}

describe('THE LEGACY PLAN SLOT — no writer left (docs/multi-plan-holdings.md, phase 5)', () => {
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
      `New slot-field sites. Classify each file in CENSUS — it may write another document that shares the field name; it may not write a CONTACT's plan field (that is a plan grant now)\n  ${unclassified.map((f) => `${f} (${found.get(f)})`).join('\n  ')}`
    )
  })

  it('…with exactly the number of sites the census records', () => {
    const drifted = Object.entries(CENSUS)
      .filter(([f, e]) => (found.get(f) ?? 0) !== e.sites)
      .map(([f, e]) => `${f}: census ${e.sites}, source ${found.get(f) ?? 0}`)
    assert.deepEqual(
      drifted,
      [],
      `Site counts moved. Re-check that no site writes a contact's plan field, then update CENSUS:\n  ${drifted.join('\n  ')}`
    )
  })

  it('the shared slot writer is gone, and nothing calls it', () => {
    const callers = [...sources].filter(([, src]) => (code(src).match(WRITER_CALL) ?? []).length > 0).map(([f]) => f)
    assert.deepEqual(callers, [], `writeContactSubscriptionFields called from:\n  ${callers.join('\n  ')}`)
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
