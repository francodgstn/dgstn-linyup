# Launch readiness

Operational checklists for taking Linyup live — and for onboarding the first
~5 **founder** studios without rushing a risky go-live.

## The model: sandbox → promote

We do **not** validate on production. Each founder is set up and validated in the
**`linyup-sandbox`** project (Stripe **test** mode, Brevo test sender). Once the
founder signs off on their own data and configuration, we **promote** their team
to **`linyup-prod`** (live providers) and they go live.

```
linyup-sandbox (test mode)            linyup-prod (live)
  ┌───────────────────────┐  sign-off   ┌────────────────────┐
  │ import / set up data  │  ─────────▶  │ promote team       │
  │ white-glove config    │             │ live Connect onboard│
  │ founder test purchase │             │ controlled 1st charge│
  └───────────────────────┘             └────────────────────┘
```

### Decisions locked

| Decision | Choice |
|---|---|
| Founder onboarding model | **Sandbox → promote** (validate in `linyup-sandbox`, then promote to `linyup-prod`) |
| Live member payments at launch | A short **validation window without live payments is acceptable** |
| Founder data source | **Mix** — some migrate existing data (HMD/CSV), some start fresh |

The model rests on two safety nets so "we got it wrong" is always recoverable:
backups (PITR + scheduled exports) and a per-tenant **reset/export** capability.

## Status

[`readiness-2026-08.md`](./readiness-2026-08.md) — what the first readiness pass
shipped (backups, deploy gates, observability, tenant purge) and what is still
open. Read it before working through the checklists below: several of their
boxes are already done, and three claims in the wider `docs/` tree were found to
be stale against the code.

## Checklists

| Doc | Use it for |
|---|---|
| [`provider-wiring-checklist.md`](./provider-wiring-checklist.md) | Proving Stripe / Brevo / Payrexx are wired correctly — sandbox QA, then one controlled live smoke test in prod. |
| [`data-safety-checklist.md`](./data-safety-checklist.md) | Backups (PITR + exports), restore runbook, and the per-team **reset** tool (`purgeTeam`). Run before any prod customer data lands. |
| [`founder-onboarding-runbook.md`](./founder-onboarding-runbook.md) | The per-founder sandbox→promote runbook + sign-off template + rollback. The day-to-day playbook for the first 5. |

## Suggested order

1. **Backups first** (`data-safety` §1) + **secrets/config** (`provider-wiring` §1) — cheapest, highest safety.
2. **Sandbox QA sweep** (`provider-wiring` §2–3) — prove every provider path in test mode.
3. **Reset/export tooling + pilot flag** (`data-safety` §3, `founder-onboarding` §TODOs).
4. **Controlled prod smoke + alerting** (`provider-wiring` §4–5).
5. **Onboard founders** one at a time via the runbook.

## Related references

- [`../payment-contact-studio.md`](../payment-contact-studio.md) — contact → studio (Stripe Connect + BYO gateways)
- [`../payment-studio-linyup.md`](../payment-studio-linyup.md) — studio → Linyup SaaS billing + test setup
- [`../stripe-catalog.md`](../stripe-catalog.md) — the Stripe catalog (`stripe:sync`)

> These checklists are distilled from the launch-readiness plan. Re-verify exact
> secret names, function params and CI workflows against the live infra as you go —
> the **status** of each codebase capability (built vs TODO) is called out inline.
