import assert from 'node:assert/strict'
import {
  rankEligibility,
  promotionReadiness,
  addDuration,
  monthsBetween,
  type ParticipationFact,
  type RankFactsSnapshot,
  type RankProgression,
  type RankingSystem,
} from '@linyup/shared'

// Fixtures for THE rank-progression evaluator.
//
// The evaluator never promotes and never refuses — it reports a checklist — so
// what these tests pin is the ARITHMETIC and the three-valued answer, not any
// notion of permission.
//
// Run with: pnpm --filter @linyup/functions test

const MONTH = 'months' as const

/** A scale whose ids are named after numbers that are deliberately NOT
 *  contiguous, so anything assuming `next = current + 1` fails here rather
 *  than in front of a customer. Levels are named by id and ordered by
 *  position; there is no number on a level at all (Phase 4). */
const SYSTEM: RankingSystem = {
  id: 'test',
  name: 'Test scale',
  is_primary: true,
  levels: [
    { id: 'none', label: 'None' },
    { id: 'one', label: 'One' },
    { id: 'two', label: 'Two' },
    { id: 'five', label: 'Five' },
  ],
}

const NOW = Date.UTC(2026, 7, 19) // 2026-08-19

function monthsAgo(n: number): number {
  return addDuration(NOW, -n, MONTH)
}

function facts(over: Partial<RankFactsSnapshot> = {}): RankFactsSnapshot {
  return {
    nowMs: NOW,
    ranks: { test: 'one' },
    participation: [],
    examsAtMs: [],
    ...over,
  }
}

