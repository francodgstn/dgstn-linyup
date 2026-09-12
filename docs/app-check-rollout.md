# App Check rollout runbook

Firebase App Check is **implemented but not turned on**. This is the one-time procedure to
enable it, done when you're ready — it is intentionally a manual, staged flip because turning
enforcement on before the client can produce tokens locks out real users.

See finding #3 in [`security-audit-2026-07.md`](./security-audit-2026-07.md) for the why.

## Current state (as shipped)

App Check is inert today — nothing is rejected:

- **Web** — `initAppCheck()` (`apps/web/src/lib/app-check.ts`, mounted via `AppCheckProvider`
  in the locale layout, provider `ReCaptchaEnterpriseProvider`) **no-ops** unless
  `NEXT_PUBLIC_FIREBASE_APPCHECK_RECAPTCHA_KEY` is set,
  and it is always skipped under the emulator. With no key, the browser sends no token — and
  no deployed environment sets one yet: the slot sits commented out in
  `apps/web/apphosting{,.prod,.sandbox}.yaml`, ready for step 2.
- **Functions** — `APP_CHECK_ENFORCE=false` in every `packages/functions/.env.*`, so
  `monitorAppCheck()` (`packages/functions/src/utils/appCheck.ts`) only **logs**
  `[appcheck-monitor] <fn>: request without a valid App Check token`. Nothing is blocked.

## Scope (what enforcement covers)

`APP_CHECK_ENFORCE=true` enforces on every callable that declares
`enforceAppCheck: APP_CHECK_ENFORCE`. **Derive that set by grep — never from a list here.**
This section previously named "five web-only callables" and claimed
`sendContactVerificationCode` was "explicitly excluded", while the code enforced neither
claim: the auth callables declared the *same* flag, and there were nine web declarers, not
five. To see the current web-enforced set:

```bash
grep -rn 'enforceAppCheck: APP_CHECK_ENFORCE' packages/functions/src | grep -v _MOBILE
```

**The mobile-reachable callables are on a SEPARATE flag, by construction.**
`sendContactVerificationCode` and `loginContactWithCode` — the student app's only login path,
which the Expo JS SDK cannot attest — declare `enforceAppCheck: APP_CHECK_ENFORCE_MOBILE`
(default false), so `APP_CHECK_ENFORCE=true` **cannot** reach them. That set is likewise
grep-derived and pinned by `packages/functions/src/auth/appCheckMobile.test.ts`, which fails
the build if any callable the mobile app calls ever ends up on the bare web flag. Mobile
enforcement is the separate `APP_CHECK_ENFORCE_MOBILE` flip (see Caveats).

## Staged rollout — do these in order

> ⚠️ Never do step 4 before step 2 is live and confirmed (step 3). Enforcing while the web
> client is not yet sending tokens rejects every legitimate web request.

1. **Register App Check in the Firebase Console.** App Check → your **Web app** → register
   with **reCAPTCHA Enterprise**. This produces an Enterprise **site key** (public — safe to
   embed) linked to the project. Do this for the **staging** project first.

   The two APIs it needs — `firebaseappcheck.googleapis.com` and
   `recaptchaenterprise.googleapis.com` — are declared in `infra/environments/*/main.tf`, so
   `terraform apply` for the environment enables them ahead of the registration. If the
   Console still offers to enable one, that environment has not been applied since they were
   added; enabling it there is harmless and Terraform will converge.

   **Enterprise, not plain v3 — this matters to the client code.** The Console no longer
   offers reCAPTCHA v3 for a new web registration, and `apps/web/src/lib/app-check.ts` uses
   `ReCaptchaEnterpriseProvider` to match. The two are not interchangeable: an Enterprise key
   handed to `ReCaptchaV3Provider` fails at token exchange, and the symptom is "no token
   arrives" — indistinguishable from having configured no key at all.

