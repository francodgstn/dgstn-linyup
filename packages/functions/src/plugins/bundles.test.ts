import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_BUNDLES, bundleMembers, isBundleContainer } from '@linyup/shared'

// THE BUNDLE CENSUS.
//
// A plugin CONTAINER installs other plugins. The whole design rests on members
// being ORDINARY plugins — so that nav, event types, automation contributions,
// the server gate, the teardown switch and firestore.rules all keep working with
// no knowledge that bundles exist — and on exactly three places knowing the
// difference:
//
//   1. the surfaces that OFFER AN INSTALL, which must hide members;
//   2. plugins/bundleReconcile.ts, the ONE writer of a member install doc;
//   3. the container config panel + settings/event-types attribution.
//
// This file re-derives that split FROM THE SOURCE rather than trusting prose,
// for the reason connect/commitSites.test.ts gives at length: a list written in
// a comment has no gate behind it, and this one spans the functions/web
// boundary — which is exactly where a correction stops traveling.
//
// Run with: pnpm --filter @linyup/functions test

const SRC = join(__dirname, '..')
/** The worktree root: SRC -> packages/functions -> packages -> root. */
const ROOT = join(SRC, '..', '..', '..')
const WEB_SRC = join(ROOT, 'apps', 'web', 'src')

function readAt(abs: string): string {
  return readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
}
function read(rel: string): string {
  return readAt(join(SRC, rel))
}

