# AI insights — the AI plugin container

Since 2026-09-16 the AI features a studio switches on live in ONE plugin card,
**AI insights** (`ai`), built exactly like HMD's bundle: a container whose modules
are ordinary plugins, materialized by `reconcileBundle` and switched on and off
independently in the card's Configure dialog. See `docs/plugins.md` → Bundles for
the mechanism; this page is what the modules do. The card carries the **beta**
badge — the model's output is still what is being tuned.

Owner installs it on Studio and up (the default client-install tier). An
organisation can also install it at org level; `pluginIsActive` sees that install
too, and the module switches then render on the org plugins page.

## The modules

| Module | What it does | Surface | Server |
|---|---|---|---|
| `ai-contact-summary` | The coach's briefing on a contact: status, outlook, one thing for the next session. Also writes the member recap in the same call. | Contact page, insights card | `generateContactSummary` (`contacts/aiSummary.ts`) |
| `ai-member-recap` | "Send to member": the member-facing part of the briefing, reviewed and editable, emailed as the studio. | Button on the briefing + `MemberRecapDialog` | `sendContactRecapEmail` (`contacts/aiRecapEmail.ts`) |
| `ai-team-sentiment` | A reading of the team's ACTIVE members: refreshes their briefings where something changed, then reads them — mood, overview, what is working, what to watch, where to focus. | Dashboard, between the working rows and Trends | `generateTeamSentiment` (`aiInsights/teamSentiment.ts`) starts a run; `refreshTeamSentimentRound` (`aiInsights/teamSentimentWorker.ts`) drains it |
| `ai-offer-drafting` | "Draft with AI": describe the studio, review the proposed activities and plans, then create them in one batch. Owner only. | Offerings → Create menu + `AiDraftDialog` | `draftOfferings` proposes, `applyOfferingDraft` writes (`offer/draftOfferings.ts`) |

Ids, limits and stored shapes: `packages/shared/src/types/aiInsights.ts`.
The briefing itself — dossier, signals, prompt, reply: `docs/contact-summary.md`.

## Cost is bounded by buttons, never by a schedule

Every model call is a button somebody pressed. **There is no scheduled generation
for all contacts** (Franco, 2026-09-16): it would spend calls on people nobody is
about to look at. A scheduled refresh stays the recorded, unbuilt option in
`docs/contact-summary.md` → Regeneration.

- **Briefing:** one call per press, 30 per user and team per hour.
- **Member recap:** no model call at all. The recap is written in the briefing's
  call, so the dossier is sent once. 20 sends per user and team per hour.
- **Team sentiment:** the one press that fans out. A run refreshes the briefing of
  every ACTIVE member with something new — one call each — and then reads up to
  150 briefings in one more call. That is why it is capped at **5 runs per team
  per calendar day** (Europe/Zurich), which was the point of the cap (Franco,
  2026-09-16). The run is reserved in the same transaction that creates it,
  BEFORE the first member is touched — a run spends its slot whether or not it
  finishes — and the count is written absolutely, with no path that gives a run
  back. Refusals that cost nothing (a module off, a run already going, fewer than
  3 active members) come before the reservation. The freshness rule
  (`summaryNeedsRefresh`) is what keeps five runs a day from being five full
  roster passes: a second run the same day refreshes almost nobody.

## The member recap

Two parts written TO the person: where they stand, and one thing for their next
session. **Never the outlook** — the studio's outlook is a note about a person
("at risk of drifting"), not a message to them, and the model is not asked for a
member version of it. The prompt also keeps risk, gaps, no-shows, payments, plans
ending and the coach's notes out of these parts. German is written with du,
French and Italian with tu; a studio that addresses members formally edits the
parts before sending.

**A person reviews every recap.** The dialog shows the email as it will arrive —
greeting, labels and sign-off come from `composeMemberRecap` in
`packages/shared/src/utils/memberRecapEmail.ts`, the same function the server
renders with, so the preview cannot drift — and the two parts are editable. What
is sent is what is in the boxes. There is no bulk or automated arm.

