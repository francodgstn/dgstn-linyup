// WHEN AN AFFILIATION RUNS OUT — the one answer, for the server and the client.
//
// `renewAffiliation` computed it in `packages/functions`, `previewRenewedUntil`
// computed it again in `apps/web` for the preview, and the two agreed only
// because both were three lines of `addMonths`. The moment a second mode
// existed they would have stopped agreeing, and the failure would be a preview
// that says one date and a saved record that says another.
//
// So: one resolver, pure, no Firestore, no Timestamp — callers convert.

/** How a type decides when membership lapses. */
export type AffiliationValidityMode = 'months' | 'fixed_date'

export interface AffiliationValidityConfig {
  /** Absent ⇒ 'months', which is what every existing type is. */
  validity_mode?: AffiliationValidityMode
  /** `months` mode: how long a term lasts. Absent ⇒ 12. */
  default_validity_months?: number
  /**
   * `fixed_date` mode: the day the whole federation resets, as `MM-DD`.
   *
   * A STRING, not two numbers, because it is written and read as a date and
   * '09-01' sorts and compares the way a reader expects. Absent in fixed_date
   * mode ⇒ treated as `months`, because a reset date nobody set is not a reset
   * date, and silently picking January would expire everyone at once.
   */
  reset_month_day?: string
}

/** `MM-DD` → [month, day], or null when it is not a date. */
function parseResetDay(value: string | undefined): [number, number] | null {
  if (!value) return null
  const m = /^(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const month = Number(m[1])
  const day = Number(m[2])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return [month, day]
}

/**
 * The first reset date STRICTLY AFTER `from`.
 *
 * Strictly after matters at both ends. Somebody joining ON the reset day gets a
 * full year rather than an affiliation that expires the same afternoon; and a
 * renewal of a membership that runs to this year's reset lands on next year's,
 * instead of returning the date it already had.
 */
function nextResetAfter(from: Date, month: number, day: number): Date {
  // Local midnight, matching how the rest of the product reads a calendar day.
  let candidate = new Date(from.getFullYear(), month - 1, day, 0, 0, 0, 0)
  if (candidate.getTime() <= from.getTime()) {
    candidate = new Date(from.getFullYear() + 1, month - 1, day, 0, 0, 0, 0)
  }
  // 02-30 and friends roll forward in the Date constructor; that is a
  // configuration error rather than a date, and rolling is the harmless reading.
  return candidate
}

/** Calendar-month arithmetic that clamps rather than rolling into the next month. */
function addMonths(base: Date, months: number): Date {
  const d = new Date(base)
  const targetMonth = d.getMonth() + months
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(targetMonth)
  // 31 Jan + 1 month is 28/29 Feb, not 3 March.
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()))
  return d
}

/**
 * When an affiliation of this type, renewed or issued now, runs out.
 *
 * `currentValidUntil` extends from the later of now and the existing expiry, so
 * renewing early never costs the member the time they had left. That rule is
 * the same in both modes — it is only what "one term" MEANS that differs.
 *
 * `monthsOverride` is an explicit caller-supplied term (the renew dialog lets a
 * manager type one). It is honored in `months` mode only: in `fixed_date` mode
 * the whole point is that nobody has their own clock.
 */
export function resolveAffiliationValidUntil(opts: {
  type: AffiliationValidityConfig | null | undefined
  currentValidUntil?: Date | null
  now?: Date
  monthsOverride?: number | null
}): Date {
  const now = opts.now ?? new Date()
  const current = opts.currentValidUntil
  const base = current && current.getTime() > now.getTime() ? current : now

  const reset = parseResetDay(opts.type?.reset_month_day)
  if (opts.type?.validity_mode === 'fixed_date' && reset) {
    return nextResetAfter(base, reset[0], reset[1])
  }

  const months =
    typeof opts.monthsOverride === 'number' && opts.monthsOverride > 0
      ? Math.floor(opts.monthsOverride)
      : opts.type?.default_validity_months && opts.type.default_validity_months > 0
        ? opts.type.default_validity_months
        : 12
  return addMonths(base, months)
}
