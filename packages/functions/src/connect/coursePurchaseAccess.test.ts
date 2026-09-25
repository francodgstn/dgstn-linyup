import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolvePaymentOptions,
  type ContactPaymentSnapshot,
  type CourseAccessRule,
} from '@linyup/shared'

// ─────────────────────────────────────────────────────────────────────────────
// "A contact who PAID for a course can open it in their Space."
//
// The whole path, end to end, because it broke in the middle and every half
// looked fine on its own:
//
//   webhook writes courses/{courseId}/purchases/{contactId}   (verified elsewhere)
//        ↓
//   Space/shop LIST it: collectionGroup('purchases')
//                         .where('contactId','==',me).where('teamId','==',team)
//        ↓  ← firestore.rules must authorize this SHAPE  (§1 below)
//        ↓  ← firestore.index.json must serve it in prod  (§2 below)
//   → purchasedCourseIds → ownsCourse → resolvePaymentOptions → 'covered' (§3)
//
// It shipped broken: the rule that was supposed to authorize the list only
// existed as a NESTED match, which a collection-group read never reaches, so the
// query 403'd with "No matching allow statements" and the card silently never
// rendered. The resolver half (§3) was correct the whole time and proved
// nothing, which is exactly why §1 and §2 are asserted here too — a test that
// only exercises the pure function re-passes the day the rule regresses.
//
// §1/§2 read the deployed artefacts as text on purpose: they are the two files
// a reviewer changes without running the app, and mocha has no emulator. What
// they CANNOT prove is that the rule evaluates as intended — that was done once,
// live, against the emulator with a real contact-session token over the
// Firestore REST API (own row returned; another contact, another team, and
// either clause dropped all refused). Redo that, do not infer it, if this block
// is ever rewritten: reading the rule is precisely what produced the false
// comment that hid the bug.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

/**
 * Extract ONE `match` statement from firestore.rules — its leading comment block
 * and its body — as text.
 *
 * Deliberately NOT `rules.slice(indexOf(a), indexOf(b))` between two landmarks.
 * The first version of this file did exactly that to isolate the nested
 * purchases block, using the collection-group block as the end landmark. The
 * nested block sits BELOW the collection-group one in the file, so the call was
 * `slice(70867, 64486)` — the empty string — and every assertion against it
 * passed unconditionally. `assert.doesNotMatch('', /anything/)` is a green tick
 * that proves nothing, which is worse than no test at all: it reports a safety
 * it does not provide.
 *
 * So this throws rather than returning something empty, and every caller
 * asserts against a region it has been shown really exists.
 */
function matchBlock(rules: string, statement: string): string {
  // Split on EITHER ending. This repo is `core.autocrlf=true` with `text: auto`
  // on firestore.rules, so a fresh Windows checkout writes CRLF while a file an
  // editor just wrote may be LF — and the closing-brace comparison below is an
  // EXACT match, so a stray `\r` would make the walk run off the end and throw.
  // The first version of this guard passed here and failed on a clean clone.
  const lines = rules.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim().startsWith(statement))
  assert.notEqual(start, -1, `firestore.rules has no \`${statement}\` statement.`)

  // Walk UP through the block's own comment: the false claim lived in the
  // comment, not the rule body, so the comment is part of the block under test.
  let from = start
  while (from > 0 && /^\s*(\/\/|$)/.test(lines[from - 1])) from--

  // Walk DOWN to the closing brace at this statement's own indentation (an exact
  // match, so nested blocks — which are indented deeper — cannot end it early).
  const indent = /^\s*/.exec(lines[start])![0]
  let to = start + 1
  while (to < lines.length && lines[to] !== `${indent}}`) to++
  assert.ok(to < lines.length, `\`${statement}\` block is never closed at its own indent.`)

  const block = lines.slice(from, to + 1).join('\n')
  assert.ok(
    block.includes(statement),
    `Extracted an empty or wrong region for \`${statement}\` — do not assert against it.`
  )
  return block
}

/**
 * The claim that hid the bug for months, as a predicate. Named so the guard
 * below can be asserted BOTH ways: absent from the real file, and present in
 * text that carries it. A negative assertion is only worth its green tick if it
 * is demonstrably capable of a red one.
 */
const FALSE_CLAIM = /also governs the Space/

