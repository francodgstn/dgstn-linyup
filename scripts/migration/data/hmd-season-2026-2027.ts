/**
 * HMD'S PUBLISHED SEASON CALENDAR, 2026/2027 — the editable source.
 *
 * This file IS the calendar. Edit it here and re-run the season pass; nothing
 * else needs changing, and re-running converges because every row carries its
 * own document id.
 *
 * ── HOW TO EDIT ─────────────────────────────────────────────────────────────
 *  • Dates are `'YYYY-MM-DD'`, wall-clock at the venue. A one-day event has the
 *    same `start` and `end`.
 *  • `external: true` means HMD does not organise it. It still belongs on the
 *    calendar — members compete at these — but nobody at HMD runs the door.
 *  • `id` is the Firestore document id. NEVER change one after a run: check-ins,
 *    invitations and programme items all hang off it, and a changed id creates a
 *    second event rather than moving the first.
 *
 * ── THE TYPE IS NOT COSMETIC ────────────────────────────────────────────────
 * `type` drives HMD's own belt rules. The ladder seeded by the `hmd-belts`
 * plugin asks each dan candidate for one CAMP, one TOURNAMENT and one EXAM
 * since their last grading, so an event typed `workshop` when it is really a
 * camp silently costs every attendee a requirement — and nothing reports it.
 *
 *   camp              → Montagna Invernale, Montagna Estiva, Family Camp
 *   exam              → Esami HMD
 *   competition       → the WAKO circuit and other outside opens
 *   hmd_fighting_cup  → HMD's own cup (the plugin's event type)
 *   seminar / workshop → training that counts toward nothing
 *   other             → none of the above; counts toward nothing
 *
 * ── THE GUESSED ROWS, AS HMD ANSWERED THEM (2026-09-07) ─────────────────────
 * Nothing here is a guess any more — no row is awaiting confirmation.
 *
 * Riunione Cinture Nere and Budo Night are `other`, not `seminar` — one is a
 * plain meeting, the other a once-a-year show, and neither involves teaching.
 * `other` was added to the built-in types for exactly this shape of event;
 * `BuiltinEventType` in `packages/shared/src/types/event.ts` says why a
 * catch-all had to be one. Both already counted toward nothing, so this is a
 * LABELLING correction and moves no belt requirement.
 *
 * Escursione Pre Pasqua IS a `camp`, and that one does change the rules. It is
 * a new one-day format REPLACING the Easter camp — and the Easter camp counted.
 * Typing the replacement as anything else would quietly withdraw a requirement
 * from everyone who attends the thing that replaced it, which is the silent
 * failure this header warns about two paragraphs up. One consequence to
 * expect: `camp` is the one type whose check-in demands `join_as`
 * (`isCheckinCompleted`), so a day outing's roster now asks what each person
 * is coming as.
 *
 * ── THE PUBLISHED ORDER IS NOT ALWAYS BY DATE ───────────────────────────────
 * March lists the Italian World Cup (11–15) above Esami (13), and May lists the
 * Zagreb World Cup (30 May – 4 Jun) above the IV Cup (22). Both overlaps are
 * real — an external circuit event running across an HMD date — so the rows are
 * ordered by date here and the published sheet's order is not reproduced.
 */

export type SeasonEventType =
  | 'competition'
  | 'camp'
  | 'exam'
  | 'seminar'
  | 'workshop'
  | 'other'
  | 'hmd_fighting_cup'

export interface SeasonEvent {
  /** Firestore document id. Stable forever — see the header. */
  id: string
  title: string
  type: SeasonEventType
  /** 'YYYY-MM-DD' at the venue. */
  start: string
  /** 'YYYY-MM-DD'. Same as `start` for a one-day event. */
  end: string
  /** Not organised by HMD. Members still attend; HMD does not run it. */
  external?: boolean
  location?: string
  /**
   * Free text that becomes part of the event's DESCRIPTION — members read it,
   * on the event page (`describe()` in the season pass).
   *
   * Reasoning about WHY a row is typed the way it is is not that. It goes in a
   * `//` comment above the row, where the next editor of this file sees it and
   * no member does.
   */
  note?: string
  /**
   * "This type is a guess — ask HMD." Internal: the season pass prints these
   * loudly at the end of a run and NEVER writes them to Firestore.
   *
   * It has its own field because it used to be a `CONFIRM:` prefix on `note` —
   * and `note` is member-facing copy, so the marker for an unanswered question
   * would now be published on the event page as its description.
   */
  confirm?: string
}

/** The season these events belong to, for the pass's log line. */
export const HMD_SEASON_LABEL = '2026/2027'

