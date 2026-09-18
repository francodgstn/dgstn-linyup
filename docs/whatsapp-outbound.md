---
title: WhatsApp
description: WhatsApp Business — outbound
status: living
area: messaging
order: 3
---
# WhatsApp

Status: **Phases 1 and 2 built** — Phase 1 on staging 2026-09-18, Phase 2 in
review — behind `WHATSAPP_ENABLED`
(off in every environment) and waiting on the Meta app (see "Ops
prerequisites"). Phase 2 — the second opt-in, templates written in Linyup,
the `send_whatsapp` automation action held until 08:00, and the cost line — is
section 6.

Code: `packages/functions/src/whatsapp/` (its files' headers say who owns what),
`packages/shared/src/types/whatsapp.ts`.

## Decisions (Franco, 2026-09-17)

| Question | Decision |
|---|---|
| Whose number, who pays | **The studio's own.** Linyup is a Meta **Tech Provider**; each studio connects its own WhatsApp Business account through Embedded Signup and adds its own payment method there. Meta bills the studio; Linyup carries no message cost. |
| What v1 sends | **Booking reminders** (a WhatsApp reminder step) and the **automation action** (approved templates only). Not waitlist offers, not bulk outreach. |
| Entitlement | The `whatsapp` plugin goes live, **Studio+** (`minPlan: 'studio'`, as the landing already sells). |
| Replies | **Opt-outs only.** The studio connects a number it keeps using in the **WhatsApp Business App** (Meta's coexistence onboarding), so every reply lands in its app. Linyup reads inbound messages only to catch STOP, and stores nothing else. Forwarding replies by email was rejected: it spends Brevo volume, and Linyup is not replacing the app. |
| Opt-in | Meta requires it before ANY business-initiated message, reminders included. Collected on the **booking and signup forms**, in the member's **Space**, in the **member app**, and **by staff** on the contact page (recorded as staff-entered). |
| A WhatsApp step that cannot send | **Skipped**, like an SMS step today (no opt-in, no phone, not connected). No fallback to email. A notice is a later, separate call — or a line in the help docs. |

## Why these shapes

- **Tech Provider, not Solution Partner.** A Solution Partner holds a credit line
  and re-bills customers; a Tech Provider's customers pay Meta directly. That is
  what keeps a studio's sending off Linyup's bill — the same worry that kept the
  API and MCP off the public demos.
- **Coexistence, not an API-only number.** A number registered only to the Cloud
  API has no inbox: a member's "running 5 min late" would vanish. On a
  coexistence number the studio's app keeps working and Linyup's messages appear
  in it as sent messages. Linyup needs `GET /{phone-number-id}?fields=is_on_biz_app,platform_type`
  to confirm it, and **never** calls the contacts/history sync (`smb_app_data`):
  we do not want a copy of the studio's chats.
- **Templates, always.** Every message Linyup sends is business-initiated, so
  every one is a pre-approved template. There is no free-text path, which is why
  the stub's `message` textarea goes.

## Architecture

```
Settings → Plugins → WhatsApp (owner)
  └─ Embedded Signup (FB JS SDK, coexistence feature) ─ code, waba_id, phone_number_id
        ▼
  connectWhatsApp (callable) ── exchange code → business token (encrypted, server-only)
                              ├─ check is_on_biz_app
                              ├─ POST /{waba}/subscribed_apps
                              ├─ provision Linyup templates into the WABA
                              └─ write status doc + number→team map

sendBookingReminders ─┐
automation action ────┴─► sendStudioWhatsApp(teamId, msg)   ONE send rail
                              kill switch → idempotency (mail_sends) → policy
                              → opt-in → suppression → connection → provider
                              ▼
                        whatsapp/graph.ts   (the only file that calls graph.facebook.com)

handleWhatsAppWebhook (onRequest, public)
  GET  verify-token challenge
  POST X-Hub-Signature-256 over the raw body, fail closed
       statuses → mail_sends row by wamid (delivered / read / failed + pricing category)
       messages → STOP keywords only → opt-out; everything else ignored, not stored
       message_template_status_update → template status
       (quality and number changes: read by refreshWhatsAppStatus, not the webhook)
```

### 1. Platform configuration

| Name | Kind | Use |
|---|---|---|
| `META_APP_ID`, `WHATSAPP_SIGNUP_CONFIG_ID`, `META_GRAPH_VERSION` | `defineString` | Embedded Signup + Graph calls (pinned version, bumped deliberately) |
| `WHATSAPP_ENABLED` | `defineString`, default off | Kill switch, like `SMS_ENABLED` |
| `meta-app-secret` | Secret Manager | code exchange + webhook signature |
| `whatsapp-webhook-verify-token` | Secret Manager | GET challenge |
| `whatsapp-token-key` | Secret Manager | AES-256-GCM key for studio tokens |

Every new `defineString` goes into each committed `.env.<alias>`, or the
non-interactive deploy fails.

### 2. Data model (all client writes denied)

| Path | Shape | Read |
|---|---|---|
| `teams/{t}/integrations/whatsapp` | `status` (`connected` \| `disconnected` \| `error`), `waba_id`, `phone_number_id`, `display_phone_number`, `verified_name`, `is_on_biz_app`, `quality_rating`, `templates: {key: {status, reason?}}`, `connected_by`, `connected_at`, `last_error?` | owner (the existing integrations rule) |
| `whatsapp_connections/{teamId}` | encrypted business token, `waba_id`, `phone_number_id` | deny |
| `whatsapp_numbers/{phoneNumberId}` | `teamId` — **one number, one team**; a connect that finds it held by another team is refused (the `connect_accounts` lesson) | deny |
| `teams/{t}/whatsapp_templates/{id}` *(Phase 2)* | studio-authored template: `name`, `category`, `language`, `body`, `variables[]`, `meta_template_id`, `status`, `rejected_reason?` | team members |
| `whatsapp_suppressions/{teamId}_{phoneHash}` | STOP replies, **per studio** (a STOP to one studio says nothing about another) | deny |
| `mail_sends/*` | existing ledger, `channel: 'whatsapp'`, `provider_message_id` = wamid, plus `wa_category`, `wa_billable` | existing |

**Contact consent** — `Contact.whatsapp_consent`:
`{ status: 'opted_in' | 'opted_out', at, source: 'booking_form' | 'signup_form' | 'space' | 'member_app' | 'staff' | 'reply_stop', recorded_by? }`.
Present only once somebody has answered; absent reads as "not opted in".
One predicate, `whatsappConsentAllows(contact)` in shared, is the only reader;
one builder, `whatsappConsentPatch` (`whatsapp/consentPatch.ts`), the only
writer — both pinned by `whatsapp.test.ts`. A STOP writes `opted_out` on the
contacts that number was messaged as (found through the send log, which keeps
`contact_id` + `recipient_hash`; contact phones are stored as typed) AND a
suppression, so a second contact record with the same number is covered too.
**The newest answer wins**: a suppression blocks only when it is newer than the
contact's opt-in (`suppressionBlocks`), so a member who replied STOP and later
opted in again on a form is not silently blocked, and no opt-in door has to
know the suppression list exists. Wiped on anonymisation
(`CONTACT_IDENTIFYING_FIELDS`), added to the API field catalogue as `excluded`.

### 3. Connect / disconnect (callables, owner-only, plugin-gated)

- `connectWhatsApp({ code, wabaId, phoneNumberId? })`: `assertPluginInstalled`;
  **refused for public demo tenants** (the `api_access_blocked` flag the
  `/try` teams and `linyup-demo` carry); exchange
  the code (`GET /oauth/access_token`); when the browser has no number id
  (Business App onboarding reports the account only) read the account's numbers
  and require exactly one; refuse unless `is_on_biz_app`; claim
  `whatsapp_numbers/{id}` in a transaction; subscribe the app to the WABA;
  provision the reminder templates; write the status doc.
- `disconnectWhatsApp`: unsubscribe the app, delete the token and the number
  claim, status → `disconnected`. The studio's WABA and app are untouched.
- `refreshWhatsAppStatus`: re-read quality, template statuses, `is_on_biz_app`.
- Plugin teardown arm (`onInstalledPluginStatusChange`) runs the disconnect.

Web: the plugin's `ConfigPanel` loads the Facebook JS SDK on that page only
(CSP allowance for `connect.facebook.net` scoped to the settings route), shows
the connected number, quality, template statuses, and the month's sent count
by category with "Meta bills you directly". The disabled access-token field goes.

### 4. The send rail — `packages/functions/src/messaging/whatsapp/`

`sendStudioWhatsApp(teamId, { contactId, to, template, language, params, tag, idempotencyKey })`,
in `smsService.ts`'s order, plus what SMS is missing:

1. `WHATSAPP_ENABLED`, else no-op.
2. Idempotency on `mail_sends` (`ledgerRowSpendsKey`, keys prefixed `wa-`).
3. `resolveMessagingPolicy(teamId)` → `applyPhonePolicy` — **reuses**
   `allowPhones` / `redirectPhone` (both are phone channels; one knob set).
   Silent sandbox stays silent.
4. Consent: the CONTACT is loaded and `whatsappConsentAllows` asked. Seeders
   never write consent, so seeded contacts — whose fabricated Swiss numbers are
   routable — can never be messaged. That is the synthetic-recipient guard for
   this channel, by construction.
5. `whatsapp_suppressions` by phone hash.
6. Connection: status `connected`, template `APPROVED` for that language.
7. Provider send; ledger row with the wamid. Dropped sends write a
   `suppressed` row with the reason, as email does.

Phone normalisation moves out of `smsService.ts` into shared
(`normalizePhoneE164`, same rules) so both channels agree; no storage change.
Quiet hours reuse `isWithinSmsSendingHours`.

### 5. Booking reminders

- `BookingReminderStep.channel` gains `'whatsapp'`; the step editor in
  `SystemEmailsCard.tsx` offers it only while the plugin is installed and
  connected.
- `sendBookingRemindersForTeam`: a WhatsApp step needs a booking with a
  `contactId`, a phone, consent, quiet hours; else it is **skipped** and marked
  so it is not retried. Key `wa-reminder-{session}-{booking}-{step}`.
- Template `linyup_booking_reminder_v1`, UTILITY, in en/de/fr/it, named
  parameters: first name, class, date, time (studio clock), studio name; a URL
  button to the manage-booking page. Owned by Linyup in
  `packages/shared/src/whatsapp/templates.ts`, provisioned into each WABA at
  connect. **Template names are versioned**: an approved template is edited by
  publishing `_v2`, never in place.

### 6. Phase 2 — studio templates and the automation action

Decisions (Franco, 2026-09-18): **two opt-ins** — booking reminders and "news
and offers" are separate answers; studios **write templates in Linyup**, never
in Meta's tools; a WhatsApp automation message outside 08:00–21:00 is **held
until 08:00**, not skipped and not sent.

**Why marketing needs its own opt-in.** Almost every useful automation — a
welcome, a win-back, a birthday, a trial follow-up — is MARKETING in Meta's
categories: dearer for the studio, and outside what a member agreed to when they
ticked "reminders". Utility is only what is tied to something the member did.

#### 6a. The second consent

`Contact.whatsapp_marketing_consent`, the same
shape as `whatsapp_consent`, written by the same builder
(`whatsappConsentPatch(kind, optIn, source)`) and read by the same predicate
(`whatsappConsentAllows(contact, kind)`, `kind: 'reminders' | 'marketing'`).
Every Phase 1 door gains a second, independent choice: a second unticked box on
the booking and signup forms ("News and offers from {studio}"), a second switch
in the Space and the member app, a second row on the contact page. A STOP ends
**both**; Meta's own "stop promotions" failure ends **marketing** only. Denied
to clients by the rules like the first; wiped on anonymisation; `excluded` in
the API catalogue.

#### 6b. Templates, written in Linyup

`teams/{t}/whatsapp_templates/{id}`:
`label` (the studio's name for it), `category` (`UTILITY` | `MARKETING`, asked
in the owner's words — "about something they booked or bought" / "news, offers,
invitations"), `language` (the studio's `Team.language`), `body` with the same
`{{firstname}}`-style tokens as email templates (the `substituteVariables` set
that makes sense in a chat: first name, last name, studio name, date, and the
booking / membership / bio-link / website / review URLs), `meta_name`
(`lyp_…`, generated), `status`, `rejected_reason`. Written only by callables:

- `submitWhatsAppTemplate` validates what Meta would refuse, before Meta does —
  body length, a token at the very start or end, two tokens side by side, an
  unknown token — turns tokens into named parameters with generated examples,
  and creates the template under a fresh `meta_name`.
- **An approved template is never edited in place.** Editing submits a new
  `meta_name`; the old one keeps sending until the new one is approved, then is
  deleted at Meta. Rules point at the Linyup id, so they never notice.
- `deleteWhatsAppTemplate` deletes at Meta and here; a rule still pointing at it
  skips with a reason, like a deleted email template.
- The webhook's template-status arm (today Linyup's own templates only) finds a
  studio template by `meta_name`, and a new `template_category_update` arm
  records a reclassification — the editor then says the studio is now paying
  the marketing price and needs the marketing opt-in.

Editor: on the WhatsApp plugin page, a list (label, category, review state) and
a form with a live chat-bubble preview, filled with the same sample values the
email template editor uses.

#### 6c. The action is BUILT-IN, not a plugin action

`send_whatsapp`
`{ templateId }` joins `send_email` in the engine's action union and in the
rule builder, offered only while the plugin is installed. The generic
`plugin:*` action path has no config editor in the builder and untranslated
labels, so a template picker cannot live there. At run time, per contact: the
template must be APPROVED; the consent asked is the template's category
(UTILITY → reminders, MARKETING → marketing); a contact without it is skipped
with its own reason in the run history and in the preview dialog. Parameters
are the template's tokens rendered by `substituteVariables` for that contact.
It sends through `sendStudioWhatsApp`, keyed
`wa-auto-{ruleId}-{contactId}-{occurrence}`.

#### 6d. Held until 08:00

Outside the window the action does not send and is
not skipped: it enqueues a Cloud Task (`sendHeldWhatsApp`) for
`nextSmsWindowOpen(now)`, task id derived from the idempotency key. The handler
re-reads the contact and template and calls `sendStudioWhatsApp`, which asks
consent, suppression, connection and approval again — a member who opted out
overnight gets nothing. Only the WhatsApp action waits; the rule's other actions
run on time. The run history says "held until 08:00".

#### 6e. What it costs the studio

The plugin page shows this month's sent
messages by Meta category from the send log (`wa_category`), with "Meta bills
you directly". No Linyup metering. `getWhatsAppUsage` counts them (the send log
is denied to clients), on the `mail_sends (team_id, channel, wa_category,
created_at)` index.

**Where it lives.** `whatsapp/studioTemplates.ts` (submit, delete, and the
webhook's promote-on-approval), `whatsapp/automation.ts` (the action, token
rendering, and `sendHeldWhatsApp`), `whatsapp/usage.ts`; the engine arm is in
`utils/automationEngine.ts` (`send_whatsapp`, `ruleSendsWhatsApp`), and the
preview marks each contact the message would or would not reach. Tests:
`whatsapp/phase2.test.ts` and the rules file.

**Two things to confirm in the Phase 0 spike:** the failure code Meta uses for
"this person stopped promotions" (`META_STOPPED_PROMOTIONS`, 131050 assumed),
and that `template_category_update` is the field Meta sends on a
reclassification.

### 7. Opt-in surfaces (one callable, three doors)

- Public booking + signup forms: an unticked checkbox naming the studio and
  WhatsApp, shown only when `TeamPublicProfile.whatsapp_opt_in_offered` (plugin
  installed AND a number connected; connect/disconnect touch the team doc so the
  mirror follows). Book forms send the reserved answer key `whatsapp_opt_in` in
  `contactFieldAnswers`, which `buildContactFieldPatch` turns into the consent —
  so every rail that already narrows book-form answers records it with no change
  of its own. Signup sends `contactDetails.whatsappOptIn`. Only `true` is read:
  an unticked box never withdraws an opt-in.
- Space profile + member app: `setMyWhatsAppConsent({ optIn })`, a
  contact-session callable shared by both.
- Staff: a toggle on the contact page → `setContactWhatsAppConsent`
  (`contacts.manage`), `source: 'staff'`, `recorded_by: uid`.

### 8. Webhook — `handleWhatsAppWebhook`

- One endpoint for the Linyup app (all studios). GET: compare
  `hub.verify_token`, echo `hub.challenge`. POST: HMAC-SHA256 of the raw body
  with the app secret, timing-safe compare, 401 before any read (pattern:
  `appstores/webhook.ts`). Route by `metadata.phone_number_id` →
  `whatsapp_numbers`; unknown numbers are logged and dropped.
- Statuses update the ledger by wamid, keep `pricing.category` / `billable` for
  the studio's monthly count, and turn "recipient stopped marketing" and
  "not a WhatsApp user" failures into the right outcome (suppression vs. no-op).
- Inbound `messages`: normalised text in STOP / STOPP / ARRÊT / ARRET / BASTA /
  ABMELDEN → opt-out. Nothing else is read, logged or stored. No confirmation
  message is sent in v1.
- Always 200 after the signature passed, so Meta does not retry a
  handled-but-ignored event.

## Ops prerequisites — long lead time, start first

1. Meta Business verification for the Linyup business portfolio.
2. A Meta app with the WhatsApp product; Tech Provider onboarding.
3. App Review for `whatsapp_business_messaging` and
   `whatsapp_business_management` — needs a screencast of the working connect
   and send flow, so it follows Phase 1 on staging with a test WABA.
4. An Embedded Signup configuration with the coexistence (Business App)
   onboarding enabled; its config id into the params.
5. Legal: Meta as a sub-processor in the privacy policy and
   `docs/launch/legal-input-pack.md`; the studio is the controller of its own
   WhatsApp account.

## Phasing

**Phase 0 — spike on staging (gate).** Connect a real Business App number
through coexistence Embedded Signup, send one reminder template, receive the
signed status webhook. Record in this doc, with sources:
- coexistence limits that matter to a studio (countries incl. CH, throughput,
  how long the app may go unopened, features that stop working in the app);
- whether the business token expires;
- whether a reminder is approved as UTILITY or reclassified MARKETING (price);
- the failure codes for "stopped marketing" and "not on WhatsApp";
- how Linyup-sent messages appear in the studio's app.

**Phase 1 — connect + rail + reminders + consent.** *(built)* Sections 1–5, 7, 8;
plugin to `beta`; rules + rules tests; i18n fragment; `pnpm census:reads` rows
for any new LOG read. Enough for App Review.

**Phase 2 — templates + automation action.** *(built)* Section 6: 6a consent and 6b templates first (both usable on their own), then 6c the action, 6d holding, 6e the cost line.

## Not in v1, on purpose

- Waitlist seat offers, confirmations, bulk outreach / broadcasts.
- An inbox, reply forwarding, the `message_received` trigger.
- Linyup metering or re-billing of Meta charges.
- A notice when a WhatsApp step was skipped (docs first; decide later).
- Any change to SMS. Its gaps (`sms_opt_out` not enforced, no SMS status
  webhook) are separate work.

## Verification

- Unit: signature verify (valid / tampered / missing raw body), GET challenge,
  routing to the right team, STOP in four languages, consent predicate, send
  rail order (policy silent, no consent, suppressed, template not approved →
  suppressed rows with reasons), reminder step skip + key, token encryption
  round-trip, demo-tenant refusal. Built: `whatsapp/*.test.ts` (templates,
  token sealing, webhook parse + signature, STOP keywords, consent + the
  newest-answer rule, reminder formatting); the send rail and callables are not
  unit-tested against Firestore — the staging E2E below covers them.
- Source pins: the provider file is the only `graph.facebook.com` caller;
  every WhatsApp send goes through `sendStudioWhatsApp`; `whatsapp_consent` is
  read only through its predicate.
- Rules tests for the new paths: `whatsapp/whatsapp.rules-test.ts`.
- Staging E2E (Phase 0/1): a studio number via coexistence; opt in from the
  booking form; a reminder arrives and shows in the studio's app; STOP from the
  phone → consent `opted_out` → the next reminder is suppressed.
