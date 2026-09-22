import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// EVERY `send_email` TEMPLATE KEY IN THE AUTOMATION LIBRARY RESOLVES TO A REAL
// TEMPLATE — asserted against the source, not trusted.
//
// ── THE DEFECT THIS PINS ────────────────────────────────────────────────────
//
// A library item's `send_email` action names a template by KEY. Two kinds of
// item exist, and only one of them carries the template:
//
//   • an item with its own `template` block (four translations), whose action
//     names its own `library_key` — self-contained;
//   • a migrated `sys_rule_*` item with NO `template` block, whose action names
//     a SHARED starter-kit template: sys_trial_followup, sys_rebook_nudge,
//     sys_winback or sys_milestone_10.
//
// Nothing in the app ever created that second kind. SYSTEM_TEMPLATES is read
// only by the email-templates "reset to default" helper, so on any team not
// migrated from hmd-lineup the install found no match and wrote the rule with
// `templateId: ''`.
//
// That is worse than a dead rule. The engine's read is
// `teamRef.collection('outreach_templates').doc(action.templateId).get()`
// (utils/automationEngine.ts), and the Admin SDK validates the path CLIENT-side:
// `.doc('')` THROWS synchronously. `to()` takes a promise, so the throw happens
// while evaluating its argument and escapes the guard that would have logged
// "Template not found or inactive" — and with it the `hasResolvableActions`
// check that exists to skip exactly this rule. The throw leaves `runRule`
// before the `automation_logs` row is built, so the run leaves no ledger entry
// either.
//
// Eight of the nine STARTER_BUNDLE_KEYS name a shared template, so this was the
// ordinary path rather than an edge case.
//
// ── WHAT EACH HALF PINS, AND WHAT IT DOES NOT ───────────────────────────────
//
// These are two different guards and it is worth not confusing them, because
// the obvious reading of the first one is wrong:
//
//   • "every send_email key has a template behind it" does NOT reproduce the
//     shipped defect. All four shared keys were always DECLARED in
//     SYSTEM_TEMPLATES — the bug was that the installer never consulted it —
//     so this check passed before the fix just as it passes after. It guards
//     the FUTURE case the fix turned into a thrown error: a new library item
//     naming a template that nothing declares anywhere. Without it that item
//     would reach a studio and fail at install time instead of at CI.
//
//   • "a missing starter-kit template is created, not blanked" IS the
//     regression guard. It fails against the pre-fix installer, and its
//     capable-of-failing case runs the assertions against that exact text.
//
// A grep for the old `?? ''` tail was rejected as the regression guard: it
// pins one spelling of one mistake, and the `?? 0` precedent in this repo went
// green against the very edit it existed to catch.
//
// Both read the web SOURCE deliberately: `apps/web` has no test runner, and the
// claim spans the functions/web boundary, which is where corrections stop
// travelling (same reasoning as connect/commitSites.test.ts).
//
// Run with: pnpm --filter @linyup/functions test

/** SRC → packages/functions → packages → root. */
const ROOT = join(__dirname, '..', '..', '..', '..')

