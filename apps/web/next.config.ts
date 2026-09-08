import path from 'node:path'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
import { commitEnv } from '../../scripts/lib/commitSha.mjs'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

// When running against the Firebase emulators, proxy the emulator API paths
// through this dev server. In a browser-based Codespace the emulators aren't
// reachable on localhost; routing through the (already-authenticated) app
// origin avoids having to make ports public. The auth paths use a benign
// `/__fb.auth/...` prefix because GitHub's tunnel 401s any path containing
// `googleapis.com` — see the fetch shim in src/lib/firebase-auth.ts that
// rewrites the SDK's outgoing URLs to match. All paths contain dots, so the
// next-intl middleware matcher (which excludes `.*\..*`) leaves them alone.
const emulatorRewrites = async () => {
  if (process.env.NEXT_PUBLIC_USE_EMULATORS !== 'true') return []
  const auth = 'http://127.0.0.1:9099'
  const firestore = 'http://127.0.0.1:8080'
  return {
    beforeFiles: [
      {
        source: '/__fb.auth/it/:path*',
        destination: `${auth}/identitytoolkit.googleapis.com/:path*`,
      },
      {
        source: '/__fb.auth/st/:path*',
        destination: `${auth}/securetoken.googleapis.com/:path*`,
      },
      {
        source: '/google.firestore.v1.Firestore/:path*',
        destination: `${firestore}/google.firestore.v1.Firestore/:path*`,
      },
    ],
  }
}

const securityHeaders = [
  // Framing headers (X-Frame-Options / frame-ancestors) are set per-path in
  // src/proxy.ts so the public /embed/* widget routes can be framed by a studio's
  // own website while the rest of the app stays frame-denied.
  // Stop browsers from MIME-sniffing
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Control referrer in cross-origin requests
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Enforce HTTPS for 2 years (preload-eligible)
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  // Note: CSP is deferred — Firebase SDK + next-intl require careful inline-script handling
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // WHICH COMMIT THIS BUNDLE IS, stamped in so `/api/health` can say it.
  //
  // `NEXT_PUBLIC_*` is inlined at BUILD time on both the server and the client,
  // which is exactly the property that makes the answer trustworthy: it reports
  // what the served bundle was COMPILED from, not what the running container's
  // environment happens to say today.
  //
  // Resolved by `scripts/lib/commitSha.mjs`, which also reports WHICH source
  // answered — App Hosting documents no build-time commit variable, so whether
  // its buildpack image keeps a `.git` (or a `git` binary) is something only a
  // real deploy can settle. `commitSource` in the health payload is how.
  //
  // Both keys are omitted entirely when nothing could be resolved; `?? null` at
  // the read end turns that back into an honest "unknown".
  env: commitEnv(path.join(__dirname, '..', '..')),
  // Pin the workspace root to THIS monorepo checkout. Without it, Next infers
  // the root from the nearest lockfile — inside a git worktree
  // (.claude/worktrees/*) it finds the parent checkout's pnpm-workspace.yaml
  // and module resolution breaks ("Module not found" for installed packages).
  turbopack: { root: path.join(__dirname, '..', '..') },
  rewrites: emulatorRewrites,
  // NOTE: the bare-root → /login redirect is intentionally NOT a config redirect.
  // Config redirects run outside the middleware, so their Location keeps the
  // leaked Cloud Run :8080 port and can't be corrected — a bare demo.linyup.com/
  // then breaks. It lives in src/proxy.ts instead, where the port-fix applies.
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default withNextIntl(nextConfig)
