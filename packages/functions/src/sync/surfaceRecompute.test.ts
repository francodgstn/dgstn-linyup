import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// A SURFACE RECOMPUTE MUST NOT CREATE A TEAM.
//
// `touchTeamForSurfaceRecompute` nudges `teams/{teamId}` so `syncTeamPublicProfile`
// re-runs. It used to do that with `set(..., {merge: true})`, which CREATES the
// document when it is absent — and most of its callers are `onDocumentWritten`
// triggers on a team's courses, forms, documents, events, activities and
// availability, all of which fire on DELETE.
//
// So deleting a tenant resurrected it: the write created `teams/{teamId}`, that
// fired `onTeamCreated`, and the team came back half-provisioned with default
// payment modes, the trial-cleanup automation rule and a public profile mirror.
// Thirteen of HMD's sixteen studios came back that way on staging (2026-09-05),
// and the same content deletes run under `saas-billing/purgeTeam.ts` for a real
// customer.
//
// Source-reading rather than behavioral because the failure is one call shape,
// the fix is one call shape, and a reviewer changing it back would otherwise get
// a green suite. Precedent: connect/commitSites.test.ts.
//
// Run with: pnpm --filter @linyup/functions test

const SRC = join(__dirname, '..')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** CODE only — the header explains the bug using the very strings under test. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(abs)
  }
  return out
}

describe('a surface recompute never creates a team', () => {
  const body = code(read('utils/plugins.ts'))
  const fn = body.slice(body.indexOf('export async function touchTeamForSurfaceRecompute'))
  const impl = fn.slice(0, fn.indexOf('\n}\n') + 1)

  it('touches with update(), not set()', () => {
    assert.ok(
      /\.update\(\{\s*surfaces_updated_at/.test(impl),
      'touchTeamForSurfaceRecompute must write with update(). set(..., {merge:true}) creates ' +
        'the document, and its callers fire on DELETE — that is what resurrected thirteen ' +
        'deleted studios as half-provisioned tenants.',
    )
    assert.ok(
      !/\.set\(/.test(impl),
      'touchTeamForSurfaceRecompute must not call set() at all — merge or otherwise.',
    )
  })

  it('swallows NOT_FOUND and nothing else', () => {
    assert.ok(
      /code\s*===\s*5/.test(impl),
      'the NOT_FOUND (gRPC 5) case must be handled explicitly — a deleted team has nothing ' +
        'to recompute, and every other error must still surface.',
    )
    assert.ok(
      /throw err/.test(impl),
      'errors other than NOT_FOUND must be rethrown; a bare catch would hide real failures.',
    )
  })

  it('is the ONLY writer of surfaces_updated_at outside a manager callable', () => {
    // waivers/publish.ts writes it inside a transaction that has already
    // authorized against a LIVE team, so it cannot fire on a deleted one. Any
    // OTHER writer is a new resurrection vector and must be justified here.
    const allowed = new Set(['utils/plugins.ts', 'waivers/publish.ts'])
    const writers = walk(SRC)
      .filter((abs) => /surfaces_updated_at:\s*FieldValue/.test(code(readFileSync(abs, 'utf8'))))
      .map((abs) => abs.slice(SRC.length + 1).replace(/\\/g, '/'))

    for (const w of writers) {
      assert.ok(
        allowed.has(w),
        `${w} writes surfaces_updated_at. If it can run while the team is being deleted it ` +
          'must use update() + the NOT_FOUND guard, not set(merge) — otherwise it will ' +
          'recreate a deleted tenant. Add it here once you have checked which it is.',
      )
    }
  })
})
