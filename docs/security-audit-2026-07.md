# Security audit — Linyup — 2026-07

> **RECORD — audit run 2026-07; not re-run since.** Findings are stated as they
> were on that date and many have shipped. This file stays in `docs/` (not the
> archive) because other documents cite its findings by number — notably
> `app-check-rollout.md`, which depends on finding #3 — so the numbering must keep
> resolving. **Verify any finding against the code before acting on it.**

A full read-through of every externally reachable surface of the Linyup platform:
Firestore rules (~1,260 lines), Storage rules, all Cloud Functions exports, every public
web route, contact/passwordless auth, the operator console, mobile auth, secret hygiene,
and CI/CD. `teamId` is the tenant boundary and — because there is no server middleware in
the web app and team/owner provisioning is done by direct client-side Firestore writes —
security rests almost entirely on the Firestore/Storage rules plus Cloud Function
validation. The platform handles real money across four payment rails (Stripe Connect
member→studio, BYO Payrexx, BYO Stripe, Linyup SaaS billing) plus one-off course/drop-in
checkouts, so the payment paths received the closest scrutiny.

**Headline:** the payment money-integrity controls are sound (server-side price lookup,
server-computed platform fee, HMAC-verified idempotent webhooks, entitlements written from
webhook events only). The issues found were in tenant isolation, contact-PII exposure, and
input handling — not in amount tampering. Payment-rail code changes were held for
per-item sign-off; everything else in the "Fixed" column below has been applied on branch
`claude/codebase-security-analysis-eujhge`.

Severity: **H** = exploitable / cross-tenant or money impact · **M** = meaningful weakness
or hardening gap · **L** = low-risk / defense-in-depth.

---

## Findings & status

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | H | Cross-tenant LIST on `courses`/`forms`/`documents` | ✅ Fixed |
| 2 | H | `createDropInCheckout` trusts client `authenticatedContactId` | ✅ Fixed |
| 2b | H | Same pattern missed in `bookSession` / `bookAppointment` | ✅ Fixed (2026-07-17) |
| 3 | M | App Check absent on all callables | ✅ Implemented (web provider + staged monitor→enforce on web-only callables) |
| 4 | M | Event-invitation tokens never expire + leak PII | ✅ Fixed |
| 5 | M | Unescaped user content in email HTML | ✅ Fixed |
| 6 | M | Brevo/inbound webhooks: non-constant-time token / secret in logs | ✅ Fixed |
| 7 | M | `sharesContactEmail` allowed unverified-email cross-tenant contact reads | ✅ Fixed |
| 8 | M | Operator authz was a hardcoded email allowlist | ✅ Fixed |
| 9 | M | Mobile stores refresh token in unencrypted AsyncStorage | ▶ Deferred (device-test required) |
| 10 | L | `completeSignup` didn't re-check the 6-digit code | ✅ Fixed |
| 11 | L | Deprecated world-readable `users/*` subcollections + `users_public` | ✅ Fixed |
| 12 | L | Storage `contacts/**` readable by any authenticated user | ✅ Fixed |
| 13 | L | Course-media storage read doesn't re-check subscription tier | ✅ Documented (by design) |
| 14 | L | Staging Firebase web API key hardcoded in CI | ✅ Fixed |
| 15 | L | Leftover prod token-exchange debug step | ✅ Fixed |
| 16 | L | `getInTouchForm` rate-limiter failed open | ✅ Fixed |
| 17 | L | `sendContactVerificationCode` existence-blind send + plaintext code | ▶ Accepted (rate-limited; noted) |

---

## Detail

### 1 — Cross-tenant LIST on authoring collections (H, fixed)
`firestore.rules` had `allow list: if isAuthed()` on `courses`, `forms`, and `documents`.
A `list` rule cannot reference `resource.data.teamId`, so the "Staff only" comment was not
enforced: any authenticated principal — a coach of an unrelated team, or a low-privilege
contact-session custom token — could list raw authoring docs (including unpublished drafts)
across every tenant. **Fix:** the list rules now require `isMemberOfResourceTeam(resource)`,
which references `resource.data.teamId`; Firestore therefore only permits a list whose query
is scoped `where('teamId','==', <team>)` and rejects any unscoped or cross-tenant list. The
admin authoring queries already carry that filter, so the change is transparent to the app.

### 2 — `createDropInCheckout` trusts client `authenticatedContactId` (H, fixed)
`booking/dropIn.ts` accepted a contact id from the request body and only checked the contact
exists and matches `teamId` — not that the caller *is* that contact (contrast the other
checkout callables, which derive the contact from the verified session). This was a
contact-id enumeration + "already covered" oracle and booking-on-behalf-of. **Fix:** the
callable now derives the contact solely from the verified contact-session token (shared
`optionalContactSessionFromRequest`, `utils/contactSession.ts`, unit-tested), falling back to
the `contactDetails` email/name path only when there is no session. The client-supplied
`authenticatedContactId` field was removed. The `optionalContactSession` duplicate in
`connect/payments.ts` was folded into the same shared helper. The web guest flow (which
already sent `contactDetails`) is unaffected.