export const HMD_SEASON_EVENTS: SeasonEvent[] = [
  // ── Settembre 2026 ────────────────────────────────────────────────────────
  {
    // A black-belt MEETING — nobody is taught anything, so `seminar` was a
    // claim about it that was not true. Counts toward nothing either way.
    id: 'hmd-2026-09-12-riunione-cinture-nere',
    title: 'Riunione Cinture Nere HMD',
    type: 'other',
    start: '2026-09-12',
    end: '2026-09-12',
  },

  // ── Ottobre 2026 ──────────────────────────────────────────────────────────
  {
    id: 'hmd-2026-10-10-seminario',
    title: 'Seminario HMD',
    type: 'seminar',
    start: '2026-10-10',
    end: '2026-10-10',
  },
  {
    id: 'hmd-2026-10-22-bristol-open',
    title: 'Bristol Open',
    type: 'competition',
    start: '2026-10-22',
    end: '2026-10-26',
    external: true,
  },

  // ── Novembre 2026 ─────────────────────────────────────────────────────────
  {
    id: 'hmd-2026-11-15-fighting-cup-i',
    title: 'I HMD Fighting Cup',
    type: 'hmd_fighting_cup',
    start: '2026-11-15',
    end: '2026-11-15',
  },
  {
    id: 'hmd-2026-11-28-esami',
    title: 'Esami HMD',
    type: 'exam',
    start: '2026-11-28',
    end: '2026-11-28',
  },

  // ── Dicembre 2026 ─────────────────────────────────────────────────────────
  {
    // A show, once a year. HMD's own call: not worth a type of its own, so it
    // takes the catch-all. Counts toward nothing.
    id: 'hmd-2026-12-19-budo-night',
    title: 'Budo Night',
    type: 'other',
    start: '2026-12-19',
    end: '2026-12-19',
  },
  {
    id: 'hmd-2026-12-27-montagna-invernale',
    title: 'Montagna Invernale',
    type: 'camp',
    start: '2026-12-27',
    end: '2026-12-30',
  },

  // ── Gennaio 2027 ──────────────────────────────────────────────────────────
  {
    id: 'hmd-2027-01-17-seminario',
    title: 'Seminario HMD',
    type: 'seminar',
    start: '2027-01-17',
    end: '2027-01-17',
  },
  {
    id: 'hmd-2027-01-21-athens-challenge',
    title: 'Athens Challenge — WAKO',
    type: 'competition',
    start: '2027-01-21',
    end: '2027-01-25',
    external: true,
  },

  // ── Febbraio 2027 ─────────────────────────────────────────────────────────
  {
    id: 'hmd-2027-02-14-fighting-cup-ii',
    title: 'II HMD Fighting Cup',
    type: 'hmd_fighting_cup',
    start: '2027-02-14',
    end: '2027-02-14',
  },

  // ── Marzo 2027 ────────────────────────────────────────────────────────────
  {
    id: 'hmd-2027-03-11-italian-world-cup',
    title: 'Italian World Cup — WAKO, Jesolo',
    type: 'competition',
    start: '2027-03-11',
    end: '2027-03-15',
    external: true,
    location: 'Jesolo',
  },
  {
    // Runs INSIDE the Italian World Cup window above. Both are in the published
    // calendar; the overlap is not a transcription error.
    id: 'hmd-2027-03-13-esami',
    title: 'Esami HMD',
    type: 'exam',
    start: '2027-03-13',
    end: '2027-03-13',
  },
  {
    // ONE DAY, AND STILL A CAMP. A new format replacing the Easter camp — and
    // the Easter camp counted toward the camp requirement. Typing the
    // replacement as a workshop would withdraw that requirement from everyone
    // who attends it, silently. The duration is not what `camp` means here.
    id: 'hmd-2027-03-27-escursione-pre-pasqua',
    title: 'Escursione Pre Pasqua',
    type: 'camp',
    start: '2027-03-27',
    end: '2027-03-27',
    note: 'Replaces the Easter camp.',
  },

  // ── Aprile 2027 ───────────────────────────────────────────────────────────
  {
    id: 'hmd-2027-04-18-fighting-cup-iii',
    title: 'III HMD Fighting Cup',
    type: 'hmd_fighting_cup',
    start: '2027-04-18',
    end: '2027-04-18',
  },

  // ── Maggio 2027 ───────────────────────────────────────────────────────────
  {
    id: 'hmd-2027-05-22-fighting-cup-iv',
    title: 'IV HMD Fighting Cup — Abruzzo',
    type: 'hmd_fighting_cup',
    start: '2027-05-22',
    end: '2027-05-22',
    location: 'Abruzzo',
  },
  {
    // '30/4' in the published sheet — 30 May into 4 June. The only row that
    // crosses a month boundary.
    id: 'hmd-2027-05-30-zagreb-world-cup',
    title: 'Zagreb World Cup — WAKO',
    type: 'competition',
    start: '2027-05-30',
    end: '2027-06-04',
    external: true,
  },

  // ── Giugno 2027 ───────────────────────────────────────────────────────────
  {
    id: 'hmd-2027-06-12-family-camp',
    title: 'Family Camp',
    type: 'camp',
    start: '2027-06-12',
    end: '2027-06-14',
  },
  {
    id: 'hmd-2027-06-19-esami',
    title: 'Esami HMD',
    type: 'exam',
    start: '2027-06-19',
    end: '2027-06-19',
  },

  // ── Luglio 2027 ───────────────────────────────────────────────────────────
  {
    id: 'hmd-2027-07-22-montagna-estiva',
    title: 'Montagna Estiva',
    type: 'camp',
    start: '2027-07-22',
    end: '2027-07-26',
  },
]
