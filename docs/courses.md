---
title: Courses
description: Courses, a bounded and sellable set of lessons
status: living
area: booking
order: 6
---
# Courses

A **course** is a bounded set of lessons sold as one thing:

> Every Wednesday 15:45 to 16:15, from 20.08 to 26.11, with no lesson on 8.10
> or 15.10. Thirteen lessons, nine places, CHF 364, one booking, and the child
> enrolled in every one.

A class is a seat in a session. A course is the whole set, and the set is what
the studio and the parent both talk about: "levels 1 to 5 start in August",
"13 lessons", "9 places", "sold out". None of that is expressible as thirteen
independent sessions. Thirteen sessions at 9/9 are thirteen answers to one
question, and a child who misses lesson four must not free a place.

**Two words, two things.** In the UI, *Course* is this; the online-courses
plugin (`courses/{id}`, on-demand video) is *Online course*. In code they are
`course_blocks/{id}` and `courses/{id}`, and they never share a message
namespace (`CourseBlocks` and `Courses`), so they cannot drift into sharing a
word by accident. Stored values never change; the display rename is display-only.

---

## The shape: meetings are a LIST

`RecurrencePattern` carries one `startDate` (which is also its time of day)
and one `duration`. So it cannot say *"Saturday 10:00–16:15 AND Sunday
09:00–15:00"*, and that weekend crawl course is an ordinary product, not an
edge case. **A course stores `meetings[]`.**

A repeating rule is an **authoring input**, resolved to the list and kept beside
it (`pattern.recurrence`) so the studio can re-edit what it typed. Three ways of
asking, one thing stored:

| The studio says | Stored |
|---|---|
| every Wednesday until 26.11, skipping 8.10 and 15.10 | `recurrence` + 13 `meetings` |
| a Saturday and a Sunday, different times | `meetings` × 2, no rule |
| one afternoon in October | `meetings` × 1, no rule |

`resolveCourseSchedule` (`functions/src/courseBlocks/schedule.ts`) is the one
place the three become one, and it reuses `calculateOccurrences` rather than
reimplementing a calendar: skip dates, the DST-safe advance and the
Europe/Zurich civil day are decided there already.

A course must END. An open-ended rule is refused: that is a timetable, which a
plain session series already is.

---

## What owns what

A course **owns** one `session_series`, whose sessions are its lessons.

```
course_blocks/{blockId}
  └── owns → session_series/{seriesId}   (status: 'fixed', course_block_id)
                └── sessions/*            (course_block_id, allowBooking: false)
                      └── bookings/{contactId}
  └── enrolments/{contactId}              ← the place
```

That is what makes the lessons **ordinary sessions**: roster, attendance,
check-in, reminders, cancellation, the coach's busy set and the existing
teardown job all work with no new code, and `materializeOccurrences` stays the
one materialisation path with its one `(seriesId, instanceDate)` dedupe rule.

The series document is **not** an indirection to skip. `freezeSeriesForTeardown`
and `endSeriesAfterTeardown` call `update()` on it, and an `update()` on a
missing document throws. A course with no series doc would break "cancel the
whole course" silently.

`status: 'fixed'` means *materialised in full, nothing to roll*. The daily
roller queries `status == 'active'`, so a course's series is never even read.

### The refusals

Reuse cuts both ways, so three guards:

- **Every lesson carries `course_block_id`**, stamped by `buildSeriesSessionDoc`
  from the **series** rather than the template. It is a fact about which series
  this is, not a field a studio can edit off a lesson.
- **`updateRecurringSession` and the series-wide `cancelSession` refuse** a
  series carrying `course_block_id`, in the shape the `teardown_job_id` refusal
  beside them already uses. The first one's regeneration branch deletes future
  sessions outright with no bookings check; the second would strip the lessons
  and leave the course still advertising thirteen.
- **Cancelling ONE lesson stays allowed.** That is what "no lesson on 8.10,
  we'll add a make-up" means: seats return, the roster is mailed, the course is
  untouched.

