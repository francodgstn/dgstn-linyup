import path from 'node:path'
import type { NextConfig } from 'next'
import { commitEnv } from '../../scripts/lib/commitSha.mjs'

// Operator console. Reads data server-side via the Firebase Admin SDK, so no
// client-side Firestore proxy is needed (unlike apps/web). The only client
// Firebase usage is the login page hitting the Auth emulator / production
// Identity Toolkit directly.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // WHICH COMMIT THIS BUNDLE IS — the same stamp apps/web carries, for the same
  // reason: the Cloud Run revision names a BUILD, not a commit, and the console
  // is the surface an operator reaches for when they need to know exactly what
  // is running. See `scripts/lib/commitSha.mjs`.
  env: commitEnv(path.join(__dirname, '..', '..')),
  // Server-only, and both must stay UNBUNDLED.
  //
  // @google-cloud/secret-manager pulls google-gax → @grpc/grpc-js. Bundling
  // grpc-js mangles its module state: grpc's own callErrorFromStatus renders
  // `${status.code} ${Status[status.code]}: ${status.details}` as
  // "undefined undefined: undefined", and — worse — the code/details never
  // reach our callers, so `err.code === 5` (NOT_FOUND) checks silently fail and
  // a routine "secret isn't set yet" surfaced as a page-level runtime error on
  // /settings. firebase-admin was already listed, which is why Firestore and
  // Auth were unaffected and only the settings page broke.
  serverExternalPackages: ['firebase-admin', '@google-cloud/secret-manager'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