It is outreach and follows outreach's rules: the studio's email opt-out
(`email_unsubscribed`) through `partitionRecipients`, an idempotency key per
dialog so a double click or retry sends once, the `List-Unsubscribe` header, and
an `outreach_email_sent` row in the contact's Emails tab. The send stamps
`ai_summary.member_sent_at` / `member_sent_by` (dotted paths — the summary is
never rewritten); a regenerated summary is written whole and so arrives unsent.

## Team sentiment

A press starts a **run** (`aiInsights/teamSentimentRun.ts`), in Cloud Task rounds
like `tarif595/bulkWorker.ts`:

1. **Who.** The ACTIVE members: on the roster (members and leads, no externals)
   AND in the `active` engagement band — seen within the studio's
   `active_within_days` (default 14), measured like the contact page's meter (last
   session, else when they joined). Most recently seen first, capped at 150. Found
   with one field-masked scan of the team's contacts.
2. **Refresh.** Each member's briefing is regenerated only when
   `summaryNeedsRefresh` says so: there is none, it is older than 7 days, or the
   member attended, booked or got a note since it was written. Otherwise it is
   reused. The briefing is the SAME one the contact page's button writes
   (`contacts/aiSummaryGenerate.ts`), stamped `generated_by: 'team_sentiment'`.
   One member the model cannot answer for does not end the run.
3. **Read.** Those members' briefings (younger than 180 days) go in one prompt.

State lives on the card's own document (`run`: status, members, rounds done,
refreshed / reused / failed), so the dashboard shows progress with the listener it
already has. Every write to the run is a transaction that re-reads it and checks
the run id, status and `rounds_done`, with absolute counts — a redelivered round
does nothing, and a member a crashed round already refreshed looks fresh to the
retry. A run still going after 30 minutes is treated as abandoned so the button
works again; its slot is not given back.

- **Nobody is named.** Entries are numbered, and each person's first name is
  replaced by `[member]` in their own text before it is sent; the prompt forbids
  identifying anyone. No new fact about any person reaches the model: every line
  was already written by the model about that person.
- **It says who it covers.** A reading covers active members only, so the card
  always states that, with the threshold in days and how many briefings it read.
- **It needs the briefings module.** The run writes contact briefings, which belong
  to `ai-contact-summary`; with that module off the run refuses rather than write
  summaries nobody switched on.
- **Owners and managers only.** A coach scoped to their own book cannot read the
  other contacts, so they do not get a reading of them: the dashboard does not
  mount it, the callable refuses, and `teams/{t}/ai_reports/{id}` is readable by
  all-scoped members only (and writable by nobody but the function).

Stored at `teams/{teamId}/ai_reports/team_sentiment`: `report` (replaced whole
when a run finishes, carrying `active_within_days`) beside `usage: { day, count }`
and `run`, one listener for all three.

## What moved, and what did not

- The `contact-summary` **experiment** was retired into `ai-contact-summary`. A
  team that had it on reads as off and installs the plugin; the stored summaries
  are untouched.
- The `offer-drafting` **experiment** was retired into `ai-offer-drafting` on
  2026-09-17, so every AI feature a studio switches on sits in this one card.
  It stays OWNER-ONLY: the Create menu shows "Draft with AI" to the owner alone,
  and `draftOfferings` / `applyOfferingDraft` check the owner role and then the
  module. A team that had the experiment on installs the plugin.
- **A container installed before a module was added does not get that module on
  deploy.** The reconciler runs when the container's install document is written,
  so an existing install gains `ai-offer-drafting` the next time a module switch
  in its Configure dialog is saved.
- **The in-app assistant** (`ai-assistant`) stays standalone: it is `locked`, and
  a locked plugin cannot be a member (`unlockPlugin` writes one document and never
  reconciles).

## Not built yet

- **A member generating their own recap from the app.** The recap already exists
  per contact; a member-facing surface would read `ai_summary.member` (or ask a
  contact-session callable with its own per-contact cap), and needs a member-app
  release. Recorded as the next step, not started.
- **A scheduled refresh** of briefings (see above). Team sentiment runs refresh the
  active members' briefings on a press; nothing refreshes them on a clock.
- **A history of team readings.** Each run replaces the last; nothing charts mood
  over time.
