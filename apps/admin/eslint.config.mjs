// Flat ESLint config. Next.js 16 removed the `next lint` CLI — lint runs via
// the ESLint CLI directly (`pnpm lint`), with the Next.js rules pulled in
// through FlatCompat (eslint-config-next still ships eslintrc-style configs).
import { FlatCompat } from '@eslint/eslintrc'
// Tripwire shared with the web app: a Cloud Function is called through
// callFunction, never httpsCallable. The reasoning lives beside the rule.
import { noDirectCallables } from '../web/eslint.callables.mjs'

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
})

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/callFunction.ts'],
    rules: {
      'no-restricted-imports': ['error', noDirectCallables],
    },
  },
]

export default eslintConfig
