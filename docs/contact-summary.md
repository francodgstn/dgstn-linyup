# Contact AI summary

Four to six sentences at the top of a contact's insights card: an ANALYSIS,
not a restatement — where the person stands against their own history, what to
expect next and why, one thing the coach could do about it. Written by the
model behind the assistant and offer drafting (Vertex, `utils/vertexClient.ts`),
stored on the contact, regenerated only when somebody presses the button.

The first version (2026-09-12) handed the model raw counters and got the
counters back in prose — "Anna has 47 sessions and holds Unlimited", which the
coach can read off the same screen. The fix (2026-09-13) was not a better
adjective in the prompt: it was doing the arithmetic first. `deriveSignals`
computes the trend, the gaps, the booking outcomes, the weekly rhythm and the
membership history deterministically, hands them over as "Computed signals",
and the prompt then asks for what those mean together and forbids repeating
the numbers on the screen.

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

The single header card became two. Left, a third wide at `lg` (a quarter until
2026-09-13, which left the profile cramped and the insights card half empty):
the profile — an elevated card with a tinted band along the top, a round
gradient avatar overlapping the top edge with a soft glow behind it, the name,
chips, the contact lines in a quiet panel, groups, and four captioned action
tiles pinned to the bottom edge. Right, two thirds: the insights card — the
summary block on top (absent, not empty, while the experiment is off), four
figures under it (the three counters and the engagement band as a coloured dot
with its name), and on the bottom edge the attendance chart, starting where the
relationship did (the join or the first attended week, at least twelve weeks and
at most a year). Attendance only: plan periods were briefly drawn behind it as
bands and taken out again, because one small chart reads better telling one
story. Below `lg` the two stack. `page.tsx` keeps the profile card inline (it reads a dozen pieces of
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
plans held (names, status, and the end date when one is cancelling), the last
12 membership periods (renewals, gaps, how the last one ended), credit
balances, affiliation, total sessions, last session, streak, sessions per week
over the last 26 weeks, the last 30 bookings (activity name, date, status),
no-show strikes, open-alert count, tags, and the last 3 coach notes (HTML
stripped, 240 characters each). **Never**: surname, email, phone, login
emails, birthdate, birthplace, address, weight, emergency contacts, custom
fields.

Then the **computed signals**, from `deriveSignals` (pure, tested): the
attendance trend — mean sessions per week over the last 4 weeks against the
weeks before, called rising, steady or slipping, or "too little history" under
four earlier weeks; active weeks, the longest gap and the trailing gap;
booking outcomes (kept, no-show with a rate once three are decided, cancelled,
upcoming, and the next upcoming booking — a confirmed booking in the future is
the strongest forward signal there is); the usual rhythm (top weekdays and time
of day in the studio's clock, Europe/Zurich, and the activity mix); tenure; and
the engagement band from the studio's own thresholds, so the model and the
page's meter read the same thing.

Notes are the deliberate inclusion — they are the most useful thing a coach
has written, and a summary that ignores them is a worse summary. A studio that
does not want its notes near a model leaves the switch off; that is what the
experiment framing is for.

The language is the studio's authoring language (`Team.language`, default
English); German asks for Swiss spelling.

## What comes back

**Three parts, since 2026-09-14: Status, Outlook, At the next session.** The
prompt always asked for engagement now, what to expect next and one thing to do
at the next session, in that order; the reply is now those three parts under a
response schema (`status`, `outlook`, `nextSession`), and the card puts a bold,
translated label in front of each. The labels are the APP'S, in the reader's
language — a label the model wrote would drift in wording and language between
contacts, so one it adds anyway is stripped. "Outlook" rather than
"Prediction": the prompt makes the model state its confidence and say so when
the history is thin, which a prediction does not promise.

`readSummaryReply` reads the parts and runs each through `normaliseSummary` at
two sentences / 300 characters (three parts at the cap stay inside the old
six-sentence, 900-character paragraph). A reply that is not JSON at all reads
as the old paragraph; a reply stopped mid-JSON keeps the parts that closed.
`normaliseSummary` itself still strips fences, heading lines, bullets and
emphasis and cuts at a sentence boundary where one exists. Empty in, empty out
— the callable turns that into an `internal` error rather than storing
nothing. The stored record carries `text` (the parts joined — every reader of
the paragraph keeps working), `sections` when there are parts, `generated_at`,
`generated_by` (the uid), `model` and `language`; the card shows the parts (or,
for a summary written before the change, the paragraph), the date and a
one-line disclaimer. The record is written whole, so a regenerated summary
never keeps an older one's parts.

**Thinking is off, and a stopped reply loses its fragment.** On
`gemini-2.5-flash` thinking is on by default and its tokens count against
`maxOutputTokens`, so summaries on staging were being stopped mid-sentence and
stored as a fragment. The call sets `thinkingBudget: 0`, and passes whether the
reply hit the cap (`finishReason: MAX_TOKENS`) to `normaliseSummary`, which then
drops an unfinished last sentence, or ends a lone one with "…". A summary stored
before the fix stays as it is until someone regenerates it.

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
