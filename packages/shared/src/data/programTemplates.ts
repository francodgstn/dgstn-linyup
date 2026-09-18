import type { ProgramTemplate, ProgramTemplateItem } from '../types/event'

// ─── Starter programme library ─────────────────────────────────────────────────
// A small, built-in repository of ready-made event programmes so a studio can
// start from a sensible skeleton instead of a blank agenda. Each entry is a
// plain `ProgramTemplate` body (the same shape `extractTemplate` produces and
// `materialiseTemplate` consumes), so a starter can be:
//   • applied straight onto an event  → materialiseTemplate(starter, date, newId)
//   • cloned into a studio's own list → useSaveProgramTemplate(scope, ownerId)
// with NO special-casing in the engine.
//
// The content is authoring-language (English) free text, exactly like a
// user-authored template and like activity/place names — a studio clones a
// starter and adjusts it on a real event, so the item titles are placeholders,
// not UI chrome (see site-translations "Never translated" list). Linyup is
// sport-agnostic, so the wording is generic on purpose.

/** The reusable body of a template, minus its identity + audit fields. */
export type ProgramTemplateBody = Pick<
  ProgramTemplate,
  'days' | 'tracks' | 'items' | 'timezoneLabel' | 'note'
>

/** A built-in template the studio can apply or clone. It IS a template body, so
 *  it flows through `materialiseTemplate` / the save hook unchanged. */
export interface StarterProgramTemplate extends ProgramTemplateBody {
  /** Stable slug — never a Firestore id; used for picker keys + icon lookup. */
  id: string
  /** lucide-react icon name, resolved by the UI. */
  icon: string
  name: string
  description: string
}

// A track colour palette kept small and neutral — a studio recolours on the
// event anyway. Values are Tailwind-ish hexes matching the rest of the app.
const TRACK_A = '#2563eb' // blue
const TRACK_B = '#f97316' // orange

/** Assemble items for one day, numbering `order` sequentially so items sharing a
 *  start time keep a stable, authored order (times still drive the display). */
function day(
  dayIndex: number,
  rows: Array<Omit<ProgramTemplateItem, 'dayIndex' | 'order'>>,
): ProgramTemplateItem[] {
  return rows.map((row, i) => ({ ...row, dayIndex, order: i }))
}

// ── 1. Half-day workshop ────────────────────────────────────────────────────
const HALF_DAY_WORKSHOP: StarterProgramTemplate = {
  id: 'half-day-workshop',
  icon: 'GraduationCap',
  name: 'Half-day workshop',
  description: 'A single morning: welcome, two working sessions and a wrap-up.',
  tracks: [],
  days: [{ dayIndex: 0, title: 'Workshop' }],
  items: day(0, [
    { startTime: '09:00', endTime: '09:30', title: 'Welcome & registration', kind: 'briefing' },
    { startTime: '09:30', endTime: '10:45', title: 'Session 1 — fundamentals', kind: 'activity' },
    { startTime: '10:45', endTime: '11:00', title: 'Break', kind: 'break' },
    { startTime: '11:00', endTime: '12:15', title: 'Session 2 — practice', kind: 'activity' },
    { startTime: '12:15', endTime: '12:30', title: 'Wrap-up & questions', kind: 'briefing' },
  ]),
}

