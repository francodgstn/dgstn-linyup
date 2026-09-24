/**
 * Where a seeded course's lessons fall. Pure, and deliberately IMPORT-FREE.
 *
 * It lives apart from `courseBlocks.ts` for one reason: that module reaches
 * firebase-admin and the money fixtures, and the seed scripts do not resolve
 * `@linyup/shared`, so anything importing it cannot be compiled by the
 * functions test runner. This leaf can be, which is what lets the one piece of
 * arithmetic in the seeder have a test at all (`courseBlocks/seedSchedule.test.ts`).
 */

/**
 * The lesson dates: `lessonsElapsed` of them behind us, the rest ahead, all on
 * the same weekday at the same wall-clock time.
 *
 * ANCHORED TO THE MOST RECENT OCCURRENCE of the weekday, not to today, which is
 * the whole point: `/try` reseeds nightly and `pnpm emulators:seed` runs
 * whenever somebody feels like it, so this is evaluated on all seven weekdays
 * and has to put the course a third of the way through on every one of them. A
 * course that lands entirely in the future shows an empty roster and nothing to
 * attend; one entirely in the past cannot be enrolled on. Both read as a
 * working seed until somebody opens them.
 *
 * Day arithmetic is done on the LOCAL date parts (`setDate`), so a week that
 * crosses a DST boundary is still "one week later at 18:00" rather than 17:00.
 */
export function courseLessonDates(spec: {
  /** JS `getDay()`: 0=Sun … 6=Sat. */
  dayOfWeek: number
  /** 'HH:MM', local. */
  time: string
  lessons: number
  lessonsElapsed: number
}): Date[] {
  const now = new Date()
  const [hh, mm] = spec.time.split(':').map(Number)

  // The most recent occurrence of the weekday that has ALREADY HAPPENED.
  //
  // The second step is the one that is easy to miss: on the course's own
  // weekday, before the lesson's time of day, "this week's occurrence" is still
  // ahead of us, so anchoring on it leaves one fewer lesson behind us than
  // asked for. That is wrong on exactly one day in seven, which is precisely
  // the kind of thing nobody notices by looking.
  const anchor = new Date(now)
  anchor.setHours(hh, mm, 0, 0)
  anchor.setDate(anchor.getDate() - ((anchor.getDay() - spec.dayOfWeek + 7) % 7))
  if (anchor.getTime() > now.getTime()) anchor.setDate(anchor.getDate() - 7)

  const first = new Date(anchor)
  first.setDate(anchor.getDate() - (spec.lessonsElapsed - 1) * 7)
  return Array.from({ length: spec.lessons }, (_, i) => {
    const d = new Date(first)
    d.setDate(first.getDate() + i * 7)
    return d
  })
}
