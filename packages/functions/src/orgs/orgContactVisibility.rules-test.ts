import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  collectionGroup,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
} from 'firebase/firestore'

// Security-rules tests for WHICH CONTACTS AN ORGANISATION MAY READ.
//
// The rule under test is `orgAdminMayReadContact`, and the thing it exists to
// stop is a federation reading a member studio's whole address book. A studio
// inside an organisation has contacts who are nobody's business but its own —
// someone training at the club spot, a lead from a fitness app, a person doing
// an activity the studio runs under its own name. The old rule
// (`isOrgAdminOfTeam`) admitted all of them on the strength of the STUDIO's
// membership, so belonging to a federation meant handing it your customer list.
//
// THE AFFILIATION ROW IS THE DISCLOSURE. A contact becomes readable when — and
// only when — they hold an affiliation issued by THIS organisation, in ANY
// status. The tests are as much about what that does NOT admit: a contact with
// no row at all, a studio's own internal club membership, another federation's
// member, and a contact whose summary predates the field.
//
// The `active_org_ids` / `org_ids` distinction is deliberate and is pinned
// below: an EXPIRED licence still admits the org, because renewing it is
// precisely what an administrator opens the page to do. Narrowing to
// `active_org_ids` would hide the people the federation most needs to chase.
//
// `affiliation_summary` is written directly here. In production
// `onAffiliationWrite` denormalises it from the affiliations subcollection —
// triggers do not run under the rules emulator, and the rule reads the
// denormalised field either way.
//
// Runs against the isolated emulator only:
//   pnpm --filter @linyup/functions test:rules

function findRules(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'firestore.rules')
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
    dir = path.dirname(dir)
  }
  throw new Error('firestore.rules not found above ' + process.cwd())
}

const RULES = findRules()
const ORG = 'fedOrg'
const OTHER_ORG = 'rivalOrg'
const STUDIO = 'memberStudio'

let testEnv: RulesTestEnvironment

/** The federation's admin — NOT a member of any studio in it. */
const asFedAdmin = () => testEnv.authenticatedContext('fedAdmin').firestore()
/** The studio's own owner, whose current team is the studio. */
const asStudioOwner = () => testEnv.authenticatedContext('studioOwner').firestore()

