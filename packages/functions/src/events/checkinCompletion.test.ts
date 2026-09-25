import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isCheckinCompleted } from '@linyup/shared'

// Table-driven tests for the ONE check-in completion predicate
// (packages/shared/src/utils/checkins.ts), which the server runs in
// addEventCheckin and the client repeats in CheckinPanel — they must never
// disagree about whether a person still has paperwork outstanding.
//
// The exam rows are the point of this file: a level's VALUE may legitimately be
// 0 (every ranking preset's first level is 0 — BJJ White, the Swiss "Krebs",
// HMD "No belt"), so "not examined" has to be the absence of the key. The rest
// pin the arms that must NOT have moved while that one was fixed.
// Run with: pnpm --filter @linyup/functions test

interface Row {
  name: string
  eventType: string
  checkinData?: Record<string, unknown>
  expected: boolean
}

function runRows(rows: Row[]) {
  for (const row of rows) {
    it(row.name, () => {
      assert.equal(isCheckinCompleted(row.eventType, row.checkinData), row.expected)
    })
  }
}

describe('isCheckinCompleted — exam', () => {
  runRows([
    {
      name: 'level 0 is a result: the entry grade completes the check-in',
      eventType: 'exam',
      checkinData: { disciplines: { hmd: 0 } },
      expected: true,
    },
    {
      name: 'level 0 completes even alongside a higher discipline',
      eventType: 'exam',
      checkinData: { disciplines: { hmd: 0, kd: 3 } },
      expected: true,
    },
    {
      name: 'a positive level completes, as it always did',
      eventType: 'exam',
      checkinData: { disciplines: { hmd: 7 } },
      expected: true,
    },
    {
      name: 'an EMPTY disciplines map is nobody examined',
      eventType: 'exam',
      checkinData: { disciplines: {} },
      expected: false,
    },
    {
      name: 'an ABSENT disciplines key is nobody examined',
      eventType: 'exam',
      checkinData: {},
      expected: false,
    },
    {
      name: 'no checkin_data at all is nobody examined',
      eventType: 'exam',
      checkinData: undefined,
      expected: false,
    },
    {
      // The door writes `checkinData: {}` for everyone it admits and asks this
      // to decide whether to promise a second step. Exam must leave one.
      name: 'the base check-in written by the add dialog leaves an exam to finalize',
      eventType: 'exam',
      checkinData: {},
      expected: false,
    },
    {
      // A null slipping in from a form reset is not a result — only a finite
      // number is. Same for a level that arrived as a string.
      name: 'a null level is not a result',
      eventType: 'exam',
      checkinData: { disciplines: { hmd: null } },
      expected: false,
    },
    {
      name: 'a non-numeric level is not a result',
      eventType: 'exam',
      checkinData: { disciplines: { hmd: '0' } },
      expected: false,
    },
    {
      name: 'NaN is not a result',
      eventType: 'exam',
      checkinData: { disciplines: { hmd: Number.NaN } },
      expected: false,
    },
  ])
})

describe('isCheckinCompleted — camp (unchanged)', () => {
  runRows([
    {
      name: 'join_as completes',
      eventType: 'camp',
      checkinData: { join_as: 'participant' },
      expected: true,
    },
    {
      name: 'an empty join_as does not complete',
      eventType: 'camp',
      checkinData: { join_as: '' },
      expected: false,
    },
    {
      name: 'an absent join_as does not complete',
      eventType: 'camp',
      checkinData: {},
      expected: false,
    },
    {
      // Camp asks a different question, so an exam payload answers nothing.
      name: 'disciplines do not stand in for join_as',
      eventType: 'camp',
      checkinData: { disciplines: { hmd: 3 } },
      expected: false,
    },
  ])
})

describe('isCheckinCompleted — default arm (categories, then auto-confirm)', () => {
  runRows([
    {
      name: 'fighting_cup: a picked category completes',
      eventType: 'fighting_cup',
      checkinData: { categories: ['cat-1'] },
      expected: true,
    },
    {
      name: 'fighting_cup: an empty categories array does not complete',
      eventType: 'fighting_cup',
      checkinData: { categories: [] },
      expected: false,
    },
    {
      // The array must be PRESENT to gate: a fighting-cup check-in that has not
      // been through the form yet carries no categories key, and the type
      // collects nothing else, so it auto-confirms. That is the existing
      // behavior, pinned here so the exam fix cannot be read as license to
      // change it.
      name: 'fighting_cup: no categories key at all auto-confirms',
      eventType: 'fighting_cup',
      checkinData: {},
      expected: true,
    },
    {
      name: 'seminar collects nothing, so admission is completion',
      eventType: 'seminar',
      checkinData: {},
      expected: true,
    },
    {
      name: 'competition auto-confirms with no checkin_data',
      eventType: 'competition',
      checkinData: undefined,
      expected: true,
    },
    {
      name: 'an unknown event type auto-confirms',
      eventType: 'whatever_a_plugin_adds',
      checkinData: {},
      expected: true,
    },
    {
      // A DELIBERATE NARROWING, recorded here because it is a behavior change.
      //
      // The rule used to live in core's `default` branch as a bare
      // `Array.isArray(checkinData.categories)`, so it applied to ANY event type
      // that happened to carry that key — a seminar with an empty `categories`
      // array was held pending by the fighting cup's rule. The rules are keyed
      // by event type now, so a plugin's rule reaches its own type and nothing
      // else.
      //
      // Nothing writes `categories` outside the cup's own check-in form, so this
      // is unreachable in practice; it is pinned so the narrowing is a decision
      // somebody made rather than something that quietly stopped happening.
      name: "one plugin's rule does not gate another type that carries its key",
      eventType: 'seminar',
      checkinData: { categories: [] },
      expected: true,
    },
  ])

  it('the fighting-cup shape is no longer written into core', () => {
    // The point of the move: `isCheckinCompleted` knew one tenant-specific
    // plugin's payload. If `categories` reappears in that file, core has learned
    // it again.
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'shared', 'src', 'utils', 'checkins.ts'),
      'utf8'
    )
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ 	]*\/\/.*$/gm, '')
    assert.ok(
      !code.includes('categories'),
      'core reads a plugin payload key again — the rule belongs in PLUGIN_CHECKIN_COMPLETION'
    )
    assert.ok(
      code.includes('PLUGIN_CHECKIN_COMPLETION'),
      'the registry lookup is gone, so plugin rules reach nothing'
    )
  })
})
