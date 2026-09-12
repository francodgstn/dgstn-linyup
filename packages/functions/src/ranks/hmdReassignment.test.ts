import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * THE HMD BELT REASSIGNMENT IS DATA, AND THIS PINS ITS SHAPE — Phase 6 of
 * docs/rank-scale-decoupling.md.
 *
 * `scripts/migration/config.ts` holds the ladder the migration writes and the
 * old→new map `backfill:rank-reassign` applies. The scripts tree is outside
 * this runner's module resolution (the same seam statusVocabulary.test.ts
 * describes), so both are read as SOURCE. What can go wrong silently and is
 * caught here: a map entry naming a level the ladder does not carry (every
 * holder of it would be orphaned), a source mapped onto itself, a decision
 * half-recorded (a name with no date, or the reverse), and the two inserted
 * belts drifting out of the positions HMD put them in.
 */

function repoRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('repo root not found above ' + process.cwd())
}

const src = fs
  .readFileSync(path.join(repoRoot(), 'scripts/migration/config.ts'), 'utf8')
  .replace(/\r\n/g, '\n')

function block(startMarker: string): string {
  const start = src.indexOf(startMarker)
  assert.ok(start >= 0, `${startMarker} not found in scripts/migration/config.ts`)
  const end = src.indexOf('\n]', start)
  assert.ok(end > start, `${startMarker} block has no closing bracket`)
  return src.slice(start, end)
}

const ladderIds = [...block('const HMD_BELT_LEVELS').matchAll(/\{ id: '([a-z0-9-]+)'/g)].map((m) => m[1])

function reassignment(): { decidedBy: string | null; decidedOn: string | null; map: Record<string, string> } {
  const start = src.indexOf('export const HMD_BELT_REASSIGNMENT = {')
  assert.ok(start >= 0, 'HMD_BELT_REASSIGNMENT not found')
  const body = src.slice(start, src.indexOf('\n}', start))
  const field = (name: string) => {
    const m = body.match(new RegExp(`${name}: (null|'([^']*)')`))
    assert.ok(m, `${name} not declared as null or a string literal`)
    return m[1] === 'null' ? null : m[2]
  }
  const mapSrc = body.match(/map: \{([^}]*)\}/)
  assert.ok(mapSrc, 'map not found')
  const map: Record<string, string> = {}
  for (const m of mapSrc[1].matchAll(/'?([a-z0-9-]+)'?: '([a-z0-9-]+)'/g)) map[m[1]] = m[2]
  return { decidedBy: field('decidedBy'), decidedOn: field('decidedOn'), map }
}

describe('HMD belt reassignment (Phase 6)', () => {
  it('the ladder carries the two inserted belts where HMD put them', () => {
    assert.equal(ladderIds.indexOf('white-yellow'), ladderIds.indexOf('white') + 1)
    assert.equal(ladderIds.indexOf('yellow-orange'), ladderIds.indexOf('yellow') + 1)
    assert.equal(new Set(ladderIds).size, ladderIds.length, 'duplicate level id')
  })

  it('every id the map names is on the ladder, and nothing maps onto itself', () => {
    const { map } = reassignment()
    assert.ok(Object.keys(map).length > 0, 'the map is empty')
    for (const [from, to] of Object.entries(map)) {
      assert.ok(ladderIds.includes(from), `map source '${from}' is not on the ladder`)
      assert.ok(ladderIds.includes(to), `map target '${to}' is not on the ladder — every holder would be orphaned`)
      assert.notEqual(from, to, `'${from}' maps onto itself`)
      assert.ok(!(to in map), `'${to}' is both a target and a source — the map would chain`)
    }
  })

  it('the decision is recorded whole or not at all', () => {
    const { decidedBy, decidedOn } = reassignment()
    assert.equal(decidedBy === null, decidedOn === null, 'decidedBy and decidedOn must be set together')
    if (decidedOn !== null) assert.match(decidedOn, /^\d{4}-\d{2}-\d{2}$/, 'decidedOn is an ISO date')
  })
})
