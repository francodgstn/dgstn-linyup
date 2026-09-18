# @linyup/help — public docs (docs.linyup.com)

Public product documentation for studio owners, coaches and developers. Starlight, static.
**Not** the internal `apps/docs` (engineering docs, local only) — nothing here may link to or
import from the repo's `docs/` folder.

```
pnpm dev:help        # http://localhost:4323 — drafts visible
pnpm --filter @linyup/help build   # dist/ — drafts excluded
```

Content lives in `src/content/docs/`. A page with `draft: true` is an outline: visible in dev,
left out of the build, so nothing unfinished can go public.

## Hosting (not wired yet)

Same pattern as `landing` / `api`: a static Firebase Hosting target.

1. Terraform: add a `linyup-{env}-help` site to `infra/modules/firebase-project` (site IDs are
   reserved forever once deleted — pick the name once).
2. `firebase.json`: a `help` hosting target, `public: apps/help/dist`, same cache headers as landing.
3. `.firebaserc`: map `help` in each project (and restore `_comment_targets` if `target:apply`
   drops it).
4. Deploy workflows: add `hosting:help` to the `--only` list in `deploy.yml` / `deploy-prod.yml`,
   after a `pnpm --filter @linyup/help build` step.
5. Custom domain `docs.linyup.com` (prod) / `docs-stg.linyup.com` (staging) in the Firebase
   console, DNS-only CNAME in Cloudflare.

## Languages

English only, at the root. When translating: add `de`/`fr`/`it` under `locales` in
`astro.config.ts` — English URLs stay where they are, and untranslated pages fall back to English
with a notice. Translations are generated ahead of time (DeepL, with a glossary for product terms)
into committed files under `src/content/docs/<lang>/`, then reviewed — never translated at request time.
