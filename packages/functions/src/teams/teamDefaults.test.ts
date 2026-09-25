// THE THREE COPIES OF "WHICH PLUGIN MAY WHICH PLAN INSTALL", kept honest.
//
// The truth is a plugin MANIFEST (apps/web/src/plugins/<id>/manifest.ts): its
// `minPlan`, and whether it carries an `addon`. Two other places need the same
// answer and neither can read a manifest:
//
//   packages/shared/src/types/pluginDefaults.ts  — the functions package, which
//       provisions a new team and cannot import PLUGIN_REGISTRY (apps/web).
//   firestore.rules                              — which can import nothing.
//
// Derived data is fine; UNCHECKED derived data is how a Coach came to see
// Custom Fields offered as "Included" and be denied on click for two months.
// This file reads all three and fails the build when they disagree, so adding a
// plugin or moving its `minPlan` cannot silently leave the other two behind.
//
// It spans the functions/web boundary on purpose — the same reason
// connect/commitSites.test.ts does. That boundary is where corrections stop
// traveling.

import { strict as assert } from 'assert'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import {
  CLIENT_INSTALLABLE_FROM,
  CLIENT_INSTALLABLE_DEFAULT_PLAN,
  DEFAULT_TEAM_PLUGINS,
  clientInstallableFrom,
  isBundleMember,
  PLUGIN_ADDONS,
  planIsAtLeast,
} from '@linyup/shared'
import type { SaasPlan } from '@linyup/shared'

const SRC = join(__dirname, '..')
const ROOT = join(SRC, '..', '..', '..')
const PLUGINS_DIR = join(ROOT, 'apps', 'web', 'src', 'plugins')

const read = (abs: string) => readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')

interface ManifestFacts {
  id: string
  minPlan: SaasPlan
  isAddon: boolean
  isLocked: boolean
}

/** Every plugin manifest, read as data. */
function manifests(): ManifestFacts[] {
  const out: ManifestFacts[] = []
  for (const entry of readdirSync(PLUGINS_DIR)) {
    const file = join(PLUGINS_DIR, entry, 'manifest.ts')
    if (!existsSync(file)) continue
    const src = read(file)
    const id = /\bid:\s*'([^']+)'/.exec(src)?.[1]
    const minPlan = /\bminPlan:\s*'([^']+)'/.exec(src)?.[1] as SaasPlan | undefined
    assert.ok(id, `${entry}/manifest.ts has no id`)
    assert.ok(minPlan, `${entry}/manifest.ts has no minPlan`)
    out.push({
      id,
      minPlan,
      isAddon: /\baddon:\s*/.test(src),
      isLocked: /\blocked:\s*true/.test(src),
    })
  }
  assert.ok(out.length > 10, 'expected to find the plugin manifests')
  return out
}

/**
 * What `pluginAccessForPlan` resolves to `included` at, expressed as the lowest
 * plan. An add-on is floored at Studio: at Coach it is PAID, so it must go
 * through `activatePluginAddon` server-side and must never be client-installable.
 */
function expectedInstallableFrom(m: ManifestFacts): SaasPlan {
  if (m.isAddon) return 'studio'
  return planIsAtLeast('studio', m.minPlan) ? m.minPlan : m.minPlan
}

