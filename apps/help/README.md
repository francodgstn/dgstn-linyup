# @linyup/help — the public help centre (help.linyup.com)

Public product documentation for studio owners, coaches and developers. Starlight, static.
It is called **help** everywhere (the app, the `hosting:help` target and the domain). **Not** the internal `apps/docs` (engineering docs, local only) — nothing here may link to or
import from the repo's `docs/` folder.

```
pnpm dev:help        # http://localhost:4323 — drafts visible
pnpm --filter @linyup/help build   # dist/ — drafts excluded
```

Content lives in `src/content/docs/`. A page with `draft: true` is an outline: visible in dev,
left out of the build, so nothing unfinished can go public.

## Pages: draft, coming soon, live

- `draft: true`: an outline. Visible in dev, left out of the build.
- `comingSoon: guide`: **published**, with a "Guide soon" badge and a banner saying the feature is
  already in Linyup and only the guide is missing. Most placeholders are this one.
- `comingSoon: feature`: **published**, with a "Coming soon" badge, for a feature that is not
  available yet (the member app, WhatsApp).
- For either, give the page a truthful one-paragraph summary. To make it a real page, write it
  and delete the line.
- Neither: a live page.

A folder under `src/content/docs/` is a product area; `astro.config.ts` lists the folders in
sidebar order, and each one autogenerates from its pages' `sidebar.order`.

## Look

`src/styles/custom.css` puts linyup.com's brand on Starlight (violet accent, Plus Jakarta Sans,
Sora titles) and `src/components/SiteTitle.astro` replaces the title with the swoosh and the
two-tone wordmark. `apps/docs` carries the same pair, tagged "engineering"; keep them in step.

## Hosting

A static Firebase Hosting target, the same pattern as `landing` / `api`:

- **Site**: `linyup-help-staging` / `linyup-help-prod`, created by Terraform
  (`infra/modules/firebase-project`, `help_site_id`). Sandbox has none.
- **Target**: `help` in `firebase.json` (`public: apps/help/dist`, landing's cache headers) and
  `.firebaserc`.
- **Deploy**: `deploy.yml` (staging, on push to `main`) and `deploy-prod.yml` (prod, on a `v*`
  tag) build it and ship `hosting:help`. `verify.yml` checks and builds it on every PR.
- **Domain**: `help.linyup.com` (prod), `help-stg.linyup.com` (staging). Added as a custom
  domain on the Hosting site, with a **DNS-only** (grey-cloud) record in Cloudflare — never
  proxied, see `infra/README.md`.

The site must exist before a deploy names `hosting:help`, or the whole deploy fails.

## Languages

English only, at the root. When translating: add `de`/`fr`/`it` under `locales` in
`astro.config.ts` — English URLs stay where they are, and untranslated pages fall back to English
with a notice. Translations are generated ahead of time (DeepL, with a glossary for product terms)
into committed files under `src/content/docs/<lang>/`, then reviewed — never translated at request time.
