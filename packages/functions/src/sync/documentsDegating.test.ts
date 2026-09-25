import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  publicPagesIndexable,
  resolveSignupDocumentIds,
  type SaasPlan,
} from '@linyup/shared'

// Documents stopped being a plugin (Wave 3 Phase 4, §6). Three things about that
// change are invisible at a glance and expensive to get wrong, so they are pinned
// here rather than left to review:
//
//   1. Public document pages exist on every tier, so `noindex` is what stops a
//      free signup borrowing the domain's search standing. The predicate that
//      decides it has to refuse a TRIAL, which is the tier every throwaway
//      account lands on.
//   2. The signup-consent config moved, and both readers go through one helper.
//   3. Nothing tears down a team's document mirrors any more — a plan change must
//      not delete the public copy of a document a booking gate points at.

describe('publicPagesIndexable', () => {
  const cases: Array<[{ plan?: SaasPlan | null; plan_status?: string | null }, boolean, string]> = [
    [{ plan: 'free', plan_status: 'active' }, false, 'free is never indexable'],
    [{ plan: 'coach', plan_status: 'active' }, true, 'a paying coach is'],
    [{ plan: 'studio', plan_status: 'active' }, true, 'a paying studio is'],
    [{ plan: 'organization', plan_status: 'active' }, true, 'a paying organization is'],
    // THE case the whole guard turns on: self-service signups are provisioned
    // studio/trial, so keying on the plan alone would leave the spam vector open
    // for the length of a trial — and a page only has to be crawled once.
    [{ plan: 'studio', plan_status: 'trial' }, false, 'a trial is NOT a paid tier'],
    [{ plan: 'studio', plan_status: 'expired' }, false, 'a lapsed trial is refused before the cron'],
    [{ plan: 'studio', plan_status: 'past_due' }, false, 'an unpaid invoice is not paying'],
    [{ plan: 'studio', plan_status: 'cancelled' }, false, 'a canceled plan is not paying'],
    // Fail closed on anything unknown.
    [{}, false, 'a team with no plan fields at all'],
    [{ plan: null, plan_status: null }, false, 'explicit nulls'],
  ]

  for (const [team, expected, why] of cases) {
    it(why, () => {
      assert.equal(publicPagesIndexable(team), expected)
    })
  }
})

describe('resolveSignupDocumentIds', () => {
  it('prefers the new settings location', () => {
    assert.deepEqual(
      resolveSignupDocumentIds({
        settings: { signupDocumentIds: ['a'] },
        legacyPluginConfig: { signupDocumentIds: ['b'] },
      }),
      ['a']
    )
  })

  it('falls back to the retired plugin config for an un-migrated team', () => {
    assert.deepEqual(
      resolveSignupDocumentIds({ settings: null, legacyPluginConfig: { signupDocumentIds: ['b'] } }),
      ['b']
    )
  })

  it('treats an EMPTY new selection as authoritative — clearing must not resurrect the old list', () => {
    assert.deepEqual(
      resolveSignupDocumentIds({
        settings: { signupDocumentIds: [] },
        legacyPluginConfig: { signupDocumentIds: ['b'] },
      }),
      []
    )
  })

  it('is empty when neither location has anything', () => {
    assert.deepEqual(resolveSignupDocumentIds({}), [])
  })

  it('drops non-string entries rather than trusting stored data', () => {
    assert.deepEqual(
      resolveSignupDocumentIds({
        settings: { signupDocumentIds: ['a', 1 as unknown as string, '', 'c'] },
      }),
      ['a', 'c']
    )
  })
})

describe('the documents teardown is gone', () => {
  const root = join(__dirname, '..')

  it('no code deletes a team\'s document mirrors in bulk', () => {
    // Read the SOURCE rather than assert it in prose: the helper existed to run
    // on plugin deactivation, which downgradeTeamToFree triggers for every lapsed
    // team, and under a waiver gate that deleted the public copy of a document a
    // booking gate points at.
    for (const rel of ['utils/plugins.ts', 'sync/onInstalledPluginStatusChange.ts']) {
      const src = readFileSync(join(root, rel), 'utf8')
      const live = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
      assert.ok(
        !live.includes('deleteAllDocumentPublicProfiles'),
        `${rel} still references deleteAllDocumentPublicProfiles`
      )
    }
  })

  it('the surface probe reads MIRRORS, not the root documents collection', () => {
    // A downgraded team still HAS its documents; only the mirrors were deleted.
    // Probing the root collection would flip the surface live again on the next
    // unrelated team write, over a page that renders empty — and offer it as a
    // default landing surface.
    const src = readFileSync(join(root, 'sync/syncTeamPublicProfile.ts'), 'utf8').replace(/\s+/g, ' ')
    assert.ok(src.includes("collectionGroup('public_profile')"))
    assert.ok(src.includes("where('type', '==', 'document')"))
    // The install gate is gone entirely — not merely bypassed.
    assert.ok(!src.includes('documentsPluginActive'), 'the plugin probe must be gone')
  })

  it('the signup-consent save NUDGES the team doc, or the mirror never recomputes', () => {
    // The defect this pins: `signup_documents` on the public profile is the ONLY
    // thing the public signup form reads, and it is computed by
    // syncTeamPublicProfile — which triggers on `teams/{teamId}`. NOTHING
    // triggers on `teams/{teamId}/settings/{settingId}`. So when the consent
    // config moved out of installed_plugins (whose trigger touched the team on
    // every write), a save stopped reaching the mirror: the form rendered its
    // fallback sentence with no link to the studio's Terms, and since it echoes
    // back only what it displayed, recordSignupConsent wrote ZERO acceptance
    // rows. Silent, unbounded, and the missed rows are not recoverable.
    // Normalize line endings before slicing. This test isolates the function
    // body by looking for a closing brace at column 0, and `core.autocrlf` gives
    // every Windows checkout CRLF — so the LF-only needle missed, the slice
    // collapsed to an empty string, and the assertion below failed against
    // nothing while the source was correct all along. A source-reading test has
    // to read the source the way it is on disk, not the way CI happens to store it.
    const hooks = readFileSync(
      join(root, '../../../apps/web/src/plugins/documents/hooks.ts'),
      'utf8'
    ).replace(/\r\n/g, '\n')
    const save = hooks.slice(hooks.indexOf('export async function saveSignupDocumentIds'))
    const body = save.slice(0, save.indexOf('\n}\n') + 1)
    assert.ok(
      body.includes('surfaces_updated_at'),
      'saveSignupDocumentIds must stamp surfaces_updated_at on the team doc — writing only ' +
        'the settings doc leaves TeamPublicProfile.signup_documents stale forever'
    )
    assert.ok(
      /batch\.set\(\s*doc\(db, TEAMS_COLLECTION, teamId\)/.test(body),
      'the nudge must target the TEAM document — that is the only path syncTeamPublicProfile ' +
        'triggers on'
    )
    assert.ok(
      body.includes('writeBatch(db)') && body.includes('batch.commit()'),
      'both writes must be atomic, or a partial save reproduces the original silent staleness'
    )
  })

  it('the public profile carries the indexability flag the crawler path reads', () => {
    const src = readFileSync(join(root, 'sync/syncTeamPublicProfile.ts'), 'utf8')
    // Denormalised because the pages that need it read public_profile alone. If
    // this stops being written, every page silently falls back to `noindex` —
    // which is the safe direction, and still a bug worth failing on.
    assert.ok(src.includes('public_pages_indexable'))
    assert.ok(src.includes('publicPagesIndexable('))
  })
})
