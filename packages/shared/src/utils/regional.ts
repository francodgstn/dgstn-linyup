/**
 * Regional DISPLAY settings — ONE model and ONE resolver for how the product
 * renders dates and times.
 *
 * All four settings live on the TEAM (`Team.regional`), never on the user. A
 * studio is a place with one clock, one calendar and one printed roster; two
 * staff reading the same manifest must read the same thing. The user's UI
 * LANGUAGE stays per-user and layers on top — it picks the words (weekday and
 * month names), the team picks the shape (zone, week start, date order, hour
 * cycle).
 *
 * The defaults are Swiss and they apply when the field is ABSENT, so every
 * tenant that predates this has them with no migration and no backfill:
 * Europe/Zurich, weeks starting Monday, DD/MM/YYYY, 24-hour.
 *
 * That default is a CHOICE, and it is one a tenant can see and undo. A studio
 * outside Swiss time was previously rendered in whatever zone the reader's
 * browser was in, so this is a real change for it, not a no-op: the dashboard
 * therefore owns the zone rather than inheriting it. Settings → Team → Region
 * & formats writes all four fields (with a one-click "use this device" for the
 * zone), and a surface whose display zone differs from the reader's browser
 * says so on screen — see the header of the schedule page. Nothing REINTERPRETS
 * a stored instant: the value in Firestore is the same instant either way, only
 * the clock it is printed against moves.
 *
 * ── THE BOUNDARY THAT MATTERS ────────────────────────────────────────────────
 * `RegionalSettings.timezone` is a DISPLAY preference and nothing else. It is
 * NOT the timezone the scheduling and accounting math runs in. Modules such as
 * `functions/utils/recurrence.ts`, `functions/appointments/index.ts`
 * (`getDatePartsInTz` / `localTimeToUtc`), `shared/types/finance.ts`
 * (`FINANCE_TIMEZONE`) and `shared/utils/usageWindows.ts` (`USAGE_TIMEZONE`)
 * compute STORED values from a hardcoded Europe/Zurich, and they must keep
 * doing so: making them tenant-configurable retroactively re-buckets finance
 * periods and shifts recurrence anchors for data already written. Wall-clock
 * conventions elsewhere (`Event.program`, `availability.ts`) are likewise
 * deliberate and are not instants to convert. Read this setting for rendering;
 * never feed it into that math.
 */

export type UiLanguage = 'en' | 'de' | 'fr' | 'it'

/** 0 = Sunday, 1 = Monday. Matches date-fns / react-day-picker's `weekStartsOn`. */
export type WeekStart = 0 | 1

/** Order of the NUMERIC date. Name-bearing formats follow the UI language. */
export type DateFormatStyle = 'DMY' | 'MDY' | 'YMD'

export type TimeFormatStyle = '24h' | '12h'

export interface RegionalSettings {
  /** IANA zone, e.g. 'Europe/Zurich'. */
  timezone: string
  weekStartsOn: WeekStart
  dateFormat: DateFormatStyle
  timeFormat: TimeFormatStyle
}

export const DEFAULT_REGIONAL: RegionalSettings = {
  timezone: 'Europe/Zurich',
  weekStartsOn: 1,
  dateFormat: 'DMY',
  timeFormat: '24h',
}

export const DATE_FORMAT_STYLES: readonly DateFormatStyle[] = ['DMY', 'MDY', 'YMD']
export const TIME_FORMAT_STYLES: readonly TimeFormatStyle[] = ['24h', '12h']

/** How each style is written out, for a settings control that has to show it. */
export const DATE_FORMAT_SAMPLE: Record<DateFormatStyle, string> = {
  DMY: 'DD/MM/YYYY',
  MDY: 'MM/DD/YYYY',
  YMD: 'YYYY-MM-DD',
}

/**
 * Base BCP-47 tag per UI language. The regional variants are deliberate: a
 * bare `en` is en-US in most runtimes, which is the exact failure this module
 * exists to remove. Mirrors the map the server has always used in
 * `functions/utils/dateFormatting.ts`, which now delegates here.
 */
const LANGUAGE_LOCALE: Record<UiLanguage, string> = {
  en: 'en-GB',
  de: 'de-CH',
  fr: 'fr-CH',
  it: 'it-IT',
}