// ── 2. Weekend seminar (two parallel tracks) ─────────────────────────────────
const SEM_FUND = 'fundamentals'
const SEM_ADV = 'advanced'
const WEEKEND_SEMINAR: StarterProgramTemplate = {
  id: 'weekend-seminar',
  icon: 'CalendarDays',
  name: 'Weekend seminar',
  description: 'Two days across a Fundamentals and an Advanced track, with shared meals and open mat.',
  tracks: [
    { id: SEM_FUND, name: 'Fundamentals', color: TRACK_A, order: 0 },
    { id: SEM_ADV, name: 'Advanced', color: TRACK_B, order: 1 },
  ],
  days: [
    { dayIndex: 0, title: 'Day 1' },
    { dayIndex: 1, title: 'Day 2' },
  ],
  items: [
    ...day(0, [
      { startTime: '08:30', endTime: '09:00', title: 'Registration & coffee', kind: 'briefing' },
      { startTime: '09:00', endTime: '09:15', title: 'Opening briefing', kind: 'briefing' },
      { startTime: '09:15', endTime: '10:45', trackId: SEM_FUND, title: 'Technique block', kind: 'activity' },
      { startTime: '09:15', endTime: '10:45', trackId: SEM_ADV, title: 'Technique block', kind: 'activity' },
      { startTime: '10:45', endTime: '11:00', title: 'Break', kind: 'break' },
      { startTime: '11:00', endTime: '12:30', trackId: SEM_FUND, title: 'Guided drills', kind: 'activity' },
      { startTime: '11:00', endTime: '12:30', trackId: SEM_ADV, title: 'Guided drills', kind: 'activity' },
      { startTime: '12:30', endTime: '13:30', title: 'Lunch', kind: 'meal' },
      { startTime: '13:30', endTime: '15:00', trackId: SEM_FUND, title: 'Application', kind: 'activity' },
      { startTime: '13:30', endTime: '15:00', trackId: SEM_ADV, title: 'Sparring', kind: 'activity' },
      { startTime: '15:00', endTime: '15:15', title: 'Break', kind: 'break' },
      { startTime: '15:15', endTime: '16:30', title: 'Open mat & Q&A', kind: 'free' },
    ]),
    ...day(1, [
      { startTime: '09:00', endTime: '09:15', title: 'Recap briefing', kind: 'briefing' },
      { startTime: '09:15', endTime: '10:45', trackId: SEM_FUND, title: 'Morning session', kind: 'activity' },
      { startTime: '09:15', endTime: '10:45', trackId: SEM_ADV, title: 'Morning session', kind: 'activity' },
      { startTime: '10:45', endTime: '11:00', title: 'Break', kind: 'break' },
      { startTime: '11:00', endTime: '12:30', title: 'Combined session', kind: 'activity' },
      { startTime: '12:30', endTime: '13:30', title: 'Lunch', kind: 'meal' },
      { startTime: '13:30', endTime: '14:30', title: 'Review & feedback', kind: 'briefing' },
      { startTime: '14:30', endTime: '15:00', title: 'Closing ceremony', kind: 'ceremony', isHighlight: true },
    ]),
  ],
}

// ── 3. Five-day camp (two age tracks, repeating training rhythm) ─────────────
const CAMP_JR = 'juniors'
const CAMP_SR = 'seniors'
const campTrainingDay = (dayIndex: number): ProgramTemplateItem[] =>
  day(dayIndex, [
    { startTime: '07:30', endTime: '08:00', title: 'Morning mobility', kind: 'activity' },
    { startTime: '08:00', endTime: '09:00', title: 'Breakfast', kind: 'meal' },
    { startTime: '09:30', endTime: '11:00', trackId: CAMP_JR, title: 'Morning session', kind: 'activity' },
    { startTime: '09:30', endTime: '11:00', trackId: CAMP_SR, title: 'Morning session', kind: 'activity' },
    { startTime: '11:00', endTime: '11:30', title: 'Break', kind: 'break' },
    { startTime: '11:30', endTime: '13:00', trackId: CAMP_JR, title: 'Technique lab', kind: 'activity' },
    { startTime: '11:30', endTime: '13:00', trackId: CAMP_SR, title: 'Technique lab', kind: 'activity' },
    { startTime: '13:00', endTime: '14:30', title: 'Lunch & rest', kind: 'meal' },
    { startTime: '15:00', endTime: '16:30', title: 'Afternoon session', kind: 'activity' },
    { startTime: '16:30', endTime: '17:00', title: 'Cool-down & recovery', kind: 'activity' },
    { startTime: '18:30', endTime: '19:30', title: 'Dinner', kind: 'meal' },
    { startTime: '20:00', endTime: '21:00', title: 'Evening programme', kind: 'free' },
  ])
