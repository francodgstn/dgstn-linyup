import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLIENT_INSTALLABLE_DEFAULT_PLAN,
  CLIENT_INSTALLABLE_FROM,
  PLUGIN_ADDONS,
  PLUGIN_BUNDLES,
  PLUGIN_REQUIREMENTS,
  pluginRequirements,
  pluginsRequiring,
  requirementBlockers,
  isBundleMember,
  type SaasPlan,
} from '@linyup/shared'

// THE REQUIREMENT CENSUS.
//
// "Installing A requires B" is a DIFFERENT relation from "container A installs
// members B" (PLUGIN_BUNDLES), and the difference is the whole point: a bundle
// member is hidden from every catalog and owned by its container, while a
// requirement is independently discoverable, installable and keepable.
// Conflating them is the failure this file exists to catch — see the header of
// packages/shared/src/types/plugin-requirements.ts.
//
// Run with: pnpm --filter @linyup/functions test

const SRC = join(__dirname, '..')
const ROOT = join(SRC, '..', '..', '..')
const WEB_SRC = join(ROOT, 'apps', 'web', 'src')

const readAt = (abs: string): string => readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')

/** Strip block comments and full-line `//` so a header explaining a rule is not
 *  mistaken for the code that breaks it. Same device as bundles.test.ts. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const manifestPath = (id: string) => join(WEB_SRC, 'plugins', id, 'manifest.ts')
const PLAN_RANK: Record<SaasPlan, number> = { free: 0, coach: 1, studio: 2, organization: 3 }
const installableFrom = (id: string): SaasPlan =>
  CLIENT_INSTALLABLE_FROM[id] ?? CLIENT_INSTALLABLE_DEFAULT_PLAN

describe('the requirement map is well formed', () => {
  const pairs = Object.entries(PLUGIN_REQUIREMENTS).flatMap(([requirer, reqs]) =>
    reqs.map((req) => [requirer, req] as const)
  )

  it('names a real manifest on both sides', () => {
    for (const [requirer, req] of pairs) {
      assert.ok(existsSync(manifestPath(requirer)), `${requirer} has no manifest`)
      assert.ok(existsSync(manifestPath(req)), `${req} has no manifest`)
    }
  })

  it('has no cycles and no chains — one level only', () => {
    for (const [requirer, req] of pairs) {
      assert.notEqual(requirer, req, `${requirer} requires itself`)
      assert.deepEqual(
        [...pluginRequirements(req)],
        [],
        `${req} is a requirement AND has requirements of its own — a chain would ` +
          'need a transitive resolver, and reconcileRequirements deliberately has none'
      )
    }
  })

  it('never points at a bundle member — a requirement must be installable alone', () => {
    for (const [, req] of pairs) {
      assert.ok(
        !isBundleMember(req),
        `${req} is a bundle member, so no catalogue offers it and a tenant could ` +
          'never keep it after the requirer went away'
      )
    }
  })

  it('never points at a paid add-on — the reconciler installs it for free', () => {
    for (const [, req] of pairs) {
      assert.ok(
        !PLUGIN_ADDONS[req],
        `${req} is a paid add-on; auto-installing it would grant paid value without a charge`
      )
    }
  })

  it('is never gated above its requirer, or the auto-install would be unreachable', () => {
    for (const [requirer, req] of pairs) {
      assert.ok(
        PLAN_RANK[installableFrom(req)] <= PLAN_RANK[installableFrom(requirer)],
        `${req} is installable from ${installableFrom(req)} but ${requirer} from ` +
          `${installableFrom(requirer)} — a tenant could install the requirer and never get the requirement`
      )
    }
  })

  it('is not expressible as a bundle, which is why it is a separate map', () => {
    for (const [requirer] of pairs) {
      assert.ok(
        !PLUGIN_BUNDLES[requirer],
        `${requirer} is both a bundle container and a requirer — pick one relation`
      )
    }
  })
})

describe('the lookups agree with each other', () => {
  it('pluginsRequiring is the exact reverse of pluginRequirements', () => {
    for (const [requirer, reqs] of Object.entries(PLUGIN_REQUIREMENTS)) {
      for (const req of reqs) {
        assert.ok(
          pluginsRequiring(req).includes(requirer),
          `${requirer} requires ${req} but the reverse lookup does not say so`
        )
      }
    }
  })

  it('requirementBlockers only blocks on a requirer that is actually installed', () => {
    assert.deepEqual(requirementBlockers('asset-register', ['finance']), ['finance'])
    assert.deepEqual(requirementBlockers('asset-register', ['website']), [])
    assert.deepEqual(requirementBlockers('finance', ['asset-register']), [])
  })
})

describe('reconcileRequirements is the one writer, and keeps its loop breakers', () => {
  const reconcile = code(readAt(join(SRC, 'plugins', 'requirementsReconcile.ts')))

  it('keeps both loop breakers', () => {
    assert.match(
      reconcile,
      /if \(asRequirer\.length === 0 && asRequirement\.length === 0\) return/,
      'the not-in-the-relation early return is gone — every install write would read'
    )
    assert.match(
      reconcile,
      /if \(ops === 0\) return/,
      'the empty-diff early return is gone — a no-op commit re-fires this trigger'
    )
  })

  it('never stamps installedByBundle — a requirement is not a bundle member', () => {
    assert.ok(
      !/INSTALLED_BY_BUNDLE_FIELD/.test(reconcile),
      'requirements must not borrow the bundle provenance field; bundles.test.ts ' +
        'allows exactly one writer of it, and reusing it would make a requirement ' +
        'deletable by a container it does not belong to'
    )
  })

  it('is mounted on both install-document triggers', () => {
    const triggers = code(readAt(join(SRC, 'plugins', 'bundleTriggers.ts')))
    const mounts = triggers.match(/reconcileRequirements\(/g) ?? []
    assert.equal(
      mounts.length,
      2,
      'reconcileRequirements must run on BOTH the team and org install triggers — ' +
        'finance installs at org level too, and an org install IS the grant'
    )
  })

  it('is NOT mounted on onInstalledPluginStatusChange, which is retry:false', () => {
    const statusChange = code(
      readAt(join(SRC, 'sync', 'onInstalledPluginStatusChange.ts'))
    )
    assert.ok(
      !/reconcileRequirements/.test(statusChange),
      'that trigger carries the non-idempotent finance ledger rebuild and must stay ' +
        'retry:false; this reconciler wants retry:true'
    )
  })
})
