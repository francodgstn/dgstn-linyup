import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// EVERY <SelectItem> MUST BE ABLE TO NAME ITSELF.
//
// It spans the functions/web boundary for the same reason connect/commitSites.test.ts
// does: that boundary is where corrections stop traveling.
// Run with: pnpm --filter @linyup/functions test
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// apps/web/src/components/ui/select.tsx builds the value→label registry that
// Base UI's Select.Value reads by walking SelectContent's children:
//
//   const label = p.label ?? p.textValue ?? (typeof p.children === "string" ? p.children : undefined)
//
// An item whose children are anything ELSE — `{a.code} · {a.name}`, a span with a
// color dot, an icon — registers nothing, and the trigger then prints the raw
// `value`: a Firestore document id, a level number, an account code. It looks
// like a rendering glitch and is reported as one; it was found in the wild on the
// event program's Day picker, and a sweep turned up EIGHTEEN of them across
// finance, contacts, automations, documents, bookings, affiliations,
// appointments, subscriptions and connect.
//
// Nothing typed catches it: `label` and `textValue` are both optional, and the
// broken form is valid TSX that renders a perfectly good dropdown — only the
// closed trigger is wrong. apps/web has no test runner, so the guard lives here.
//
// ── WHICH PROP ─────────────────────────────────────────────────────────────
//   label      — title of a TWO-LINE item; `children` become a muted sublabel.
//   textValue  — trigger text for a row that renders its own INLINE content
//                (color dot, icon, tree indent), leaving the layout alone.
// Using `label` where `textValue` belongs is not caught here: it type-checks and
// registers fine, it just pushes the decoration onto a second line. That one is
// a review question, not an assertion.

const WEB_SRC = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'src')

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full))
    else if (entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Children that select.tsx CAN read a label from: a single `{expr}` (which is a
 *  string at runtime in every current call site) or a bare text literal. */
function childrenCanRegister(body: string): boolean {
  const t = body.trim()
  if (!t) return false
  if (/^\{(?:[^{}]|\{[^{}]*\})*\}$/.test(t)) return true
  return !t.includes('{') && !t.includes('<')
}

const ITEM = /<SelectItem\b([^>]*?)(\/)?>([\s\S]*?)(?:<\/SelectItem>)?(?=<SelectItem\b|$)/g

/** Every SelectItem that would print its raw value, as 'path:line'. */
export function unlabelledSelectItems(): string[] {
  const offenders: string[] = []
  for (const file of tsxFiles(WEB_SRC)) {
    const src = readFileSync(file, 'utf8')
    // Paired form only; a self-closing item has no children and therefore must
    // carry label/textValue, which the same attribute test covers.
    const paired = /<SelectItem\b([^>]*?)>([\s\S]*?)<\/SelectItem>/g
    let m: RegExpExecArray | null
    while ((m = paired.exec(src)) !== null) {
      const [, attrs, body] = m
      if (/\blabel=/.test(attrs) || /\btextValue=/.test(attrs)) continue
      if (childrenCanRegister(body)) continue
      offenders.push(`${relative(WEB_SRC, file)}:${src.slice(0, m.index).split('\n').length}`)
    }
    const selfClosing = /<SelectItem\b([^>]*?)\/>/g
    while ((m = selfClosing.exec(src)) !== null) {
      if (/\blabel=/.test(m[1]) || /\btextValue=/.test(m[1])) continue
      offenders.push(`${relative(WEB_SRC, file)}:${src.slice(0, m.index).split('\n').length}`)
    }
  }
  return offenders.sort()
}

describe('every SelectItem can name itself', () => {
  it('finds the SelectItems at all — the scan is not silently matching nothing', () => {
    // A floor, so a broken regex cannot make this suite pass by seeing no items.
    let total = 0
    for (const file of tsxFiles(WEB_SRC)) {
      total += (readFileSync(file, 'utf8').match(/<SelectItem\b/g) ?? []).length
    }
    assert.ok(total > 100, `expected the app's SelectItems, found ${total}`)
  })

  it('no SelectItem falls back to printing its raw value', () => {
    const offenders = unlabelledSelectItems()
    assert.deepEqual(
      offenders,
      [],
      `these SelectItems register no label, so the closed trigger shows the raw ` +
        `value (a document id, a number, an account code):\n  ${offenders.join('\n  ')}\n` +
        `Add \`label\` (title + sublabel layout) or \`textValue\` (inline content, ` +
        `layout untouched) — see components/ui/select.tsx.`,
    )
  })

  it('and the check is capable of failing', () => {
    // The guard above is only worth having if this shape is actually rejected.
    assert.equal(childrenCanRegister('{a.code} · {a.name}'), false)
    assert.equal(childrenCanRegister('<span>{x}</span>'), false)
    assert.equal(childrenCanRegister('{t(`kind_${k}`)}'), true)
    assert.equal(childrenCanRegister('All time'), true)
  })
})
