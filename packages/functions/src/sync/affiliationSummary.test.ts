import assert from 'node:assert/strict'
import { type Affiliation } from '@linyup/shared'

// The org-derived halves of `Contact.affiliation_summary`, which the federation's
// dashboard counts from. `onAffiliationWrite` is a Firestore trigger and cannot
// be called from here, so what is tested is the DERIVATION it performs — copied
// as one function below and kept identical to the trigger's body. That is worth
// something because every bug this area has had was in the derivation, never in
// the plumbing: `org_ids` was read as if it meant `active_org_ids`, and a
// federation's headline numbers counted last season's lapsed licence as current.
//
// There were THREE lists here until 2026-09-10. `org_status_ids` — one
// `org:status` key per bucket — existed so the dashboard's status breakdown
// could exclude archived people, and went away with the query that read it: the
// breakdown moved back to the affiliations collection group, where the rules can
// prove it, and carries the parent's liveness as `Affiliation.contact_live`
// instead. See `docs/org-contact-visibility.md`.

interface OrgSummary {
  org_ids: string[]
  active_org_ids: string[]
}

/** The derivation in `onAffiliationWrite`, verbatim. */
function orgSummary(affiliations: Affiliation[]): OrgSummary {
  const orgIssued = affiliations.filter((a) => a.issuer === 'org' && a.org_id)
  return {
    org_ids: [...new Set(orgIssued.map((a) => a.org_id as string))],
    active_org_ids: [
      ...new Set(orgIssued.filter((a) => a.active === true).map((a) => a.org_id as string)),
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
  it('a current licence lands in both', () => {
    const s = orgSummary([aff({})])
    assert.deepEqual(s.org_ids, ['fed'])
    assert.deepEqual(s.active_org_ids, ['fed'])
  })

  it('a lapsed licence keeps the org but not its currency', () => {
    // THE 2026-09-08 BUG, still pinned: `org_ids` is "ever", not "now". It is
    // also what `orgAdminMayReadContact` reads, so this is now a PERMISSION as
    // well as a figure — an expired licence must keep the organisation able to
    // see the person it needs to chase.
    const s = orgSummary([aff({ status_id: 'expired', active: false })])
    assert.deepEqual(s.org_ids, ['fed'])
    assert.deepEqual(s.active_org_ids, [])
  })

  it("a studio's own membership and a body it merely tracks are not the org's", () => {
    // Counting other people's badges as your own coverage is worse than counting
    // nothing — so neither issuer reaches either list. Since
    // `orgAdminMayReadContact`, this is also what keeps a studio's internal club
    // membership from disclosing the contact to the federation it belongs to.
    const s = orgSummary([
      aff({ id: 'club', issuer: 'team', org_id: undefined }),
      aff({ id: 'ext', issuer: 'external', org_id: undefined, issuer_name: 'Swiss Olympic' }),
    ])
    assert.deepEqual(s, { org_ids: [], active_org_ids: [] })
  })

  it('two affiliations of one org are one entry, whatever their statuses', () => {
    // Real, because affiliation types share one status vocabulary: a licence
    // that is active and a grading merely requested is ONE person, on the books
    // once and current once.
    const s = orgSummary([
      aff({ id: 'licence', status_id: 'active', active: true }),
      aff({ id: 'grading', status_id: 'requested', active: false }),
    ])
    assert.deepEqual(s.org_ids, ['fed'])
    assert.deepEqual(s.active_org_ids, ['fed'])
  })

  it('two federations stay apart', () => {
    // A contact on two federations' books, current on one. Each list names the
    // orgs it means, so neither can be read as the other's answer.
    const s = orgSummary([
      aff({ id: 'a', org_id: 'fed', status_id: 'active', active: true }),
      aff({ id: 'b', org_id: 'swiss', status_id: 'expired', active: false }),
    ])
    assert.deepEqual([...s.org_ids].sort(), ['fed', 'swiss'])
    assert.deepEqual(s.active_org_ids, ['fed'])
  })

  it('an affiliation with no status still puts the org on the books', () => {
    // `org_ids` asks whether the organisation knows this person, and a row with
    // no status is still a row somebody created.
    const s = orgSummary([aff({ status_id: undefined as unknown as string })])
    assert.deepEqual(s.org_ids, ['fed'])
  })
})
