import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeWaiverLocale } from './accept'

// THE HARDENING ROUND, ASSERTED.
//
// Four defects, and what they have in common is that each was a rule the phase
// had already written down somewhere and then failed to enforce at ONE of the
// places it applies:
//
//   • `firestore.rules` denied a client the publish pointers on UPDATE and left
//     them free on CREATE;
//   • three waiver callables branched on a document's `kind` before checking
//     that the caller was allowed to know it existed;
//   • `signWaiverInSpace` wrote acceptances from a contact snapshot it never
//     checked the tenant of;
//   • the ledger stored an unbounded client string on a legal record.
//
// They are asserted from the SOURCE (and from the rules file) rather than from a
// running emulator, in the same shape as surfaces.test.ts, because the thing
// each one protects is an ordering or a clause — things a fixture can read and a
// reviewer cannot be relied on to re-read.
//
// Run with: pnpm --filter @linyup/functions test

const ROOT = join(__dirname, '..', '..', '..', '..')

/** Strip comments and string literals so a grep cannot match prose. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

const src = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8')

/** Offset of a marker, asserted present so an ordering check can never pass by
 *  comparing two -1s. */
function at(text: string, needle: string): number {
  const i = text.indexOf(needle)
  assert.notEqual(i, -1, `expected to find ${needle}`)
  return i
}

// ─────────────────────────────────────────────────────────────────────────────

describe('CREATE CANNOT MINT A PUBLISH STATE (W3, W29)', () => {
  const rules = readFileSync(join(ROOT, 'firestore.rules'), 'utf8').replace(/\r\n/g, '\n')
  const createClause = (): string => {
    const start = at(rules, 'match /documents/{documentId}')
    const block = rules.slice(start, rules.indexOf('match /versions/{versionId}', start))
    const i = at(block, 'allow create')
    return block.slice(i, block.indexOf(';', i))
  }

  // THE DEFECT. The create clause constrained `kind` and nothing else, so the
  // one write that decides a document's whole starting state was the one write
  // that constrained none of it: a manager could `setDoc` a document already at
  // `status: 'published'` with no version behind it (W29 broken by a single
  // client call), or at a `current_version` pointing at a snapshot that does not
  // exist — which is the assumption every acceptance rests on.
  it('a client-created document is never published', () => {
    assert.match(createClause(), /get\('status', 'draft'\) != 'published'/)
  })

  it('and carries neither version pointer', () => {
    const clause = createClause()
    assert.match(clause, /get\('current_version', null\) == null/)
    assert.match(clause, /get\('min_valid_version', null\) == null/)
  })

  it('the editor still creates the shape it always created', () => {
    // The rule is only safe to tighten because the one legitimate client create
    // writes exactly this: status draft, neither pointer. If this drifts, the
    // rule above starts denying the product's own Save.
    const hooks = code(
      readFileSync(join(ROOT, 'apps', 'web', 'src', 'plugins', 'documents', 'hooks.ts'), 'utf8')
    )
    const create = hooks.slice(at(hooks, 'export async function createDocument'))
    const payload = create.slice(0, at(create, 'await setDoc'))
    assert.match(payload, /status: '' as const/)
    assert.equal(payload.includes('current_version'), false)
    assert.equal(payload.includes('min_valid_version'), false)
  })

  it('delete still excludes a waiver — verified, not assumed', () => {
    // Claimed closed by an earlier round. Re-derived here rather than trusted,
    // because the claim and the clause are in different files.
    const start = at(rules, 'match /documents/{documentId}')
    const block = rules.slice(start, rules.indexOf('match /versions/{versionId}', start))
    const i = at(block, 'allow delete')
    assert.match(block.slice(i, block.indexOf(';', i)), /get\('kind', 'other'\) != 'waiver'/)
  })
})

