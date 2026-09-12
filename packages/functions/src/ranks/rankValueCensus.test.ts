import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * THE CENSUS OF `RankLevel.value` — Phase 4 of docs/rank-scale-decoupling.md.
 *
 * The ordinal that used to be a level's identity, its order and its
 * progression key all at once is gone from the shape. The type system now
 * refuses every ordinary read of it (`level.value` does not compile), so what
 * is left to guard is the ONE deliberate hole: `legacyRankValue`, which peeks
 * at the field on a ladder document written before Phase 4 so that a record
 * `backfill:rank-refs` has not reached still resolves. This test pins who may
 * call it, and that nobody has put the number back into a seed, a preset or a
 * hand-copied type. It reads the SOURCE, across the package boundary, the way
 * connect/commitSites.test.ts does — that boundary is where corrections stop
 * travelling.
 *
 * When Phase 4b lands (the flip has run everywhere and `--strip-values` has
 * emptied the ladders), `legacyRankValue` is deleted and the allow-list below
 * shrinks to nothing.
 */

function repoRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('repo root not found above ' + process.cwd())
}

const ROOT = repoRoot()
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

/** Every source file under `dir` (recursive), as repo-relative POSIX paths. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue
      const full = path.join(abs, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path.relative(ROOT, full).split(path.sep).join('/'))
    }
  }
  walk(path.join(ROOT, dir))
  return out
}

/**
 * The files that may call `legacyRankValue`. The resolver's own numeric arm,
 * and the two ranking editors' holder counts — which must still find a
 * contact holding the NUMBER until the flip has run, or a level could be
 * deleted from under them with the count saying nobody holds it.
 */
const LEGACY_READERS = [
  'packages/shared/src/utils/rankLevels.ts',
  'apps/web/src/app/[locale]/(auth)/org/[orgId]/ranking/page.tsx',
  'apps/web/src/app/[locale]/(auth)/settings/team/page.tsx',
]

describe('RankLevel.value census (Phase 4)', () => {
  it('the shape declares no `value` — the ordinal is gone, not optional', () => {
    const src = read('packages/shared/src/types/team.ts')
    const start = src.indexOf('export interface RankLevel {')
    assert.ok(start >= 0, 'RankLevel interface not found')
    const end = src.indexOf('\n}', start)
    const body = src.slice(start, end)
    assert.ok(!/^\s*value\??:/m.test(body), 'RankLevel declares `value` again — Phase 4 removed it; order is array position and identity is `id`')
    assert.ok(/^\s*id: string/m.test(body), 'RankLevel.id must be required')
  })

  it('legacyRankValue is defined once and called only from the allow-list', () => {
    const roots = ['packages/shared/src', 'packages/functions/src', 'apps/web/src', 'apps/mobile/src', 'scripts']
    const callers = new Set<string>()
    let definitions = 0
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        if (file.endsWith('.test.ts')) continue
        const src = read(file)
        if (/export function legacyRankValue\(/.test(src)) definitions++
        if (/\blegacyRankValue\(/.test(src.replace(/export function legacyRankValue\(/g, ''))) callers.add(file)
      }
    }
    assert.equal(definitions, 1, 'legacyRankValue must be defined exactly once (utils/rankLevels.ts)')
    assert.deepEqual(
      [...callers].sort(),
      [...LEGACY_READERS].sort(),
      'a new reader of the legacy `value` appeared — resolve by id through findRankLevel instead, or add it here with the reason it must see pre-flip records',
    )
  })

  it('no seed, preset or migration ladder states a `value` on a level', () => {
    // A level literal is `{ [id: '…',] value: N, label: '…' … }`. The
    // migration's source table carries `legacyValue` — a different word on
    // purpose, and never written to the ladder.
    const files = [
      'apps/web/src/lib/rank-presets.ts',
      'scripts/seed-emulator.ts',
      'scripts/seed-staging.ts',
      'scripts/seed-sandbox.ts',
      'scripts/migration/config.ts',
    ]
    for (const file of files) {
      const src = read(file)
      assert.ok(!/\{\s*(id:\s*'[^']*',\s*)?value:\s*\d+\s*,\s*label:/.test(src), `${file} seeds a level with a value`)
    }
  })

  it('the member app has no copy of RankLevel of its own', () => {
    // It re-exports the shared type; a hand-copied interface would be exactly
    // where a `value` comes back without anyone noticing.
    for (const file of sourceFiles('apps/mobile/src')) {
      assert.ok(!/interface RankLevel\b/.test(read(file)), `${file} declares its own RankLevel`)
    }
  })
})
