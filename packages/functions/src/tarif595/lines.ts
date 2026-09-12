// Tarif 595 — the line builder. PURE: no I/O, no dates from the clock, no
// Firestore. Given a mapped offering, a period and (for attendance) the dates
// attended, it produces the `service` rows the XML and the PDF print, following
// the insurers' line rules (Qualitop FAQ 3.3–3.7, Helsana Wegleitung §4,
// docs/tarif-595.md → "Line rules"):
//
//   lesson  one line PER ATTENDED DAY, quantity 1, dated that day
//   entry   ONE line, quantity = the pass size (a 10-pass is "10 × Einzeleintritt")
//   month   quantity = calendar months of the period; a period longer than a
//           year is split at each anniversary into one line per year, each
//           dated its own start (the multi-year rule)
//   year    one line per anniversary year, quantity 1
//   flat    one line, quantity 1
//
// Every line's `date_begin` is the START of what it covers — never a from–to
// (Helsana §4.1: "Es ist immer das Abonnement-Start-Datum einzugeben") — and
// the whole period lives in the XML `treatment` element, not on the lines.
//
// A position is looked up BY THE LINE DATE: the list changes every 1 January
// and a position that expired on 31 December cannot be printed for a period
// starting in the new year. The lookup is injected so this module never
// imports the data table.
//
// Money is in minor units (Rappen) throughout; `amount = quantity × unit`
// rounded to the Rappen. Prices are gross (Swiss consumer prices include VAT),
// so the VAT contained is `amount × r / (100 + r)`.

import {
  TARIF595_FREE_TEXT_CODE,
  type Tarif595Lang,
  type Tarif595Line,
  type Tarif595OfferingMapping,
  type Tarif595PreviewIssue,
} from '@linyup/shared'

export interface Tarif595PositionText {
  code: string
  text: { de: string; fr: string; it: string }
}

export interface LineInput {
  mapping: Tarif595OfferingMapping
  /** YYYY-MM-DD, inclusive. */
  period: { from: string; to: string }
  /** YYYY-MM-DD of each attended day (unit `lesson`); duplicates and days
   *  outside the period are dropped. */
  attendanceDates?: readonly string[]
  /** Price per unit (per month, per lesson, per entry…), minor units. */
  unitPriceMinor: number
  /** Percent. */
  vatRate: number
  language: Tarif595Lang
  /** The position valid on `dateIso`, or null. */
  positionOn: (code: string, dateIso: string) => Tarif595PositionText | null
}