function isUiLanguage(v: unknown): v is UiLanguage {
  return v === 'en' || v === 'de' || v === 'fr' || v === 'it'
}

function isSupportedTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Fill an absent or half-written stored value with the defaults. Every read of
 * `Team.regional` goes through here — the stored shape is partial by design
 * (a studio that only ever changed the week start stores only that), and it
 * arrives from Firestore, so a value the enum does not name falls back rather
 * than reaching `Intl` and throwing.
 */
export function resolveRegional(input?: Partial<RegionalSettings> | null): RegionalSettings {
  const weekStartsOn: WeekStart = input?.weekStartsOn === 0 ? 0 : input?.weekStartsOn === 1 ? 1 : DEFAULT_REGIONAL.weekStartsOn
  const dateFormat = DATE_FORMAT_STYLES.includes(input?.dateFormat as DateFormatStyle)
    ? (input!.dateFormat as DateFormatStyle)
    : DEFAULT_REGIONAL.dateFormat
  const timeFormat = TIME_FORMAT_STYLES.includes(input?.timeFormat as TimeFormatStyle)
    ? (input!.timeFormat as TimeFormatStyle)
    : DEFAULT_REGIONAL.timeFormat
  const timezone = isSupportedTimezone(input?.timezone) ? input!.timezone! : DEFAULT_REGIONAL.timezone
  return { timezone, weekStartsOn, dateFormat, timeFormat }
}

/**
 * The BCP-47 tag to hand `Intl`. The language picks the words; `dateFormat`
 * only redirects English, because en-GB and en-US are the one pair in this set
 * that genuinely disagree about order. German, French and Italian write the
 * day before the month in every register, so an MDY preference does not — and
 * must not — reorder their month names; it reorders the NUMERIC date, which
 * `RegionalFormatter.date()` writes from an explicit pattern instead.
 */
export function regionalLocale(
  language?: string | null,
  regional: RegionalSettings = DEFAULT_REGIONAL
): string {
  const lang: UiLanguage = isUiLanguage(language) ? language : 'en'
  if (lang === 'en' && regional.dateFormat === 'MDY') return 'en-US'
  return LANGUAGE_LOCALE[lang]
}

/** Midnight of the week containing `date`, in the RUNTIME's zone. */
export function startOfWeek(date: Date, weekStartsOn: WeekStart): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const shift = (d.getDay() - weekStartsOn + 7) % 7
  d.setDate(d.getDate() - shift)
  return d
}

/** The seven weekday indices (0=Sun … 6=Sat) in the studio's display order. */
export function weekdayOrder(weekStartsOn: WeekStart): number[] {
  return Array.from({ length: 7 }, (_, i) => (i + weekStartsOn) % 7)
}

/** Anything a call site is likely to be holding. Firestore Timestamps included. */
export type DateLike = Date | number | { toDate(): Date } | null | undefined

export function toDateOrNull(value: DateLike): Date | null {
  if (value == null) return null
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }
  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    const d = (value as { toDate(): Date }).toDate()
    return d instanceof Date && !isNaN(d.getTime()) ? d : null
  }
  return null
}

export interface RegionalFormatter {
  /** The tag actually handed to `Intl` — exposed so a third-party widget
   *  (a calendar, a chart axis) can be given the same one. */
  locale: string
  /** The zone every formatter below renders in. */
  timeZone: string
  weekStartsOn: WeekStart
  /** The resolved settings, for a call site that needs to branch on them. */
  regional: RegionalSettings
  /** 24/08/2026 — the numeric order the studio chose, exactly. */
  date(value: DateLike): string
  /** Mon, 24 Aug 2026 */
  dateMedium(value: DateLike): string
  /** Monday, 24 August 2026 */
  dateLong(value: DateLike): string
  /** 24 Aug */
  dayMonth(value: DateLike): string
  /** 24 August — with the year appended when `withYear`. */
  dayMonthLong(value: DateLike, withYear?: boolean): string
  /** August 2026 */
  monthYear(value: DateLike): string
  /** Mon */
  weekdayShort(value: DateLike): string
  /** Monday */
  weekdayLong(value: DateLike): string
  /** 18:30 (or 6:30 PM) */
  time(value: DateLike): string
  /** Mon, 24 Aug 2026 18:30 */
  dateTime(value: DateLike): string
  /** 2026-08-24 in `timeZone` — for date-keyed lookups, never for display. */
  isoDate(value: DateLike): string
  /** Escape hatch: any `Intl` options, with zone and hour cycle already set. */
  custom(value: DateLike, options: Intl.DateTimeFormatOptions): string
}

