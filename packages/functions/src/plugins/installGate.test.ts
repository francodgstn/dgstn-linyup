// THE PLUGIN INSTALL GATE ON THE TWO SEAMS THAT DID NOT HAVE ONE.
//
// A plugin is a capability the studio bought, and two places carried on as if it
// could never be given back:
//
//   THE AUTOMATION ENGINE dispatched `plugin:*` actions on the stored action id
//   alone, so a rule composed while WhatsApp was installed kept sending after
//   the plugin was removed.
//
//   `syncTeamPublicProfile` probed the TEAM install path only, so an org-level
//   install — which every other server gate honors through `pluginIsActive` —
//   was invisible to the one computation that decides what the PUBLIC sees.
//
// Both are `docs/plugins.md` Phase 1b. The first also turned out to hide a
// second defect, pinned below: a rule whose ONLY action was a plugin action was
// skipped wholesale, because `hasResolvableActions` had no arm for one.
//
// The behavior tests are pure. The source assertions exist because a gate is
// exactly the kind of line that gets deleted while "simplifying" a dispatch —
// same argument as `connect/commitSites.test.ts`, and the same technique.

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import { join } from 'path'
import { pluginIdOfNamespacedId } from '@linyup/shared'
import { hasResolvableActions, type AutomationAction, type ResolvedActions } from '../utils/automationEngine'

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

function resolved(activePlugins: string[] = []): ResolvedActions {
  return {
    template: null,
    alertPreset: null,
    language: 'en',
    activePlugins: new Set(activePlugins),
  }
}

const WHATSAPP = { type: 'plugin:whatsapp:send_message' } as unknown as AutomationAction
const ADD_NOTE = { type: 'add_note' } as unknown as AutomationAction

describe('plugin install gate', () => {
  describe('the namespaced id parse (ONE owner, in types/plugin.ts)', () => {
    it('extracts the plugin id', () => {
      assert.equal(pluginIdOfNamespacedId('plugin:whatsapp:send_message'), 'whatsapp')
    })

    it('rejects anything that is not exactly plugin:{id}:{name}', () => {
      // Each of these once looked close enough to a namespaced id to be worth
      // stating: returning a middle segment for any of them hands the caller a
      // plugin id that nothing installed, and the gate would then refuse an
      // action for a plugin that was never named.
      for (const bad of ['plugin:whatsapp', 'whatsapp:send_message', 'plugin::send', 'plugin:a:b:c', 'add_note', '']) {
        assert.equal(pluginIdOfNamespacedId(bad), null, bad)
      }
    })

    it('the rank-requirement parser is the SAME function, not a copy', async () => {
      const { pluginIdOfRequirement } = await import('@linyup/shared')
      assert.equal(
        pluginIdOfRequirement,
        pluginIdOfNamespacedId,
        'requirement ids share the shape; a second parse would drift'
      )
    })
  })

  describe('hasResolvableActions', () => {
    it('runs a plugin-only rule when the plugin is installed', () => {
      // THE SECOND DEFECT. Before the plugin arm existed this was false for
      // every plugin-only rule, and the caller logged "no executable action
      // resources found" and skipped it — a WhatsApp-only automation had simply
      // never run.
      assert.equal(hasResolvableActions([WHATSAPP], resolved(['whatsapp'])), true)
    })

    it('skips a plugin-only rule when the plugin is gone', () => {
      assert.equal(hasResolvableActions([WHATSAPP], resolved([])), false)
    })

    it('still runs a mixed rule when the plugin is gone', () => {
      // The other actions are the studio's and have nothing to do with the
      // plugin it removed.
      assert.equal(hasResolvableActions([WHATSAPP, ADD_NOTE], resolved([])), true)
    })

    it('does not treat a built-in action as a plugin action', () => {
      assert.equal(hasResolvableActions([ADD_NOTE], resolved([])), true)
    })
  })

  describe('the gate is where it must be (source)', () => {
    it('the automation engine resolves the install ONCE PER RULE, not per contact', () => {
      const engine = src('utils/automationEngine.ts')
      const resolveFn = engine.slice(
        engine.indexOf('async function resolveActionResources'),
        engine.indexOf('async function createContactAlertDoc')
      )
      assert.ok(
        resolveFn.includes('pluginIsActive('),
        'the per-rule prepass must be what asks — a rule sweeps every contact in the team'
      )
      const perContact = engine.slice(engine.indexOf('async function executeActionsForContact'))
      assert.ok(
        !perContact.includes('pluginIsActive('),
        'an install read inside the per-contact loop is one Firestore read per contact per action'
      )
    })

    it('the dispatch consults the resolved set before calling a handler', () => {
      const engine = src('utils/automationEngine.ts')
      const dispatch = engine.slice(engine.indexOf("startsWith('plugin:')"))
      const handlerAt = dispatch.indexOf('pluginActionHandlers[')
      const gateAt = dispatch.indexOf('activePlugins.has(')
      assert.ok(gateAt !== -1, 'the dispatch must check activePlugins')
      assert.ok(
        gateAt < handlerAt,
        'the check must gate the handler lookup, not follow it'
      )
    })

    it('syncTeamPublicProfile probes plugins through the org-aware resolver', () => {
      const sync = src('sync/syncTeamPublicProfile.ts')
      assert.ok(
        sync.includes('resolveActivePluginInstalls('),
        'the surface computation must go through the shared resolver'
      )
      // The four LIVENESS probes. `documents` is deliberately excluded: it is a
      // retired plugin whose CONFIG is read as a backfill fallback, not a
      // question about whether a feature is on.
      for (const id of ['website', 'kiosk', 'custom-forms', 'gift-cards']) {
        assert.ok(
          !new RegExp(`INSTALLED_PLUGINS_SUBCOLLECTION}/${id}\``).test(sync),
          `${id} must not be probed on the team path directly — an org install would be invisible`
        )
      }
    })

    it('the resolver has ONE implementation of the precedence rule', () => {
      const plugins = src('utils/plugins.ts')
      const singular = plugins.slice(
        plugins.indexOf('export async function resolveActivePluginInstall('),
        plugins.indexOf('export async function resolveActivePluginInstalls(')
      )
      assert.ok(
        singular.includes('resolveActivePluginInstalls('),
        'the singular form must delegate — an inactive team doc must not veto an active org one, ' +
          'and that rule is too subtle to hold in two places'
      )
      assert.ok(
        !singular.includes('ORG_INSTALLED_PLUGINS_SUBCOLLECTION'),
        'the singular form must not re-implement the org lookup'
      )
    })
  })
})
