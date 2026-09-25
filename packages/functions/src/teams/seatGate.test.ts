import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  MULTIPLE_USERS_PLAN_REFUSAL,
  minimumPlanForFeature,
  planHasFeature,
  PLAN_ORDER,
} from '@linyup/shared'

// EVERY SEAM THAT CAN PUT A SECOND USER ON A TEAM IS GATED — re-derived from the
// source, not listed by hand.
//
// A second user is a Studio feature (`multiple_managers`). A client-side gate on
// an invite button is not a gate: `manageTeamMember` action 'add' has no UI at
// all, and an invitation link outlives the plan that issued it by up to seven
// days. So the rule is structural — a file that can create a `team_members` doc
// must also refuse when the plan cannot hold one — and this test rediscovers the
// call sites so a NEW one that forgets the gate fails the build rather than
// shipping a hole.

const SRC = path.join(__dirname, '..')

/**
 * Line endings normalized. The working tree is checked out LF on CI and CRLF on
 * Windows, and the assertions below slice source on newline markers: without
 * this, indexOf of a newline-brace-newline sequence returns -1 against a CRLF
 * file, the slice silently collapses to two characters, and the gate assertion
 * fails on Windows while passing on CI. Same guard, same reason, as
 * connect/commitSites.test.ts.
 */
function readSource(full: string): string {
  return fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n')
}

function readTs(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...readTs(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push({ file: path.relative(SRC, full).replace(/\\/g, '/'), text: readSource(full) })
    }
  }
  return out
}

const FILES = readTs(SRC)
const GATE = 'requireExtraUserPlan('

// utils/teams.ts holds BOTH the gate itself and `createTeamRecord`, which seats
// the team's first owner — the one membership that exists before any plan does.
const EXEMPT = new Set(['utils/teams.ts'])

describe('a second team user is a plan feature — the server seams', () => {
  it('every file that can create a team_members doc calls the gate', () => {
    const creators = FILES.filter(
      (f) => f.text.includes('addTeamMember(') && !EXEMPT.has(f.file)
    ).map((f) => f.file)

    // Named, not counted: the list is checkable by reading it, and a new file
    // simply joins it.
    assert.deepEqual(
      creators.sort(),
      ['teams/acceptTeamInvitation.ts', 'teams/manageTeamMember.ts'],
      'a new member-creating file appeared — gate it, then add it here'
    )
    for (const file of creators) {
      const text = FILES.find((f) => f.file === file)!.text
      assert.ok(text.includes(GATE), `${file} creates a member without ${GATE}`)
    }
  })

  it('the invitation seam is gated too — it commits the seat before the acceptor exists', () => {
    const invite = FILES.find((f) => f.file === 'teams/sendTeamInvitation.ts')!
    assert.ok(invite.text.includes(GATE))
  })

  it('the gate is on ADDING — managing existing members stays open', () => {
    const src = FILES.find((f) => f.file === 'teams/manageTeamMember.ts')!.text
    assert.equal(
      src.split(GATE).length - 1,
      1,
      'exactly one gate in manageTeamMember, and it belongs to the add case'
    )
    const gateAt = src.indexOf(GATE)
    assert.ok(gateAt > src.indexOf("case 'add'"))
    assert.ok(gateAt < src.indexOf("case 'remove'"), "'remove' must not be gated")
    assert.ok(gateAt < src.indexOf("case 'updateRole'"), "'updateRole' must not be gated")
    assert.ok(gateAt < src.indexOf("case 'setCoach'"), "'setCoach' must not be gated")
  })

  it('nothing removes or demotes a member because of the plan', () => {
    // The other half of "adding, not being": if a downgrade ever starts deleting
    // memberships, this is where the contradiction surfaces.
    const downgrade = FILES.find((f) => f.file === 'saas-billing/downgrade.ts')!.text
    assert.equal(downgrade.includes('team_members'), false)
    assert.equal(downgrade.includes('removeTeamMember'), false)
  })

  it('the refusal is the shared code, and the old free-plan code is gone', () => {
    assert.equal(MULTIPLE_USERS_PLAN_REFUSAL, 'multiple-users-plan-required')
    for (const f of FILES) {
      assert.equal(
        f.text.includes('free-plan-single-user'),
        false,
        `${f.file} still throws the superseded free-plan refusal`
      )
    }
  })

  it('the CLIENT-SIDE seam refuses on the same tier — firestore.rules, pinned to the flag', () => {
    // The seam no callable can defend: an owner writing a
    // `team_members` doc for somebody else straight from the client. The rules
    // cannot import PLAN_FEATURES, so the tier list is a literal — which is
    // exactly why it is pinned here.
    const rules = readSource(path.join(SRC, '../../../firestore.rules'))
    const block = rules.slice(rules.indexOf('match /team_members/{memberId}'))
    const write = block.slice(block.indexOf('allow write:'))
    const clause = write.slice(0, write.indexOf(';') + 1)
    assert.ok(clause.includes('team_members') === false && clause.length < 900)

    const granted = PLAN_ORDER.filter((p) => planHasFeature(p, 'multiple_managers'))
    const denied = PLAN_ORDER.filter((p) => !planHasFeature(p, 'multiple_managers'))
    const marker = "'plan', 'free') in ["
    assert.ok(clause.includes(marker), 'the plan check moved — re-derive this test')
    // From AFTER the marker: `get('plan', 'free')` names the DEFAULT, and reading
    // it as a member of the allow-list would report free as permitted.
    const listed = clause.slice(clause.indexOf(marker) + marker.length)
    const list = listed.slice(0, listed.indexOf(']'))

    for (const plan of granted) {
      assert.ok(list.includes(`'${plan}'`), `firestore.rules must allow ${plan}`)
    }
    for (const plan of denied) {
      assert.equal(list.includes(`'${plan}'`), false, `firestore.rules must refuse ${plan}`)
    }
  })

  it('the gate reads the FLAG, so it cannot drift from PLAN_FEATURES again', () => {
    // The contradiction this closed (UX-42): PLAN_FEATURES said studio while the
    // members page unlocked at coach. Nothing in the gate names a tier.
    const util = FILES.find((f) => f.file === 'utils/teams.ts')!.text
    const gateBody = util.slice(util.indexOf('export async function requireExtraUserPlan'))
    const body = gateBody.slice(0, gateBody.indexOf('\n}\n') + 3)
    assert.ok(body.includes("planHasFeature(plan, 'multiple_managers')"))
    assert.equal(/'studio'|'organization'/.test(body), false, 'no tier literal in the gate')

    assert.equal(minimumPlanForFeature('multiple_managers'), 'studio')
    assert.equal(planHasFeature('coach', 'multiple_managers'), false)
    assert.equal(planHasFeature('studio', 'multiple_managers'), true)
  })
})
