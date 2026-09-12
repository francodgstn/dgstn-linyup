// THE SEED CONTRACT — the four rules at `PLUGIN_SEEDS`, made executable.
//
// Three of the four are behavioural and pinned by `seedShouldWrite` below. The
// fourth (a seed never touches a tenant's own collections) is a claim about the
// applier's reach, so it is checked by reading the source: a seeder that learns
// to write `contacts` is a different and much more dangerous thing than the one
// documented.

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PLUGIN_SEEDS, pluginSeeds } from '@linyup/shared'
import { seedShouldWrite } from './seeds'

describe('a seed converges, and never reverts a human', () => {
  it('an absent document is written', () => {
    assert.equal(seedShouldWrite(undefined, 1), true)
  })

  it('the same version is not rewritten — this is what makes a retry cost nothing', () => {
    assert.equal(seedShouldWrite({ seed_version: 1 }, 1), false)
  })

  it('a newer version overwrites an older one', () => {
    assert.equal(seedShouldWrite({ seed_version: 1 }, 2), true)
  })

  it('a document with no recorded version is treated as version 0', () => {
    // Hand-written, or laid down before the field existed. Seeding it is the
    // right answer: the plugin's content is what the tenant asked for by
    // installing it, and nobody has claimed the document yet.
    assert.equal(seedShouldWrite({}, 1), true)
  })

  it("A HUMAN'S EDIT WINS, at any version, forever", () => {
    // The rule that matters most. A federation that tuned its own ladder must
    // not have it reverted by a deploy — and merging is not an option, because
    // it would make "which rule applied to this grading" stop having one answer.
    assert.equal(seedShouldWrite({ seed_version: 1, updated_by: 'uid' }, 2), false)
    assert.equal(seedShouldWrite({ updated_by: 'uid' }, 99), false)
  })
})

describe("the applier stays inside the plugin's own model", () => {
  const src = readFileSync(join(__dirname, 'seeds.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  it('writes only rank_progressions, and only under the tenant it was called for', () => {
    // RULE 4. A seeder that can reach `contacts`, `sessions` or anything
    // money-shaped is a different and far more dangerous thing than the one
    // documented at PLUGIN_SEEDS.
    for (const forbidden of ['contacts', 'sessions', 'bookings', 'member_payments', 'invoices']) {
      assert.ok(
        !code.includes(`'${forbidden}'`),
        `the seeder reaches ${forbidden} — a seed may only write the plugin's own model`
      )
    }
    assert.ok(code.includes('RANK_PROGRESSIONS_SUBCOLLECTION'))
  })

  it('has NO teardown — an uninstall leaves seeded content standing', () => {
    // RULE 3. A rule that has been grading people for a year belongs to the
    // organisation, and deleting it would strand every grading recorded against
    // it. The absence of a delete is the feature.
    assert.ok(!/\.delete\(\)/.test(code), 'the seeder deletes something')
    assert.ok(
      !/status\s*!==\s*'active'[\s\S]{0,120}delete/.test(code),
      'a deactivation branch removes content'
    )
  })

  it('refuses to seed an install that is not active', () => {
    assert.ok(
      code.includes("status !== 'active'"),
      'a disabled install must not have new content laid down'
    )
  })

  it('uses a FIXED document id, never an auto-id', () => {
    // RULE 1. `.doc()` with no argument is what turns a re-install into a
    // duplicate ladder.
    assert.ok(code.includes('.doc(seed.systemId)'))
    assert.ok(!/collection\([^)]*\)\.add\(/.test(code), 'an auto-id document is created')
  })

  it('a failed seed does not fail the install', () => {
    assert.ok(/catch \(err\)/.test(code) && code.includes('seeding failed'))
  })
})

