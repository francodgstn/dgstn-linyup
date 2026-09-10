# Data safety checklist

Goal: make "we got it wrong" (bad migration, misconfigured setup) **recoverable**,
and keep the messy validation off production. Do §1 **before any prod customer
data lands**.

---

## 1. Backups + Point-in-Time Recovery (do first — highest leverage)

- [x] Enable Firestore **PITR** (7-day window) on `linyup-prod` (and `linyup-staging`) — verified 2026-09-10 with `gcloud firestore databases describe --database="(default)" --project=linyup-prod`: `POINT_IN_TIME_RECOVERY_ENABLED`, `versionRetentionPeriod: 604800s`, `DELETE_PROTECTION_ENABLED`, plus a daily `backupSchedules` entry with 98-day retention (`gcloud firestore backups schedules list`). Staging identical. Both come from `infra/modules/firestore` defaults (`enable_pitr`, `enable_daily_backup`) — check GCP, not the tf state, which is known to drift.
- [ ] Schedule **daily managed exports** to a dedicated GCS bucket
- [ ] Set the bucket lifecycle/retention policy (decide retention — see open items)
- [ ] Document + dry-run the **restore runbook**:
  - **Full restore** — import a managed export into a scratch project, verify, then into prod if needed
  - **Single-tenant partial** — export → fix offline → import only the affected `teamId` docs
- [ ] Test a restore into a scratch project at least once so the runbook is proven, not theoretical

> PITR alone converts most "got it wrong" cases from catastrophe to a restore.

---

## 2. Tenant data topology (single source of truth)

All tenant-scoped data locations are registered in **one** manifest:
`packages/shared/src/tenantData.ts` (`TENANT_DATA_COLLECTIONS`,
`PLATFORM_COLLECTIONS`, `RETIRED_TOP_LEVEL_COLLECTIONS`, the team-doc subtree and
the Storage prefix helper).

- A **completeness test** (`packages/functions/src/saas-billing/tenantData.test.ts`)
  fails CI if a new top-level `*_COLLECTION` isn't classified — so tenant data
  can't silently leak out of teardown/export as the schema grows.
- **Status: built.** ✅

When you add a new top-level collection: classify it in `tenantData.ts`
(tenant vs platform) or the test will fail. That is the intended guard rail.

---

## 3. Per-team "reset account" tool — `purgeTeam`

`purgeTeam(teamId, dryRun)` lives in
`packages/functions/src/saas-billing/index.ts`. It is **manifest-driven**: it
iterates `TENANT_DATA_COLLECTIONS`, recursively deletes each match (incl.
subcollections), removes the `teams/{teamId}` subtree + Storage prefix, and writes
a best-effort `team_audits` entry.

**Status:**
- ✅ Firestore + Storage teardown, manifest-driven, dry-run, audit log
- ⚠️ **External provider teardown is NOT automated yet.** `connect_accounts` is
  flagged `externalTeardown: 'stripe_connect'` and `purgeTeam` logs a warning —
  the Stripe Connect account + its member subscriptions (and any SaaS subscription)
  must still be cancelled/disconnected **manually** at Stripe. *(TODO: automate.)*
- ⏳ **TODO:** wrap as an admin-only callable + CLI; add a **soft-reset** variant
  (keep team + members, clear content) for QA reuse.

### Usage

- [ ] **Always dry-run first** — it logs per-collection counts, deletes nothing:
      call `purgeTeam(teamId, true)`.
- [ ] Review the counts; confirm they match expectations for that team.
- [ ] Run for real: `purgeTeam(teamId, false)`.
- [ ] **Manually** cancel/disconnect the team's Stripe Connect account + subscriptions
      and any SaaS subscription (until external teardown is automated).
- [ ] Confirm the `team_audits` entry was written.

### Verify (recommended in `linyup-sandbox`)

- [ ] Seed a throwaway team → `purgeTeam(teamId, true)` lists every manifest collection
- [ ] `purgeTeam(teamId, false)` → re-query each manifest collection → **zero residual docs**

> Whole-environment resets (not per-team) already exist for non-prod:
> `scripts/reset-sandbox-db.ts` / `reset-staging-db.ts` (guarded, `--confirm`).
> Never run these against prod.

---

## 4. Tenant data export (GDPR + pre-change snapshot)

- ⏳ **TODO:** build an **export** counterpart to `purgeTeam` on the **same
  manifest** (serialize all tenant data → JSON + a Storage file manifest → GCS /
  downloadable). Needed for GDPR data-subject requests regardless, and doubles as
  a per-tenant snapshot to take **before** any risky change to a founder's data.

Until then, the "snapshot before risky change" fallback is a **managed export**
(§1) taken immediately before the change.

---

## Done when

PITR + scheduled exports enabled and a restore proven into a scratch project ·
manifest-completeness test green · `purgeTeam` dry-run lists every manifest
collection and a real run leaves zero residual docs in sandbox · export tool
shipped (or the managed-export fallback documented for founders).
