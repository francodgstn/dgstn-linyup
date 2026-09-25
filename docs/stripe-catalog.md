---
title: Stripe catalog
description: Stripe catalog — declarative
status: living
area: payments
order: 4
---
# Stripe catalog

The **whole catalog** (subscription plans **and** plugin add-ons) is defined
**in the repo** and applied to Stripe idempotently, so test and prod stay
reproducible.

## Source of truth
- Plans → `PLAN_PRICING` in `packages/shared/src/types/plan.ts`
  (`{ baseMonthly, stripeLookupKey }`).
  The **Free plan has `stripeLookupKey: null` by design** — it is never billed,
  has no Stripe product/price, and the sync script skips it. Teams land on Free
  via trial expiry or subscription cancellation, never via checkout.
- Add-ons → `PLUGIN_ADDONS` in `packages/shared/src/types/plugin-addons.ts`
  (`{ coachPriceMonthly, stripeLookupKey }`).
- Studio contact block → `STUDIO_CONTACT_BLOCK` in
  `packages/shared/src/types/plan.ts`
  (`{ size: 300, monthly: 10, stripeLookupKey: 'linyup_studio_contact_block_monthly' }`).
  A Studio team that grows past its included cap buys room in flat **+300
  blocks** (Stripe quantity = number of blocks) — there is **no per-contact
  metering**. Coach over its cap is prompted to upgrade to Studio instead; Free
  is a hard cap. See `contactOverageForPlan`.
- _Removed:_ the legacy per-student overage (`linyup_extra_student_monthly`) and
  its `syncContactOverage` scheduled function were retired when pricing moved to
  the block model — there is no per-contact metering. Any
  `linyup_extra_student_monthly` price already created in a Stripe account is now
  orphaned (safe to archive in the Stripe dashboard); the sync script no longer
  manages it.

These same maps drive the web UI, the billing Cloud Functions, and the sync
script — one definition, no drift. Lookup-key convention: `linyup_<plan>_monthly`,
`linyup_addon_<pluginId>_monthly`, and `linyup_studio_contact_block_monthly`.

## Sync
`scripts/stripe-sync.ts` (`pnpm stripe:sync`) provisions a Stripe Product +
recurring monthly Price for each entry, keyed by `lookup_key`:

| State | Default action | With `--reprice` |
|---|---|---|
| lookup key missing | create Product + Price | create |
| present, same amount | no-op | no-op |
| present, **different** amount | **drift warning only — left unchanged** | new Price + `transfer_lookup_key` |

Repricing is opt-in so a routine sync can never silently change a live price.
`transfer_lookup_key` only affects **new** checkouts; existing subscriptions keep
their current price until changed explicitly.

```bash
# dry-run (prints planned changes, no writes)
STRIPE_SECRET_KEY=sk_test_... pnpm stripe:sync
# create any missing products/prices
STRIPE_SECRET_KEY=sk_test_... pnpm stripe:sync --apply
# also re-point lookup keys where the repo amount differs from live
STRIPE_SECRET_KEY=sk_test_... pnpm stripe:sync --apply --reprice

# (PowerShell) pull the key from Secret Manager instead of typing it
$env:STRIPE_SECRET_KEY = (gcloud secrets versions access latest --secret=stripe-secret-key --project=linyup-staging).Trim()
pnpm stripe:sync --apply
```

Run once per environment (test, then prod) whenever the catalog changes.

> The base plan amounts in `PLAN_PRICING` are **indicative placeholders**. If your
> live plan prices already exist with real amounts, the default sync leaves them
> untouched (you'll just see `! drift` lines). Set the repo values to match live,
> or pass `--reprice` deliberately when you actually want to change a price.

The script approach was chosen for full in-house control and reuse of the
existing `lookup_key` convention.
