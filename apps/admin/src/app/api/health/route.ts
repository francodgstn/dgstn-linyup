// Which project this operator console is pointed at — see the header of
// `apps/web/src/app/api/health/route.ts` for why this exists at all.
//
// It matters MORE here than on the customer app. This console flips messaging
// policies, overrides plans and reads tenant data with the Admin SDK; being
// wrong about which project it is attached to is the difference between a demo
// tweak and a production change. The sidebar already shows the target, but the
// sidebar is behind an operator login and an uptime check cannot log in.
//
// UNAUTHENTICATED by design, so it reports the project id and Cloud Run's
// revision labels and NOTHING else — no operator emails, no tenant data, no
// service-account detail.
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export function GET() {
  const usingEmulators =
    process.env.USE_FIREBASE_EMULATORS === 'true' || !!process.env.FIRESTORE_EMULATOR_HOST

  return NextResponse.json(
    {
      status: 'ok',
      app: 'admin',
      // Mirrors the resolution order in lib/firebase-admin.ts, so this reports
      // what the Admin SDK actually attached to rather than a second guess.
      firebaseProject:
        process.env.FIREBASE_PROJECT_ID ??
        process.env.GOOGLE_CLOUD_PROJECT ??
        process.env.GCLOUD_PROJECT ??
        null,
      usingEmulators,
      revision: process.env.K_REVISION ?? null,
      service: process.env.K_SERVICE ?? null,
      // THE COMMIT THIS BUNDLE WAS BUILT FROM, and where the build got it —
      // 'env', 'git', 'git-file', or null. The revision above names a BUILD;
      // this names the CODE. Stamped by next.config.ts via
      // scripts/lib/commitSha.mjs; see apps/web's route for the full reasoning.
      commit: process.env.NEXT_PUBLIC_COMMIT_SHA ?? null,
      commitSource: process.env.NEXT_PUBLIC_COMMIT_SOURCE ?? null,
      time: new Date().toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
