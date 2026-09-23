---
title: Courses
description: Courses — a bounded, sellable set of lessons
status: living
area: booking
order: 6
---
# Courses

A **course** is a bounded set of lessons sold as one thing:

> Every Wednesday 15:45–16:15, 20.08 to 26.11, no lesson on 8.10 and 15.10 —
> 13 lessons, 9 places, CHF 364, one booking, the child enrolled in every one.

A class is a seat in a session. A course is the whole set, and the set is what
the studio and the parent both talk about: "levels 1 to 5 start in August",
"13 lessons", "9 places", "sold out". None of that is expressible as thirteen
independent sessions — thirteen sessions at 9/9 are thirteen answers to one
question, and a child who misses lesson four must not free a place.

**Two words, two things.** In the UI, *Course* is this; the online-courses
plugin (`courses/{id}`, on-demand video) is *Online course*. In code they are
`course_blocks/{id}` and `courses/{id}`, and they never share a message
namespace — `CourseBlocks` and `Courses` — so they cannot drift into sharing a
word by accident. Stored values never change; the display rename is display-only.

---

## The shape: meetings are a LIST

`RecurrencePattern` carries one `startDate` — which is also its time of day —
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
reimplementing a calendar — skip dates, the DST-safe advance and the
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
missing document throws — a course with no series doc would break "cancel the
whole course" silently.

`status: 'fixed'` means *materialised in full, nothing to roll*. The daily
roller queries `status == 'active'`, so a course's series is never even read.

### The refusals

Reuse cuts both ways, so three guards:

- **Every lesson carries `course_block_id`**, stamped by `buildSeriesSessionDoc`
  from the **series**, not the template — a fact about which series this is, not
  a field a studio can edit off a lesson.
- **`updateRecurringSession` and the series-wide `cancelSession` refuse** a
  series carrying `course_block_id`, in the shape the `teardown_job_id` refusal
  beside them already uses. The first one's regeneration branch deletes future
  sessions outright with no bookings check; the second would strip the lessons
  and leave the course still advertising thirteen.
- **Cancelling ONE lesson stays allowed.** That is what "no lesson on 8.10,
  we'll add a make-up" means: seats return, the roster is mailed, the course is
  untouched.

---

## The place — ONE PLACE WRITER

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

That is what makes it safe to run arbitrarily often — inline after an enrolment,
from a Cloud Task, from a nightly reconciliation — and it is also what makes
*"the member cancelled lesson six"* stick: a cancelled booking still exists, so
the converger leaves it where it is instead of resurrecting it next pass.

Each ensure is its own small transaction in the shape `bookSession` already
uses: read the session's `bookings`, count with `countHoldingSeats`, write
`bookings_count` **absolutely**. The seat rule is untouched.

**A hold writes no bookings.** An open checkout holds a place, but putting an
unpaid person on thirteen registers and taking them off again when the checkout
lapses is worse than waiting for the money.

**`pending_bookings_count` moves at creation**, with `increment`, because that is
what every existing disposal path expects — it is per-contact, spans every
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

Following `cancelBooking` — *"NOT money — this callable issues no refund of any
kind"* — and `cancelSingleSession`, which mails a paying attendee and moves no
money:

| What happened | What moves |
|---|---|
| The studio cancels **one lesson** | Seats return, the roster is mailed, the course is untouched — no place moves, no money moves |
| A participant **withdraws** | The enrolment goes `withdrawn`, the place returns, their **future** bookings are cancelled through the ordinary path. Past bookings stay: they are attendance history. No automatic refund |
| A member cancels **one lesson** themselves | Allowed, deliberately. They keep their place, and the converger never resurrects the booking |

An enrolment is marked `withdrawn`, never deleted: who was on a course is the
studio's record, and a deleted row would also lose the fact that they paid.

---

## Security

Unlike the series it owns, **every client write to a course is denied**. A
series is client-writable because `SessionFormDialog` writes one directly and
the series doc IS the commit for a hand-made recurring class; a course carries a
capacity counter and (from the sale stage) a price, and neither can live on a
document a client may edit. That asymmetry is asserted out loud in
`courseBlocks/courseBlockAccess.rules-test.ts` rather than left to be
rediscovered.

---

## Files

| Concern | File |
|---|---|
| Type, predicates, the place rule | `packages/shared/src/types/courseBlock.ts` |
| The meeting-list resolver | `packages/functions/src/courseBlocks/schedule.ts` |
| Create / reschedule / publish / delete | `packages/functions/src/courseBlocks/index.ts` |
| Enrolment, the converger, the recount | `packages/functions/src/courseBlocks/enrolment.ts` |
| Rules | `firestore.rules` → `match /course_blocks/{blockId}` |
| Admin | `apps/web/src/components/offer/CourseBlockDialog.tsx`, the Courses tab in `manage/offer` |

## Not built yet

The sale (a price, a checkout, the plan edge), the waiting list, duplicate for
next term, and cancelling a whole course. Each is its own stage; nothing above
writes a price.
