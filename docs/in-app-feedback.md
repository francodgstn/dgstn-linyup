---
title: Feedback widget
description: In-app feedback system
status: living
area: product
order: 5
---
# Feedback widget

Lightweight feedback channel for the tenant dashboard (`apps/web`), built for the
lead-sandbox phase: users report general or scoped feedback with minimal friction,
ops manages everything from the operator console (`apps/admin` → **Feedback**).

## User side (apps/web)

A slim vertical **Feedback** tab sits on the right edge of every authenticated
page (`FeedbackLauncher`, mounted in the auth layout). It only renders when the
ops-controlled global flag is on. Clicking it opens a sheet with:

- **Quick likert** (1–5 faces) and/or a free-text description — one of the two is
  required. Optional **scope chips** (scheduling, bookings, contacts, …); none
  selected = general feedback.
- **Screenshot** via the native `getDisplayMedia` tab capture (no DOM-render
  library — Tailwind v4 oklch breaks html2canvas). The browser shows its share
  picker once; the sheet hides itself during capture. Hidden on browsers without
  support (mobile). Uploaded to Storage at `feedback/{uid}/{uuid}.png`
  (owner-only, image-only, <5 MB).
- **Page context is always attached automatically**: route, page title, viewport,
  user agent, locale, plus team id/name and plan.
- **Questions for you** — ops-pushed prompt questions. Users answer inline
  (rating and/or text, per prompt config) or **mute**; muted prompts stay listed
  under "Muted questions" (unmute + answer any time). Answered/muted state lives
  at `users/{uid}.feedback` (syncs across devices); the edge tab shows a pulse
  dot while any active prompt is neither answered nor muted.

Submissions are direct Firestore creates into `feedback/{id}`, validated by
security rules (identity enforced: `created_by` == auth uid, `created_at` must be
a `serverTimestamp()`, status forced to `new`, strict key allow-list). Clients
can never read the collection back.

## Ops side (apps/admin → /feedback)

Admin-SDK only (rules deny everything). Three tabs:

- **Inbox** — all submissions, filterable by status (new / reviewed / archived,
  composite index `status ASC, created_at DESC`). Detail page shows the full
  message, context facts, and the screenshot (streamed through
  `/feedback/screenshot?path=…`, a route handler doing an operator-checked
  Admin-SDK download — works against the Storage emulator, unlike signed URLs).
  Status actions stamp `reviewed_at` / `reviewed_by`.
- **Prompts** — create a question (rating and/or text answers) as a **draft**,
  then **Push** (status `active`, visible to all users) and **Close** / **Push
  again**. `answer_count` is incremented by the trigger. Prompt docs are readable
  by any signed-in user (drafts included — rules can't filter list reads), so
  keep the content non-sensitive.
- **Settings** — the **global widget switch** (all tenants; stored on the
  world-readable `app_settings/public` doc as `feedback_enabled`) and the
  **per-feedback email notification**: on/off + up to 10 recipient emails
  (stored privately on `app_settings/global_settings`).

## Notification flow

`onFeedbackCreated` (`packages/functions/src/feedback/onFeedbackCreated.ts`)
fires on every `feedback/{id}` create:

1. Reads the notify config **fresh** from `app_settings/global_settings` on each
   event (deliberately NOT `getAppSettings()` — that helper module-caches forever
   and throws on a missing doc). Ops toggles apply immediately.
2. For prompt answers: increments the prompt's `answer_count` and includes the
   question in the email.
3. Sends **system mail** (from hello@linyup.com — no `teamId`) to the configured
   recipients, using the shared email layout, idempotent per feedback doc. A mail
   failure is logged, never retried (the counter increment isn't idempotent).

## Data model

Types: `packages/shared/src/types/feedback.ts`. Collections: `feedback` (tenant
data — registered in `tenantData.ts` for per-team teardown via `team_id`),
`feedback_prompts` (platform). Rules: `firestore.rules` (bottom) +
`storage.rules` (`/feedback/{userId}/`).

`prompt_id` on every answer keeps the door open for a future rewards layer
(attribute answered prompts per user) without schema changes.

## Rollout notes

- Default state is **off** everywhere (no seed writes `app_settings`) — flip it
  on in the ops console when delivering sandboxes.
- Deploy order: `firestore.index.json` + rules before (or with) functions.
- apps/admin now needs Storage access for screenshots: `FIREBASE_STORAGE_BUCKET`
  (defaults: `{projectId}.appspot.com` on the emulator,
  `{projectId}.firebasestorage.app` on cloud) and, against the emulator,
  `FIREBASE_STORAGE_EMULATOR_HOST=localhost:9199`.