/** Line endings normalised: LF on CI, CRLF in a Windows checkout. */
function readRoot(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

const AUTOMATIONS = 'apps/web/src/app/[locale]/(auth)/automations'

const library = readRoot(`${AUTOMATIONS}/automationLibrary.ts`)
const systemDefaults = readRoot(`${AUTOMATIONS}/systemDefaults.ts`)
const libraryDialog = readRoot(`${AUTOMATIONS}/LibraryDialog.tsx`)

/** The starter-kit templates that DO get created from `SYSTEM_TEMPLATES`. Read
 *  from the `SYSTEM_TEMPLATES` array only — `SYSTEM_RULES`, further down the
 *  same file, also carries `system_key` values, and counting those would let a
 *  rule key masquerade as a template. */
function systemTemplateKeys(source: string): Set<string> {
  const start = source.indexOf('export const SYSTEM_TEMPLATES')
  assert.notEqual(start, -1, 'SYSTEM_TEMPLATES not found in systemDefaults.ts')
  const end = source.indexOf('export const SYSTEM_RULES')
  const block = source.slice(start, end === -1 ? undefined : end)
  return new Set([...block.matchAll(/system_key: '([a-z0-9_]+)'/g)].map((m) => m[1]))
}

interface LibraryItemShape {
  key: string
  ownsTemplate: boolean
  emailKeys: string[]
}

/** Split the library into per-item blocks. Each item starts at its
 *  `library_key` and runs to the next one; a `library_key` occurrence with no
 *  `trigger:` after it is not an item (STARTER_BUNDLE_KEYS lists bare keys). */
function libraryItems(source: string): LibraryItemShape[] {
  const marks = [...source.matchAll(/library_key: '([a-z0-9_]+)'/g)]
  const items: LibraryItemShape[] = []
  for (let i = 0; i < marks.length; i++) {
    const block = source.slice(
      marks[i].index!,
      i + 1 < marks.length ? marks[i + 1].index! : source.length
    )
    if (!/\btrigger:/.test(block)) continue
    items.push({
      key: marks[i][1],
      // Item-level `template` block — indented four spaces inside the array.
      ownsTemplate: /^ {4}template: \{/m.test(block),
      emailKeys: [...block.matchAll(/template_key: '([a-z0-9_]+)'/g)].map((m) => m[1]),
    })
  }
  return items
}

/** THE PREDICATE. `item -> key` for every send_email action naming a template
 *  that neither the item itself nor SYSTEM_TEMPLATES provides. */
function unresolvedTemplateKeys(librarySource: string, systemSource: string): string[] {
  const sysKeys = systemTemplateKeys(systemSource)
  const out: string[] = []
  for (const item of libraryItems(librarySource)) {
    for (const tmplKey of item.emailKeys) {
      const ownsIt = item.ownsTemplate && tmplKey === item.key
      if (!ownsIt && !sysKeys.has(tmplKey)) out.push(`${item.key} -> ${tmplKey}`)
    }
  }
  return out
}

describe('AUTOMATION LIBRARY — every send_email key has a template behind it', () => {
  it('parses a plausible library and starter kit', () => {
    const items = libraryItems(library)
    assert.ok(items.length > 10, `expected a populated library, got ${items.length} items`)
    assert.ok(systemTemplateKeys(systemDefaults).size > 0, 'expected SYSTEM_TEMPLATES entries')
    assert.ok(
      items.some((i) => i.ownsTemplate) && items.some((i) => !i.ownsTemplate),
      'expected both self-contained and shared-template items'
    )
    assert.ok(
      items.some((i) => i.emailKeys.length > 0),
      'expected at least one send_email action to parse'
    )
  })

  it("resolves every template_key to the item's own template or a starter-kit template", () => {
    const unresolved = unresolvedTemplateKeys(library, systemDefaults)
    assert.deepEqual(
      unresolved,
      [],
      `library items name a template that nothing creates:\n  ${unresolved.join('\n  ')}\n` +
        'Give the item its own `template` block, or add the key to SYSTEM_TEMPLATES.'
    )
  })

  // ── The falsification ──────────────────────────────────────────────────────
  // A source-reading assertion is green on the day it is written whether or not
  // it works, so the predicate is run against the defect it exists to catch.
  // The two synthetic items below are the exact shapes that shipped broken and
  // that shipped fine.
  it('and the pin is capable of failing', () => {
    const SYNTHETIC_SYS = `export const SYSTEM_TEMPLATES = [
  { system_key: 'sys_rebook_nudge' },
]
export const SYSTEM_RULES = [
  { system_key: 'sys_rule_decoy' },
]`

    // The defect: a migrated item with no template of its own, naming a key
    // that SYSTEM_TEMPLATES does not carry.
    const broken = `
  {
    library_key: 'sys_rule_trial_day1',
    rule: {
      trigger: { type: 'schedule_daily' },
      actions: [{ type: 'send_email', template_key: 'sys_trial_followup' }],
    },
  },
`
    assert.deepEqual(unresolvedTemplateKeys(broken, SYNTHETIC_SYS), [
      'sys_rule_trial_day1 -> sys_trial_followup',
    ])

    // …and it does not cry wolf on either healthy shape: an item that owns its
    // template, or one naming a key the starter kit really does carry.
    const ownsIt = `
  {
    library_key: 'lib_trial_noshow_3d',
    template: {
      translations: { en: {}, de: {}, fr: {}, it: {} },
    },
    rule: {
      trigger: { type: 'schedule_daily' },
      actions: [{ type: 'send_email', template_key: 'lib_trial_noshow_3d' }],
    },
  },
`
    assert.deepEqual(unresolvedTemplateKeys(ownsIt, SYNTHETIC_SYS), [])

    const sharedOk = broken.replace('sys_trial_followup', 'sys_rebook_nudge')
    assert.deepEqual(unresolvedTemplateKeys(sharedOk, SYNTHETIC_SYS), [])

    // A rule key is not a template key: SYSTEM_RULES must not satisfy a lookup.
    const viaRuleKey = broken.replace('sys_trial_followup', 'sys_rule_decoy')
    assert.deepEqual(unresolvedTemplateKeys(viaRuleKey, SYNTHETIC_SYS), [
      'sys_rule_trial_day1 -> sys_rule_decoy',
    ])
  })
})

describe('AUTOMATION INSTALL — a missing starter-kit template is created, not blanked', () => {
  it('resolves send_email ids through a creator, not a lookup with an empty tail', () => {
    // The installer must be able to CREATE a referenced starter-kit template,
    // not merely look one up — that is the whole difference between a rule that
    // sends and a rule whose templateId is ''.
    assert.match(
      libraryDialog,
      /import \{ SYSTEM_TEMPLATES \} from '\.\/systemDefaults'/,
      'LibraryDialog must import SYSTEM_TEMPLATES to create a missing starter-kit template'
    )
    assert.match(
      libraryDialog,
      /async function resolveEmailTemplateId/,
      'LibraryDialog must resolve send_email template ids through resolveEmailTemplateId'
    )
    assert.match(
      libraryDialog,
      /templateId: await resolveEmailTemplateId\(/,
      'the send_email action must take its id from the resolver'
    )
  })

  it('and the check is capable of failing', () => {
    const withoutImport = libraryDialog.replace(
      /import \{ SYSTEM_TEMPLATES \} from '\.\/systemDefaults'\n/,
      ''
    )
    assert.ok(!/import \{ SYSTEM_TEMPLATES \} from '\.\/systemDefaults'/.test(withoutImport))

    // The pre-fix tail, as it actually read.
    const preFix = `        const id =
          teamLangTemplateId[tmplKey] ??
          allTemplates.find(t => t.system_key === tmplKey)?.id ??
          ''
        return { type: 'send_email', templateId: id }`
    assert.ok(!/templateId: await resolveEmailTemplateId\(/.test(preFix))
    assert.ok(!/async function resolveEmailTemplateId/.test(preFix))
  })
})
