---
title: Go-live readiness 2026-08
description: "Go-live readiness — first pass, August 2026"
status: record
area: ops
---
# Go-live readiness 2026-08

Closes the **irreversible-harm** class of the readiness plan. Everything here is
merged (PRs #74, #75, #76) and, where it is infrastructure, applied and verified
against GCP rather than against Terraform state.

The starting point was a ~40% confidence read: the product is strong, the
scaffolding around it was close to absent. This pass fixed the scaffolding.

---

## What shipped

**Backups.** Firestore PITR and a daily backup schedule on all three projects,
plus `delete_protection_state` — `prevent_destroy` and `deletion_policy` only
stop Terraform; that flag stops a human in the Console. Prod retains 14 weeks,
sandbox and staging 7 days (their data is reseedable). Applied and confirmed via
`gcloud firestore databases describe`.

**Deploy gates.** `storage` was missing from `deploy-prod.yml`'s `--only` list
while staging and sandbox both had it, so `storage.rules` had never reached
production through the pipeline. `verify.yml` ran on pull requests only, so a
release tag could ship code that had never been typechecked or tested — it now
exposes `workflow_call` and both deploys `needs:` it. On prod the checks run
BEFORE the environment approval. `main` is branch-protected with those five
checks; `enforce_admins` is deliberately false as an escape hatch.

**Observability.** Nothing made a production failure reach a human.
`withErrorReporting()` reports unhandled throws to Cloud Error Reporting and
rethrows unchanged; it is applied at the boundary of both payment webhooks, and
deliberately does NOT report expected `HttpsError` codes — a rate limiter
refusing a flood is an outcome, not a bug. `infra/modules/monitoring` adds the
log metric, uptime check, alert policies and an email channel; alerting is live
on all three projects. `/api/health` on web and admin reports the resolved
Firebase project id.

**Ops console → Health.** Per-environment deep links into Error Reporting,
scoped logs, alerting, rollouts, index state and Stripe delivery, led by the
incident order. Native GCP has no branded inbox; this is the answer to "where
does that surface?".

**`purgeTeam` got an invocation path.** It was fully built but not re-exported,
with no callable and no script, so seven data-safety checkboxes described
something nobody could run. Now `pnpm purge:team` — dry-run by default,
`--project` never inferred, and the team's NAME shown before the typed
confirmation, because a mistyped id that happens to exist is the real failure.

**`.claude/agents/ops-agent/`** — there is no deploy documentation in this repo,
so that file is now it: safety rules, environment map, release/hotfix/restore
runbooks, and the traps each of the above came from.

Also: Terraform state drift reconciled (three resources existed in GCP but not in
state, so *every* apply exited non-zero); Facebook dropped as a sign-in provider;
all GitHub Actions moved off the deprecated Node 20 runtime.

---

## Corrections worth remembering

Three things the earlier assessment got wrong, all because a document was trusted
over the code:

- **UX-1 was already shipped.** It was ranked as a top blocker from the review's
  headline prose; the status table and the code both said fixed. `docs/` here is
  a **log, not a status board**.
- **Rate limiting already existed, and is better than described.** Every public
  callable is covered, with per-surface prefixes and a peek-don't-spend variant
  for the waitlist. The App Check gap is materially less severe than stated.
- **`stripe-sync` reported another project's endpoint as its own.** Sandbox and
  staging share one Stripe test account, and `.find()` returned the first match
  by function name. It produced a confident, wrong conclusion before the script
  was fixed.

---

## Left over

**Blocking a real customer:**

| | |
|---|---|
| Restore rehearsal | PITR is on, but no restore has been performed. "We have backups" and "we can restore" are different claims and only one is testable. Needs a scratch project. |
| ToS + DPA | Neither exists; `privacy.md` §2.9 promises a DPA twice. Longest external clock — a lawyer reviewing a template beats drafting from scratch by 5–8 business days. |
| Unaided walkthrough | 93 of 98 "fixed" UX findings are typecheck-only and no contact-persona runtime run has ever happened. Budget three days for what it finds. |
| Prod Stripe | No `stripe-secret-key` version exists. `api_version` drift on the existing endpoints needs an endpoint recreation (new signing secrets). Prod endpoints created fresh will start on the correct version. |

**Operational:**

- **Cloud Run CPU quota, `europe-west6`.** Staging has ~202 services against ~80
  functions and its deploys now fail consistently. It is a deadlock: the deploy
  exhausts quota, errors, prints "Skipping deletes", and the stale services that
  caused it are never cleaned up. **This is not the per-minute 429 that converges
  on re-dispatch.** Prod is at ~153 and on the same curve.
- **Auth providers are hand-configured per project** — `google_identity_platform_config`
  carries `ignore_changes = [..., sign_in]`, so nothing in the repo records that
  they must be set. Prod had zero providers, which is why sign-in failed with
  `auth/operation-not-allowed`. Apple and email-link are still unconfigured
  everywhere, i.e. dead buttons.
- **Alerting depends on `alert_email`** in each gitignored `terraform.tfvars`.
  Check with `terraform output monitoring_alerting_enabled`, never by looking at
  a green metric.

**Accepted, written down:** the BYO Stripe double-count (detection shipped, the
structural fix deliberately rejected); Stripe handler params typed `any`; no web
test coverage beyond one planned E2E path; `purgeTeam` leaves the Stripe Connect
account live; sandbox has no SaaS-billing endpoint (billing is tested from
staging only).

---

## Next

Seed alignment — **done** (PRs #80/#81/#82); the schema reference is
[`../seed-truth-2026-08.md`](../seed-truth-2026-08.md), and the closed plan is
archived at [`../archive/seed-alignment-plan.md`](../archive/seed-alignment-plan.md).
It matters more than it looks: the launch model is sandbox→promote, and a
founder's sign-off is only worth something if the sandbox data reflects the
current schema.
