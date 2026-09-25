import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE REFUSAL VOCABULARY AND ITS COPY, ASSERTED ACROSS FILES THAT CANNOT SEE
// EACH OTHER.
//
// A waiver refusal arrives on the acquisition path, in four languages, at the
// moment a visitor is trying to give a studio money. The failure this file
// exists to make impossible has already shipped once in this repo: a public
// surface rendered internal English billing prose to a French visitor because
// one refusal had no reason code and fell through to `err.message`.
//
// Three sets have to agree and nothing in the type system makes them:
//
//   1. what the SERVER raises  — `reason: '…'` literals under
//      packages/functions/src/waivers/
//   2. what the CLIENT maps    — `WAIVER_REFUSAL_REASONS` in
//      apps/web/src/lib/waiver.ts
//   3. what the COPY covers    — `Waiver.reason_{code}` in all four
//      apps/web/messages/*.json
//
// This file spans the functions/web boundary for the same reason
// `connect/commitSites.test.ts` does: that boundary is where corrections stop
// traveling. It is also W25's lockstep check made executable — a grep over four
// JSON files run by hand once at the end of a phase is not a gate, it is a
// memory.
//
// Run with: pnpm --filter @linyup/functions test

const REPO = join(__dirname, '..', '..', '..', '..')
const WAIVERS = join(__dirname)
const MESSAGES = join(REPO, 'apps', 'web', 'messages')

const LOCALES = ['en', 'de', 'fr', 'it'] as const
type Locale = (typeof LOCALES)[number]

function read(path: string): string {
  assert.ok(existsSync(path), `expected ${path} to exist`)
  return readFileSync(path, 'utf8')
}

