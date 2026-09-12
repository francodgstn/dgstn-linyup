# Contact AI summary

Two or three sentences at the top of a contact's insights card: how regularly
they come and whether that changed, what they hold, anything in the latest
notes worth acting on. Written by the model behind the assistant and offer
drafting (Vertex, `utils/vertexClient.ts`), stored on the contact, regenerated
only when somebody presses the button.

## Where it lives

| Piece | Path |
|---|---|
| Registry entry (experiment `contact-summary`) | `packages/shared/src/types/experimental.ts` |
| Stored record `Contact.ai_summary` | `packages/shared/src/types/contact.ts` (`ContactAiSummary`) |
| Callable `generateContactSummary` | `packages/functions/src/contacts/aiSummary.ts` |
| The prompt's facts and the reply's cleanup (pure) | `packages/functions/src/contacts/aiSummaryDossier.ts` + `aiSummary.test.ts` |
| The card | `apps/web/src/app/[locale]/(auth)/contacts/[id]/InsightsCard.tsx` |
| Client write denied | `firestore.rules` (contacts update guard) + `coaching/goalDenormAccess.rules-test.ts` |
| Wiped on anonymisation | `CONTACT_IDENTIFYING_FIELDS` in `packages/shared/src/utils/contactDeletion.ts` |

## The header, since 2026-09-12

The single header card became two. Left, a quarter wide at `lg`: the profile —
round avatar overlapping the card's top edge, name, chips, contact lines,
groups, the action buttons, all centred. Right, three quarters: the insights
card — the summary block on top (absent, not empty, while the experiment is
off), and docked at the bottom the three counters, the attendance sparkline and
the engagement meter that used to be the foot of the old card. Below `lg` the
two stack. `page.tsx` keeps the profile card inline (it reads a dozen pieces of
page state); the insights card is its own file because it needs only the
contact.

## Gate

An **experiment**, not a plugin and not a plan feature — the same call offer
drafting made and for the same reason: the output is what is being tuned. The
owner switches it on under Settings → Experimental; the card mounts the block
only while it is on, and the callable re-checks the flag on the team doc so a
client cannot spend model calls on a switch that is off. The settings list
notes Studio+ (AI insights is that row on the plan comparison) without gating
the toggle, as every entry does.

Beyond the switch: signed in, member of the team, the contact in that team,
and — for an own-scoped coach — on the contact's coach list or its creator
(the rules' `callerOwnsContact`, repeated server-side because a callable is not
gated by the rules). Rate limit: 30 per user and team per hour, through the
shared `utils/rateLimit.ts`.

## What the model sees

`buildContactDossier` is the ONE place the facts are assembled, and its test
sets every identifying field to something conspicuous and asserts none of it
appears. In: first name, time with the studio, journey stage, external flag,
plans held (names + status), affiliation, total sessions, last session, streak,
sessions per week over the last 12 weeks, the last 10 bookings (activity name,
date, status), no-show strikes, open-alert count, tags, and the last 3 coach
notes (HTML stripped, 240 characters each). **Never**: surname, email, phone,
login emails, birthdate, birthplace, address, weight, emergency contacts,
custom fields.

Notes are the deliberate inclusion — they are the most useful thing a coach
has written, and a summary that ignores them is a worse summary. A studio that
does not want its notes near a model leaves the switch off; that is what the
experiment framing is for.

The language is the studio's authoring language (`Team.language`, default
English); German asks for Swiss spelling.

## What comes back

`normaliseSummary` strips fences, heading lines, bullets and emphasis, keeps at
most three sentences and never more than 480 characters, cutting at a sentence
boundary where one exists. Empty in, empty out — the callable turns that into
an `internal` error rather than storing nothing. The stored record carries
`text`, `generated_at`, `generated_by` (the uid), `model` and `language`; the
card shows the text, the date and a one-line disclaimer.

## Regeneration: manual now, schedule later

Only the button regenerates. This is the recorded decision: a scheduled refresh
is not built until the button has shown whether a summary is worth the model
calls (Franco, 2026-09-11). When it is:

- it is a `dispatchTenantJob` fan-out (`utils/tenantFanOut.ts`), one Cloud Task
  per tenant, never a loop — the rule every scheduled job here follows;
- it runs the callable's body minus the caller checks, per contact, skipping
  anything whose `generated_at` is younger than the refresh interval and
  anything with no attendance since — idempotence is the job's, keyed on
  `generated_at`;
- it writes the same record with `generated_by: 'schedule'`.

Nothing about the stored shape or the card changes for that; the field on the
record exists so the two triggers can be told apart afterwards.

## Not done, on purpose

- No summary on the contacts LIST, in search, or on the mobile app — the record
  is there if a surface wants it, but nothing asks for it.
- No "why" on the card: the model's input is not shown. `buildContactDossier`
  is the answer for anyone who needs to know.
- No per-contact opt-out. The switch is per studio; a studio that wants some
  contacts summarised and others not is a case nobody has asked for.
