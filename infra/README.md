# Linyup Infrastructure as Code

Terraform that provisions the Firebase/GCP plumbing for Linyup's **staging** and
**production** environments, plus keyless CI deploys via Workload Identity
Federation (WIF).

> **Local development needs none of this.** Day-to-day work uses the Firebase
> emulators against the `demo-linyup` project (see the root `CLAUDE.md`). This
> directory is only for standing up real cloud environments.

---

## Ownership boundary — what Terraform owns vs the Firebase CLI

Two tools touch the same project, so the split is deliberate and
non-overlapping. Rule of thumb: **Terraform creates the empty box; the Firebase
CLI fills it.**

| Terraform owns (slow-moving plumbing) | Firebase CLI owns (fast-moving, repo-versioned) |
|---|---|
| Project creation + billing link | Functions **code** (`firebase deploy --only functions`) |
| API/service enablement | Firestore **rules + indexes** (`firestore.rules`, `firestore.index.json`) |
| Service accounts + IAM | Hosting **content** (`apps/web/.next`, `apps/landing/dist`) |
| Secret Manager **containers** (no values) | Storage **rules** (`storage.rules`) |
| Firestore **database instance** (not rules/indexes) | Realtime DB **rules** (deny-all, unused) |
| Firebase project init + Web App + Hosting **sites** | **Cloud Tasks queue** `executeDelayedRule` (auto-created on deploy) |
| App Hosting API + deploy SA role (`roles/firebaseapphosting.admin`) | App Hosting **backend** creation (CLI, once) + GitHub repo connection (Console, once) |
| Firebase Storage **default bucket** (not rules) | |
| WIF pool/provider + CI deploy SA | |
| Budgets/alerts + TF state bucket | |

The Cloud Tasks queue is **not** in Terraform:
`packages/functions/src/automation/executeDelayedRule.ts` is an
`onTaskDispatched` handler, and Firebase auto-provisions its queue on deploy.

---

## Layout

```
infra/
├── bootstrap/            # run ONCE: TF state bucket + WIF + CI deploy SA (local→GCS state)
├── modules/
│   ├── project-services/ # API enablement
│   ├── firebase-project/ # firebase project + web app + hosting sites (google-beta)
│   ├── firestore/        # database instance only (location LOCKED to europe-west6)
│   ├── storage/          # default Firebase Storage bucket (location LOCKED to europe-west6)
│   ├── secrets/          # secret containers + accessor IAM (no values)
│   ├── iam/              # functions runtime SA + deploy SA project roles
│   └── budget/           # billing budget + alerts
└── environments/
    ├── staging/          # wires modules for linyup-staging  (state prefix env/staging)
    └── prod/             # wires modules for linyup-prod      (state prefix env/prod)
```

State lives in **one GCS bucket** with per-stack prefixes (`bootstrap`,
`env/staging`, `env/prod`).

---

## Prerequisites

- Terraform >= 1.7, `gcloud`, and the GitHub CLI (`gh`).
- A **billing account** ID (`gcloud billing accounts list`).
- A bootstrap/admin project (e.g. `linyup-admin`) created by hand once.

### Organization?

A GCP **Organization** is optional and only exists if you use Google Workspace
or Cloud Identity on a domain. A **personal Google account has no org**
(`gcloud organizations list` returns empty) — that is the assumed setup here:

- Leave `org_id` and `folder_id` **unset** in `terraform.tfvars`; projects are
  created under "No organization".
- The operator who runs the bootstrap/apply just needs to be able to create
  projects (default for the account that owns billing) and `roles/billing.user`
  on the billing account. There is no org-level IAM to grant.
- Note the per-account **project-creation quota** is low (~12–30); fine for a
  two-project SaaS. For production hardening, consider a free Cloud Identity org
  on `linyup.com` later so ownership isn't tied to a personal Gmail — then set
  `org_id` and re-apply.

---

## Runbook

### 1. Bootstrap (once, by a human, local state)