/** Strip comments and template literals so a grep cannot match prose. A reason
 *  code only ever appears as a plain single- or double-quoted literal. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function messages(locale: Locale): Record<string, Record<string, unknown>> {
  return JSON.parse(read(join(MESSAGES, `${locale}.json`)))
}

function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key))
      else out[key] = v
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────

describe('THE REFUSAL CENSUS — every reason the server raises has copy in four languages', () => {
  // The owner of the SERVER side is this list of files plus the grep below —
  // not a hand-maintained list of codes. A new waiver refusal in any of them is
  // picked up automatically, which is the whole point: the previous phase's
  // three-round failure was a fix applied to the sites a report NAMED rather
  // than every site that EXISTS.
  const SERVER_FILES = ['gate.ts', 'requirement.ts', 'accept.ts', 'space.ts']

  function serverReasons(): Set<string> {
    const found = new Set<string>()
    for (const file of SERVER_FILES) {
      const src = code(read(join(WAIVERS, file)))
      // Both spellings the area uses: the `reason:` property, and the union
      // member declarations on `WaiverRefusalReason`.
      for (const m of src.matchAll(/'(waiver_[a-z_]+)'/g)) found.add(m[1])
    }
    return found
  }

  function clientReasons(): string[] {
    const src = read(join(REPO, 'apps', 'web', 'src', 'lib', 'waiver.ts'))
    const block = /export const WAIVER_REFUSAL_REASONS = \[([\s\S]*?)\] as const/.exec(src)
    assert.ok(block, 'WAIVER_REFUSAL_REASONS should be a literal array in apps/web/src/lib/waiver.ts')
    return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  }

  it('the client maps every reason the server raises', () => {
    const server = serverReasons()
    const client = new Set(clientReasons())
    const unmapped = [...server].filter((r) => !client.has(r)).sort()
    assert.deepEqual(
      unmapped,
      [],
      `these refusals reach a visitor with no translated sentence: ${unmapped.join(', ')}`
    )
  })

  it('and maps NOTHING the server cannot raise', () => {
    // The client table used to carry one deliberate extra — a guardian state the
    // requirement callable reported as an action rather than throwing. With the
    // guardian machinery gone the set is exact, and asserting it as exact is what
    // keeps a table describing the system: an unraised reason is copy nobody can
    // reach, and this test is the only place that would notice it.
    const server = serverReasons()
    const extra = clientReasons().filter((r) => !server.has(r)).sort()
    assert.deepEqual(extra, [], `unexpected unraised reasons: ${extra.join(', ')}`)
  })

  it('every mapped reason has a non-empty string in all four locales', () => {
    const reasons = clientReasons()
    for (const locale of LOCALES) {
      const ns = (messages(locale).Waiver ?? {}) as Record<string, unknown>
      for (const reason of reasons) {
        const value = ns[`reason_${reason}`]
        assert.equal(
          typeof value,
          'string',
          `${locale}.json is missing Waiver.reason_${reason}`
        )
        assert.ok(String(value).trim().length > 0, `${locale}.json has an empty Waiver.reason_${reason}`)
      }
    }
  })

  it('no refusal sentence interpolates a value the client does not pass', () => {
    // `next-intl` throws on a missing placeholder value, and it throws at
    // exactly the wrong moment: mid-refusal, on the acquisition path. Every
    // remaining reason is rendered by `waiverErrorMessage` with no arguments at
    // all, so a `{placeholder}` in any of them is a crash waiting for a locale.
    for (const locale of LOCALES) {
      const ns = (messages(locale).Waiver ?? {}) as Record<string, string>
      for (const [key, value] of Object.entries(ns)) {
        if (!key.startsWith('reason_')) continue
        assert.doesNotMatch(
          String(value),
          /\{[a-zA-Z]/,
          `${locale}.json: ${key} interpolates a value nothing passes`
        )
      }
    }
  })

  it('the self-declaration copy says plainly that nothing verifies it', () => {
    // The one place a visitor makes the claim is the one place it has to be
    // described honestly — in all four languages, or a studio in Ticino reads a
    // stronger promise than the record can support.
    for (const locale of LOCALES) {
      const ns = (messages(locale).Waiver ?? {}) as Record<string, string>
      for (const key of ['signerChoiceLabel', 'signerChoiceSelf', 'signerChoiceGuardian', 'signerChoiceNote']) {
        assert.equal(typeof ns[key], 'string', `${locale}.json is missing Waiver.${key}`)
        assert.ok(String(ns[key]).trim().length > 0, `${locale}.json has an empty Waiver.${key}`)
      }
      assert.ok(
        ns.signerChoiceNote.length > 40,
        `${locale}.json: signerChoiceNote must actually say what is and is not recorded`
      )
    }
  })
})

describe('I18N LOCKSTEP (W25) — identical key SETS, not merely similar files', () => {
  // The namespaces this phase touches. Named rather than counted: a count would
  // rot the moment somebody adds a key, and the names are checkable by reading
  // them.
  const NAMESPACES = [
    'Waiver',
    'Waivers',
    'Documents',
    'Nav',
    'PublicBooking',
    'Appointments',
    'Waitlist',
    'Space',
    'Manifest',
    'SessionDetail',
    'Kiosk',
  ]

  it('every namespace has the same keys in every locale', () => {
    const en = messages('en')
    for (const ns of NAMESPACES) {
      assert.ok(en[ns], `en.json has no ${ns} namespace`)
      const expected = Object.keys(flatten(en[ns])).sort()
      for (const locale of LOCALES.filter((l) => l !== 'en')) {
        const actual = Object.keys(flatten(messages(locale)[ns] ?? {})).sort()
        const missing = expected.filter((k) => !actual.includes(k))
        const extra = actual.filter((k) => !expected.includes(k))
        assert.deepEqual(missing, [], `${locale}.json is missing ${ns}: ${missing.join(', ')}`)
        assert.deepEqual(extra, [], `${locale}.json has extra ${ns} keys: ${extra.join(', ')}`)
      }
    }
  })

  it('the WHOLE message file is in lockstep, not only the namespaces above', () => {
    // The namespace list above says what this phase touched; this says the file
    // is sound. A key added to the wrong namespace — the failure this repo has
    // actually seen, because several namespaces share key names and a naive
    // anchor lands the key one namespace over — shows up here as an extra in
    // one locale and a miss in another.
    const expected = Object.keys(flatten(messages('en'))).sort()
    for (const locale of LOCALES.filter((l) => l !== 'en')) {
      const actual = Object.keys(flatten(messages(locale))).sort()
      assert.deepEqual(
        actual.filter((k) => !expected.includes(k)),
        [],
        `${locale}.json has keys en.json does not`
      )
      assert.deepEqual(
        expected.filter((k) => !actual.includes(k)),
        [],
        `${locale}.json is missing keys en.json has`
      )
    }
  })

  it('no locale left a waiver string untranslated by copying the English', () => {
    // Not a hard rule across the whole file — proper nouns, "OK" and a bare
    // "{count}" legitimately match — so it is scoped to the two waiver
    // namespaces and to values long enough that a coincidence is implausible.
    // A studio in Ticino reading the English liability copy is a worse failure
    // than a missing key, because nothing errors.
    const en = messages('en')
    for (const ns of ['Waiver', 'Waivers']) {
      const source = flatten(en[ns]) as Record<string, string>
      for (const locale of LOCALES.filter((l) => l !== 'en')) {
        const target = flatten(messages(locale)[ns] ?? {}) as Record<string, string>
        for (const [key, value] of Object.entries(source)) {
          if (typeof value !== 'string' || value.length < 25) continue
          assert.notEqual(
            target[key],
            value,
            `${locale}.json: ${ns}.${key} is still the English string`
          )
        }
      }
    }
  })
})