const FIVE_DAY_CAMP: StarterProgramTemplate = {
  id: 'five-day-camp',
  icon: 'Tent',
  name: 'Five-day camp',
  description: 'Arrival, three full training days across Juniors and Seniors tracks, and a departure morning.',
  note: 'Times are the venue’s local wall-clock — adjust to your site on the event.',
  tracks: [
    { id: CAMP_JR, name: 'Juniors', color: TRACK_A, order: 0 },
    { id: CAMP_SR, name: 'Seniors', color: TRACK_B, order: 1 },
  ],
  days: [
    { dayIndex: 0, title: 'Day 1', subtitle: 'Arrival' },
    { dayIndex: 1, title: 'Day 2' },
    { dayIndex: 2, title: 'Day 3' },
    { dayIndex: 3, title: 'Day 4' },
    { dayIndex: 4, title: 'Day 5', subtitle: 'Departure' },
  ],
  items: [
    ...day(0, [
      { startTime: '15:00', endTime: '17:00', title: 'Check-in & registration', kind: 'briefing' },
      { startTime: '17:00', endTime: '18:00', title: 'Welcome & orientation', kind: 'briefing' },
      { startTime: '18:30', endTime: '19:30', title: 'Dinner', kind: 'meal' },
      { startTime: '20:00', endTime: '21:00', title: 'Opening social', kind: 'free' },
    ]),
    ...campTrainingDay(1),
    ...campTrainingDay(2),
    ...campTrainingDay(3),
    ...day(4, [
      { startTime: '08:00', endTime: '09:00', title: 'Breakfast', kind: 'meal' },
      { startTime: '09:30', endTime: '11:00', title: 'Final session', kind: 'activity' },
      { startTime: '11:00', endTime: '11:30', title: 'Closing ceremony', kind: 'ceremony', isHighlight: true },
      { startTime: '11:30', endTime: '12:30', title: 'Group photo & farewell', kind: 'free' },
      { startTime: '12:30', endTime: '13:00', title: 'Check-out', kind: 'transfer' },
    ]),
  ],
}

// ── 4. One-day competition ───────────────────────────────────────────────────
const COMPETITION_DAY: StarterProgramTemplate = {
  id: 'competition-day',
  icon: 'Trophy',
  name: 'One-day competition',
  description: 'Registration and weigh-in through pools, finals and the awards ceremony.',
  tracks: [],
  days: [{ dayIndex: 0, title: 'Competition day' }],
  items: day(0, [
    { startTime: '08:00', endTime: '09:00', title: 'Registration & weigh-in', kind: 'briefing' },
    { startTime: '09:00', endTime: '09:30', title: 'Referees & coaches briefing', kind: 'briefing' },
    { startTime: '09:30', endTime: '09:45', title: 'Opening', kind: 'ceremony' },
    { startTime: '09:45', endTime: '12:30', title: 'Pool rounds', kind: 'activity', isHighlight: true },
    { startTime: '12:30', endTime: '13:15', title: 'Lunch break', kind: 'meal' },
    { startTime: '13:15', endTime: '15:30', title: 'Elimination rounds', kind: 'activity' },
    { startTime: '15:30', endTime: '16:30', title: 'Finals', kind: 'activity', isHighlight: true },
    { startTime: '16:30', endTime: '17:00', title: 'Awards ceremony', kind: 'ceremony', isHighlight: true },
  ]),
}

// ── 5. Grading / testing day ─────────────────────────────────────────────────
const GRADING_DAY: StarterProgramTemplate = {
  id: 'grading-day',
  icon: 'ClipboardCheck',
  name: 'Grading day',
  description: 'A structured assessment: warm-up, two assessed parts, panel review and results.',
  tracks: [],
  days: [{ dayIndex: 0, title: 'Grading day' }],
  items: day(0, [
    { startTime: '09:00', endTime: '09:30', title: 'Check-in & warm-up', kind: 'briefing' },
    { startTime: '09:30', endTime: '11:00', title: 'Assessment — part 1', kind: 'activity' },
    { startTime: '11:00', endTime: '11:15', title: 'Break', kind: 'break' },
    { startTime: '11:15', endTime: '12:30', title: 'Assessment — part 2', kind: 'activity' },
    { startTime: '12:30', endTime: '13:00', title: 'Panel review', kind: 'free' },
    { startTime: '13:00', endTime: '13:30', title: 'Results & presentation', kind: 'ceremony', isHighlight: true },
  ]),
}

/** The built-in library, in the order shown in the picker (quickest first). */
export const STARTER_PROGRAM_TEMPLATES: StarterProgramTemplate[] = [
  HALF_DAY_WORKSHOP,
  WEEKEND_SEMINAR,
  FIVE_DAY_CAMP,
  COMPETITION_DAY,
  GRADING_DAY,
]

export function starterTemplateById(id: string): StarterProgramTemplate | undefined {
  return STARTER_PROGRAM_TEMPLATES.find((s) => s.id === id)
}
