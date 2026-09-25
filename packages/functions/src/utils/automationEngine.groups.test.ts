// Unit tests for the add_to_group / remove_from_group automation actions.
//
// Tests cover the two testable layers:
//   1. groupActionUpdate() — pure helper that returns the Firestore update payload;
//      verifies arrayUnion/arrayRemove sentinel selection and the no-op guard.
//   2. hasResolvableActions() — verifies the two new types are recognized as
//      self-contained (core) actions and don't fall through to the plugin path.
//
// These tests run without a Firestore connection.  The actual write path
// (admin.firestore().collection('contacts').doc(id).update(payload)) is
// exercised by the emulator integration tests.

import assert from 'node:assert/strict'
import { FieldValue } from 'firebase-admin/firestore'
import {
  groupActionUpdate,
  hasResolvableActions,
  type AutomationAction,
  type ResolvedActions,
} from './automationEngine'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// No plugin actions in these fixtures, so the install gate is empty — which is
// also the correct default: a plugin action is dispatched only when its plugin
// resolved as active.
const EMPTY_RESOLVED: ResolvedActions = {
  template: null,
  alertPreset: null,
  language: 'en',
  activePlugins: new Set<string>(),
}

// FieldValue sentinels are opaque objects; check their internal _methodName so we
// don't couple to the private shape — just confirm they are the right sentinel type.
function sentinelName(fv: unknown): string {
  // firebase-admin/firestore FieldValue sentinels expose _methodName internally.
  // Fall back to the constructor name when testing in isolation.
  const obj = fv as Record<string, unknown>
  if (typeof obj['_methodName'] === 'string') return obj['_methodName'] as string
  return (fv as object).constructor?.name ?? String(fv)
}

// ---------------------------------------------------------------------------
// 5. groupActionUpdate — pure payload helper
// ---------------------------------------------------------------------------

describe('groupActionUpdate — Firestore payload', () => {
  it('add_to_group returns a payload with group_ids = arrayUnion(group_id)', () => {
    const payload = groupActionUpdate({ type: 'add_to_group', group_id: 'grp-abc' })
    assert.ok(payload, 'payload should not be null')
    const sentinel = payload.group_ids
    // The sentinel must be a FieldValue (arrayUnion)
    assert.ok(sentinel instanceof FieldValue, 'group_ids should be a FieldValue sentinel')
    assert.match(
      sentinelName(sentinel),
      /arrayUnion/i,
      'sentinel should be arrayUnion'
    )
  })

  it('remove_from_group returns a payload with group_ids = arrayRemove(group_id)', () => {
    const payload = groupActionUpdate({ type: 'remove_from_group', group_id: 'grp-xyz' })
    assert.ok(payload, 'payload should not be null')
    const sentinel = payload.group_ids
    assert.ok(sentinel instanceof FieldValue, 'group_ids should be a FieldValue sentinel')
    assert.match(
      sentinelName(sentinel),
      /arrayRemove/i,
      'sentinel should be arrayRemove'
    )
  })

  it('returns null (no-op) when group_id is an empty string', () => {
    // Cast via unknown to exercise the runtime guard without a TS error
    // (group_id: string allows '' at the type level; the runtime guard rejects it)
    const payload = groupActionUpdate(
      { type: 'add_to_group', group_id: '' } as unknown as { type: 'add_to_group'; group_id: string }
    )
    assert.equal(payload, null)
  })

  it('add_to_group and remove_from_group produce different sentinel types', () => {
    const add = groupActionUpdate({ type: 'add_to_group', group_id: 'g1' })!
    const remove = groupActionUpdate({ type: 'remove_from_group', group_id: 'g1' })!
    assert.notDeepEqual(add.group_ids, remove.group_ids)
  })
})

// ---------------------------------------------------------------------------
// 6. hasResolvableActions — new types are recognized as core (not plugin path)
// ---------------------------------------------------------------------------

describe('hasResolvableActions — add_to_group / remove_from_group', () => {
  it('returns true for a sole add_to_group action (self-contained, no template needed)', () => {
    const actions: AutomationAction[] = [{ type: 'add_to_group', group_id: 'g1' }]
    assert.equal(hasResolvableActions(actions, EMPTY_RESOLVED), true)
  })

  it('returns true for a sole remove_from_group action (self-contained)', () => {
    const actions: AutomationAction[] = [{ type: 'remove_from_group', group_id: 'g1' }]
    assert.equal(hasResolvableActions(actions, EMPTY_RESOLVED), true)
  })

  it('returns false when the only action is send_email with no resolved template', () => {
    const actions: AutomationAction[] = [{ type: 'send_email', templateId: 'tmpl-1' }]
    assert.equal(hasResolvableActions(actions, EMPTY_RESOLVED), false)
  })

  it('returns true when add_to_group is present alongside an unresolvable send_email', () => {
    const actions: AutomationAction[] = [
      { type: 'send_email', templateId: 'tmpl-1' },
      { type: 'add_to_group', group_id: 'g1' },
    ]
    assert.equal(hasResolvableActions(actions, EMPTY_RESOLVED), true)
  })

  it('returns true when remove_from_group is present alongside an unresolvable send_email', () => {
    const actions: AutomationAction[] = [
      { type: 'send_email', templateId: 'tmpl-1' },
      { type: 'remove_from_group', group_id: 'g1' },
    ]
    assert.equal(hasResolvableActions(actions, EMPTY_RESOLVED), true)
  })
})