export interface LineBuildResult {
  lines: Tarif595Line[]
  totals: { amount_minor: number; vat_minor: number }
  issues: Tarif595PreviewIssue[]
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

/** Parse `YYYY-MM-DD` into a UTC Date at midnight — wall dates, no zones. */
function utc(iso: string): Date {
  if (!ISO_RE.test(iso)) throw new Error(`lines: bad ISO date ${iso}`)
  return new Date(`${iso}T00:00:00Z`)
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addMonthsUtc(d: Date, months: number): Date {
  const out = new Date(d.getTime())
  const day = out.getUTCDate()
  out.setUTCDate(1)
  out.setUTCMonth(out.getUTCMonth() + months)
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate()
  out.setUTCDate(Math.min(day, last))
  return out
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000)
}

/**
 * Whole calendar months in an inclusive span, partial months rounded UP, never
 * below 1. `Jan 15 – Feb 14` is 1, `Jan 1 – Dec 31` is 12, `Jan 15 – Jan 14`
 * (next year) is 12, `Jan 1 – Jan 15` is 1, `Jan 15 – Mar 1` is 2.
 */
export function monthsBetween(fromIso: string, toIso: string): number {
  const from = utc(fromIso)
  const end = addDaysUtc(utc(toIso), 1) // exclusive end
  if (end.getTime() <= from.getTime()) return 0
  let months = (end.getUTCFullYear() - from.getUTCFullYear()) * 12 + (end.getUTCMonth() - from.getUTCMonth())
  if (end.getUTCDate() > from.getUTCDate()) months += 1
  return Math.max(1, months)
}

/**
 * Split an inclusive period at each anniversary of its start: `2027-04-01 –
 * 2029-03-31` → `[2027-04-01 – 2028-03-31, 2028-04-01 – 2029-03-31]`. A period
 * within a year is one segment. The last segment may be shorter than a year.
 */
export function splitByYear(fromIso: string, toIso: string): Array<{ from: string; to: string }> {
  const from = utc(fromIso)
  const to = utc(toIso)
  if (to.getTime() < from.getTime()) return []
  const out: Array<{ from: string; to: string }> = []
  let cursor = from
  let k = 1
  while (cursor.getTime() <= to.getTime()) {
    const nextStart = addMonthsUtc(from, 12 * k)
    const segEnd = addDaysUtc(nextStart, -1)
    out.push({ from: iso(cursor), to: iso(segEnd.getTime() < to.getTime() ? segEnd : to) })
    cursor = nextStart
    k += 1
  }
  return out
}

function vatContained(amountMinor: number, ratePercent: number): number {
  if (ratePercent <= 0) return 0
  return Math.round((amountMinor * ratePercent) / (100 + ratePercent))
}

export function buildTarif595Lines(input: LineInput): LineBuildResult {
  const { mapping, period, language } = input
  const issues: Tarif595PreviewIssue[] = []
  const lines: Tarif595Line[] = []

  if (!ISO_RE.test(period.from) || !ISO_RE.test(period.to) || period.to < period.from) {
    return { lines: [], totals: { amount_minor: 0, vat_minor: 0 }, issues: [{ code: 'period_invalid' }] }
  }

  // Which (date, quantity) pairs the unit produces — resolved BEFORE any
  // position lookup so an expired position is reported per line date.
  const slots: Array<{ date: string; quantity: number }> = []
  switch (mapping.unit) {
    case 'lesson': {
      const days = Array.from(new Set(input.attendanceDates ?? []))
        .filter((d) => ISO_RE.test(d) && d >= period.from && d <= period.to)
        .sort()
      for (const d of days) slots.push({ date: d, quantity: 1 })
      break
    }
    case 'entry': {
      const n = typeof mapping.entries === 'number' && mapping.entries > 0 ? mapping.entries : 0
      if (n > 0) slots.push({ date: period.from, quantity: n })
      break
    }
    case 'month': {
      for (const seg of splitByYear(period.from, period.to)) {
        slots.push({ date: seg.from, quantity: monthsBetween(seg.from, seg.to) })
      }
      break
    }
    case 'year': {
      for (const seg of splitByYear(period.from, period.to)) slots.push({ date: seg.from, quantity: 1 })
      break
    }
    case 'flat':
      slots.push({ date: period.from, quantity: 1 })
      break
  }

  if (slots.length === 0) {
    return { lines: [], totals: { amount_minor: 0, vat_minor: 0 }, issues: [{ code: 'no_lines' }] }
  }

  const unitMinor = Math.max(0, Math.round(input.unitPriceMinor))
  const seenInvalid = new Set<string>()
  let recordId = 0

  const push = (code: string, slot: { date: string; quantity: number }, unit: number): void => {
    const position = input.positionOn(code, slot.date)
    if (!position) {
      const key = `${code}@${slot.date}`
      if (!seenInvalid.has(key)) {
        seenInvalid.add(key)
        issues.push({ code: 'position_invalid_on_date', detail: key })
      }
      return
    }
    const name =
      code === TARIF595_FREE_TEXT_CODE && mapping.customName?.trim() ? mapping.customName.trim() : position.text[language]
    const amount = Math.round(slot.quantity * unit)
    recordId += 1
    lines.push({
      record_id: recordId,
      code,
      name,
      quantity: slot.quantity,
      date_begin: slot.date,
      unit_minor: unit,
      amount_minor: amount,
      vat_rate: input.vatRate,
    })
  }

  for (const slot of slots) {
    push(mapping.position, slot, unitMinor)
    // Personal training: the method's position AND the PT position (Qualitop
    // FAQ 4.6). The price sits on the method line; the companion is the
    // classification, at zero.
    if (mapping.ptPosition) push(mapping.ptPosition, slot, 0)
  }

  const amount_minor = lines.reduce((s, l) => s + l.amount_minor, 0)
  // VAT is rounded ONCE per rate group (on the summed amount), exactly as the
  // XML's `vat_rate` rows and the printed VAT block do — per-line rounding
  // would drift a Rappen from them on three lines of 25.00 at 8.1%.
  const byRate = new Map<number, number>()
  for (const l of lines) byRate.set(l.vat_rate, (byRate.get(l.vat_rate) ?? 0) + l.amount_minor)
  let vat_minor = 0
  for (const [rate, amount] of byRate) vat_minor += vatContained(amount, rate)
  if (lines.length === 0 && issues.length === 0) issues.push({ code: 'no_lines' })
  return { lines, totals: { amount_minor, vat_minor }, issues }
}