describe('course purchase → Space access', () => {
  describe('§1 firestore.rules authorizes the entitlements collection-group query', () => {
    const rules = readFileSync(join(REPO_ROOT, 'firestore.rules'), 'utf8')

    // The block, isolated: a `{path=**}` match is the ONLY statement kind a
    // collection-group read is evaluated against. Extraction itself fails the
    // suite if the statement is gone, so every assertion below is reachable.
    it('declares a collection-group match for purchases', () => {
      const groupBlock = matchBlock(rules, 'match /{path=**}/purchases/')
      assert.match(
        groupBlock,
        /allow list:/,
        'A nested courses/{courseId}/purchases match does NOT authorise a ' +
          'collection-group list — that is the exact defect this test exists for.'
      )
    })

    it('grants list, scoped to the caller’s own contactId', () => {
      assert.match(
        matchBlock(rules, 'match /{path=**}/purchases/'),
        /resource\.data\.contactId == request\.auth\.token\.contactId/,
        'The contactId constraint is what stops contact A listing contact B’s entitlements.'
      )
    })

    it('grants list, scoped to the caller’s own team', () => {
      assert.match(
        matchBlock(rules, 'match /{path=**}/purchases/'),
        /isContactOfTeam\(resource\.data\.teamId\)/,
        'The teamId constraint is the tenant boundary: a collection group spans every studio.'
      )
    })

    it('never lets a client write an entitlement', () => {
      assert.match(matchBlock(rules, 'match /{path=**}/purchases/'), /allow write: if false/)
    })

    it('does not re-introduce the false claim on the nested block', () => {
      // The nested block once said it "also governs the Space's `purchases`
      // collection-group query". It did not, and the comment is why nobody
      // looked. A comment asserting what the code does not establish is the
      // defect, not a cosmetic issue — see CLAUDE.md.
      assert.doesNotMatch(
        matchBlock(rules, 'match /purchases/{contactId}'),
        FALSE_CLAIM,
        'The nested match cannot serve a collection-group query; do not claim it does.'
      )
    })

    it('…and that guard is capable of failing', () => {
      // Guards the guard. Both halves of the previous version were dead: the
      // region was empty AND nothing proved the predicate still fired. Assert
      // the predicate against text that carries the claim, so a future
      // refactor of the extraction cannot quietly turn the test above green.
      assert.match(
        "      // This block also governs the Space's `purchases` collection-group query.",
        FALSE_CLAIM
      )
      assert.throws(
        () => matchBlock(rules, 'match /no_such_collection/{id}'),
        'matchBlock must throw on a missing statement rather than return "".'
      )
    })

    it('the nested block is scoped to the caller’s team and live session', () => {
      // The sibling of the collection-group rule, and a narrower question: this
      // one authorizes a GET by document id. `contactId` alone is not a tenant
      // boundary and carries no expiry, so the team + session check has to be
      // here too — otherwise an expired session, or a session minted for another
      // studio, still reads an entitlement document by name.
      const nested = matchBlock(rules, 'match /purchases/{contactId}')
      assert.match(
        nested,
        /isContactOfTeam\(resource\.data\.teamId\)/,
        'The contact branch must go through isContactOfTeam (team + sessionExpires).'
      )
      assert.match(nested, /request\.auth\.token\.contactId == resource\.data\.contactId/)
      assert.match(nested, /allow write: if false/)
    })
  })

  describe('§2 firestore.index.json serves the query outside the emulator', () => {
    const indexes = JSON.parse(
      readFileSync(join(REPO_ROOT, 'firestore.index.json'), 'utf8')
    ) as {
      indexes: Array<{
        collectionGroup: string
        queryScope: string
        fields: Array<{ fieldPath: string }>
      }>
    }

    it('has a COLLECTION_GROUP index on purchases covering contactId + teamId', () => {
      // The emulator auto-creates indexes, so this query works locally whether or
      // not the index is declared and fails in staging/production if it is not.
      const match = indexes.indexes.find((i) => {
        if (i.collectionGroup !== 'purchases' || i.queryScope !== 'COLLECTION_GROUP') return false
        const fields = i.fields.map((f) => f.fieldPath)
        return fields.includes('contactId') && fields.includes('teamId')
      })
      assert.ok(
        match,
        'Missing the purchases (contactId, teamId) COLLECTION_GROUP index — the query ' +
          'would pass every local test and 400 in production.'
      )
    })
  })

  describe('§3 an entitlement makes the course openable', () => {
    const PAID_COURSE: CourseAccessRule = { type: 'purchase', priceAmount: 49 }

    function contact(overrides: Partial<ContactPaymentSnapshot> = {}): ContactPaymentSnapshot {
      return {
        authenticated: true,
        joined: true,
        heldUnmeteredTypeIds: [],
        heldCreditTypes: [],
        ...overrides,
      }
    }

    /** What "My courses" actually asks: is there a COVERED option? A `pay`
     *  option means "you could buy this", which is a catalog entry, not a
     *  library entry — see hasAccess() in space/SpaceHome.tsx. */
    function openableInSpace(snapshot: ContactPaymentSnapshot): boolean {
      return resolvePaymentOptions(snapshot, {
        kind: 'course',
        accessRule: PAID_COURSE,
      }).options.some((o) => o.type === 'covered')
    }

    it('a bought course is openable', () => {
      assert.equal(openableInSpace(contact({ ownsCourse: true })), true)
    })

    it('the same course is NOT openable without the entitlement', () => {
      assert.equal(openableInSpace(contact({ ownsCourse: false })), false)
    })

    it('an empty purchases result is indistinguishable from never having bought', () => {
      // This is the consequence of the 403 the rule fix removes: a failed LIST
      // and an honest "no purchases" both yield ownsCourse === false. Nothing
      // downstream can tell them apart, which is why SpaceHome must surface the
      // failure itself rather than swallowing it into an empty state.
      const purchasedCourseIds = new Set<string>() // what a 403 left behind
      assert.equal(
        openableInSpace(contact({ ownsCourse: purchasedCourseIds.has('course-1') })),
        false
      )
    })

    it('derives ownsCourse from the entitlement documents the query returns', () => {
      // The mapping SpaceHome/ShopHome perform on the snapshot: prefer the
      // stored courseId, fall back to the doc id (which IS the contactId only in
      // the parent path — the field is what identifies the course).
      const docs = [
        { id: 'contact-1', data: { contactId: 'contact-1', courseId: 'course-1', teamId: 'team-1' } },
        { id: 'contact-1', data: { contactId: 'contact-1', teamId: 'team-1' } },
      ]
      const purchasedCourseIds = new Set(
        docs.map((d) => (d.data as { courseId?: string }).courseId ?? d.id)
      )
      assert.equal(purchasedCourseIds.has('course-1'), true)
      assert.equal(openableInSpace(contact({ ownsCourse: purchasedCourseIds.has('course-1') })), true)
      assert.equal(openableInSpace(contact({ ownsCourse: purchasedCourseIds.has('course-2') })), false)
    })
  })
})
