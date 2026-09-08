import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_ORG_AFFILIATION_STATUSES } from '@linyup/shared'

// THE STATUS VOCABULARY HAS NO 'guest', AND IT IS WRITTEN DOWN IN THREE PLACES.
//
// `packages/shared` is the canonical list. Two more copies exist because neither
// caller can import it: `scripts/lib/affiliations.ts` (the seeders) and
// `scripts/migration/passes/00-setup.ts` (the HMD import), both outside the
// workspace's module resolution under tsconfig.scripts.json. Copies drift, and
// this one drifting has a specific consequence rather than a vague one — the
// import seeds the ORG's vocabulary, so a `guest` that survives there puts it
// back in the federation's status picker for the one tenant with real data.
//
// Why its absence matters at all: belonging is a ROW. 'guest' was the old
// model's way of saying "on the roster, not a member", and every writer in the
// product already treats it as "write no row". The only way to create one was to
// pick it from the roster's status list — which writes a row, and a row is what
// discloses the contact to the organisation (`orgAdminMayReadContact`). The
// status labelled "not a member" was the one control that made someone a member.
// See `docs/org-contact-visibility.md`.
//
// Reads the two mirrors as SOURCE, the same way `orgTierRails.test.ts` does, so
// the claim is re-derived from the tree rather than restated here.

function repoRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('repo root not found above ' + process.cwd())
}

/** The `id:` values of a `DEFAULT_ORG_AFFILIATION_STATUSES = [...]` literal. */
function mirrorStatusIds(relPath: string): string[] {
  const src = fs.readFileSync(path.join(repoRoot(), relPath), 'utf8')
  const start = src.indexOf('DEFAULT_ORG_AFFILIATION_STATUSES = [')
  assert.ok(start >= 0, `${relPath} no longer declares DEFAULT_ORG_AFFILIATION_STATUSES`)
  const body = src.slice(start, src.indexOf(']', start))
  return [...body.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1])
}

const MIRRORS = [
  'scripts/lib/affiliations.ts',
  'scripts/migration/passes/00-setup.ts',
]

describe('the affiliation status vocabulary', () => {
  it('does not offer a "guest" status', () => {
    assert.ok(
      !DEFAULT_ORG_AFFILIATION_STATUSES.some((s) => s.id === 'guest'),
      'not belonging is the ABSENCE of an affiliation row, never a status — a ' +
        'selectable "guest" writes the row whose absence it claims to mean'
    )
  })

  it('still has exactly one status that counts as active', () => {
    // The removal must not have disturbed the one def that drives `active`,
    // `has_active` and every affiliation rollup in the product.
    const active = DEFAULT_ORG_AFFILIATION_STATUSES.filter((s) => s.countsAsActive)
    assert.deepEqual(active.map((s) => s.id), ['active'])
  })

  it('orders every status distinctly, so the picker is stable', () => {
    const orders = DEFAULT_ORG_AFFILIATION_STATUSES.map((s) => s.order)
    assert.equal(new Set(orders).size, orders.length)
    assert.deepEqual([...orders].sort((a, b) => a - b), orders, 'declared out of order')
  })

  for (const rel of MIRRORS) {
    it(`${rel} mirrors the canonical ids`, () => {
      assert.deepEqual(
        mirrorStatusIds(rel),
        DEFAULT_ORG_AFFILIATION_STATUSES.map((s) => s.id),
        `${rel} has drifted from packages/shared — it cannot import the constant, ` +
          'so this test is the only thing holding the two together'
      )
    })
  }
})