/** CODE only — a header that explains the rule mentions the very strings these
 *  assertions search for, and counting prose as a call site is the confusion
 *  this file exists to remove. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** Every .ts/.tsx file under a directory, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue
      walk(abs, out)
    } else if (/\.tsx?$/.test(entry)) {
      out.push(abs)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. Structural invariants of the bundle map
// ---------------------------------------------------------------------------

describe('the bundle map is well formed', () => {
  const containers = Object.keys(PLUGIN_BUNDLES)

  it('no container is a member of another container', () => {
    for (const c of containers) {
      for (const m of bundleMembers(c)) {
        assert.ok(
          !isBundleContainer(m),
          `${m} is both a member of ${c} and a container itself. The reconciler walks one ` +
            'level; nesting would leave the inner container members unmanaged.',
        )
      }
    }
  })

  it('no plugin belongs to two containers', () => {
    const seen = new Map<string, string>()
    for (const c of containers) {
      for (const m of bundleMembers(c)) {
        const prev = seen.get(m)
        assert.ok(
          !prev,
          `${m} is a member of both ${prev} and ${c}. Two containers would each believe they ` +
            'own its install doc, and whichever reconciled last would delete it.',
        )
        seen.set(m, c)
      }
    }
  })

  it('every id in the map has a manifest file', () => {
    for (const c of containers) {
      for (const id of [c, ...bundleMembers(c)]) {
        assert.ok(
          existsSync(join(WEB_SRC, 'plugins', id, 'manifest.ts')),
          `PLUGIN_BUNDLES names ${id} but apps/web/src/plugins/${id}/manifest.ts does not exist`,
        )
      }
    }
  })

  it('a container is never an addon and never locked', () => {
    for (const c of containers) {
      const manifest = readAt(join(WEB_SRC, 'plugins', c, 'manifest.ts'))
      assert.ok(
        !/^\s*addon:/m.test(code(manifest)),
        `container ${c} declares an addon. The add-on activation callable writes ONE install ` +
          'document and never reconciles, so a container bought that way would install none ' +
          'of its members.',
      )
      assert.ok(
        !/^\s*locked:\s*true/m.test(code(manifest)),
        `container ${c} is locked. unlockPlugin writes ONE document and never reconciles — ` +
          'the same failure as the addon path.',
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 2. THE CENSUS — every surface that offers an install hides bundle members
// ---------------------------------------------------------------------------

describe('the catalog census', () => {
  // Files that OFFER an install. Each must go through installableManifests(),
  // which is the only thing that hides a member.
  const CATALOGUE = [
    // /plugins since 2026-09-20 — the marketplace left the settings shell for a
    // full page. It is a PATH IN A TEST and moving the route is exactly what
    // makes it stale, which is how this one was found: the file simply stopped
    // existing and the census asserted against nothing.
    'app/[locale]/(auth)/plugins/page.tsx',
    'app/[locale]/(auth)/org/[orgId]/plugins/page.tsx',
    // components/dashboard/DiscoverPanel.tsx was the third. It was deleted with
    // the incumbent dashboard (the new page drops Discover by decision — a shelf
    // you go to, not a thing you are handed while finding out whether the 09:00
    // is full). Plugin discovery now happens only on the two marketplace pages
    // above and through the sidebar's Explore link, all of which are covered.
  ]

  // Files that touch PLUGIN_REGISTRY but resolve an ALREADY-INSTALLED plugin, or
  // describe one without offering an install. These must stay bundle-blind — a
  // member resolves through its own id exactly like any other plugin.
  const RESOLVER: Record<string, string> = {
    'plugins/registry.ts': 'the registry itself — it DEFINES installableManifests()',
    'app/[locale]/(auth)/layout.tsx':
      'the sidebar mounts installed plugins nav rows; a member rows must mount normally',
    'app/[locale]/(auth)/settings/event-types/page.tsx':
      'describes a member event type without offering an install; it credits the CONTAINER',
    'app/[locale]/(auth)/events/[id]/page.tsx':
      'resolves the plugin that owns an event type, installed or not',
    'app/[locale]/(auth)/org/[orgId]/events/[id]/page.tsx':
      'the ORG twin of the line above — same resolution by event type, for events the ' +
      'organisation owns. Offers no install; org installs are the plugins page.',
    'components/events/CheckinPanel.tsx':
      'resolves the plugin providing a check-in form or exports for an event type',
    'hooks/useEventTypes.ts':
      'offers event types from INSTALLED plugins — install state, not installability',
    'hooks/useInstalledPlugins.ts':
      'resolves install docs into manifests; a member is an ordinary install',
    'hooks/usePluginDiscovery.ts': 'the audience predicate, an orthogonal question',
    'app/[locale]/(auth)/automations/page.tsx':
      'offers automation triggers and actions contributed by installed plugins',
  }

  it('every apps/web file importing PLUGIN_REGISTRY is classified', () => {
    const importers = walk(WEB_SRC)
      .filter((abs) => /\bPLUGIN_REGISTRY\b/.test(readAt(abs)))
      .map((abs) => abs.slice(WEB_SRC.length + 1).replace(/\\/g, '/'))

    for (const rel of importers) {
      const known = CATALOGUE.includes(rel) || rel in RESOLVER
      assert.ok(
        known,
        `${rel} reads PLUGIN_REGISTRY and is in neither list in this test.\n` +
          '  If it OFFERS AN INSTALL, add it to CATALOGUE and make it call installableManifests().\n' +
          '  If it resolves an already-installed plugin, add it to RESOLVER with the reason.\n' +
          '  Getting this wrong puts a bundle member card in a tenant marketplace, where\n' +
          '  installing it writes a doc the reconciler then owns and may delete.',
      )
    }
  })

  it('every catalogue surface goes through installableManifests()', () => {
    for (const rel of CATALOGUE) {
      const source = readAt(join(WEB_SRC, rel))
      assert.ok(
        source.includes('installableManifests('),
        `${rel} offers an install but does not call installableManifests() — it would offer ` +
          'bundle members as if they were standalone plugins',
      )
      assert.ok(
        !/PLUGIN_REGISTRY\s*[.[]/.test(code(source)),
        `${rel} still reaches into PLUGIN_REGISTRY directly; the filtered view is the only ` +
          'list a catalog may iterate',
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 3. ONE writer of a member install document
// ---------------------------------------------------------------------------

describe('the reconciler is the only writer of a member install doc', () => {
  const reconcile = read('plugins/bundleReconcile.ts')

  it('nothing else stamps installedByBundle', () => {
    const offenders: string[] = []
    for (const abs of [...walk(SRC), ...walk(WEB_SRC)]) {
      const rel = abs.replace(/\\/g, '/')
      if (rel.endsWith('bundleReconcile.ts') || rel.endsWith('.test.ts')) continue
      const src = code(readAt(abs))
      if (/INSTALLED_BY_BUNDLE_FIELD\]\s*:/.test(src)) offenders.push(rel)
    }
    assert.deepEqual(
      offenders,
      [],
      'only plugins/bundleReconcile.ts may write installedByBundle — a second writer means ' +
        'two ideas of which installs a container owns, and the loser gets deleted',
    )
  })

  it('the migration installs the CONTAINER, never a member', () => {
    const setup = code(readAt(join(ROOT, 'scripts', 'migration', 'passes', '00-setup.ts')))
    assert.ok(
      /CONTAINER_PLUGIN_ID\s*=\s*'hmd'/.test(setup),
      'the migration must install the hmd container. Pins the VALUE, not just the identifier: ' +
        'the previous form matched the declaration name alone and failed on a rename that ' +
        'changed nothing about the behavior it is guarding.',
    )
    for (const member of bundleMembers('hmd')) {
      assert.ok(
        !setup.includes(member),
        `scripts/migration/passes/00-setup.ts writes the member ${member} directly. That makes ` +
          'it a second writer, and the doc it writes carries no installedByBundle stamp — so ' +
          'the reconciler would never clean it up.',
      )
    }
  })

  it('it DELETES a removed member and never deactivates one', () => {
    assert.ok(
      !/status:\s*'inactive'/.test(code(reconcile)),
      'bundleReconcile must not write an inactive status. That marker means a plan lapse, and ' +
        'orgs/orgTierRails.test.ts allows exactly two writers of it; a deleted doc also carries ' +
        'no stale keep_course_mirrors marker into a reinstall.',
    )
    assert.ok(code(reconcile).includes('batch.delete('), 'removal must be a delete')
  })

  it('both loop breakers are present', () => {
    const body = code(reconcile)
    assert.ok(
      /if\s*\(!isBundleContainer\(containerId\)\)\s*return/.test(body),
      'without the isBundleContainer guard, every member doc this function writes re-enters ' +
        'the trigger as if it were a container',
    )
    assert.ok(
      /if\s*\(ops === 0\)\s*return/.test(body),
      'without the empty-diff early return, a commit with no changes still re-fires the ' +
        'trigger this function runs inside — an infinite write loop on the first install',
    )
  })
})

// ---------------------------------------------------------------------------
// 4. The server gate resolves an ORG install
// ---------------------------------------------------------------------------

describe('pluginIsActive sees an org-level install', () => {
  const plugins = read('utils/plugins.ts')

  it('it reads org_id and the org installs subcollection', () => {
    const body = code(plugins)
    assert.ok(
      body.includes('org_id'),
      'pluginIsActive read only the TEAM path once, which made every org-level install ' +
        'invisible to every server-side gate — a studio could see a feature in its sidebar ' +
        'and be refused by the callable behind it',
    )
    assert.ok(body.includes('ORG_INSTALLED_PLUGINS_SUBCOLLECTION'))
  })

  it('an inactive TEAM doc does not veto an active ORG doc', () => {
    const body = code(plugins)
    // MATCHED BY SHAPE, NOT BY VARIABLE NAME. This assertion used to name
    // `installSnap`, and it broke the day the resolver was batched — the RULE
    // was intact and the test failed anyway, which is the failure mode that
    // teaches people to delete source assertions.
    assert.ok(
      /exists\s*&&\s*\w+\.data\(\)\?\.status === 'active'/.test(body),
      'the team branch must be gated on an active status before it wins. useInstalledPlugins ' +
        'filters to active FIRST and only then lets a team entry take precedence, so a server ' +
        'where the team doc wins merely by existing refuses what the studio can see.',
    )
  })

  it('the ad-hoc gates delegate to it', () => {
    for (const [rel, sym] of [
      ['finance/access.ts', 'pluginIsActive('],
      ['assistant/index.ts', 'pluginIsActive('],
      ['website/index.ts', 'pluginIsActive('],
      ['kiosk/index.ts', 'resolveActivePluginInstall('],
    ] as const) {
      assert.ok(
        code(read(rel)).includes(sym),
        `${rel} must resolve install state through utils/plugins.ts. Its own copy could not ` +
          'see an ORG-level install, so a studio whose organization bought the plugin was refused.',
      )
    }
  })
})
