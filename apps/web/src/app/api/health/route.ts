// The permanent answer to "which project is this deployment actually talking to?"
//
// That question was expensive once already: `apphosting.prod.yaml`'s own comment
// claimed App Hosting selects it by BACKEND ID, when selection is really by the
// backend's ENVIRONMENT NAME. If that name is unset, the app silently builds
// from the base `apphosting.yaml` — which points at STAGING — and production
// customers land on the wrong Firebase project with nothing on screen to say so.
// Answering it meant a Console visit and trusting what you found. Now it is a
// GET.
//
// NEXT_PUBLIC_* values are inlined at BUILD time, so what this route reports is
// what the served bundle was actually compiled against — not what the runtime
// environment happens to say today. That is precisely the property that makes it
// a useful check.
//
// Also the target for the uptime check in `infra/modules/monitoring`, and the
// smoke step after a deploy.
//
// SAFE TO EXPOSE: every value here is public client config that already ships in
// the JavaScript bundle, plus Cloud Run's own revision labels. Never add a
// secret, a service-account detail, or anything read out of Firestore — this
// route is unauthenticated by design, because an uptime check cannot log in.
import { NextResponse } from 'next/server'

// Never prerender: a health route baked at build time reports the build host's
// view of the world forever.
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      app: 'web',
      // The load-bearing field.
      firebaseProject: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? null,
      usingEmulators: process.env.NEXT_PUBLIC_USE_EMULATORS === 'true',
      // Cloud Run sets these on every App Hosting revision, so "which code is
      // live" needs no build-time plumbing of our own.
      revision: process.env.K_REVISION ?? null,
      service: process.env.K_SERVICE ?? null,
      // THE COMMIT THIS BUNDLE WAS BUILT FROM. Stamped at build time by
      // `next.config.ts` via `scripts/lib/commitSha.mjs`; null when the build
      // could not work it out, which is honest rather than a guess.
      commit: process.env.NEXT_PUBLIC_COMMIT_SHA ?? null,
      // WHERE THAT SHA CAME FROM — 'env', 'git', 'git-file', or null.
      //
      // Not noise: App Hosting documents no build-time commit variable, so
      // whether its buildpack image keeps a `.git` (or a `git` binary) can only
      // be settled by a real deploy. This field is that answer, and the reason
      // nobody has to read a build log to find out why `commit` is null.
      commitSource: process.env.NEXT_PUBLIC_COMMIT_SOURCE ?? null,
      time: new Date().toISOString(),
    },
    // An uptime check and a CDN must never serve a cached "ok".
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