### 2b — the same pattern in `bookSession` / `bookAppointment` (H, fixed 2026-07-17)
Finding #2 scoped itself to the *checkout* callables, so the two **booking** callables were
never swept — and they carried the identical flaw. Both accepted `authenticatedContactId`
from the request body and validated it only against an *optional* `verificationCodeId`:
omit the code and the `if` block was skipped entirely, so the contact was adopted having
been checked only for existence + `teamId` match, never that the caller *is* that contact.
Worse than the `dropIn` case, which merely opened a checkout: `bookSession` writes a real
booking and runs the paid-access gate **as the victim**, consuming their subscription
entitlement or burning a lesson credit from their pack.

Exploitation needs the victim's `contactId` — a random 20-char Firestore auto-ID that is
not published — so this was not mass-exploitable, but the blast radius opened the moment
any contactId leaked (a shared QR/screenshot, a stale export, a departed staffer, or any
future endpoint returning contact ids).

**Fix:** `verificationCodeId` is now **mandatory** whenever `authenticatedContactId` is
supplied; both callables throw `invalid-argument` otherwise. The audit's own remedy
(delete the field, derive from the session) does not apply here: the web OTP caller is
anonymous — `verifyBookingCode` returns contact data without minting a custom token — so
there is no session to derive from and the code must remain the proof. Signed-in callers
(mobile) send no `authenticatedContactId` at all and are identified by their contact
session. Every real caller already sent both fields, so no client changed.

### 3 — App Check (M, implemented — staged)
No `enforceAppCheck` existed anywhere; unauthenticated Firestore-writing callables were
defended only by per-IP hourly rate limits. **Implemented:** a reCAPTCHA Enterprise App Check
provider on the web client (`apps/web/src/lib/app-check.ts` + `AppCheckProvider`, mounted in
the locale layout; no-ops under the emulator or when the key is unset), and App Check on the
**web-only** public callables — `createDropInCheckout`, `createMembershipCheckout`,
`createProductCheckout`, `createCourseCheckout`, and `submitForm` — via
`enforceAppCheck: process.env.APP_CHECK_ENFORCE === 'true'` with a `monitorAppCheck()` log in
each (`utils/appCheck.ts`). **Ships in monitor mode** (`APP_CHECK_ENFORCE=false` in all
`.env.*`): missing tokens are logged, not rejected. Rollout: provision the reCAPTCHA key →
confirm `[appcheck-monitor]` logs show tokens → set `APP_CHECK_ENFORCE=true` (staging first).
`sendContactVerificationCode` is deliberately **excluded** because the Expo mobile app calls
it and cannot produce attestation tokens; mobile enforcement needs native App Check
(`@react-native-firebase/app-check` + an EAS dev build) as a separate phase. Turning
enforcement on is a staged, manual procedure — see the runbook:
[`app-check-rollout.md`](./app-check-rollout.md).

### 4 — Event-invitation tokens never expired + PII leak (M, fixed)
`events/index.ts` minted `crypto.randomBytes(32)` tokens with no expiry, and
`getEventInvitationDetails` (public, no auth) returned contact PII — so a leaked RSVP link
was a permanent PII read. Tokens were also reused across resends. **Fix:** invitation docs
now carry `expiresAt`, bounded to the event's end (+24h grace, falling back to start, then a
30-day cap); both public callables reject expired tokens; a fresh token is minted on every
(re)send, invalidating previously emailed links. Legacy invitations without `expiresAt` stay
valid (backward-compat) — a one-off backfill can stamp `expiresAt` on them if desired.

### 5 — Unescaped user content in email HTML (M, fixed)
Public-form answers (`forms/submitForm.ts`), contact names/email
(`auth/completeSignup.ts`), and event fields (`events/index.ts`) were interpolated
unescaped into email HTML — HTML/anchor/style injection into staff-read mail (no SMTP
header injection, since Brevo takes to/subject as separate fields). **Fix:** a shared
`escapeHtml` helper (`utils/html.ts`, unit-tested) is applied at every user-controlled
interpolation, and `buildEmailTemplate` escapes its title.

### 6 — Non-Stripe webhook auth (M, fixed)
`mail/handleBrevoWebhook.ts` compared its shared token with `!==` (non-constant-time) and
preferred the URL query param (log exposure). `automation/inboundWebhook.ts` logged the raw
secret key. **Fix:** the Brevo webhook now uses a hash-based constant-time compare
(`utils/secureCompare.ts`, unit-tested) and prefers the `x-webhook-token` header over the
query param; the inbound webhook no longer logs the secret. (All three Stripe webhooks
already verify HMAC correctly and were left as-is.)

### 7 — `sharesContactEmail` unverified-email reads (M, fixed)
The rule matched `request.auth.token.email == contact.email` without checking
`email_verified`. A Firebase email/password account registered with a victim's address
(but never verified) could therefore read that victim's contact record and all
subcollections across every team. **Fix:** the rule now additionally requires
`email_verified == true`, or — for passwordless contact sessions, whose custom tokens carry
no `email_verified` claim but are code-verified — a live (non-expired) contact session.