describe('firestore.rules — an organisation reads only the contacts on its books', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-org-contact-visibility',
      firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
    })
  })
  after(async () => {
    await testEnv?.cleanup()
  })

  beforeEach(async () => {
    await testEnv.clearFirestore()
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()

      await setDoc(doc(db, 'organizations', ORG), { name: 'Federation', slug: 'fed' })
      await setDoc(doc(db, 'organizations', ORG, 'org_members', 'fedAdmin'), {
        role: 'org_admin',
        userId: 'fedAdmin',
      })
      await setDoc(doc(db, 'organizations', OTHER_ORG), { name: 'Rival', slug: 'rival' })
      await setDoc(doc(db, 'organizations', OTHER_ORG, 'org_members', 'rivalAdmin'), {
        role: 'org_admin',
        userId: 'rivalAdmin',
      })

      await setDoc(doc(db, 'organizations', ORG, 'org_teams', STUDIO), {
        teamId: STUDIO,
        orgId: ORG,
        status: 'active',
      })
      await setDoc(doc(db, 'teams', STUDIO), {
        name: 'Member Studio',
        slug: 'member-studio',
        org_id: ORG,
        createdBy: 'studioOwner',
      })
      await setDoc(doc(db, 'teams', STUDIO, 'team_members', 'studioOwner'), {
        role: 'owner',
        userId: 'studioOwner',
      })
      await setDoc(doc(db, 'users', 'studioOwner'), { currentTeam: STUDIO })

      const base = { teamId: STUDIO, deleted_at: null, archived_at: null }

      // ON THE BOOKS, valid now.
      await setDoc(doc(db, 'contacts', 'affiliated'), {
        ...base,
        firstname: 'Ada',
        affiliation_summary: { has_active: true, types: ['licence'], org_ids: [ORG], active_org_ids: [ORG] },
      })

      // ON THE BOOKS, lapsed — the federation's own problem to chase.
      await setDoc(doc(db, 'contacts', 'lapsed'), {
        ...base,
        firstname: 'Grace',
        affiliation_summary: { has_active: false, types: ['licence'], org_ids: [ORG], active_org_ids: [] },
      })

      // The studio's own person: no affiliation of any kind.
      await setDoc(doc(db, 'contacts', 'walkIn'), {
        ...base,
        firstname: 'Walk',
        affiliation_summary: { has_active: false, types: [], org_ids: [], active_org_ids: [] },
      })

      // The studio's own person, holding the STUDIO's internal club membership
      // (`issuer: 'team'`) — which puts nothing in `org_ids`.
      await setDoc(doc(db, 'contacts', 'clubOnly'), {
        ...base,
        firstname: 'Club',
        affiliation_summary: { has_active: true, types: ['club'], org_ids: [], active_org_ids: [] },
      })

      // On ANOTHER federation's books.
      await setDoc(doc(db, 'contacts', 'rivalMember'), {
        ...base,
        firstname: 'Rival',
        affiliation_summary: { has_active: true, types: ['licence'], org_ids: [OTHER_ORG], active_org_ids: [OTHER_ORG] },
      })

      // Written before the summary existed — no field at all.
      await setDoc(doc(db, 'contacts', 'noSummary'), { ...base, firstname: 'Legacy' })

      // The rows the status strip counts. All three issuers live in this one
      // subcollection and only the first is the federation's business.
      await setDoc(doc(db, 'contacts', 'affiliated', 'affiliations', 'orgLicence'), {
        teamId: STUDIO,
        issuer: 'org',
        org_id: ORG,
        status_id: 'active',
        active: true,
        contact_live: true,
      })
      await setDoc(doc(db, 'contacts', 'lapsed', 'affiliations', 'orgLicence'), {
        teamId: STUDIO,
        issuer: 'org',
        org_id: ORG,
        status_id: 'expired',
        active: false,
        contact_live: true,
      })
      await setDoc(doc(db, 'contacts', 'clubOnly', 'affiliations', 'clubMembership'), {
        teamId: STUDIO,
        issuer: 'team',
        status_id: 'active',
        active: true,
        contact_live: true,
      })
      await setDoc(doc(db, 'contacts', 'rivalMember', 'affiliations', 'rivalLicence'), {
        teamId: STUDIO,
        issuer: 'org',
        org_id: OTHER_ORG,
        status_id: 'active',
        active: true,
        contact_live: true,
      })
    })
  })

  it('reads a contact who holds this organisation’s affiliation', async () => {
    await assertSucceeds(getDoc(doc(asFedAdmin(), 'contacts', 'affiliated')))
  })

  it('STILL reads one whose affiliation has lapsed — org_ids, not active_org_ids', async () => {
    // The whole reason the permission uses `org_ids`. An expired licence is the
    // case an administrator opens the roster to act on; hiding it would make the
    // renewal queue unreachable through the very page that exists to work it.
    await assertSucceeds(getDoc(doc(asFedAdmin(), 'contacts', 'lapsed')))
  })

  it('cannot read a contact with no affiliation at all', async () => {
    await assertFails(getDoc(doc(asFedAdmin(), 'contacts', 'walkIn')))
  })

  it('cannot read a contact holding only the studio’s OWN club membership', async () => {
    // `issuer: 'team'` puts nothing in `org_ids`. A studio's internal membership
    // is not a disclosure to the federation it happens to belong to.
    await assertFails(getDoc(doc(asFedAdmin(), 'contacts', 'clubOnly')))
  })

  it('cannot read a contact on another organisation’s books', async () => {
    await assertFails(getDoc(doc(asFedAdmin(), 'contacts', 'rivalMember')))
  })

  it('cannot read a contact whose summary predates the field', async () => {
    // Absent reads as `[]`, so an un-migrated document is HIDDEN rather than
    // exposed. `org_ids` is non-optional and has been written since the summary
    // existed, so this is a belt not a backfill — but it is the safe direction
    // and worth pinning, because the alternative fails silently and outward.
    await assertFails(getDoc(doc(asFedAdmin(), 'contacts', 'noSummary')))
  })

  it('an admin of the OTHER organisation reads none of this studio’s contacts', async () => {
    const rival = testEnv.authenticatedContext('rivalAdmin').firestore()
    await assertFails(getDoc(doc(rival, 'contacts', 'affiliated')))
    await assertFails(getDoc(doc(rival, 'contacts', 'rivalMember')))
  })

  // ── THE QUERY SHAPES ────────────────────────────────────────────────────
  //
  // EVERY TEST ABOVE READS ONE DOCUMENT, AND THAT IS NOT ENOUGH. Firestore
  // checks a QUERY against the rule STATICALLY — an aggregation has no documents
  // to evaluate one at a time — so a query is admitted only when its own
  // constraints prove the rule. The first version of this rule named `org_ids`
  // alone, every single-document test passed, and the org dashboard's
  // affiliation figure was `permission-denied` for every studio the caller was
  // not personally a member of, because that figure is counted on
  // `active_org_ids`. It took a browser to find. These are the shapes the
  // product actually issues.

  it('COUNTS on-books contacts — the dashboard denominator', async () => {
    await assertSucceeds(
      getCountFromServer(
        query(
          collection(asFedAdmin(), 'contacts'),
          where('teamId', '==', STUDIO),
          where('deleted_at', '==', null),
          where('archived_at', '==', null),
          where('affiliation_summary.org_ids', 'array-contains', ORG)
        )
      )
    )
  })

  it('COUNTS currently-affiliated contacts — the dashboard numerator', async () => {
    // The one the single-document tests could not see. `active_org_ids` is a
    // subset of `org_ids` by construction, so this grants nothing; it has to be
    // NAMED in the rule for the query to be provable.
    await assertSucceeds(
      getCountFromServer(
        query(
          collection(asFedAdmin(), 'contacts'),
          where('teamId', '==', STUDIO),
          where('deleted_at', '==', null),
          where('archived_at', '==', null),
          where('affiliation_summary.active_org_ids', 'array-contains', ORG)
        )
      )
    )
  })

  it('LISTS the roster the org Affiliations page asks for', async () => {
    const snap = await getDocs(
      query(
        collection(asFedAdmin(), 'contacts'),
        where('teamId', 'in', [STUDIO]),
        where('deleted_at', '==', null),
        where('archived_at', '==', null),
        where('affiliation_summary.org_ids', 'array-contains', ORG)
      )
    )
    // And it returns the people on the books, not the studio's whole address book.
    assert.deepEqual(snap.docs.map((d) => d.id).sort(), ['affiliated', 'lapsed'])
  })

  it('REFUSES the unfiltered roster — the query this page used to run', async () => {
    // Dropping the affiliation clause is the old behaviour, and it must fail
    // rather than quietly return everyone.
    await assertFails(
      getDocs(
        query(
          collection(asFedAdmin(), 'contacts'),
          where('teamId', 'in', [STUDIO]),
          where('deleted_at', '==', null),
          where('archived_at', '==', null)
        )
      )
    )
  })

  it('COUNTS one status across the federation — the dashboard status strip', async () => {
    // THE CASE THAT WAS PENDING. #249 had moved this count onto the CONTACT,
    // filtering a denormalised `org:status` key on the contact —
    // and `orgAdminMayReadContact` could not prove it, because Firestore matches
    // a query against a rule by VALUE and the status half of that key is
    // tenant-configurable. Every document it would have returned was readable;
    // only the proof was missing, so the strip rendered `—` on every studio the
    // caller was not personally a member of.
    //
    // It counts affiliation ROWS again (Franco, 2026-09-09), where the
    // collection-group rule admits `isOrgAdminOfOrg` on the row's own `org_id`
    // and a query pinning `org_id` is provably inside it. The liveness that a
    // collection group cannot reach came with it as `contact_live`.
    await assertSucceeds(
      getCountFromServer(
        query(
          collectionGroup(asFedAdmin(), 'affiliations'),
          where('org_id', '==', ORG),
          where('contact_live', '==', true),
          where('status_id', '==', 'active')
        )
      )
    )
  })

  it('and that count reaches ONLY this organisation\u2019s rows', async () => {
    // The other half of the same rule. A studio's own club membership
    // (`issuer: 'team'`) and a rival federation's licence live in this very
    // subcollection, and `org_id` is what keeps them out.
    await assertFails(
      getCountFromServer(
        query(
          collectionGroup(asFedAdmin(), 'affiliations'),
          where('contact_live', '==', true),
          where('status_id', '==', 'active')
        )
      )
    )
  })

  it('THE STUDIO STILL READS EVERY ONE OF ITS OWN', async () => {
    // Nothing was taken from the studio: this narrowing is about what the
    // FEDERATION sees. If this ever fails, the change has broken the tenant it
    // was meant to protect.
    const db = asStudioOwner()
    for (const id of ['affiliated', 'lapsed', 'walkIn', 'clubOnly', 'rivalMember', 'noSummary']) {
      await assertSucceeds(getDoc(doc(db, 'contacts', id)))
    }
  })
})
