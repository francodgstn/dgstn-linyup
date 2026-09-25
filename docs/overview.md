---
title: Overview
description: What Linyup is, where the code lives, and how these docs are organised.
status: living
area: start
order: 1
---
# Overview

Linyup is a multi-tenant SaaS for coaches, studios and multi-studio
organisations: classes and appointments, contacts and memberships, payments,
public booking pages and websites, and a member app. It is the generalised
successor of **hmd-lineup**, a martial-arts school platform whose business logic
it ports (see [HMD port checklist](./migration-checklist.md)).

The tenant boundary is the **team** (`teamId`). An **organisation** groups
member studios above it. Everything a visitor sees without signing in is read
from `public_profile` mirrors, never from the main collections.

## Repository map

For what runs where, and which services and providers sit around the code, see
[Landscape](./landscape.md).

| Path | What it is |
|---|---|
| `apps/web/` | Studio dashboard **and** every public surface (`/public/{slug}/…`, `/embed/…`). Next.js App Router, shadcn/ui, TanStack Query, next-intl. |
| `apps/admin/` | Operator console for Linyup staff (tenants, feedback, store insights). Next.js. |
| `apps/mobile/` | Member app. Expo + React Native, contact-session auth. |
| `apps/landing/` | Marketing site and legal pages. Astro. |
| `apps/help/` | Public product docs for studios. Starlight. |
| `apps/docs/` | This site: internal engineering docs, local only, never deployed. |
| `packages/functions/` | Cloud Functions (gen2, TypeScript): callables, triggers, webhooks, scheduled jobs. |
| `packages/shared/` | Types, Firestore paths and the pure resolvers every other package shares. |
| `infra/` | Terraform for staging and production, plus the custom-domain Worker. |
| `scripts/` | Seeders, backfills, migrations and the repo's guard scripts. |
| `docs/` | The documents this site renders. |

Root tooling is pnpm workspaces + Turborepo on Node 22. Firebase rules and
indexes (`firestore.rules`, `storage.rules`) sit at the repo root.

## Environments

Local development runs entirely on the Firebase emulators (`demo-linyup`), with
no real project behind it. The cloud projects are **sandbox** (prospect demos
and the `/try` playground), **staging** and **production**. See
[Environments](/rules/environments/), [Local development](/rules/local-development/)
and [Test accounts](./test-accounts.md).

## How these docs are organised

- **Start here** — this page, the glossary, and getting a local stack running.
- **Architecture** — the rules that cut across every feature: the tenant and
  public-data boundaries, how functions and scheduled jobs are written, Stripe,
  i18n, and the house rules about comments and tests.
- **Domains** — one group per product area. Each group opens with the page that
  explains the model; the pages after it build on that one.
- **Operations** — runbooks, infrastructure, seeding and testing.
- **Product** — strategy, the roadmap, open decisions and open defects.
- **Records** — audits, reviews and closed plans. Each one was true on its date.
  Check a record against the code before you act on it.

A page marked **plan** in the sidebar describes work still to do. Its
imperatives are tasks, and they may be out of date.

Pages whose path starts with `/rules/` are rendered from `CLAUDE.md`, and pages
under `/repo/` from READMEs next to the code. Edit those at the source. The site
never keeps a second copy.