describe('A documentId IS NOT AN ORACLE — authorize, then load, then identify', () => {
  const publish = code(src('publish.ts'))

  // THE DEFECT. `loadDocument` throws `document_not_found` and the kind branch
  // throws `not_a_waiver`, and both used to run BEFORE `requireAuthedManager`.
  // A caller with no claim on the tenant learned that an id existed and what
  // kind of document it was, from the refusal alone.
  it('no callable loads a document without authorizing through the helper', () => {
    const callables = publish.slice(at(publish, 'export const createWaiver'))
    assert.equal(
      callables.includes('await loadDocument('),
      false,
      'callables must go through loadDocumentForManager / loadWaiverForManager'
    )
  })

  it('the helper asserts authentication BEFORE the read and membership BEFORE the kind', () => {
    const helper = publish.slice(
      at(publish, 'async function loadDocumentForManager'),
      at(publish, 'async function teamPlan')
    )
    assert.ok(
      at(helper, 'request.auth') < at(helper, 'await loadDocument('),
      'an anonymous caller must be refused before the document is read'
    )
    const waiverHelper = helper.slice(at(helper, 'async function loadWaiverForManager'))
    assert.ok(
      at(waiverHelper, 'await loadDocumentForManager(') < at(waiverHelper, "doc.kind !== ''"),
      'the kind may only be spoken to a caller already authorized'
    )
  })

  it('all three waiver callables enter through it', () => {
    for (const name of ['updateWaiver', 'setWaiverRequirement', 'archiveWaiver']) {
      const body = publish.slice(at(publish, `export const ${name}`))
      const head = body.slice(0, at(body, 'runTransaction') || body.length)
      assert.match(head, /loadWaiverForManager\(/, `${name} must authorize before it identifies`)
    }
    const pub = publish.slice(at(publish, 'export const publishDocumentVersion'))
    assert.match(pub.slice(0, at(pub, 'runTransaction')), /loadDocumentForManager\(/)
  })
})

describe('SPACE WRITES FOR ITS OWN TENANT ONLY', () => {
  const space = code(src('space.ts'))

  // THE DEFECT, and why the pre-existing check was not enough:
  // `requireContactSessionForTeam` does read the contact and compare its
  // `teamId` — but this callable then reads the document AGAIN and copies every
  // field of the acceptance from that second snapshot, while stamping the row
  // with `teamId` from the request. The assertion has to be made about the read
  // the write is built from.
  it('the loaded contact is checked against the team before anything is built', () => {
    assert.ok(
      at(space, 'contact.teamId !== data.teamId') < at(space, 'loadWaiverPolicy('),
      'the tenant assertion must precede the policy read and the ledger build'
    )
    // On the RAW source, because `code()` strips string literals and the
    // refusal's whole point is which code it carries.
    assert.match(src('space.ts'), /'permission-denied', 'This account is no longer active'/)
  })

  it('the session helper still carries its own check, so this is defense and not the only line', () => {
    const helper = code(readFileSync(join(__dirname, '..', 'utils', 'contactSession.ts'), 'utf8'))
    const fn = helper.slice(at(helper, 'export async function requireContactSessionForTeam'))
    assert.match(fn, /c\?\.teamId !== teamId/)
  })
})

describe('THE ONE CLIENT STRING ON A LEGAL RECORD IS BOUNDED', () => {
  it('a plausible tag survives, in the shapes the product actually sends', () => {
    for (const tag of ['en', 'de', 'fr', 'it', 'de-CH', 'fr-CH', 'en-GB']) {
      assert.equal(normalizeWaiverLocale(tag), tag)
    }
  })

  it('whitespace is trimmed rather than stored', () => {
    assert.equal(normalizeWaiverLocale('  de-CH  '), 'de-CH')
  })

  it('a payload that is not a locale becomes null, not a truncated souvenir of itself', () => {
    // The old coercion was `typeof x === 'string' ? x : null`, so every one of
    // these landed verbatim in the field an export prints as evidence.
    assert.equal(normalizeWaiverLocale('x'.repeat(50_000)), null)
    assert.equal(normalizeWaiverLocale('<script>alert(1)</script>'), null)
    assert.equal(normalizeWaiverLocale('de\nSet-Cookie: x'), null)
    assert.equal(normalizeWaiverLocale(''), null)
    assert.equal(normalizeWaiverLocale(42), null)
    assert.equal(normalizeWaiverLocale({ toString: () => 'de' }), null)
    assert.equal(normalizeWaiverLocale(null), null)
    assert.equal(normalizeWaiverLocale(undefined), null)
  })

  it('it is idempotent, which is what lets a caller apply it too', () => {
    for (const raw of ['de-CH', '  en  ', 'nonsense'.repeat(100), 42]) {
      assert.equal(normalizeWaiverLocale(normalizeWaiverLocale(raw)), normalizeWaiverLocale(raw))
    }
  })

  it('the LEDGER applies it, so a rail that forgets is still bounded', () => {
    // The enforcing point is the one place every acceptance row is built. A
    // per-caller coercion is a thing the next rail forgets — and two of the
    // three that existed had already forgotten it.
    const accept = code(src('accept.ts'))
    assert.match(accept, /locale: normalizeWaiverLocale\(input\.locale\)/)
  })

  it('and the caller that hands one over applies the same coercion, not its own', () => {
    // `signWaiverInSpace` is the one rail that takes `locale` straight off the
    // request body. It applies the SHARED bound at the call site as well as
    // relying on the ledger's — two coercions of the same field are how a
    // truncated souvenir of a payload ends up in an evidence record.
    assert.match(src('space.ts'), /locale: normalizeWaiverLocale\(/)
    assert.equal(src('space.ts').includes('.locale.slice('), false)
  })
})
