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
 *   seminar / workshop → everything else; counts toward nothing
 *
 * ── SOME ROWS ARE MY BEST GUESS, NOT HMD'S ANSWER ───────────────────────────
 * They are marked `CONFIRM` in `note`. Riunione Cinture Nere is a black-belt
 * MEETING, Budo Night is a social evening and Escursione Pre Pasqua is a
 * one-day outing — none of the five built-in types is obviously right for any
 * of them, and I have typed all three as things that count toward nothing,
 * which is the conservative direction. If the Escursione is really a day camp,
 * change it and the attendees gain a requirement they earned.
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
  /** Free text. `CONFIRM:` marks something I guessed — see the header. */
  note?: string
}

/** The season these events belong to, for the pass's log line. */
export const HMD_SEASON_LABEL = '2026/2027'

export const HMD_SEASON_EVENTS: SeasonEvent[] = [
  // ── Settembre 2026 ────────────────────────────────────────────────────────
  {
    id: 'hmd-2026-09-12-riunione-cinture-nere',
    title: 'Riunione Cinture Nere HMD',
    type: 'seminar',
    start: '2026-09-12',
    end: '2026-09-12',
    note: 'CONFIRM: a black-belt MEETING. Typed seminar because no built-in type fits; counts toward nothing.',
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
    id: 'hmd-2026-12-19-budo-night',
    title: 'Budo Night',
    type: 'seminar',
    start: '2026-12-19',
    end: '2026-12-19',
    note: 'CONFIRM: a social evening. Typed seminar; counts toward nothing.',
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
    id: 'hmd-2027-03-27-escursione-pre-pasqua',
    title: 'Escursione Pre Pasqua',
    type: 'workshop',
    start: '2027-03-27',
    end: '2027-03-27',
    note: 'CONFIRM: a one-day outing, so NOT typed camp. If it is a day camp, change the type — attendees gain a belt requirement.',
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