/**
 * Build the formatter bundle. Pure and framework-free, so the same one serves
 * React (through `useTeamFormat`) and any server-side renderer.
 *
 * `timeZoneOverride` exists for the surfaces that still POSITION things by the
 * device's clock — a hand-rolled week grid lays its blocks out with local
 * `getHours()`, so labeling them in another zone would put a Zurich time on a
 * New York row. Those pass the device zone explicitly and say why; everything
 * that merely LABELS a stored instant takes the studio's zone.
 */
export function createRegionalFormatter(
  language?: string | null,
  regionalInput?: Partial<RegionalSettings> | null,
  timeZoneOverride?: string
): RegionalFormatter {
  const regional = resolveRegional(regionalInput)
  const locale = regionalLocale(language, regional)
  const timeZone = isSupportedTimezone(timeZoneOverride) ? timeZoneOverride! : regional.timezone
  // `hourCycle` rather than `hour12`: with `hour12: false` some runtimes render
  // midnight as 24:00. h23/h12 say the same thing without that corner.
  const hourCycle: Intl.DateTimeFormatOptions['hourCycle'] =
    regional.timeFormat === '12h' ? 'h12' : 'h23'

  const cache = new Map<string, Intl.DateTimeFormat>()
  const fmt = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
    const key = JSON.stringify(options)
    let f = cache.get(key)
    if (!f) {
      f = new Intl.DateTimeFormat(locale, { timeZone, ...options })
      cache.set(key, f)
    }
    return f
  }
  const timeOpts = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions => ({
    ...options,
    hourCycle,
  })

  // The numeric date is assembled from parts rather than left to the locale,
  // because that IS the setting: a studio that asked for MM/DD/YYYY has asked
  // for it in every language it publishes in.
  const numericParts = (d: Date): { day: string; month: string; year: string } => {
    const parts = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
    const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    return { day: pick('day'), month: pick('month'), year: pick('year') }
  }

  const wrap =
    (render: (d: Date) => string) =>
    (value: DateLike): string => {
      const d = toDateOrNull(value)
      return d ? render(d) : ''
    }

  return {
    locale,
    timeZone,
    weekStartsOn: regional.weekStartsOn,
    regional,
    date: wrap((d) => {
      const p = numericParts(d)
      if (regional.dateFormat === 'MDY') return `${p.month}/${p.day}/${p.year}`
      if (regional.dateFormat === 'YMD') return `${p.year}-${p.month}-${p.day}`
      return `${p.day}/${p.month}/${p.year}`
    }),
    dateMedium: wrap((d) =>
      fmt({ weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(d)
    ),
    dateLong: wrap((d) =>
      fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
    ),
    dayMonth: wrap((d) => fmt({ day: 'numeric', month: 'short' }).format(d)),
    dayMonthLong: (value, withYear = false) => {
      const d = toDateOrNull(value)
      if (!d) return ''
      return fmt({
        day: 'numeric',
        month: 'long',
        ...(withYear ? { year: 'numeric' as const } : {}),
      }).format(d)
    },
    monthYear: wrap((d) => fmt({ month: 'long', year: 'numeric' }).format(d)),
    weekdayShort: wrap((d) => fmt({ weekday: 'short' }).format(d)),
    weekdayLong: wrap((d) => fmt({ weekday: 'long' }).format(d)),
    time: wrap((d) => fmt(timeOpts({ hour: '2-digit', minute: '2-digit' })).format(d)),
    dateTime: wrap((d) => {
      const day = fmt({ weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(d)
      const clock = fmt(timeOpts({ hour: '2-digit', minute: '2-digit' })).format(d)
      return `${day} ${clock}`
    }),
    isoDate: wrap((d) => {
      const p = numericParts(d)
      return `${p.year}-${p.month}-${p.day}`
    }),
    custom: (value, options) => {
      const d = toDateOrNull(value)
      return d ? fmt(timeOpts(options)).format(d) : ''
    },
  }
}