describe("HMD's ladder, as the organisation grades", () => {
  const hmd = pluginSeeds('hmd-belts')

  it('is carried by the hmd-belts plugin', () => {
    assert.ok(hmd, 'hmd-belts carries no seed')
    assert.equal(hmd!.rankProgressions?.length, 2, 'both disciplines must be seeded')
  })

  it('COLOUR BELTS HAVE NO BAND — the organisation grades them by judgement', () => {
    // The engine answers `not_configured` for a level no band contains, and the
    // UI must not render that as a refusal. A permissive band here would be a
    // claim HMD never made.
    const hmdSystem = hmd!.rankProgressions!.find((r) => r.systemId === 'hmd')!
    // Bands name levels by ID since the scale decoupling. None may name a
    // colour belt — those are graded by judgement, and the engine must answer
    // `not_configured` for them.
    const colourBelts = ['no-belt', 'white', 'yellow', 'orange', 'orange-green', 'green', 'green-blue', 'blue', 'blue-red', 'red', 'red-black']
    for (const r of hmdSystem.progression.rules) {
      assert.ok(!colourBelts.includes(String(r.from)) && !colourBelts.includes(String(r.to)), `a band reaches a colour belt: ${r.from}–${r.to}`)
    }
    assert.ok(hmdSystem.progression.rules.some((r) => r.from === 'black-i-dan'), 'Black I Dan has a band')
  })

  it('YEARS REQUIRED = THE DAN BEING TAKEN, and the time matches it', () => {
    const rules = hmd!.rankProgressions!.find((r) => r.systemId === 'hmd')!.progression.rules
    // 1st Dan is the exception: six months, and three flat participation
    // requirements rather than qualifying years — the window is shorter than a
    // year, so the year machinery has nothing to measure.
    const first = rules.find((r) => r.from === 'black-i-dan')!
    const firstTime = first.requirements.find((r) => r.kind === 'time_since_previous_exam')!
    assert.equal((firstTime as { amount: number }).amount, 6)
    assert.ok(!first.requirements.some((r) => r.kind === 'qualifying_years'))

    // 2nd, 3rd, Master: n years elapsed AND n qualifying years.
    for (const [level, years] of [
      ['black-ii-dan', 2],
      ['black-iii-dan', 3],
      ['master', 4],
    ] as const) {
      const band = rules.find((r) => r.from === level)
      assert.ok(band, `no band for level ${level}`)
      const time = band!.requirements.find((r) => r.kind === 'time_since_previous_exam')!
      assert.equal(
        (time as { amount: number }).amount,
        years * 12,
        `level ${level} should ask for ${years} years`
      )
      const qualifying = band!.requirements.find((r) => r.kind === 'qualifying_years')!
      assert.equal((qualifying as { minYears: number }).minYears, years)
    }
  })

  it('every dan carries the probation year — the SECOND gate', () => {
    const rules = hmd!.rankProgressions!.find((r) => r.systemId === 'hmd')!.progression.rules
    for (const band of rules) {
      assert.ok(band.promotionDelay, `band from ${band.from} has no promotionDelay`)
      assert.equal(band.promotionDelay!.amount, 12)
      assert.ok(
        (band.promotionDelay!.requirements ?? []).length > 0,
        'the probation year must itself be a qualifying one'
      )
    }
  })

  it('participation counts in ANY role — support is participation', () => {
    // Written by OMITTING `roles`. A club wanting competitors only writes
    // `roles: ['participant']`; HMD deliberately does not.
    const rules = hmd!.rankProgressions!.find((r) => r.systemId === 'hmd')!.progression.rules
    for (const band of rules) {
      for (const req of band.requirements) {
        if (req.kind === 'event_participation') {
          assert.equal((req as { spec: { roles?: unknown } }).spec.roles, undefined)
        }
        if (req.kind === 'qualifying_years') {
          for (const spec of (req as { perYear: { roles?: unknown }[] }).perYear) {
            assert.equal(spec.roles, undefined)
          }
        }
      }
    }
  })

  it('the cup counts as a tournament, without core knowing what a synonym is', () => {
    const rules = hmd!.rankProgressions!.find((r) => r.systemId === 'hmd')!.progression.rules
    const band = rules.find((r) => r.from === 'black-i-dan')!
    const specs = band.requirements
      .filter((r) => r.kind === 'event_participation')
      .map((r) => (r as { spec: { eventTypes: string[] } }).spec)
    const tournament = specs.find((s) => s.eventTypes.includes('competition'))
    assert.ok(tournament, 'no tournament requirement')
    assert.ok(
      tournament!.eventTypes.includes('hmd_fighting_cup'),
      "HMD's own cup must satisfy the tournament requirement"
    )
  })

  it('Korean Dragon ALIASES Hwal Moo Do rather than copying it', () => {
    // One document to edit, and "which rule governs this system" stays a lookup
    // instead of becoming a query.
    const kd = hmd!.rankProgressions!.find((r) => r.systemId === 'kd')!
    assert.equal(kd.progression.alias_of, 'hmd')
    assert.equal(kd.progression.rules.length, 0, 'an alias must carry no rules of its own')
  })

  it('no alias points at another alias — one hop, never a chain', () => {
    for (const bundle of Object.values(PLUGIN_SEEDS)) {
      const byId = new Map(bundle?.rankProgressions?.map((r) => [r.systemId, r.progression]) ?? [])
      for (const [, progression] of byId) {
        const target = progression.alias_of
        if (!target) continue
        const resolved = byId.get(target)
        assert.ok(resolved, `alias_of names a system this seed does not create: ${target}`)
        assert.equal(resolved!.alias_of, undefined, `alias chain via ${target}`)
      }
    }
  })
})
