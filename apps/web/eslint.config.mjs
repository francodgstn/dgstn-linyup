// Flat ESLint config. Next.js 16 removed the `next lint` CLI — lint runs via
// the ESLint CLI directly (`pnpm lint`), with the Next.js rules pulled in
// through FlatCompat (eslint-config-next still ships eslintrc-style configs).
import { createRequire } from 'node:module'
import { FlatCompat } from '@eslint/eslintrc'
import { firestorePathLiteralRule } from './eslint.firestorePaths.mjs'

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
})

const require = createRequire(import.meta.url)

// ── Tripwires (docs/scalability-2026-09.md §7) ───────────────────────────────
// Two patterns regrew on every surface and were each swept by hand; these make
// the sweep permanent by failing lint on the next copy.
//
// 1. A Firestore path segment typed as a string where packages/shared/src/paths.ts
//    already names it (item 25). The forbidden set is DERIVED from that file's
//    build, so adding a constant there is what extends the rule.
// 2. A bare `toLocale*String()` on a PUBLIC route (item 13). The browser's
//    locale is neither the studio's date shape nor the reader's language;
//    `usePublicFormat` is. Scoped to the public tree: the admin has
//    `useTeamFormat` and its own backlog, tracked separately.
const noFirestorePathLiterals = firestorePathLiteralRule(require)
const noBareLocaleFormatting = {
  selector: 'MemberExpression[property.name=/^toLocale(Date|Time)?String$/]',
  message:
    "Public routes format dates through usePublicFormat() (the studio's regional settings, the reader's language) — never a bare toLocale*String(). See docs/scalability-2026-09.md §7 item 13.",
}

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', noFirestorePathLiterals],
    },
  },
  {
    // `*` stands for the `[locale]` segment — brackets are glob syntax.
    files: ['src/app/*/(public)/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', noFirestorePathLiterals, noBareLocaleFormatting],
    },
  },
]

export default eslintConfig
