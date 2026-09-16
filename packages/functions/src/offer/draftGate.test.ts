import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AI_MODULES, EXPERIMENTAL_FEATURES, bundleMembers } from '@linyup/shared'

// OFFER DRAFTING IS A MODULE OF THE AI PLUGIN (2026-09-17), no longer the
// `offer-drafting` experiment. Both callables go through `assertAllowed`, which
// cannot run without Firestore, so its gate is pinned from the source.

describe('offer drafting — gated on the ai-offer-drafting module', () => {
  const source = readFileSync(join(__dirname, 'draftOfferings.ts'), 'utf8').replace(/\r\n/g, '\n')
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  it('is a member of the ai container', () => {
    assert.ok(bundleMembers('ai').includes(AI_MODULES.offerDrafting))
  })

  it('is no longer an experiment', () => {
    assert.ok(!EXPERIMENTAL_FEATURES.some((f) => (f.id as string) === 'offer-drafting'))
  })

  it('asks pluginIsActive for the module, and never reads the retired flag', () => {
    assert.match(body, /pluginIsActive\(teamId, AI_MODULES\.offerDrafting\)/)
    assert.ok(!/experimentalFeatures/.test(body), 'the experiment flag is retired; a read of it would re-open a switch nobody sees')
  })

  it('stays owner-only, and both callables pass the gate', () => {
    assert.match(body, /hasTeamRole\(uid, teamId, 'owner'\)/)
    assert.equal(body.match(/await assertAllowed\(uid, teamId\)/g)?.length, 2)
  })
})