```bash
cd infra/bootstrap
cp terraform.tfvars.example terraform.tfvars   # fill in bootstrap_project_id, org_suffix
gcloud auth application-default login          # as a principal with the perms above
terraform init                                 # backend.tf is commented → local state
terraform apply
```

Then migrate bootstrap state into the new bucket:

```bash
# Uncomment backend.tf and set bucket = <tf_state_bucket output>
terraform init -migrate-state
```

Record the outputs — you'll need them everywhere:

```bash
terraform output            # tf_state_bucket, wif_provider, ci_deploy_sa_email
```

### 2. Per-environment apply (staging shown; repeat for prod)

```bash
cd infra/environments/staging
# Edit backend.tf: set bucket = <tf_state_bucket>
cp terraform.tfvars.example terraform.tfvars   # project_id, billing_account, deploy_sa_email
terraform init
terraform plan
terraform apply
```

If the first apply fails on a Firebase/Firestore resource right after the APIs
were enabled (enablement is async), just **re-run apply**, or target services
first: `terraform apply -target=module.services` then a full apply.

### 3. Populate secret values (out-of-band, per env)

Terraform creates empty secret containers; values are added with `gcloud` so
plaintext never enters Terraform state:

```bash
echo -n "<value>" | gcloud secrets versions add stripe-secret-key     --project=linyup-staging --data-file=-
echo -n "<value>" | gcloud secrets versions add stripe-webhook-secret --project=linyup-staging --data-file=-
echo -n "<value>" | gcloud secrets versions add smtp-password         --project=linyup-staging --data-file=-
echo -n "<value>" | gcloud secrets versions add posthog-api-key       --project=linyup-staging --data-file=-
```

Secret IDs follow the convention in `packages/functions/src/utils/secrets.ts`:
`stripe-secret-key` → runtime env `STRIPE_SECRET_KEY` (hyphens→underscores,
uppercased). **Rotation** = add a new version with the same command.

### 4. Wire up GitHub (once)

```bash
# From the bootstrap outputs:
gh secret set GCP_WIF_PROVIDER --body "$(cd infra/bootstrap && terraform output -raw wif_provider)"
gh secret set GCP_DEPLOY_SA    --body "$(cd infra/bootstrap && terraform output -raw ci_deploy_sa_email)"
# Production may reuse the same SA, or set a dedicated one:
gh secret set GCP_PROD_DEPLOY_SA --body "<prod deploy SA email>"

# Public Firebase config → GitHub Actions VARIABLES (not secrets):
cd infra/environments/staging
gh variable set STAGING_FIREBASE_API_KEY     --body "$(terraform output -json firebase_web_config | jq -r .api_key)"
gh variable set STAGING_MESSAGING_SENDER_ID  --body "$(terraform output -json firebase_web_config | jq -r .messaging_sender_id)"
gh variable set STAGING_APP_ID               --body "$(terraform output -json firebase_web_config | jq -r .app_id)"
# Repeat with PROD_* from infra/environments/prod for production.
```

### 5. Confirm hosting targets (Firebase CLI, once)

The site IDs Terraform created must match `.firebaserc`. Apply the target map:

```bash
firebase target:apply hosting app     linyup-staging         --project staging
firebase target:apply hosting landing linyup-staging-landing --project staging
```


### 5b. Set up Firebase App Hosting backend (once, per env)

The Next.js web app runs on **Firebase App Hosting** (Cloud Run-backed SSR),
not Firebase Hosting (static). A backend must be created once per environment.

#### Create the backend via CLI

```bash
# Staging -- firebaseapphosting.googleapis.com must be enabled first (terraform apply)
npx firebase-tools apphosting:backends:create \\
  --project linyup-staging \\
  --app 1:157648925506:web:5e3aa70930d777f8374edb \\
  --backend linyup-web \\
  --primary-region europe-west4 \\
  --root-dir apps/web \\
  --non-interactive
```

> **Region:** Use **europe-west4** (Netherlands) to keep the web tier in the EU,
> close to Firestore/Functions in europe-west6. App Hosting does **not** run in
> europe-west6 itself; europe-west4 is the nearest supported EU region. (Older
> backends were created in `us-central1` because no EU region existed then — see
> "Moving an existing backend to the EU" below.) The full supported-region list:
> <https://firebase.google.com/docs/app-hosting/about-app-hosting#locations>.

