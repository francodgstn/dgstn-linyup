// The subscription-type scope has to be honored by everything that OFFERS it.
//
// It spans the functions/web boundary for the same reason connect/commitSites.test.ts
// and automation/delayedRules.test.ts do: that boundary is where corrections stop
// traveling. `subscription_cancel_requested` shipped emitting a subscriptionTypeId
// delta that `fireEventRules` never matched on, so a rule narrowed to one plan fired
// when any plan was canceled. Nothing typed catches that — the delta field is
// optional, the branch is a valid boolean expression, and the rule fires; it is only
// the NARROWING that is missing. It was found by driving the emulator.
//
// Run with: pnpm --filter @linyup/functions test

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')
const ROOT = join(SRC, '..', '..', '..')
const PAGE = join(
  ROOT,
  'apps',
  'web',
  'src',
  'app',
  '[locale]',
  '(auth)',
  'automations',
  'page.tsx'
)

/** Every trigger whose delta carries a subscriptionTypeId. Named, never counted. */
const SUBSCRIPTION_SCOPED = [
  'subscription_added',
  'subscription_removed',
  'subscription_cancel_requested',
]

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

/** A fixed window forward from the branch's own comment. Deliberately not "up to the
 *  affiliation branch": that phrase also appears in the AutomationRule docblock
 *  hundreds of lines earlier, indexOf finds THAT one, and the slice comes back empty —
 *  at which point every assertion below passes on nothing. */
function scopingBranch(): string {
  const src = read(join(SRC, 'utils', 'automationEngine.ts'))
  const at = src.indexOf('Delta scoping for the subscription-type family')
  assert.notEqual(at, -1, 'the subscription-type scoping branch was renamed or removed')
  return src.slice(at, at + 900)
}

describe('the subscription-type scope — engine and builder agree', () => {
  it('the engine narrows on subscriptionTypeId for every trigger that carries it', () => {
    const branch = scopingBranch()
    assert.ok(branch.includes('rule.trigger.subscriptionTypeId !== delta?.subscriptionTypeId'))
    for (const t of SUBSCRIPTION_SCOPED) {
      assert.ok(branch.includes(`'${t}'`), `${t} is not narrowed by the engine`)
    }
  })

  it('the builder offers the subscription-type select for exactly those triggers', () => {
    const page = read(PAGE)
    const at = page.indexOf('const SUBSCRIPTION_SCOPED_TRIGGERS')
    assert.notEqual(at, -1, 'the builder no longer names its subscription-scoped triggers')
    // From the OPENING bracket of the array literal, not from the declaration: the
    // first `]` after the name belongs to the `string[]` annotation, and slicing to
    // that one returns a window with no members in it.
    const open = page.indexOf('= [', at) + 2
    const list = page.slice(open, page.indexOf(']', open))
    for (const t of SUBSCRIPTION_SCOPED) {
      assert.ok(list.includes(`'${t}'`), `${t} is not offered the select`)
    }
    // …and the list is used to gate BOTH the control and the save, not just one of
    // them: a select that renders and is then dropped on submit is the same defect
    // wearing different clothes.
    assert.ok(page.includes('SUBSCRIPTION_SCOPED_TRIGGERS.includes(triggerType)'))
    assert.ok(page.includes('SUBSCRIPTION_SCOPED_TRIGGERS.includes(values.trigger_type)'))
  })

  it('and the engine check is capable of failing', () => {
    assert.ok(!scopingBranch().includes("'subscription_paused'"))
  })
})
