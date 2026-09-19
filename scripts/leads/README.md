# Lead demo tenants

A **lead** is a prospective customer we demo Linyup to. Each lead gets a dedicated
sandbox tenant that mirrors their **real public data** (schedule, offerings, pricing,
site copy, images — used with their permission) plus fully **synthetic contacts**
(invented names — never real client data).

## Seeding

```bash
# Cloud linyup-sandbox (via local ADC — gcloud auth application-default login):
pnpm lead:seed --lead swimli            # idempotent — re-runs overwrite in place
pnpm lead:seed --lead swimli --reset    # tear the lead's tenant down first

# Local emulator rehearsal — start the emulators first (incl. Storage, or image
# uploads are skipped), then --target emulator sets the host env vars for you:
pnpm lead:seed --lead swimli --target emulator

# ...equivalent to setting the hosts by hand (an already-set host wins):
FIRESTORE_EMULATOR_HOST=localhost:8080 \
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 \
FIREBASE_STORAGE_EMULATOR_HOST=localhost:9199 \
pnpm lead:seed --lead swimli
```

Never use `pnpm sandbox:reset` to clean up a lead — it wipes the six `/try`
playground teams too; `--reset` is lead-scoped.

Lead tenants are intentionally **not** listed on the public `/try` picker
(`apps/web/src/lib/demo.ts`) — access is via their direct logins (printed by the
seed) and `/public/{slug}` URLs.

For a persistent local snapshot: seed into running emulators, then
`pnpm emulators:export:swimli`; from then on `pnpm emulators:swimli` restores it
(including uploaded images — note the snapshot bakes `localhost:9199` URLs, so it
is for local rehearsal only).

### Seeding from a git worktree

The main checkout's lead folders and `.env.local` are the authority. A worktree
gets its copy once, when it is bootstrapped, and nothing refreshes it — so a
worktree created before a profile changed typechecks, and seeds, the old one.
The bootstrap hook and `node scripts/local-env.mjs status` print `LEADS` when the
copies differ; `node scripts/local-env.mjs init --refresh-leads` copies the
out-of-date files over and keeps anything edited in the worktree (name a lead,
`--refresh-leads swimli`, to overwrite that too). Details:
`.claude/skills/local-env/SKILL.md` → "Lead data drifts".

### Payments — "pay with Linyup" (Stripe Connect)

To let a seeded lead tenant take payments, wire an already-onboarded Stripe **test**
connected account (details: `docs/payment-contact-studio.md` → *Faster local setup*):

```bash
pnpm lead:seed --lead swimli --target emulator --connect acct_xxx
```

Precedence: `--connect` flag > `STRIPE_CONNECT_TEST_ACCOUNT` env >
`profile.stripeConnectTestAccount`. Omit all three to skip payments wiring. The account
must be onboarded once in Stripe test mode — grab its id with
`pnpm connect:test-account --list`. Because it wires the team's `payments` block +
`connect_accounts/{acct}`, `--reset` removes that doc along with the rest of the tenant.

**TWINT in the demo checkout**: payment methods come from the *connected account's*
payment-method configuration (not the platform's settings page). One-time setup per
test account — full walkthrough in `docs/payment-contact-studio.md` → *Enable TWINT on
a test connected account*; short version:

```bash
stripe payment_method_configurations list --stripe-account acct_xxx
stripe payment_method_configurations update pmc_xxx --stripe-account acct_xxx \
  -d "twint[display_preference][preference]=on"     # repeat per pmc_… returned
```

CHF one-off checkouts (drop-in, packs, products) then offer TWINT with a test-mode
Authorize/Fail simulator page — a nice touch in CH lead demos.

### Contact POV — sign in as a member (shop / Space)

To try the **member** experience (shop checkout, Space, courses, credit balance)
without a real inbox for each synthetic contact, flag one data-rich contact in the
profile with `demoLogin: true` (pick one with a subscription + credit pack +
bookings — the richest POV). The seeder adds the operator email
(`LEAD_OPERATOR_EMAIL`, default the maintainer's) to that contact's
`login_emails`; add the lead's own address via profile-level `demoLoginEmails`:

```ts
// profile.ts
contacts: [{ firstname: 'Priya', /* … */ demoLogin: true }, /* … */],
demoLoginEmails: ['hello@swimliclub.com'], // + operator, added automatically
```

Then sign in on `/public/{slug}/shop` (or `/space`) with the passwordless code,
using any allow-listed email. **Delivery of the code obeys the messaging policy**
(studio stream): under the default `redirect → operator` only the operator
receives codes, so for the lead to self-serve, switch the tenant policy to
`allowlist` including their address (operator console / `pnpm messaging:policy`).
`login_emails` is capped at 5.

## Adding a new lead

> **Lead folders are local-only.** Every `scripts/leads/{lead}/` folder (profile +
> assets) is gitignored via `scripts/leads/.gitignore`, so prospective-customer data
> never lands in the repo — only `README.md` and `types.ts` are tracked. Keep your
> lead folders on your machine (and back them up outside the repo). Seeding is
> **local-only** — run it from your machine with the profile + images present.

1. Create `scripts/leads/{lead}/profile.ts` exporting a `LeadProfile`
   (contract: `scripts/leads/types.ts`; the local `swimli` folder is the reference).
2. Optionally add images under `scripts/leads/{lead}/assets/` (see below).

Profile ground rules:

- **Every lead tenant carries a disclaimer.** The seeder stamps `lead_demo` on
  the team, and every public page (website, booking, shop, Space…) then shows a
  fixed bar at the bottom of the screen: "Demo by Linyup — this is not the
  official website of {teamName}", in the visitor's language. Set
  `officialWebsite` (https) in the profile so it links the real site. Only the
  seeder or an operator can remove it — the owner login cannot
  (`firestore.rules`, `tenantGovernanceUnchanged`).

- **Public data only** for the business side (schedule, pricing, copy, images),
  gathered with the lead's permission. Mark any invented/assumed values (e.g.
  unconfirmed prices) via `priceAssumed` + a `notes` entry so the demo never
  overstates what's real.
- **Contacts are always synthetic.** Realistic names and distributions, yes —
  real people, never.
- The tenant id is `lead-{id}`; staff logins use `{name}@{id}.linyup.com`-style
  addresses. The password is randomly generated per seed run (printed in the
  summary) — pass `--password <value>` to pin it, e.g. when reseeding without
  rotating the lead's known password.

## Assets folder (`scripts/leads/{lead}/assets/`)

Drop-in images the seed uploads to Storage (tokened download URLs — no rules
changes needed; the admin UI can replace any of them later). Accepted formats:
`.jpg` `.jpeg` `.png` `.webp`. Missing files fall back to accent-color branding
with a console warning.

| Base name                                              | Wired to                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `profile`                                              | team profile image (bio-link avatar)                                                |
| `hero`                                                 | team hero image (bio-link header)                                                   |
| `activity-<slug>`                                      | activity card cover (per `LeadActivityDef.imageAsset`)                              |
| `course-cover`                                         | online-course cover (per `LeadCourseDef.coverAsset`)                                |
| section `imageAsset` / `bgImageAsset` / `imagesAssets` | website section images (e.g. `site-hero`, `site-about`, `coach-ash`, `gallery-1…n`) |

Only images you have permission to use go here. Like the rest of the lead folder,
`assets/` is gitignored — images stay on your machine and are never committed
(licensing + repo size). Missing files fall back to accent-color branding.
