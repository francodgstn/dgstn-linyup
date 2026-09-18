---
title: Founder onboarding
description: Founder onboarding runbook (first 5)
status: living
area: ops
order: 7
---
# Founder onboarding

The day-to-day playbook for onboarding a founder studio under the
**sandbox → promote** model. Run it **once per founder**. White-glove throughout.

Prereqs (one-time, before any founder): the
[provider-wiring checklist](./provider-wiring-checklist.md) sandbox sweep is green,
and the [data-safety checklist](./data-safety-checklist.md) §1 (backups) is done.

---

## Capabilities this runbook depends on

| Capability | Status |
|---|---|
| Tenant-data manifest + per-team `purgeTeam` reset | ✅ built (`packages/shared/src/tenantData.ts`, `saas-billing/index.ts`) |
| `linyup-sandbox` project + guarded reset script | ✅ exists (`.firebaserc`, `scripts/reset-sandbox-db.ts`) |
| Migration framework (dry-run / `--verify` / `--from-team`) | ✅ exists (`scripts/migration/*`, `scripts/migrate-hmd.ts`) |
| **`Team.flags.internal/pilot`** (exclude from metrics + exempt from trial auto-downgrade) | ✅ built — `Team.flags` (`packages/shared/src/types/team.ts`); gated in `handleTrialLifecycle` (`saas-billing/index.ts`) and `capturePlatformMetrics` (`analytics/platformMetrics.ts`) |
| **Per-team promote tool** (sandbox → prod, idempotent + verified) | ✅ built — `pnpm promote:team` (`scripts/promote-team.ts`), manifest-driven |
| External provider teardown in `purgeTeam` (Stripe cancel/disconnect) | ⏳ **TODO** — do manually for now |

> **Flag semantics** (`TenantFlags`, `packages/shared/src/types/team.ts` — the same
> type on a team and on an organisation):
>
> | Flag | Trial sweep | Platform metrics | MRR | Meaning |
> |---|---|---|---|---|
> | `internal` | exempt | **excluded** | — | Linyup-internal / synthetic tenant (the prod smoke-test studio). |
> | `pilot` | exempt | counted | counted | Founder mid-validation. **Temporary by construction.** The promote tool sets this on the target team. |
> | `comped` | exempt | counted | **excluded** | A real customer billed nothing, indefinitely. Sits on `plan_status: 'active'` with no Stripe subscription. |
>
> All three are read for the sweep through the ONE predicate
> `tenantExemptFromTrialSweep(flags)` — never spelled out at a call site, so a team
> and an org cannot answer it differently. `comped` is deliberately not `pilot`:
> a pilot ends, a comped arrangement does not, and overloading the flag would make
> "how many pilots do we have" unanswerable. It is deliberately not `internal`
> either — a comped customer's usage is real and belongs in every platform figure;
> only the revenue line excludes them, since no invoice exists.
>
> `comped_reason` and `comped_since` record *why* there is no subscription. Without
> them the first billing reconciliation reports the tenant as broken rather than as
> a decision somebody made. Operator-set only; never client-writable.
>
> `lapseOrganization` refuses outright on any exempt org, so a hand-run script
> cannot tear down a comped customer's site and studios.

---

## Phase A — Validate in sandbox (`linyup-sandbox`, Stripe TEST mode)

1. **Create the sandbox team.** Set `flags.pilot = true` so it can't lapse to Free
   mid-validation (the trial-downgrade job skips internal/pilot teams).
2. **Load data.**
   - *Migrating founder (HMD/CSV):* import **into sandbox first** using the
     migration framework — `--dry-run` then real, then `--verify` (counts +
     spot-checks). Keep the **source immutable** so it can be re-imported.
   - *Fresh founder:* set up from scratch in the admin.
3. **White-glove config:** Connect **test** account onboarding, email sender
   (managed or BYO), subscription types / products / courses, bio-link + shop.
4. **Founder review + test purchase.** The founder reviews **their own** data and
   config, and completes a **Stripe test-mode** purchase end-to-end.
5. **Written sign-off** (template below).

## Phase B — Promote to prod (`linyup-prod`, LIVE providers)

6. **Promote the team** sandbox → prod with `pnpm promote:team` — it copies the
   studio's content (team doc + subcollections, contacts/sessions/courses/products/
   …) but **excludes provider plumbing** (Stripe Connect account, member payments/
   subscriptions, SaaS billing, integration secrets), which is re-established live.
   Dry-run first, then run with `--verify` + `--confirm`; it marks the prod team
   `flags.pilot`:
   ```
   pnpm promote:team --team <id> --source-creds sandbox-sa.json \
     --target-creds prod-sa.json --dry-run --verify
   pnpm promote:team --team <id> --source-creds sandbox-sa.json \
     --target-creds prod-sa.json --verify --confirm \
     [--include-storage --source-bucket <b> --target-bucket <b>]
   ```
7. **Founder completes LIVE Connect onboarding** + the **controlled first real
   charge** (small, then refund) per the
   [provider-wiring checklist](./provider-wiring-checklist.md) §4.
8. **Go live.** Keep the sandbox copy until the founder confirms prod is good.

---

## Per-founder sign-off checklist (template)

Copy per founder.

```
Founder: ____________________   Date: __________   Env: linyup-sandbox

Data
[ ] Contacts present & correct (count: ____ ; matches source: ____)
[ ] Subscriptions / memberships configured
[ ] Products / courses configured (if selling)
[ ] Sessions / activities / events set up
[ ] No obvious migration artefacts or duplicates

Config
[ ] Connect (test) onboarding complete — charges_enabled
[ ] Email sender (managed or BYO verified) sends correctly
[ ] Bio-link + shop look right; links resolve

Validation
[ ] Founder completed a test-mode purchase end-to-end
[ ] Founder reviewed their own data and approves

Sign-off: founder ____________   operator ____________
Approved to promote to prod:  YES / NO
```

---

## Rollback

- **Bad data discovered after promote:** restore from PITR / managed export
  (data-safety §1), or re-run the idempotent **promote** from the immutable sandbox
  source.
- **Need to wipe and restart a team:** `purgeTeam(teamId, dryRun=true)` to preview,
  then real run (data-safety §3) — **plus** manual Stripe Connect / subscription
  teardown until automated.

---

## Blast-radius controls

- Small cohort, onboarded **one at a time**, white-glove.
- Set the expectation with founders that **data may be adjusted** during the pilot.
- Use per-team plan/feature gating to disable risky features for a founder if needed.

---

## Done when

The founder has signed off in sandbox, been promoted to prod with a clean verify
pass, completed live Connect onboarding + the controlled first charge, and is live —
with the sandbox copy retained until prod is confirmed.