---

## The place: ONE PLACE WRITER

A course's "9 places" is a second capacity axis. The course document is the
serialization point, exactly as the session document is for a seat, and the
counter obeys the seat rule one level up:

> **ONE PLACE WRITER.** `CourseBlock.places_taken` is only ever an ABSOLUTE
> value, written either by `trackCourseBlockEnrolments`' recount or from inside
> a transaction that read the `enrolments` subcollection in the same read set.
> There is NO `FieldValue.increment` on it anywhere. Add a new writer only in
> that shape.

The predicates are deliberate siblings of the seat ones, so a reader who knows
one knows the other:

| Course | Session |
|---|---|
| `courseBlockEnrolmentHoldsPlace` | `bookingHoldsSeat` |
| `countHoldingPlaces` | `countHoldingSeats` |
| `placesFree` | `seatsFree` |
| `placeFreedEdge` | `seatFreedEdge` |

…down to the details that were bugs on the seat side first: a lapsed hold frees
its place **immediately** rather than at the next sweep (a course advertised
full on the strength of an abandoned checkout is a place nobody can reach),
`nowMs` is sampled **once** by the caller, and the caller's own row is excluded
from the count so re-opening an abandoned checkout does not refuse them the
place they hold.

`placeFreedEdge` carries the same binding corollary as `seatFreedEdge`: **a
handler on the edge must not write the course document on any path where it
decides not to promote**, or a harmless touch re-enters it for ever.

---

## One purchase, thirteen bookings

**The enrolment is the truth; the per-session bookings are a projection.**
Nothing writes thirteen bookings inside one transaction.

`syncCourseBlockRoster` is the converger, and its whole safety rests on one
rule:

> **It only ever CREATES a booking that is missing.** It never rewrites one that
> exists.

That is what makes it safe to run arbitrarily often (inline after an enrolment,
from a Cloud Task, from a nightly reconciliation), and it is also what makes
*"the member cancelled lesson six"* stick: a cancelled booking still exists, so
the converger leaves it where it is instead of resurrecting it next pass.

Each ensure is its own small transaction in the shape `bookSession` already
uses: read the session's `bookings`, count with `countHoldingSeats`, write
`bookings_count` **absolutely**. The seat rule is untouched.

**A hold writes no bookings.** An open checkout holds a place, but putting an
unpaid person on thirteen registers and taking them off again when the checkout
lapses is worse than waiting for the money.

**`pending_bookings_count` moves at creation**, with `increment`, because that is
what every existing disposal path expects. It is per-contact, spans every
session and nothing recounts it, so a booking that was never counted would drive
a real person's counter negative the first time they cancelled one lesson.

**A conflict is not a failure.** A lesson already full from an ordinary drop-in
is recorded in `fanout_conflicts` and shown on the roster. Refunding a whole
course over one full lesson is the wrong answer. It is rare by construction:
`createCourseBlock` copies the course's capacity onto the template as
`max_participants` and sets `allowBooking: false`.

---

## Visible is not bookable

A course's lesson carries `allowBooking: false` and has no booking form of its
own, but its public mirror **is** written, with `course_block_id`. A public
calendar has to be able to show that the hall is busy on Wednesdays at 15:45; a
course-shaped hole in the week reads as a bug. A click on such a lesson belongs
to the course, not to a booking form.

---

## Cancellation is a record, not a refund