2. **Give the web client the key (staging).** Uncomment the
   `NEXT_PUBLIC_FIREBASE_APPCHECK_RECAPTCHA_KEY` block in **`apps/web/apphosting.yaml`**
   (that file is staging; `apphosting.prod.yaml` and `apphosting.sandbox.yaml` carry the
   same commented block), fill in the site key, and redeploy web. The browser now attaches
   App Check tokens to callable requests. (`APP_CHECK_ENFORCE` is still `false`, so this
   changes nothing user-facing yet.)

   ⚠️ **Keep `availability: [BUILD, RUNTIME]`** — BUILD is the load-bearing half.
   `NEXT_PUBLIC_*` is inlined into the JS bundle at build time, so a key supplied only at
   runtime (a variable added in the Console without BUILD, for instance) never reaches the
   browser: `initAppCheck()` reads `undefined`, no-ops, and the client sends no token. The
   failure is silent and looks exactly like a bad registration — which is what step 3 below
   would then have you conclude. If step 3's warnings do not fall, check that the key is in
   the *bundle* before re-doing the registration: open the deployed app and run
   `performance.getEntriesByType('resource').some(r => r.name.includes('recaptcha'))` in the
   console, or grep the served JS for the key.

   Only `apps/web` needs it. The operator console and the landing site call none of the
   enforced callables, and the member app's two are on the mobile flag (see Scope above) —
   verify rather than trust this: `grep -rl '<callable>' apps/*/src`.

3. **Watch the monitor logs.** In Cloud Functions logs, filter for `[appcheck-monitor]`. On
   real staging traffic through the web-enforced callables (grep above), these warnings should
   drop to ~zero as clients start sending valid tokens. If they persist, the web
   key/registration is wrong — fix before proceeding.

4. **Flip enforcement (staging → prod).** Set `APP_CHECK_ENFORCE=true` in
   `packages/functions/.env.staging` (the neighbouring `APP_CHECK_ENFORCE_MOBILE` stays
   `false` — it is a separate decision, see Caveats), redeploy functions, and smoke-test a
   drop-in checkout + a form submission. When staging is clean, repeat steps 1–2 for the
   **production** project (register App Check, set the prod web key) and set
   `APP_CHECK_ENFORCE=true` in `.env.production`.

To roll back at any point: set `APP_CHECK_ENFORCE=false` and redeploy functions (back to
monitor mode instantly). The web key can stay set — it's harmless without enforcement.

## Caveats

- **reCAPTCHA false positives.** It scores requests; a small fraction of real users can be
  rejected. Watch error rates after step 4; keep the rollback (above) handy.
- **reCAPTCHA Enterprise is a billed product**, unlike the plain v3 this started out on — it
  has a free monthly assessment allowance and per-assessment pricing above it (check the
  current Google Cloud pricing page; do not trust a figure quoted in a doc). The volume is
  driven by token MINTS, not by callable invocations: `isTokenAutoRefreshEnabled: true` means
  roughly one assessment per browser session per token lifetime, not one per checkout. Worth
  a glance at the bill after the prod flip all the same, alongside the budget alert.
- **Mobile is not covered, and cannot be flipped on by accident.** The mobile-reachable
  callables sit behind their own `APP_CHECK_ENFORCE_MOBILE` flag (default false), so the web
  flip above leaves them alone. Enforcing them needs native attestation —
  `@react-native-firebase/app-check` (Play Integrity / App Attest) plus an EAS **dev build**
  (not Expo Go) — and only *then* set `APP_CHECK_ENFORCE_MOBILE=true`. Adding a new callable the
  mobile app will call? Put it on `APP_CHECK_ENFORCE_MOBILE`, not `APP_CHECK_ENFORCE`;
  `auth/appCheckMobile.test.ts` fails the build if a mobile-reachable one is on the web flag.
- **Local testing.** To exercise App Check locally against a real project, set the optional
  `NEXT_PUBLIC_FIREBASE_APPCHECK_DEBUG_TOKEN` (register the printed debug token in the Firebase
  console). Never set it in production.
