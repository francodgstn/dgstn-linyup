import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TARIF595_WARNING_CODES, resolveActivityDropIn, studioDropInOf, toMinorUnits } from '@linyup/shared'

// An attendance receipt with no typed price takes the class's RESOLVED drop-in
// price. Two things can go wrong silently, and both are pinned here:
//
//   1. reading the price off the activity instead of through the resolver — a
//      class that FOLLOWS the studio default stores no price of its own, so an
//      inline read is zero for exactly the classes that most often have one;
//   2. letting the default beat a price the manager typed — a member on a
//      ten-pass paid a different rate per lesson than the door price.
//
// The composition itself needs Firestore and is exercised end to end by
// integration/tarif595.integration.mjs; what is checked here is the CAUSE of
// each mistake, structurally, in the source.

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8').replace(/\r\n/g, '\n')

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`)
  assert.notEqual(start, -1, `${name} not found`)
  const rest = src.slice(start)
  const next = rest.indexOf('\n// ───', 1)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('tarif595 — the lesson price of a class comes from THE drop-in resolver', () => {
  const body = fnBody(read('sources.ts'), 'loadClassLessonPriceMinor')

  it('goes through resolveActivityDropIn with the studio default, and converts with toMinorUnits', () => {
    assert.match(body, /resolveActivityDropIn\(activity, studioDropInOf\(bookingSettings\)\)/)
    assert.match(body, /toMinorUnits\(dropIn\.priceAmount\)/)
  })

  it('never reads a price or a flag off the activity itself — on ANY receiver', () => {
    // `dropIn.priceAmount` on the RESOLVED value is the only allowed read; a
    // member access on the stored field is `<anything>.dropIn.priceAmount`.
    assert.ok(!/\.dropIn\??\.(priceAmount|enabled|mode)/.test(body), 'an inline read of the stored drop-in field')
  })

  it('refuses an activity of another team', () => {
    assert.match(body, /if \(activity\.teamId !== teamId\) return null/)
  })

  it('and the pin is capable of failing', () => {
    assert.ok(/\.dropIn\??\.(priceAmount|enabled|mode)/.test('const p = activity.dropIn?.priceAmount'))
    assert.ok(/\.dropIn\??\.(priceAmount|enabled|mode)/.test('if (a.dropIn.enabled) {}'))
  })
})

describe('tarif595 draft — the default never beats a typed price', () => {
  const draft = read('draft.ts')

  it('derives only when no price was given, and says so with a warning', () => {
    const at = draft.indexOf('loadClassLessonPriceMinor(req.teamId')
    assert.notEqual(at, -1)
    const before = draft.slice(Math.max(0, at - 200), at)
    assert.match(before, /if \(unitPriceMinor === null\) \{/)
    assert.match(draft.slice(at, at + 300), /warnings\.push\(\{ code: 'unit_price_from_drop_in' \}\)/)
  })

  it('the new warning is on THE list a mixed-code reader picks its namespace from', () => {
    assert.ok(TARIF595_WARNING_CODES.includes('unit_price_from_drop_in'))
  })
})

describe('the resolver, on the shapes this path meets', () => {
  // A class limited to people who signed up — a MODERN wall. A legacy
  // `{ type: 'members' }` document's price never fires (`classDoorIsInert`,
  // docs/class-access-derived.md), so it would not exercise the price at all.
  const gated = { type: 'class' as const, accessRule: { audience: 'members' as const } }

  it('a class with its own price', () => {
    const d = resolveActivityDropIn({ ...gated, dropIn: { mode: 'custom', enabled: true, priceAmount: 30 } }, null)
    assert.equal(d.enabled && toMinorUnits(d.priceAmount!), 3000)
  })

  it('a class FOLLOWING the studio default stores no price — the case an inline read gets wrong', () => {
    const studio = studioDropInOf({ dropIn: { enabled: true, priceAmount: 27.5 } })
    const d = resolveActivityDropIn({ ...gated, dropIn: { mode: 'studio', enabled: false } }, studio)
    assert.equal(d.enabled && toMinorUnits(d.priceAmount!), 2750)
  })

  it('no price anywhere, a class switched off, and an appointment all answer none', () => {
    assert.equal(resolveActivityDropIn({ ...gated }, null).enabled, false)
    assert.equal(resolveActivityDropIn({ ...gated, dropIn: { mode: 'off', enabled: false } }, studioDropInOf({ dropIn: { enabled: true, priceAmount: 20 } })).enabled, false)
    assert.equal(resolveActivityDropIn({ type: 'appointment' as const, dropIn: { mode: 'custom', enabled: true, priceAmount: 90 } }, null).enabled, false)
  })
})