Following `cancelBooking` (*"NOT money. This callable issues no refund of any
kind"*) and `cancelSingleSession`, which mails a paying attendee and moves no
money:

| What happened | What moves |
|---|---|
| The studio cancels **one lesson** | Seats return, the roster is mailed, and the course is untouched. No place moves and no money moves |
| A participant **withdraws** | The enrolment goes `withdrawn`, the place returns, their **future** bookings are cancelled through the ordinary path. Past bookings stay: they are attendance history. No automatic refund |
| A member cancels **one lesson** themselves | Allowed, deliberately. They keep their place, and the converger never resurrects the booking |
| The studio cancels **the whole course** | The door shuts first, everyone is told once, the remaining lessons go. No money moves: `cancelCourseBlock` RETURNS the payments that may be owed back |

An enrolment is marked `withdrawn`, never deleted: who was on a course is the
studio's record, and a deleted row would also lose the fact that they paid.
Cancelling the whole course withdraws nobody, for the same reason.

### Cancelling the whole course: one message, not one per lesson

The order is the design, and each step closes something the next one depends on:

1. **The door shuts first.** One synchronous `status: 'cancelled'` write. It
   closes every way in at once: `courseBlockSalesOpen` goes false,
   `takeCourseBlockPlace` refuses, and `syncCourseBlockPublicProfile` deletes
   the public mirror. Same "freeze before you enqueue" rule the series teardown
   already follows, and for the same reason: somebody buying a place into a
   course whose lessons are being deleted is the one outcome nothing downstream
   repairs.
2. **The people are told, once.** Nine people on a thirteen-week course would
   otherwise receive a hundred and seventeen mails, because a series teardown
   mails each session's roster. So `cancelSingleSession` takes a `notify`
   argument, carried on the teardown job for the background path
   (`SeriesTeardownJob.notify`), and the course sends one mail per enrolled
   person itself. **It suppresses the MESSAGE and nothing else**: every
   `pending_bookings_count` still moves, the waitlists still close, the deletes
   still happen. Cancelling ONE lesson of a course still mails the roster
   through the very same function, because there it is the news.
3. **The lessons go, from now forward.** Past lessons are attendance history.

The mail **promises no refund**, deliberately. Whether money comes back, and in
what shape (a credit, next term, a partial), is the studio's policy, and a mail
that commits them on their behalf is a commitment this code cannot make.

---

## The waiting list

A full course is the one case where "sold out" is not the end of the
conversation: a term course is bought months ahead, and people drop out. The
queue reuses the class waitlist's **shape** and none of its **storage**.

Three invariants are carried over verbatim (`docs/waitlist.md` owns the
originals):

- **The single-deadline rule.** The offered enrolment's `expires_at`, its
  `claim_expires_at`, the entry's `offer_expires_at` and, for a paid claim, the
  Stripe session all come from ONE `resolveCourseClaimWindow` call and are
  copied. Diverge and a place is sold twice. Stripe's 24-hour ceiling clamps its
  own session DOWN, which is the safe direction: a checkout that dies before the
  hold costs one more click, one that outlives it sells a place that has gone.
- **An offered place is an ordinary enrolment** carrying `waitlist_claim`, held
  as `status: 'hold'`. So `courseBlockEnrolmentHoldsPlace` already counts it and
  already lapses it lazily, and nothing else had to learn what a queue is.
- **Release before re-offering.** The sweep's pass 1 releases, pass 2 offers.

Two things are deliberately **different** from the class queue:

- **The window is DAYS, not hours** (`COURSE_CLAIM_DEFAULT_HOURS = 48`). A class
  seat is a grab-it-now decision; a course is a term's fees and a diary to
  check, and an offer nobody can realistically answer is a place the studio
  loses rather than fills.
- **The subcollection is `course_waitlist`, not `waitlist`,** and the name is
  load-bearing. A collection-group query is a global namespace: the class
  sweep reads `collectionGroup('waitlist')` and walks each hit as a session
  booking, so a course entry under that name would be dereferenced through a
  `session` field it does not have.

The promoter hangs on ONE trigger, the course document's `placeFreedEdge`. Every
way a place can free converges there, because `places_taken` has one writer and
always writes an absolute value. The binding corollary of hanging on an edge:
**on any path where the promoter decides not to promote, it must not write the
course document at all**, or a harmless touch re-enters the edge for ever.

**The claim window is clamped to the course's END, not its start.** A waiting
list exists for the place that frees in week four, so clamping to the first
lesson closed the window before it opened on every course that had already
begun: `offerable` came back false and the promoter returned silently having
done nothing. Whether a place is still worth offering with two lessons left is
the studio's question, and `booking_closes_at` is the control that answers it.

**Every free way onto a course prices it first.** The claim rail settles an
enrolment without a charge, so it runs `resolvePaymentOptions` and refuses a
payable caller with `payment_required` before it writes anything, exactly as the
free join rail does. It shipped without that check while the header above it
said otherwise, which made an offer token the whole gate: whoever held a valid
one settled a course of any price for nothing. `courseBlocks/claimGate.test.ts`
pins the shape for both rails, and the refusal leaves the offer standing so the
claimant can come back through checkout with the same token.

### The claim page

`/public/{slug}/course-waitlist?token=…`, the sibling of `/public/{slug}/waitlist`
for a class seat. **Which token matched decides what the holder may do, and the
SERVER decides that, not the URL**: `getCourseWaitlistEntry` tries the single-use
`offer_token` first and the long-lived `entry_token` second, so a forwarded join
confirmation can only ever show a status view. The link carries ONE parameter and
it is the credential; naming the course and the contact in it would let the page
assert whose offer it was.

It is a callable rather than a client read because it has to be: the queue is
readable only by team members, and somebody who queued from the public shop has
no session at all. The token in their mail is their whole identity there, which
is what `auth/publicSurfaceIdentity.test.ts` records for the route.

---

## Duplicating for next term

The setup is carried, the people never are, and the copy lands in `draft`. Two
rules are decisions rather than plumbing:

- **The shift is in civil days at the studio's wall clock**
  (`shiftWallClockDays`). Adding `n * 86_400_000` moves a 15:45 lesson to 14:45
  across a DST boundary, and a term duplicated into the next term crosses one by
  construction.
- **Skip dates are dropped, not shifted.** "No lesson on 8 October" is a fact
  about one autumn; carried into spring it removes a lesson nobody asked about,
  and the studio finds out in week seven. Starting with every date present is
  the error somebody notices the same day.

The deny-list (`DROPPED_ON_DUPLICATE`) is stated as a deny-list so a field added
to `CourseBlock` later is inherited by default, which is the safe direction for
setup data. `seriesId` is on it for the worst reason available: a copy that kept
it would write its lessons into LAST term's calendar.

**The make-up lesson** is the other half of "one lesson was cancelled":
`addCourseBlockMeeting` appends one meeting and converges, so everybody already
enrolled gets a booking for it and nobody is sold anything.

---

## Security

Unlike the series it owns, **every client write to a course is denied**. A
series is client-writable because `SessionFormDialog` writes one directly and
the series doc IS the commit for a hand-made recurring class; a course carries a
capacity counter and (from the sale stage) a price, and neither can live on a
document a client may edit. That asymmetry is asserted out loud in
`courseBlocks/courseBlockAccess.rules-test.ts` rather than left to be
rediscovered.

**Both subcollections authorise from the PARENT course, never from
`resource`.** `belongsToUserTeam(resource)` reads `resource.data.teamId`:
fine on a **get**, where there is a document in hand, and fatal on a **list**,
where there is not. The property access raises and the whole query is denied,
on an empty subcollection as readily as on a full one. It shipped that way and
nothing said so, because the roster panel renders a denied list as "nobody is
on this course yet", which is also what an empty course looks like, and a rules
denial reaches no log this side of the browser console. Every read in the rules
test is now asserted as a list as well as a get.

---

## Files

| Concern | File |
|---|---|
| Type, predicates, the place rule | `packages/shared/src/types/courseBlock.ts` |
| The meeting-list resolver | `packages/functions/src/courseBlocks/schedule.ts` |
| Create / reschedule / publish / delete | `packages/functions/src/courseBlocks/index.ts` |
| Enrolment, the converger, the recount | `packages/functions/src/courseBlocks/enrolment.ts` |
| The sale, and the waiting-list claim arm | `packages/functions/src/courseBlocks/checkout.ts` |
| Cancelling the whole course | `packages/functions/src/courseBlocks/cancel.ts` |
| Duplicate, and the make-up lesson | `packages/functions/src/courseBlocks/duplicate.ts` |
| The waiting list | `packages/functions/src/courseBlocks/waitlist.ts` |
| Seeding a term course | `scripts/lib/courseBlocks.ts` (+ `courseSchedule.ts`, pure) |
| Rules | `firestore.rules` → `match /course_blocks/{blockId}` |
| Admin | `apps/web/src/components/offer/CourseBlockDialog.tsx`, the Courses tab in `manage/offer` |

## In the accounts

**A course sale books to the `course` category, beside an online-course sale.**
The two are different products and the distinction is kept on
`PaymentLineItem.kind`, but a studio's accounts have one question here and it is
"what did courses bring in".

The mechanism is worth knowing because it was wrong first: **`mapCategory` is
fed the payment's TOP-LEVEL `kind`, not its line item.** A row carrying only
`line_item` is invisible to it, to the refund reversal and to the payments
list's label, so every course sale landed in `other` and the studio's course
income was not course income, on the journal, in the CSV and on the charts.
`handlePaymentIntent` therefore stamps `kind: 'course_block'` and the course
name, exactly as it does for a drop-in or an appointment.

## Seeding one

Every seeder writes a term course **mid-run**: a few lessons behind it, most
ahead, places part-taken. A course that has not started shows an empty roster
and nothing to attend, one that has finished cannot be enrolled on, and both
read as a working seed until somebody opens them.

Two rules the helper follows, each of which was a defect first:

- **Money together or not at all.** One enrolment is paid and is written with
  its `member_payments` row in the same call; the rest are studio-granted, which
  is what `enrolCourseBlockContact` writes. Its PaymentIntent id carries a
  `_course_block` suffix, because `pi_seed_{contact}_course` already belongs to
  the online-courses fixture and the two collided on one document: a course sale
  silently became an online-course sale, with the enrolment still pointing at it.
- **The anchor is the most recent occurrence that has ALREADY HAPPENED.** On the
  course's own weekday, before the lesson's time of day, "this week's
  occurrence" is still ahead, so anchoring on it leaves one fewer lesson behind
  us than asked for. Wrong on exactly one day in seven, which is why
  `courseSchedule.ts` is a pure import-free leaf with fixtures over a whole week.

### Joining from a sold-out card

`joinCourseBlockWaitlist` is a PUBLIC rail, so it resolves who is joining rather
than being told. The identity rules are the class queue's and are not re-decided:
a verified contact session is the only identity trusted from the caller (a
`contactId` in the body proves nothing and would let anyone enumerate a studio's
contacts), a guest gives email plus name and an exact match on all three is the
same person, and a new joiner becomes a PROVISIONAL contact whose expiry is tied
to the course's LAST lesson rather than a session start.

**An email address is not optional**, and that is mechanical rather than a
preference: a place is only ever redeemed through the mailed claim link, and an
entry is offered once, ever. Somebody unreachable would take a place, be offered
it, and be dropped having never been told.

The card's dialog is self-contained rather than a step in the booking flow. A
class seat is chosen inside that machine; a course card sits above it, and
pulling it through would mean teaching every step about an offer type it never
otherwise sees.

## Not built yet

Open: linking a plan to a course (the pane says so), and a Courses tab in
the Shop.

**One rename has to land WITH the sale, not after it.** The studio side already
says *Online courses* everywhere (the nav did before this work, and the
Offerings rail does now), but the member's Space still says "Courses", "My
courses" and "Browse courses" for the video plugin. Today that is unambiguous,
because a member cannot see a scheduled course at all. The moment the sale ships
a public course surface, a member sees both under one word, so
`Space.myCourses`, `Space.coursesSection`, `Space.browseCourses` and their
siblings become *Online courses* in the same change that gives courses a public
page.
