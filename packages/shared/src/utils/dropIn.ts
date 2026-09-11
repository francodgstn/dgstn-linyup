// THE ONE READER of a class's drop-in price.
//
// A drop-in used to be answered by each class alone (`Activity.dropIn`), so a
// studio whose classes all cost the same at the door typed that number once
// per class and kept the copies in step by hand (Franco, 2026-09-11). It is now
// answered in one of three ways, and every surface that needs the answer —
// the booking callables, the public mirror, the catalogue chips, the pricing
// page, the activity form — asks HERE, with the studio's default in hand:
//
//   'studio'  follow `BookingSettings.dropIn`, the studio-wide default
//   'custom'  this class names its own price
//   'off'     no drop-in on this class, even when the studio has a default
//
// The default lives on the team's public profile beside the other booking
// settings (`teams/{id}/public_profile/{id}.bookingSettings.dropIn`) because
// that is the one document the callables, the public pages and the mobile app
// already read. The activity mirror carries the RESOLVED price, so nothing
// public ever has to know a default exists; `syncStudioDropIn` rewrites the
// mirrors of every class that follows the studio when the default changes.
//
// Never read `activity.dropIn.enabled` / `.priceAmount` directly on a path
// that decides anything — a class that follows the studio stores no price of
// its own, and reading the field finds nothing where the studio put CHF 25.

import { resolveActivityAccessRule, type Activity, type ActivityDropIn, type DropInMode } from '../types/activity'
import { classIsFreeForEveryone } from './paymentOptions'

/** A drop-in price as every consumer sees it — the same shape the activity
 *  mirror carries and `hasPaidDoor` reads. */
export interface DropInPrice {
  enabled: boolean
  /** Major units, the team's currency. Present iff `enabled`. */
  priceAmount?: number
}

export interface ResolvedDropIn extends DropInPrice {
  /** Which of the three answers produced this — for the form and the chips,
   *  never for a decision (a decision reads `enabled` / `priceAmount`). */
  source: DropInMode
}

/**
 * How a class answers the drop-in question. ABSENT `mode` is the pre-2026-09-11
 * document: a class that named a price (`enabled` + `priceAmount`) is
 * 'custom', and anything else — `{ enabled: false }`, or no field at all — is
 * 'studio'. That is what makes the default worth having: a class that never
 * named a price follows the studio on the day the studio sets one, with no
 * click per class. A class that must NOT is said so out loud with 'off'.
 */
export function dropInModeOf(dropIn: ActivityDropIn | null | undefined): DropInMode {
  if (dropIn?.mode) return dropIn.mode
  return dropIn?.enabled === true && typeof dropIn.priceAmount === 'number' ? 'custom' : 'studio'
}

/**
 * The drop-in price of a class, given the studio's default.
 *
 * Appointments have no drop-in — the price is attached to the length — so
 * they resolve to none whatever the fields say. So does a class on the LEGACY
 * `open` tier: `resolveClassCoverage` covers everyone on it before it ever
 * looks at a price (the pre-2026-09 reading, kept on purpose so a deploy
 * changes nothing for a studio that touched nothing), which makes a door
 * there one that opens onto a free room — the mirror must not advertise it
 * and the catalogue must not price it. A class asked the two questions and
 * open to anyone is NOT this case: there, the price is exactly what a
 * visitor pays. A 'custom' class without a price and a 'studio' class under a
 * studio with no default both resolve to none: `enabled` is derived from
 * whether there is a price to charge, never copied from a stored flag.
 */
export function resolveActivityDropIn(
  activity: Pick<Activity, 'type' | 'accessRule' | 'isFreeTrial'> & {
    dropIn?: ActivityDropIn | null
  },
  studio: DropInPrice | null | undefined
): ResolvedDropIn {
  if (activity.type === 'appointment') return { enabled: false, source: 'off' }
  if (classIsFreeForEveryone(resolveActivityAccessRule(activity))) {
    return { enabled: false, source: 'off' }
  }
  const mode = dropInModeOf(activity.dropIn)
  if (mode === 'off') return { enabled: false, source: 'off' }
  if (mode === 'custom') {
    const price = activity.dropIn?.priceAmount
    return typeof price === 'number'
      ? { enabled: true, priceAmount: price, source: 'custom' }
      : { enabled: false, source: 'custom' }
  }
  const price = studio?.enabled === true ? studio.priceAmount : undefined
  return typeof price === 'number'
    ? { enabled: true, priceAmount: price, source: 'studio' }
    : { enabled: false, source: 'studio' }
}

/** The studio default as stored, narrowed to a price or nothing — what the
 *  fan-out compares before and after a settings write. */
export function studioDropInOf(
  settings: { dropIn?: DropInPrice | null } | null | undefined
): DropInPrice | null {
  const d = settings?.dropIn
  return d?.enabled === true && typeof d.priceAmount === 'number'
    ? { enabled: true, priceAmount: d.priceAmount }
    : null
}

export function sameDropInPrice(a: DropInPrice | null, b: DropInPrice | null): boolean {
  if (a === null || b === null) return a === b
  return a.enabled === b.enabled && (a.priceAmount ?? null) === (b.priceAmount ?? null)
}