### 8 — Operator authz (M, fixed)
`apps/admin` gated operators on an email allowlist with a personal email hardcoded in
source (`operators.ts`). **Fix:** authorization now accepts a `saas_operator` custom claim
as the primary mechanism, falling back to the `OPERATOR_EMAILS` allowlist (set via
app-hosting config in every deployed environment); the hardcoded source default was
removed (emulator demo owners retained for local sign-in). Both the session-minting route
and `requireOperator()` use the claim-aware check.

### 9 — Mobile token storage (M, deferred)
`apps/mobile` persists the Firebase refresh token and session via
`getReactNativePersistence(AsyncStorage)` — unencrypted, readable on rooted/jailbroken or
backed-up devices. **Deferred, not fixed:** the correct fix is a custom persistence adapter
backed by `expo-secure-store` (Keychain/Keystore). `expo-secure-store` is not yet a
dependency, and SecureStore's ~2 KB Android value limit means the Firebase auth blob may
need chunking — this must be validated on real iOS + Android devices before shipping, which
cannot be done in a headless CI environment. Recommended as a tracked follow-up.

### 10 — `completeSignup` code re-check (L, fixed)
Completion trusted the stored `verified` flag keyed only by the client-held `codeId`.
**Fix:** the callable now also requires the 6-digit `code` and compares it constant-time
against the stored value (the 15-min expiry is intentionally *not* re-checked — verification
already enforced it, and completion may legitimately happen later). The web signup form was
updated to pass the verified code through.

### 11–12 — Rules tightening (L, fixed)
Deprecated `users/{id}/user_weekly_reports`, `.../sessions_tags`, `.../user_places`, and
`users_public` had bare `allow read;` with no code consumers — now owner+admin (or denied
for `users_public`). Storage `contacts/{contactId}/**` was readable by any authenticated
user — now scoped to the contact's own session or the owning team's staff (team resolved
from the contact doc, since the Storage path carries no `teamId`). `users/{id}/public_profile`
was intentionally left public (governed by the global `public_profile` rule).

### 13 — Course-media storage tier (L, by design)
Storage does not re-check the subscription tier on course media; a media URL is only
discoverable after passing the Firestore lesson read, which enforces the tier. This
assumption is documented in `storage.rules`. No change.

### 14–16 — CI + rate-limiter (L, fixed)
Staging Firebase web API key moved from hardcoded to `vars.STAGING_FIREBASE_API_KEY`
(set this Actions variable to match prod's convention). The temporary prod auth-debug step
was removed. `getInTouchForm`'s rate-limiter now fails closed (retryable 503) instead of
allowing the request through on a check error.

### 17 — Verification-code send (L, accepted)
`sendContactVerificationCode` emails a code to any address for any team regardless of
whether a contact exists (a rate-limited spam/enumeration oracle) and stores the code in
plaintext (relying on rules to block reads). Accepted as low-risk given the 5/hour limit;
noted for awareness.

---

## Confirmed-strong controls (no action)
- **Payment amount integrity:** public checkouts never accept a client amount; prices are
  looked up server-side by id and validated (`connect/payments.ts`, `booking/dropIn.ts`).
  Manager callables accept an amount but the platform fee is always server-computed from
  plan tier, so the platform cut can't be shrunk.
- **Stripe webhooks:** Connect / SaaS / BYO-team all verify HMAC, load secrets from Secret
  Manager, reject bad/missing signatures, and are idempotent. Entitlements are written from
  webhook events only, never from client checkout-success.
- **Contact code hygiene:** 6-digit `crypto.randomInt`, 15-min expiry, 5/hour send limit,
  5-attempt verify burn; `buildContactSession` re-verifies the email owns the contact.
- **Secrets:** Google Secret Manager with a short cache; nothing hardcoded; `.gitignore`
  covers keys/env/service-accounts; no service-account JSON tracked.
- **CI/CD:** keyless OIDC/WIF deploys, no `pull_request_target`, no `github.event.*`
  interpolated into `run:` steps, destructive reseeds gated behind `workflow_dispatch`.
- **Team invitations & bio-link auth_tokens:** 32-byte tokens, 7-day expiry, role-gated
  issuance, expiry + used checks on redemption.

## Recommended follow-ups
- Add an emulator-backed rules test suite (`@firebase/rules-unit-testing`) asserting: a
  foreign-team authed user and a contact-session token are both denied LIST on
  courses/forms/documents; `sharesContactEmail` denies an unverified-email caller. (Not
  added here to avoid a new test-infra dependency mid-audit; rules were validated to
  compile via the emulator and reviewed manually.)
- Land App Check (finding 3) with a staged log-only rollout.
- Land the mobile SecureStore migration (finding 9) with device testing.
- Provision the `saas_operator` custom claim for operators and, once done, consider removing
  the email-allowlist fallback (finding 8).