#### Connect the GitHub repo (Firebase Console -- one-time manual step)

1. Go to **Firebase Console** -> select linyup-staging -> **App Hosting**
2. Click the linyup-web backend -> **Connect repository**
3. Authorize the Firebase GitHub App and select **francodgstn/dgstn-linyup**
4. Set **Branch**: main, **Root directory**: apps/web

Connecting the repo is what makes a backend *buildable*; whether a push actually
ships it depends on the environment — see [What ships on what](#what-ships-on-what)
below. **Staging** leaves App Hosting's automatic rollouts on, so every push to
main deploys the web app with no CI step. **Sandbox and prod turn them off** and
roll out explicitly from their workflows instead.

The apps/web/apphosting.yaml file controls the Cloud Run instance (CPU, memory, scaling, env vars).

### What ships on what

One table, three environments. Backend = Cloud Functions + Firestore/Storage
rules; web app = the App Hosting SSR backends (`linyup-web`, plus `linyup-admin`
on staging and prod).

| Env | Trigger | Backend | Web app | Approval |
|---|---|---|---|---|
| **staging** | push to `main` | `deploy.yml` | App Hosting auto-rollout, in parallel | none |
| **sandbox** | push a `sandbox-*` tag | `deploy-sandbox.yml` | `apphosting:rollouts:create` in the same job, **after** the backend | required reviewer |
| **prod** | push a `v*` tag | `deploy-prod.yml` | `apphosting:rollouts:create` in the same job, **after** the backend | required reviewer |

Both tag-driven workflows keep `workflow_dispatch` as an escape hatch for
re-running a half-failed deploy without minting a throwaway tag.

Why sandbox and prod sequence the rollout rather than letting App Hosting fire:
an automatic rollout races the backend deploy, so the frontend can go live ahead
of the functions and rules it calls. Rolling out `--git-commit $GITHUB_SHA` from
inside the job also pins the exact commit, so a concurrent merge to `main` can't
slip into the release. Sandbox additionally hosts live prospect demos, so it must
never change unattended — it is *expected* to drift behind `main`, and you tag it
when you're ready:

```bash
# what hasn't shipped to sandbox yet
git log --oneline $(git describe --tags --abbrev=0 --match 'sandbox-*')..origin/main
git tag sandbox-$(date +%F) && git push origin sandbox-$(date +%F)
```

Turning automatic rollouts **off** is a Console setting, not a repo one — see the
prerequisite note under [6. Enable CI](#6-enable-ci) below. It is written for prod
but applies verbatim to the sandbox `linyup-web` backend, which also has them off.

#### Grant the App Hosting backend access to secrets

```bash
npx firebase-tools apphosting:secrets:grantaccess firebase-api-key \\
  --project linyup-staging --backend linyup-web
```

#### Moving an existing App Hosting backend to the EU

A backend's `--primary-region` is **immutable** — you cannot relocate the
`us-central1` backends in place. Moving to **europe-west4** means standing up a
new backend alongside the old one and cutting the custom domain over:

1. **Create a new backend in europe-west4** with a distinct ID (e.g.
   `linyup-web-eu`), same `--app` / `--root-dir`, per the create command above.
2. **Connect the GitHub repo** to it (Console → Connect repository, branch `main`,
   root dir `apps/web`) and, for prod, set its **Environment name** to `prod`.
3. **Grant secret access** (`apphosting:secrets:grantaccess …`) on the new backend.
4. **Trigger a rollout** — `apphosting:rollouts:create <backend> --project <alias>
   --git-commit <sha>`, or a push to main if that backend still has automatic
   rollouts on (staging only) — and verify the
   `<backend>--<project>.<region>.hosted.app` URL serves correctly.
5. **Cut the custom domain over**: remove it from the old backend, add it to the
   new one, update the DNS records it prints, and re-add it under Authentication →
   Authorized domains if it changed.
6. **Delete the old us-central1 backend** once traffic is confirmed on the EU one.

Do the same for `linyup-admin`. There is **no zero-downtime in-place move**; plan a
short cutover window. Firestore/Functions (europe-west6) are unaffected.

### 5c. Operator console — apps/admin App Hosting backend (once, per env)

The internal **operator console** (`apps/admin`, `@linyup/admin`) is a SEPARATE
App Hosting backend in the same project, on its own domain (e.g. `ops.linyup.com`).
Unlike `apps/web`, it **writes** Firestore (`app_settings/global_settings` via the
Settings page) and **writes** the `smtp-password` secret, so it must run as the
**dedicated `linyup-admin` service account** — created with all its IAM by
Terraform — instead of the shared `firebase-app-hosting-compute` SA. This keeps
those elevated grants off the customer web app's identity.

```bash
# The SA + its roles already exist after `terraform apply`:
terraform output -raw admin_runtime_sa
#   → linyup-admin@<project>.iam.gserviceaccount.com

# Create the backend (root-dir apps/admin). Set its runtime SA to linyup-admin:
npx firebase-tools apphosting:backends:create \
  --project linyup-staging \
  --app <WEB_APP_ID> \
  --backend linyup-admin \
  --primary-region europe-west4 \
  --root-dir apps/admin \
  --service-account "$(terraform output -raw admin_runtime_sa)" \
  --non-interactive
```

> If your firebase-tools version has no `--service-account` flag, create the
> backend normally, then set the service account in **Firebase Console → App
> Hosting → linyup-admin → ⚙ Settings → Service account → `linyup-admin@…`**.

Then connect the GitHub repo (Console, root directory `apps/admin`, branch `main`)
exactly as for `linyup-web` above. The `OPERATOR_EMAILS` + public
`NEXT_PUBLIC_FIREBASE_*` config are already set in `apps/admin/apphosting.yaml`
(staging) and `apphosting.prod.yaml` (prod) — for a prod backend, set its
**Environment name** to `prod` (Console → App Hosting → backend → settings) so the
prod overrides apply, mirroring `apps/web`.

**No `apphosting:secrets:grantaccess` is needed** for the SMTP password — Terraform
already grants `linyup-admin` `secretVersionAdder` on `smtp-password` (write). The
console never reads the value back (it tracks a `password_set` flag in Firestore).

### 5d. Cloudflare — tenant custom domains (NOT SET UP)

Direction only; nothing below exists yet. Feature design: `docs/custom-domains.md`.

Tenants bring their own hostname (`book.theirdojo.ch`) for their public surfaces.
App Hosting custom domains are a manual per-domain operation (§5b, §6) and cannot
serve this — **Cloudflare for SaaS** (custom hostnames) can: one API call per
tenant hostname, Cloudflare issues and renews the cert.

**PRODUCTION ONLY.** Custom domains are wired on `linyup-prod` and nowhere else —
one Cloudflare zone has one fallback origin, so sandbox/staging would each need
their own domain, token and Worker deploy. Off-prod the studio card and this
console both say so, and `registerPublicDomain` refuses server-side. Everything
below therefore applies to the prod project alone. See `docs/custom-domains.md` →
"Environments".

**The SaaS zone is `linyup.com`** — its DNS moves from OVH to Cloudflare
(registrar stays OVH; only the nameservers change). Child-zone delegation
(`sites.linyup.com` alone) is **Enterprise-only**, and a separate single-purpose
domain was considered and rejected — reasoning in `docs/custom-domains.md`.

**Moving the zone is NOT proxying it.** Every record that exists today is
recreated **grey-cloud / DNS-only**, where Cloudflare is a plain authoritative DNS
host and behaves identically to OVH. Only the two new records are proxied.

```
Step 0 — migration preconditions (in this order, before flipping NS)
  a) DISABLE DNSSEC at OVH. If the DS record is live when the nameservers
     change, the domain goes dark until it clears. This is the step that bites.
  b) Export the zone from OVH; add linyup.com to Cloudflare; verify the import
     record-for-record BEFORE flipping — especially MX (mx*.mail.ovh.net,
     inbound redirection) and the Brevo SPF/DKIM/DMARC TXT. The scan is good,
     not perfect.
  c) Confirm in the OVH panel that email redirection keeps working with the
     zone hosted elsewhere (docs/email-inbound.md). Expected to be fine —
     redirection follows MX, not zone hosting — but verify, don't assume.
  d) Everything pre-existing = grey cloud. The App Hosting records especially:
     App Hosting manages its own certs and proxying them breaks that.
  e) Flip the nameservers at OVH. Re-verify MX + TXT resolve after propagation.

Cloudflare (once, per environment)
  1. enable Cloudflare for SaaS on the zone
  2. deploy the router Worker (infra/workers/tenant-router) on a `*/*` route
  3. origin.linyup.com   proxied (AAAA 100::); set as FALLBACK ORIGIN
  4. connect.linyup.com  proxied CNAME → origin.linyup.com
        the public target tenants CNAME to. Published separately from the
        fallback origin ON PURPOSE: it is the one string we can never change
        once it is in tenants' DNS, so the origin behind it stays swappable.
  5. API token scoped to "SSL and Certificates: Write" on this zone only →
     Secret Manager as `cloudflare-api-token` (set it in the operator console,
     Settings → Domains). NOT `DNS: Edit` — the feature never writes a DNS
     record, and withholding it is what keeps the mail records out of reach.
  6. Cloud Functions params: CLOUDFLARE_ZONE_ID + CLOUDFLARE_CNAME_TARGET.

⚠ NEVER PROXY (orange-cloud) A linyup.com RECORD. Only `origin` and `connect`
   are proxied; everything else — apex, app, app-stg, demo, ops, ops-stg, the
   mail CNAMEs, the DKIM selectors and the `_acme-challenge_*` authorizations —
   stays DNS-only.
   On 2026-08-21 every proxyable record was proxied at once. The web hosts went
   down (the Worker refused them; it passes them through now), DKIM broke because
   proxying FLATTENS a CNAME, and the certificate authorizations were flattened
   the same way. `assertZoneRecordsUnproxied` in the daily tasks now alarms on
   it — the invariant used to be enforced by this paragraph alone.

Per tenant (automatic — the app, not an operator)
  registerPublicDomain → POST /zones/{id}/custom_hostnames
     { hostname: "book.theirdojo.ch", custom_metadata: { teamId, slug } }
  the studio adds ONE record at their registrar:
     CNAME  book → connect.linyup.com
```

The Worker reads `request.cf.hostMetadata`, rewrites `/shop` →
`/public/{slug}/shop`, and forwards to the App Hosting host with the original host
preserved in a header. **App Hosting is untouched** — no new custom domain, no new
authorized domain, no cert work on the Google side.

### 6. Enable CI

**Staging — auto from `main`.** Merge to `main` → `.github/workflows/deploy.yml`
runs a keyless deploy of functions/rules/landing, and the **staging** App Hosting
backends (web + admin) auto-roll out from `main` via their GitHub connection. Fast
feedback; no gate.

**Sandbox — tag when you're ready.** `deploy-sandbox.yml` fires on a `sandbox-*`
tag (or a dispatch), waits on the `sandbox` environment's required reviewer, then
deploys functions/rules and rolls out the `linyup-web` App Hosting backend at the
tagged commit. Nothing lands on a merge to `main` — the environment hosts live
prospect demos, so it drifts behind `main` by design. Demo *data* is only touched
by a dispatch with the reseed box ticked, and even then `lead-*` tenants survive.

**Production — one gated release, everything in lockstep.** `deploy-prod.yml`
(manual `workflow_dispatch` or a `v*` tag, gated on the `production` GitHub
environment's required reviewer) deploys functions/rules/landing **and** triggers
the App Hosting rollout for web + admin (`apphosting:rollouts:create … --git-commit
$GITHUB_SHA`). So the prod web app can never ship ahead of the backend it calls.

> **Prerequisite — disable auto-rollout on the PROD *and SANDBOX* App Hosting
> backends.** For the gate to mean anything, the prod `linyup-web` +
> `linyup-admin` and the sandbox `linyup-web` backends must NOT auto-deploy on
> push. In **Console → App Hosting → backend → ⚙ Settings → Deployment /
> rollouts**, turn **automatic rollouts off** (leave the GitHub repo connected —
> manual rollouts still build from it). Leave staging backends on auto-rollout.
>
> The setting is not exposed by the CLI or the App Hosting REST API — a backend
> with rollouts disabled reads identically to one without — so verify it
> empirically: push to `main` and confirm no new rollout appears under
> `apphosting:rollouts:list` (or that the backend's `updateTime` stays put).
>
> The deploy SA needs `firebaseapphosting.admin` **plus two
> Developer Connect roles** to create rollouts: `apphosting:rollouts:create …
> --git-commit` resolves the commit through the git repository link
> (`developerconnect.admin` → `gitRepositoryLinks.get` + `fetchGitRefs`) and
> fetches a repo read token (`developerconnect.readTokenAccessor` →
> `gitRepositoryLinks.fetchReadToken`, which `admin` does NOT include).
> `firebaseapphosting.admin` covers neither, so without both it 403s — first on
> `.get`, then on `:fetchReadToken`. All three roles are in the deploy SA's
> `deploy_sa_roles` (`infra/modules/iam/variables.tf`) — run `terraform apply`
> on each project after adding the Developer Connect roles. (Sandbox already had
> them at the time it went tag-driven, verified against the live IAM policy; no
> apply was needed there.)

---

## Billing budget — what it guards, and what it does not

`modules/budget` attaches one monthly budget per environment, filtered to that
project, with alert rules at 50 / 90 / 100 % of **actual** spend plus one at
100 % of **forecast** spend. Two things are worth knowing before trusting it.

**It covers the GOOGLE bill only.** Firestore, Functions, App Hosting /
Cloud Run, Storage egress, Cloud Tasks, Vertex AI, Cloud Translation. It does
**not** see Brevo or Stripe, which are separate vendors billed separately — and
per `docs/scalability-2026-09.md` §12 Brevo is the *second-largest* COGS line at
scale (~$2,500–4,000/month at a thousand studios, against a few hundred dollars
of Google spend). So the budget is not a cap on what the business costs to run;
it is a runaway detector for the Google part. Watch Brevo's own dashboard for
the other half.

**A budget with no named channel still mails somebody — just not anybody this
repo names.** GCP's default is to mail whoever holds Billing Account
Administrator/User. The budget now also routes to the same ops-email channel as
the error and uptime alerts, and keeps the billing-admin default on top (a cost
runaway is the one alert where two independent paths to a human is right).
`terraform output budget_alerts_named_recipient` answers it honestly:

```bash
cd infra/environments/prod
terraform output budget_amount                     # the ceiling
terraform output budget_alerts_named_recipient     # false = billing admins only
terraform output monitoring_alerting_enabled       # false = nothing pages anyone
```

Both recipient outputs hang off the same `alert_email` in `terraform.tfvars`, so
setting it once fixes errors, uptime AND budget alerts together.

### Picking `budget_amount`

Default **500 CHF/month** (`variables.tf`). The number only does work if it is
close to reality, because the first actual-spend alert fires at half of it:

- **Set it from the last full month's Google spend, not from a forecast of the
  business.** Console → Billing → Reports, filtered to the project. Round up to
  give a few times headroom and no more.
- **A ceiling far above the real bill detects nothing.** At 500 CHF the first
  alert lands at 250 CHF spent; if the real bill is single-digit, something has
  gone 25× wrong before anyone hears. Pre-launch, a much lower ceiling is
  strictly better — it is an early-warning line, not a spending permission.
- **Raise it deliberately as tenants arrive**, and re-check after anything that
  changes the egress or invocation shape. The forecast rule is what gives you
  mid-month warning; the actual-spend rules are the record.
- A budget **does not stop spending** — nothing here caps anything. The per-
  function `maxInstances: 20` and App Hosting's `maxInstances` are the actual
  ceilings.

---

## Sandbox environment (demo playground)

`linyup-sandbox` is a throwaway environment that powers the public `/try` page:
six fully-seeded **Studio** demo tenants (sport + wellness) with one-click logins.
It uses the same modules as staging — only `project_id`, hosting site IDs and the
budget differ — plus two demo-specific switches.

**It is not actually throwaway any more.** It also hosts `lead-*` tenants — real
prospect demos we show to prospective customers — which is why it is deployed
like prod rather than like staging: manual `sandbox-*` tags, an approval gate, and
no automatic rollout. Two consequences worth internalising:

- **`pnpm sandbox:reset` preserves `lead-*` tenants.** It wipes only the `/try`
  playground. `--include-leads` overrides that; `--dry-run` previews the counts;
  it asks for a typed confirmation (`--yes` in CI). To tear down ONE lead, use
  `pnpm lead:seed --lead <id> --reset` instead.
- **Lead *data* never flows through CI.** Lead profiles are gitignored (they hold
  real prospect business data, and this repo is public), so seeding is local-only
  from a machine with ADC. No tag or workflow can reseed a prospect demo.

See `CLAUDE.md` → "Sandbox safety model" and `scripts/leads/README.md`.

```bash
# 1. Provision the project (same flow as staging)
cd infra/environments/sandbox
# backend.tf already points at prefix env/sandbox; tfvars set project_id=linyup-sandbox
terraform init
terraform apply        # re-run if Firebase resources fail once (async API enablement)

# Step 1 also creates the default Firebase Storage bucket (europe-west6) via the
# storage module — no manual Console/curl step needed.

# 1b. Deploy backend rules/indexes/functions. This first one is by hand; from then
#     on .github/workflows/deploy-sandbox.yml does it — but only when you push a
#     `sandbox-*` tag and approve the run, NOT on a push to main (the sandbox
#     hosts live prospect demos; see "What ships on what"). A fresh Firestore DB
#     ships locked (deny-all), so the client sees nothing until the repo rules
#     are deployed:
firebase deploy --only firestore,storage,functions --project sandbox

# 2. Secrets (same IDs as staging; demo can reuse test Stripe/SMTP keys)
echo -n "<value>" | gcloud secrets versions add stripe-secret-key --project=linyup-sandbox --data-file=-
#   …repeat for stripe-webhook-secret, smtp-password, smtp-encryption-key, posthog-api-key

# 3. Hosting targets (must match .firebaserc)
firebase target:apply hosting app     linyup-sandbox         --project sandbox
firebase target:apply hosting landing linyup-sandbox-landing --project sandbox

# 4. App Hosting backend. Fill apphosting.sandbox.yaml's REPLACE_WITH_* values
#    (and pass the web app id to --app) from:
cd infra/environments/sandbox && terraform output -json firebase_web_config
#    NOTE: firebase-tools has no --environment flag on create; set the backend's
#    "Environment name" to `sandbox` afterwards in the Console (App Hosting →
#    linyup-web → ⚙ Settings → Environment name) so apphosting.sandbox.yaml
#    applies (NEXT_PUBLIC_DEMO_MODE=true + sandbox Firebase config).
npx firebase-tools apphosting:backends:create \
  --project linyup-sandbox --app <WEB_APP_ID> --backend linyup-web \
  --primary-region europe-west4 --root-dir apps/web --non-interactive

# 5. Seed the six demo Studio tenants (ADC; idempotent — sandbox:reset to wipe first)
pnpm sandbox:seed

# 6. Custom domain — the public demo lives at https://demo.linyup.com/try.
#    a) Firebase Console → App Hosting → linyup-web (sandbox) → Custom domains →
#       add `demo.linyup.com`; set the DNS records it prints at the registrar.
#    b) Firebase Console → Authentication → Settings → Authorized domains →
#       add `demo.linyup.com` (required even for email/password sign-in).
```

The demo MUST be served from this sandbox deployment (it's built against the
`linyup-sandbox` Firebase project). It cannot live under `linyup.com/try` — that
build targets `linyup-prod`, where the demo accounts/data don't exist, and `/try`
404s there by design (`NEXT_PUBLIC_DEMO_MODE` is unset on prod).

Demo logins (all `linyup123`, plan `studio`/`active`): `grappling@`, `crossfit@`,
`tennis@`, `yoga@`, `pilates@`, `dance@` `linyup.com`.

> **Auto-reseed** (nightly wipe + reseed) is a deferred follow-up — for now reseed
> manually with `pnpm sandbox:reset` then `pnpm sandbox:seed`.

---

## How to…

- **Add a secret** → add the ID to `secret_ids` in the env stack (or the module
  default), `terraform apply`, then `gcloud secrets versions add` the value. Use
  it in code via `getSecret('my-secret')`.
- **Add a Firestore index** → edit `firestore.index.json` and deploy with the
  Firebase CLI. **Not** Terraform.
- **Add a Cloud Tasks queue** → write an `onTaskDispatched` function; Firebase
  creates the queue on deploy. **Not** Terraform.
- **Ship to sandbox** → `git tag sandbox-$(date +%F) && git push origin sandbox-$(date +%F)`,
  then approve the run in the Actions tab. Merging to `main` does nothing on its
  own. Check what's pending first with
  `git log --oneline $(git describe --tags --abbrev=0 --match 'sandbox-*')..origin/main`.
- **Ship to prod** → push a `v*` tag (or dispatch `deploy-prod.yml`) and approve.
- **Re-run a half-failed deploy** → dispatch the workflow from the Actions tab
  rather than minting a throwaway tag. That is also where the sandbox reseed
  checkbox lives.

---

## Gotchas

- Every `google_firebase_*` resource uses the **google-beta** provider.
- **App Hosting region** is immutable after backend creation. Create new backends in **europe-west4** (nearest supported EU region; europe-west6 itself is still unsupported). The firebaseapphosting.googleapis.com API must be enabled (via terraform apply) before creating the backend. To relocate a backend that was created in `us-central1`, see "Moving an existing App Hosting backend to the EU" below.
- **App Hosting vs Hosting**: apps/landing uses Firebase Hosting (static, deployed by CI); apps/web uses App Hosting (SSR, built from the connected GitHub repo). App Hosting's automatic rollout is ON for staging only — sandbox and prod have it off and roll out from their workflows instead ("What ships on what").
- **Sandbox lags `main` on purpose.** It only ships when you push a `sandbox-*` tag and approve the run. If a demo is missing a fix that's already merged, that's why — tag it.
- Firestore **location is immutable** — `europe-west6` is locked on first apply
  (`prevent_destroy` + `deletion_policy = ABANDON`). Choose deliberately.
- Storage **bucket location is immutable** — same `europe-west6` lock + `prevent_destroy`.
- If the default Storage bucket already exists (created manually via Console or
  the REST API), **import** it before applying:
  `terraform import module.storage.google_storage_bucket.default <project_id>.firebasestorage.app`
  and
  `terraform import module.storage.google_firebase_storage_bucket.default projects/<project_id>/buckets/<project_id>.firebasestorage.app`.
- API enablement is **async** — re-run apply if Firebase resources fail once.
- Hosting `site_id`s must equal `.firebaserc` exactly (`linyup-staging`,
  `linyup-staging-landing`, `linyup-prod`, `linyup-prod-landing`).
- The deploy SA needs `iam.serviceAccountUser` **on the runtime SA** (granted in
  `modules/iam`) or gen2 function deploys fail with an `actAs` error.
- `id-token: write` permission is mandatory in the deploy workflows for WIF.
- **Never** put secret values in Terraform — containers only.

---

## Disaster recovery

- The state bucket has **object versioning** enabled; a corrupted/lost state can
  be restored from a prior generation.
- `prevent_destroy` guards the project, Firestore DB, Storage bucket, and state
  bucket against accidental `terraform destroy`.
- Re-creating an environment from scratch = re-run the per-environment apply
  against a fresh project ID, then re-populate secrets and re-deploy via CI.
