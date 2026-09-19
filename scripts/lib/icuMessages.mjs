/**
 * Shared ICU message helpers for the i18n merge + check scripts.
 *
 * ONE SUBTLETY, and it produced 17 false positives before it was handled: a
 * naive `/\{(\w+)/g` sweep also captures ICU plural BRANCH BODIES —
 *
 *   {count, plural, =0 {Run anyway} one {Send to # contact now} …}
 *
 * yields `Run` and `Send`, whose first word differs in every language by
 * definition. A check that flags those flags almost every plural in the file,
 * and a check that cries wolf gets switched off.
 *
 * So arguments are collected by brace DEPTH: only `{name` at depth 0 is an
 * argument; anything nested is branch text. The deliberate cost is that a
 * placeholder nested inside a branch (`other {Send to {name}}`) is not
 * compared. That weakens the check rather than breaking it, which is the right
 * direction for a guard — a missed mismatch is a bug that survives, a false
 * one is a guard nobody trusts.
 */

/** The ICU argument names a message uses, top level only. */
export function placeholders(message) {
  const names = new Set()
  const str = String(message)
  let depth = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '}') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (ch !== '{') continue
    if (depth === 0) {
      // `{name}` or `{name, plural, …}` — anything else is literal text.
      const m = /^\{\s*(\w+)\s*[,}]/.exec(str.slice(i))
      if (m) names.add(m[1])
    }
    depth++
  }
  return names
}

/**
 * Flattens a nested message object to `Namespace.key` → string.
 *
 * ARRAYS ARE WALKED, with the index as a path segment. They hold real
 * user-visible copy — plan feature lists, the engagement-matrix actions — some
 * containing objects rather than bare strings. Skipping them once left 72
 * translated strings unguarded, and a
 * feature list that is three bullets in English and two in German is exactly
 * the silent drift this file exists to catch. The index in the path also means
 * a REORDERED array reads as a mismatch, which is correct: position is meaning
 * when the list is rendered in order beside a price.
 */
export function flatten(node, prefix = [], acc = {}) {
  const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v]) : Object.entries(node)
  for (const [key, value] of entries) {
    const path = [...prefix, key]
    if (typeof value === 'string') acc[path.join('.')] = value
    else if (value && typeof value === 'object') flatten(value, path, acc)
  }
  return acc
}

/** Compares one key's translations against the English reference. */
export function placeholderProblems(key, reference, translation, locale) {
  const ref = placeholders(reference)
  const got = placeholders(translation)
  const lost = [...ref].filter((p) => !got.has(p))
  const extra = [...got].filter((p) => !ref.has(p))
  if (!lost.length && !extra.length) return null
  return (
    `${key} [${locale}]` +
    (lost.length ? ` drops {${lost.join('}, {')}}` : '') +
    (extra.length ? ` invents {${extra.join('}, {')}}` : '')
  )
}

export const LOCALES = ['en', 'de', 'fr', 'it']
