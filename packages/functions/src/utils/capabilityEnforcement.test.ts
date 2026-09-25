import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_CAPABILITIES, capabilityEnforcement, type Capability } from '@linyup/shared'

// WHERE EACH CAPABILITY BITES, ASSERTED AGAINST THE SOURCE.
//
// `CAPABILITY_ENFORCEMENT` in packages/shared/src/types/capabilities.ts says, per
// capability, whether turning it off changes anything in the product ('app'),
// narrows a public-API key only ('api'), or is not the thing enforcing its surface
// at all ('none'). The role editor renders a hint from that map, so a wrong entry
// is a false statement made to a studio about its own permissions.
//
// It is a claim about four other trees, which is exactly the kind of claim that
// rots silently — somebody wires `contacts.view` into a page, the map still says
// 'api', and the editor keeps telling studios the switch only affects API keys.
// So the map is not trusted: this re-derives it and compares.
//
// ── THE RECIPE ──────────────────────────────────────────────────────────────
// A capability counts as enforced in the APP when its id appears in:
//   • firestore.rules, on a line reaching `hasTeamCapability(…, '<id>')`; or
//   • packages/functions/src, outside src/api/, in `requireCapability(…, '<id>')`
//     or `hasCapability(…, '<id>')`; or
//   • apps/web/src, in `can('<id>')` — the useCapabilities predicate.
// Otherwise it counts as API-enforced when its id appears in
// packages/shared/src/types/api.ts (the scope table) or under
// packages/functions/src/api/ (the request principal). Otherwise: none.
//
// Test files are excluded from every scan — this file names most of the
// capabilities in prose, and capabilities.test.ts asserts over all of them.
//
// ── WHY THE SCAN IS BOUNDED RATHER THAN LINE-BASED ──────────────────────────
// `[^;{}]{0,200}?` lets a call wrap across lines (prettier does that to a long
// `requireCapability(...)`) while refusing to cross a statement boundary, so one
// gate's name cannot be attributed to the call above it.
//
// Run with: pnpm --filter @linyup/functions test

const SRC = join(__dirname, '..')
/** SRC → packages/functions → packages → worktree root. The claim spans the
 *  rules/functions/web boundary, which is where a correction stops travelling. */
const ROOT = join(SRC, '..', '..', '..')

function read(abs: string): string {
  return readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
}

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo'])

function isScannable(name: string): boolean {
  return (
    /\.(ts|tsx)$/.test(name) &&
    !name.includes('.test.') &&
    !name.includes('.spec.') &&
    !name.endsWith('.d.ts')
  )
}

/** Every scannable file under `dir`, recursively. `skip` prunes whole subtrees. */
function walk(dir: string, skip: (abs: string) => boolean = () => false): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue
    const abs = join(dir, entry)
    if (skip(abs)) continue
    if (statSync(abs).isDirectory()) out.push(...walk(abs, skip))
    else if (isScannable(entry)) out.push(abs)
  }
  return out
}

function escapeId(cap: Capability): string {
  return cap.replace(/\./g, '\\.')
}

/** `fn(…, '<cap>')` reached without crossing a statement boundary. */
function callsWith(source: string, fns: string[], cap: Capability): boolean {
  return fns.some((fn) => new RegExp(`${fn}\\([^;{}]{0,200}?'${escapeId(cap)}'`).test(source))
}

const FUNCTIONS_API_DIR = join(SRC, 'api')

const rulesSource = read(join(ROOT, 'firestore.rules'))

const functionsSources = walk(SRC, (abs) => abs === FUNCTIONS_API_DIR).map(read)
const webSources = walk(join(ROOT, 'apps', 'web', 'src')).map(read)

const apiSources = [
  read(join(ROOT, 'packages', 'shared', 'src', 'types', 'api.ts')),
  ...walk(FUNCTIONS_API_DIR).map(read),
]

function derivedEnforcement(cap: Capability): 'app' | 'api' | 'none' {
  const inRules = callsWith(rulesSource, ['hasTeamCapability'], cap)
  const inCallable = functionsSources.some((s) =>
    callsWith(s, ['requireCapability', 'hasCapability'], cap)
  )
  const inWeb = webSources.some((s) => callsWith(s, ['can'], cap))
  if (inRules || inCallable || inWeb) return 'app'
  return apiSources.some((s) => s.includes(`'${cap}'`)) ? 'api' : 'none'
}

describe('capability enforcement map — declared vs. actual', () => {
  it('scans a plausible tree (guards against a walk that silently found nothing)', () => {
    // A recipe that reads zero files classifies EVERYTHING as 'none' and would
    // fail loudly below — but only because the map happens to disagree. Assert the
    // inputs directly so a broken walk names itself instead of arriving as
    // eighteen confusing mismatches.
    assert.ok(rulesSource.includes('hasTeamCapability'), 'firestore.rules not read')
    assert.ok(functionsSources.length > 100, `functions scan too small: ${functionsSources.length}`)
    assert.ok(webSources.length > 100, `web scan too small: ${webSources.length}`)
    assert.ok(apiSources.length > 5, `api scan too small: ${apiSources.length}`)
  })

  it('every capability is classified as the source actually enforces it', () => {
    const wrong: string[] = []
    for (const cap of ALL_CAPABILITIES) {
      const declared = capabilityEnforcement(cap)
      const actual = derivedEnforcement(cap)
      if (declared !== actual) wrong.push(`${cap}: declared '${declared}', source says '${actual}'`)
    }
    assert.deepEqual(
      wrong,
      [],
      'CAPABILITY_ENFORCEMENT is out of date with the code it describes.\n' +
        'Fix the map in packages/shared/src/types/capabilities.ts — the role editor\n' +
        'renders a hint from it, so a stale entry misinforms a studio about its own\n' +
        'permissions.\n' +
        wrong.join('\n')
    )
  })

  it('the four *.view* capabilities are the API-only ones, by name', () => {
    // Named rather than counted: this is the set the editor labels, and a claim
    // checkable by reading the names beside it fails visibly rather than silently.
    const apiOnly = ALL_CAPABILITIES.filter((c) => capabilityEnforcement(c) === 'api')
    assert.deepEqual(apiOnly.sort(), [
      'contacts.view',
      'contacts.view.all',
      'schedule.view',
      'schedule.view.all',
    ])
  })
})
