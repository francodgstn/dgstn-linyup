import assert from 'node:assert/strict'
import { orgAffiliationStatusKey, type Affiliation } from '@linyup/shared'

// The org-derived halves of `Contact.affiliation_summary`, which the federation's
// dashboard counts from. `onAffiliationWrite` is a Firestore trigger and cannot
// be called from here, so what is tested is the DERIVATION it performs — copied
// as one function below and kept identical to the trigger's body. That is worth
// something because every bug this area has had was in the derivation, never in
// the plumbing: `org_ids` read as if it meant `active_org_ids`, and a status
// breakdown built from documents that could not exclude an archived contact.

interface OrgSummary {
  org_ids: string[]
  active_org_ids: string[]
  org_status_ids: string[]
}

/** The derivation in `onAffiliationWrite`, verbatim. */
function orgSummary(affiliations: Affiliation[]): OrgSummary {
  const orgIssued = affiliations.filter((a) => a.issuer === 'org' && a.org_id)
  return {
    org_ids: [...new Set(orgIssued.map((a) => a.org_id as string))],
    active_org_ids: [
      ...new Set(orgIssued.filter((a) => a.active === true).map((a) => a.org_id as string)),
    ],
    org_status_ids: [
      ...new Set(
        orgIssued
          .filter((a) => a.status_id)
          .map((a) => orgAffiliationStatusKey(a.org_id as string, a.status_id))
      ),
    ],
  }
}

function aff(over: Partial<Affiliation>): Affiliation {
  return {
    id: 'a1',
    teamId: 't1',
    affiliation_type_id: 'licence',
    issuer: 'org',
    org_id: 'fed',
    status_id: 'active',
    active: true,
    ...over,
  }
}

describe('affiliation summary — the org-derived lists', () => {
  it('a current licence lands in all three', () => {
    const s = orgSummary([aff({})])
    assert.deepEqual(s.org_ids, ['fed'])
    assert.deepEqual(s.active_org_ids, ['fed'])
    assert.deepEqual(s.org_status_ids, ['fed:active'])
  })

  it('a lapsed licence keeps the org but not its currency', () => {
    // THE 2026-09-08 BUG, still pinned: `org_ids` is "ever", not "now".
    const s = orgSummary([aff({ status_id: 'expired', active: false })])
    assert.deepEqual(s.org_ids, ['fed'])
    assert.deepEqual(s.active_org_ids, [])
    assert.deepEqual(s.org_status_ids, ['fed:expired'])
  })

  it("a studio's own membership and a body it merely tracks are not the org's", () => {
    // Counting other people's badges as your own coverage is worse than
    // counting nothing — so neither issuer reaches any of the three lists.
    const s = orgSummary([
      aff({ id: 'club', issuer: 'team', org_id: undefined }),
      aff({ id: 'ext', issuer: 'external', org_id: undefined, issuer_name: 'Swiss Olympic' }),
    ])
    assert.deepEqual(s, { org_ids: [], active_org_ids: [], org_status_ids: [] })
  })

  it('two affiliations of one org in one status count that status once', () => {
    // The breakdown counts PEOPLE. A licence and a grading both merely requested
    // is one person waiting, not two.
    const s = orgSummary([
      aff({ id: 'licence', status_id: 'requested', active: false }),
      aff({ id: 'grading', status_id: 'requested', active: false }),
    ])
    assert.deepEqual(s.org_status_ids, ['fed:requested'])
  })

  it('two affiliations of one org in DIFFERENT statuses put them in both', () => {
    // Real, because affiliation types share one status vocabulary — and the
    // reason the strip's header states its own distinct count instead of the
    // sum of its segments.
    const s = orgSummary([
      aff({ id: 'licence', status_id: 'active', active: true }),
      aff({ id: 'grading', status_id: 'requested', active: false }),
    ])
    assert.deepEqual([...s.org_status_ids].sort(), ['fed:active', 'fed:requested'])
    assert.deepEqual(s.org_ids, ['fed'])
  })

  it('two federations stay apart, which is what the composite key is for', () => {
    // One array of orgs and another of statuses would answer "some org of
    // yours, and some status of yours" — true here for `swiss:active`, which
    // nobody holds.
    const s = orgSummary([
      aff({ id: 'a', org_id: 'fed', status_id: 'active', active: true }),
      aff({ id: 'b', org_id: 'swiss', status_id: 'expired', active: false }),
    ])
    assert.deepEqual([...s.org_status_ids].sort(), ['fed:active', 'swiss:expired'])
    assert.ok(!s.org_status_ids.includes('swiss:active'))
  })

  it('an affiliation with no status is left out rather than given one', () => {
    const s = orgSummary([aff({ status_id: undefined as unknown as string })])
    assert.deepEqual(s.org_status_ids, [])
    assert.deepEqual(s.org_ids, ['fed'])
  })

  it('the key is built one way, and both halves survive it', () => {
    assert.equal(orgAffiliationStatusKey('hmd', 'under_review'), 'hmd:under_review')
  })
})