describe('plugin install eligibility is one answer in three places', () => {
  const all = manifests()

  it('CLIENT_INSTALLABLE_FROM names exactly the plugins below Studio', () => {
    // Anything Studio-or-above is the default and must NOT be listed — a
    // redundant entry is a second thing to keep in step for no benefit.
    const expected = new Map<string, SaasPlan>()
    for (const m of all) {
      const from = expectedInstallableFrom(m)
      if (from !== CLIENT_INSTALLABLE_DEFAULT_PLAN) expected.set(m.id, from)
    }
    assert.deepEqual(
      Object.fromEntries([...expected.entries()].sort()),
      Object.fromEntries(Object.entries(CLIENT_INSTALLABLE_FROM).sort()),
      'CLIENT_INSTALLABLE_FROM disagrees with the manifests. A plugin whose minPlan ' +
        'dropped below Studio, or which stopped being a paid add-on, must be added here ' +
        'AND to clientInstallableRank in firestore.rules — that pair going stale is ' +
        'exactly how Custom Fields became uninstallable on Coach.'
    )
  })

  it('firestore.rules encodes the same map', () => {
    const rules = read(join(ROOT, 'firestore.rules'))
    const fn = rules.slice(
      rules.indexOf('function clientInstallableRank('),
      rules.indexOf('function clientInstallableRank(') + 400
    )
    assert.ok(fn.includes('clientInstallableRank'), 'the rules helper must exist')

    const rank: Record<SaasPlan, number> = { free: 0, coach: 1, studio: 2, organization: 3 }
    // Each `pluginId in [...] ? N` arm, read back out of the rule.
    const arms = [...fn.matchAll(/pluginId in \[([^\]]*)\] \? (\d)/g)].map(([, list, n]) => ({
      ids: [...list.matchAll(/'([^']+)'/g)].map(([, id]) => id),
      rank: Number(n),
    }))
    assert.ok(arms.length > 0, 'could not parse the rules helper')

    const fromRules: Record<string, number> = {}
    for (const arm of arms) for (const id of arm.ids) fromRules[id] = arm.rank

    const fromShared: Record<string, number> = {}
    for (const [id, plan] of Object.entries(CLIENT_INSTALLABLE_FROM)) fromShared[id] = rank[plan]

    assert.deepEqual(
      fromRules,
      fromShared,
      'firestore.rules and CLIENT_INSTALLABLE_FROM disagree about who may install what'
    )

    const fallback = /:\s*(\d)\s*;/.exec(fn)?.[1]
    assert.equal(
      Number(fallback),
      rank[CLIENT_INSTALLABLE_DEFAULT_PLAN],
      'the rules fallback tier must match CLIENT_INSTALLABLE_DEFAULT_PLAN'
    )
  })
})

describe('DEFAULT_TEAM_PLUGINS is safe to install unasked', () => {
  const all = manifests()
  const byId = new Map(all.map((m) => [m.id, m]))

  for (const id of DEFAULT_TEAM_PLUGINS) {
    describe(id, () => {
      it('has a manifest', () => {
        assert.ok(byId.has(id), `${id} is in DEFAULT_TEAM_PLUGINS but has no manifest`)
      })

      it('is NOT a paid add-on', () => {
        // Provisioning one would hand every new team a plugin somebody is meant
        // to be billed for — the exact thing the install rules exist to stop.
        assert.ok(!byId.get(id)?.isAddon, `${id} is a paid add-on`)
        assert.ok(!(id in PLUGIN_ADDONS), `${id} appears in PLUGIN_ADDONS`)
      })

      it('is NOT locked', () => {
        // A locked plugin is installable only through unlockPlugin, which checks
        // a strong key. Seeding one past that gate defeats the gate.
        assert.ok(!byId.get(id)?.isLocked, `${id} is locked`)
      })

      it('is NOT a bundle member', () => {
        // Bundle members have exactly one writer, bundleReconcile.ts. A second
        // one would fight it every time the container reconciles.
        assert.ok(!isBundleMember(id), `${id} is owned by a bundle container`)
      })

      it('is installable on the plan a new team is created with', () => {
        // createStudioTeam writes plan 'studio'; the trigger additionally guards
        // on the actual plan, so this is about the DEFAULT path being sane
        // rather than about the guard.
        assert.ok(
          planIsAtLeast('studio', clientInstallableFrom(id)),
          `${id} cannot be installed on the plan a new team starts on`
        )
      })
    })
  }

  it('the trigger provisions them, and guards on the plan', () => {
    const src = read(join(SRC, 'teams', 'onTeamCreated.ts'))
    assert.ok(src.includes('DEFAULT_TEAM_PLUGINS'), 'onTeamCreated must read the constant')
    assert.ok(
      src.includes('planIsAtLeast('),
      'the trigger must gate on the plan — an install document is honored by ' +
        'useInstalledPlugins with no plan check of its own, so an ungated write hands ' +
        'a Free team a paid-tier feature'
    )
    assert.ok(
      /\.create\(/.test(src),
      'must use create(), not set(): on an event retry a set would resurrect an install ' +
        'the owner had removed in between'
    )
  })
})
