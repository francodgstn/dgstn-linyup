import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import app from './firebase'

// Firebase App Check (reCAPTCHA Enterprise) for the web client. Attests that
// requests to enforced Cloud Functions come from our real app, not a script.
//
// ENTERPRISE, not the plain v3 this started as: the Firebase Console no longer
// offers reCAPTCHA v3 when registering a web app for App Check, so the key a
// registration produces today is an Enterprise site key and only
// ReCaptchaEnterpriseProvider can exchange it. Feeding an Enterprise key to
// ReCaptchaV3Provider fails at token exchange, which surfaces as the same "no
// token" symptom as having no key at all — see docs/app-check-rollout.md.
//
// Still a PUBLIC key, still safe to embed. The API it needs
// (recaptchaenterprise.googleapis.com) is enabled in infra/environments/*.
//
// No-op unless we're in the browser, outside the emulator, and a site key is
// configured — so local dev, preview builds, and any deploy where the key isn't
// provisioned yet are unaffected (and never throw). Enforcement on the callables
// is a separate, deploy-time flag on the functions side (APP_CHECK_ENFORCE); wire
// this up and confirm tokens flow before turning enforcement on.
let initialized = false

export function initAppCheck(): void {
  if (initialized || typeof window === 'undefined') return
  if (process.env.NEXT_PUBLIC_USE_EMULATORS === 'true') return

  const siteKey = process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_RECAPTCHA_KEY
  if (!siteKey) return

  // Optional: register a debug token for testing against a real project locally.
  const debugToken = process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_DEBUG_TOKEN
  if (debugToken) {
    ;(globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      debugToken
  }

  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(siteKey),
    isTokenAutoRefreshEnabled: true,
  })
  initialized = true
}
