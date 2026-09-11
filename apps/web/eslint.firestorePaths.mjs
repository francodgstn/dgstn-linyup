// The `no-restricted-syntax` entry that refuses a hand-typed Firestore path
// segment where @linyup/shared already owns a constant for it. Shared by the
// web and mobile ESLint configs (mobile's is CommonJS and loads this through
// a dynamic import).
//
// The forbidden set is READ from the shared package's build — never listed
// here — so the rule and `packages/shared/src/paths.ts` cannot disagree:
// adding a constant there is what extends the rule. `turbo run lint` builds
// shared first (`dependsOn: ['^build']`); so does `pnpm bootstrap`.

const CALLEES = /^(collection|doc|collectionGroup)$/

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function ownedPathSegments(require) {
  let paths
  try {
    paths = require('@linyup/shared/dist/paths.js')
  } catch (err) {
    throw new Error(
      'eslint: @linyup/shared is not built (dist/paths.js missing) — run `pnpm --filter @linyup/shared build` first. ' +
        (err && err.message ? err.message : ''),
    )
  }
  return [...new Set(Object.values(paths).filter((v) => typeof v === 'string' && v.length > 0))]
}

export function firestorePathLiteralRule(require) {
  const pattern = `^(${ownedPathSegments(require).map(escapeRegExp).join('|')})$`
  const message =
    'This Firestore path segment has a constant in @linyup/shared (packages/shared/src/paths.ts) — import it instead of the string. See docs/scalability-2026-09.md §7 item 25.'
  return {
    // Both call shapes: the modular SDK's `collection(db, 'x')` and the Admin
    // SDK's `db.collection('x')`.
    selector: `:matches(CallExpression[callee.name=${CALLEES}], CallExpression[callee.property.name=${CALLEES}]) > Literal[value=/${pattern}/]`,
    message,
  }
}