function part(eventType: string, monthsBack: number, over: Partial<ParticipationFact> = {}): ParticipationFact {
  return {
    eventId: `${eventType}-${monthsBack}`,
    eventType,
    atMs: monthsAgo(monthsBack),
    role: 'participant',
    ...over,
  }
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

describe('duration arithmetic is whole-month and clamps', () => {
  it('31 Jan + 1 month is the end of February, not early March', () => {
    const jan31 = Date.UTC(2026, 0, 31)
    assert.equal(new Date(addDuration(jan31, 1, MONTH)).toISOString().slice(0, 10), '2026-02-28')
  })

  it('a 29 February exam lands on 28 February in a common year', () => {
    const leap = Date.UTC(2024, 1, 29)
    assert.equal(new Date(addDuration(leap, 12, MONTH)).toISOString().slice(0, 10), '2025-02-28')
  })

  it('monthsBetween floors, and never goes negative', () => {
    assert.equal(monthsBetween(Date.UTC(2026, 0, 15), Date.UTC(2026, 2, 14)), 1)
    assert.equal(monthsBetween(Date.UTC(2026, 0, 15), Date.UTC(2026, 2, 15)), 2)
    assert.equal(monthsBetween(Date.UTC(2026, 5, 1), Date.UTC(2026, 0, 1)), 0)
  })
})

// ─── The shape of the answer ──────────────────────────────────────────────────

describe('the evaluator distinguishes no-rule from not-eligible', () => {
  const empty: RankProgression = { id: 'test', rules: [] }

  it('a level the organisation set no rule for is NOT_CONFIGURED, never a refusal', () => {
    const r = rankEligibility({ progression: empty, system: SYSTEM, facts: facts() })
    assert.equal(r.eligibility, 'not_configured')
    assert.equal(r.targetLevel, 'two', 'the next level is read from the scale, by identity')
    assert.deepEqual(r.missing, [])
  })

  it('no progression document at all is also NOT_CONFIGURED', () => {
    const r = rankEligibility({ progression: null, system: SYSTEM, facts: facts() })
    assert.equal(r.eligibility, 'not_configured')
  })

  it('the top of the scale is AT_TOP', () => {
    const r = rankEligibility({ progression: empty, system: SYSTEM, facts: facts({ ranks: { test: 'five' } }) })
    assert.equal(r.eligibility, 'at_top')
    assert.equal(r.targetLevel, null)
  })

  it('the next level is the next VALUE in the scale, not current + 1', () => {
    const r = rankEligibility({ progression: empty, system: SYSTEM, facts: facts({ ranks: { test: 'two' } }) })
    assert.equal(r.targetLevel, 'five', 'a gap in the numbering is not a level nobody defined')
  })

  it('an unranked contact is measured against the FIRST level', () => {
    const r = rankEligibility({ progression: empty, system: SYSTEM, facts: facts({ ranks: {} }) })
    assert.equal(r.currentLevel, null)
    assert.equal(r.targetLevel, 'none')
  })
})

describe('an unmeasurable requirement is UNKNOWN, never a pass and never a fail', () => {
  const timed: RankProgression = {
    id: 'test',
    rules: [{ from: 'two', to: 'two', requirements: [{ id: 't', kind: 'time_since_previous_exam', amount: 6, unit: MONTH }] }],
  }

  it('no exam history means we cannot measure time since the previous exam', () => {
    const r = rankEligibility({ progression: timed, system: SYSTEM, facts: facts({ examsAtMs: [] }) })
    assert.equal(r.eligibility, 'unknown')
    assert.equal(r.requirements[0].reason, 'no_exam_history')
    assert.equal(r.eligibleFromMs, null, 'no date may be offered from an unknown')
  })

  it('an unregistered plugin requirement is unknown, not silently satisfied', () => {
    const p: RankProgression = {
      id: 'test',
      rules: [{ from: 'two', to: 'two', requirements: [{ id: 'x', kind: 'plugin:nobody:thing' }] }],
    }
    const r = rankEligibility({ progression: p, system: SYSTEM, facts: facts() })
    assert.equal(r.eligibility, 'unknown')
    assert.equal(r.requirements[0].reason, 'no_resolver')
  })

  it('an advisory requirement is reported but never blocks', () => {
    const p: RankProgression = {
      id: 'test',
      rules: [
        {
          from: 'two',
          to: 'two',
          requirements: [
            { id: 'note', kind: 'sessions_attended', min: 100, since: 'always', advisory: true },
          ],
        },
      ],
    }
    const r = rankEligibility({ progression: p, system: SYSTEM, facts: facts({ sessionsAttended: 3 }) })
    assert.equal(r.eligibility, 'eligible')
    assert.deepEqual(r.missing, [], 'advisory requirements never appear in `missing`')
    assert.equal(r.requirements[0].status, 'unmet', 'but it is still reported')
  })
})

describe('time requirements', () => {
  const timed: RankProgression = {
    id: 'test',
    rules: [{ from: 'two', to: 'two', requirements: [{ id: 't', kind: 'time_since_previous_exam', amount: 6, unit: MONTH }] }],
  }

  it('short of the deadline reports how many months remain, and WHEN', () => {
    const r = rankEligibility({ progression: timed, system: SYSTEM, facts: facts({ examsAtMs: [monthsAgo(2)] }) })
    assert.equal(r.eligibility, 'not_eligible')
    assert.equal(r.requirements[0].reasonData?.months, 4)
    assert.equal(
      new Date(r.eligibleFromMs as number).toISOString().slice(0, 10),
      new Date(addDuration(monthsAgo(2), 6, MONTH)).toISOString().slice(0, 10),
      'time is the only thing outstanding, so a date is knowable',
    )
  })

  it('past the deadline is met', () => {
    const r = rankEligibility({ progression: timed, system: SYSTEM, facts: facts({ examsAtMs: [monthsAgo(7)] }) })
    assert.equal(r.eligibility, 'eligible')
  })

  it('the anchor is the MOST RECENT exam, not the first', () => {
    const r = rankEligibility({
      progression: timed,
      system: SYSTEM,
      facts: facts({ examsAtMs: [monthsAgo(40), monthsAgo(1)] }),
    })
    assert.equal(r.eligibility, 'not_eligible')
  })
})

describe('participation requirements', () => {
  const rule: RankProgression = {
    id: 'test',
    rules: [
      {
        from: 'two',
        to: 'two',
        requirements: [
          {
            id: 'camp',
            kind: 'event_participation',
            since: 'previous_exam',
            spec: { eventTypes: ['camp'], min: 1 },
          },
        ],
      },
    ],
  }

  it('counts only what happened since the anchor', () => {
    const before = rankEligibility({
      progression: rule,
      system: SYSTEM,
      facts: facts({ examsAtMs: [monthsAgo(6)], participation: [part('camp', 10)] }),
    })
    assert.equal(before.eligibility, 'not_eligible', 'a camp before the last exam does not count')

    const after = rankEligibility({
      progression: rule,
      system: SYSTEM,
      facts: facts({ examsAtMs: [monthsAgo(6)], participation: [part('camp', 3)] }),
    })
    assert.equal(after.eligibility, 'eligible')
  })

  it('SUPPORT counts the same as taking part, because `roles` is omitted', () => {
    const r = rankEligibility({
      progression: rule,
      system: SYSTEM,
      facts: facts({
        examsAtMs: [monthsAgo(6)],
        participation: [part('camp', 3, { role: 'volunteer' })],
      }),
    })
    assert.equal(r.eligibility, 'eligible', 'omitting roles is how "actively or as support" is written')
  })

  it('a club CAN demand participants only, by naming the role', () => {
    const strict: RankProgression = {
      id: 'test',
      rules: [
        {
          from: 'two',
          to: 'two',
          requirements: [
            {
              id: 'camp',
              kind: 'event_participation',
              since: 'previous_exam',
              spec: { eventTypes: ['camp'], min: 1, roles: ['participant'] },
            },
          ],
        },
      ],
    }
    const r = rankEligibility({
      progression: strict,
      system: SYSTEM,
      facts: facts({ examsAtMs: [monthsAgo(6)], participation: [part('camp', 3, { role: 'staff' })] }),
    })
    assert.equal(r.eligibility, 'not_eligible')
  })

  it('several event types in one spec are ONE bucket — cup, tournament, competition', () => {
    const bucket: RankProgression = {
      id: 'test',
      rules: [
        {
          from: 'two',
          to: 'two',
          requirements: [
            {
              id: 'tourn',
              kind: 'event_participation',
              since: 'previous_exam',
              spec: { eventTypes: ['competition', 'hmd_fighting_cup'], min: 1 },
            },
          ],
        },
      ],
    }
    const r = rankEligibility({
      progression: bucket,
      system: SYSTEM,
      facts: facts({ examsAtMs: [monthsAgo(6)], participation: [part('hmd_fighting_cup', 2)] }),
    })
    assert.equal(r.eligibility, 'eligible', 'core needs no notion of synonymy — the list is the bucket')
  })

  it('THE GRADING OCCASION NEVER COUNTS — not for this grade and not for the next', () => {
    const r = rankEligibility({
      progression: rule,
      system: SYSTEM,
      facts: facts({
        examsAtMs: [monthsAgo(6)],
        participation: [part('camp', 6, { isGradingOccasion: true })],
      }),
    })
    assert.equal(
      r.eligibility,
      'not_eligible',
      'the camp hosting a dan exam would otherwise hand every candidate a requirement for free',
    )
  })
})

describe('qualifying years — a year that does not count stretches the clock', () => {
  const ONE_ONE_ONE = [
    { eventTypes: ['camp'], min: 1 },
    { eventTypes: ['competition'], min: 1 },
    { eventTypes: ['exam'], min: 1 },
  ]
  const rule: RankProgression = {
    id: 'test',
    rules: [
      {
        from: 'two',
        to: 'two',
        requirements: [{ id: 'years', kind: 'qualifying_years', minYears: 2, perYear: ONE_ONE_ONE }],
      },
    ],
  }

  /** A full 1-1-1 inside the window that starts `startMonthsAgo` back. */
  function fullYear(startMonthsAgo: number): ParticipationFact[] {
    return [
      part('camp', startMonthsAgo - 1),
      part('competition', startMonthsAgo - 4),
      part('exam', startMonthsAgo - 8),
    ]
  }

  it('two complete years qualify', () => {
    const r = rankEligibility({
      progression: rule,
      system: SYSTEM,
      facts: facts({ examsAtMs: [monthsAgo(24)], participation: [...fullYear(24), ...fullYear(12)] }),
    })
    assert.equal(r.eligibility, 'eligible')
    assert.equal(r.requirements[0].progress.have, 2)
  })

  it('a year missing its tournament does not count, even though the time passed', () => {
    const r = rankEligibility({
      progression: rule,
      system: SYSTEM,
      facts: facts({
        examsAtMs: [monthsAgo(24)],
        participation: [...fullYear(24), part('camp', 11), part('exam', 8)],
      }),
    })
    assert.equal(r.eligibility, 'not_eligible')
    assert.equal(r.requirements[0].progress.have, 1)
    assert.equal(r.requirements[0].reasonData?.short, 1)
  })

  it('an incomplete trailing window is not counted at all', () => {
    const r = rankEligibility({
      progression: rule,
      system: SYSTEM,
      facts: facts({ examsAtMs: [monthsAgo(18)], participation: [...fullYear(18), ...fullYear(6)] }),
    })
    assert.equal(r.requirements[0].progress.have, 1, 'only one full 12-month window has elapsed')
  })

  it('the per-window breakdown says WHICH year is short', () => {
    const r = rankEligibility({
      progression: rule,
      system: SYSTEM,
      facts: facts({
        examsAtMs: [monthsAgo(24)],
        participation: [...fullYear(24), part('camp', 11)],
      }),
    })
    const windows = r.requirements[0].progress.detail as Array<{ qualifies: boolean; missing: string[] }>
    assert.equal(windows.length, 2)
    assert.equal(windows[0].qualifies, true)
    assert.equal(windows[1].qualifies, false)
    assert.ok(windows[1].missing.length > 0, 'the UI needs to name what the year lacked')
  })
})

describe('promotion readiness is a SECOND gate, asked later', () => {
  const withDelay: RankProgression = {
    id: 'test',
    rules: [
      {
        from: 'two',
        to: 'two',
        requirements: [],
        promotionDelay: {
          amount: 12,
          unit: MONTH,
          requirements: [
            {
              id: 'probation-camp',
              kind: 'event_participation',
              since: 'previous_exam',
              spec: { eventTypes: ['camp'], min: 1 },
            },
          ],
        },
      },
    ],
  }

  it('a band with no delay is ready at the exam', () => {
    const none: RankProgression = { id: 'test', rules: [{ from: 'two', to: 'two', requirements: [] }] }
    const r = promotionReadiness({
      progression: none,
      system: SYSTEM,
      facts: facts(),
      examinedLevel: 'two',
      examAtMs: NOW,
    })
    assert.equal(r.eligibility, 'eligible')
  })

  it('before the year is up it is not ready, and the date is knowable', () => {
    const r = promotionReadiness({
      progression: withDelay,
      system: SYSTEM,
      facts: facts({ examsAtMs: [monthsAgo(5)], participation: [part('camp', 2)] }),
      examinedLevel: 'two',
      examAtMs: monthsAgo(5),
    })
    assert.equal(r.eligibility, 'not_eligible')
    assert.deepEqual(r.missing, ['probation'])
    assert.ok(r.eligibleFromMs != null)
  })

  it('the year elapsing is not enough — it must itself have counted', () => {
    const r = promotionReadiness({
      progression: withDelay,
      system: SYSTEM,
      facts: facts({ examsAtMs: [monthsAgo(13)], participation: [] }),
      examinedLevel: 'two',
      examAtMs: monthsAgo(13),
    })
    assert.equal(r.eligibility, 'not_eligible')
    assert.deepEqual(r.missing, ['probation-camp'])
    assert.equal(r.eligibleFromMs, null, 'waiting will not fix a missing camp')
  })

  it('elapsed AND qualifying is ready', () => {
    const r = promotionReadiness({
      progression: withDelay,
      system: SYSTEM,
      facts: facts({ examsAtMs: [monthsAgo(13)], participation: [part('camp', 4)] }),
      examinedLevel: 'two',
      examAtMs: monthsAgo(13),
    })
    assert.equal(r.eligibility, 'eligible')
  })
})
