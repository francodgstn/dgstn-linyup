/**
 * THE DASHBOARD'S QUICK ACTIONS — what a studio can START from the top of the
 * page, chosen by the studio rather than by us.
 *
 * ── AN ACTION, NOT A DESTINATION ─────────────────────────────────────────────
 *
 * The bar used to hold two hard-coded pills that were plain links to
 * `/schedule` and `/contacts`. That is NAVIGATION, and navigation already has a
 * home: the sidebar, with its pins, its head tile and its recents. Repeating it
 * here spent the most valuable strip on the page saying something the nav
 * already said (Franco, 2026-08-21).
 *
 * So every entry here has to DO something. It may still change page on the way
 * — `/contacts?new=1` lands on the contacts page with the create dialog already
 * open, which is an action even though a route changed. What is banned is the
 * bare link that drops you on a page and leaves you to find the button.
 *
 * That is the whole test for adding one: **after the click, is a form open or a
 * thing done?** If the honest answer is "you are now on the page where you
 * could do it", it belongs in the nav.
 *
 * ── HOW THE `?new=1` ENTRIES WORK ────────────────────────────────────────────
 *
 * One convention, four pages: the target page reads the param ONCE, in a lazy
 * `useState` initializer, and opens its own existing create dialog. Nothing is
 * lifted or duplicated — the dialog stays where it lives, owned by the page
 * that owns the data. `quickActionOpensDialog` names the param so the pages and
 * this catalog cannot drift on the spelling.
 */

import type React from 'react'
import {
  Banknote,
  CalendarPlus,
  Dumbbell,
  QrCode,
  UserPlus,
  Zap,
} from 'lucide-react'

/** The most that may sit in the bar at once. Five pills is already the width of
 *  the greeting beside them; past that the bar wraps and stops being a strip. */
export const QUICK_ACTION_MAX = 5

/** The query param every "open the create dialog" action uses. Read by the
 *  target pages; never spelled inline. */
export const QUICK_ACTION_PARAM = 'new'

/** Prefix for the per-rule automation entries, which are DATA (one per active
 *  rule) rather than members of the static catalog below. */
export const QUICK_ACTION_AUTOMATION_PREFIX = 'automation:'

export interface QuickActionDef {
  id: string
  /** Key in the `QuickActions` message namespace. Absent for automations,
   *  which carry the studio's own rule name instead. */
  labelKey?: string
  /** Resolved label for a data-driven entry (an automation's name). */
  label?: string
  icon: React.ElementType
  /**
   * Where the click goes. `null` means the action happens in place on the
   * dashboard (the QR dialog is the only one so far).
   */
  href: string | null
}

/**
 * The fixed catalog. Order here is the order in the picker — roughly how
 * often a studio reaches for each, not alphabetical, for the same reason
 * NAV_SECTIONS is not sorted.
 */
export const QUICK_ACTION_CATALOGUE: QuickActionDef[] = [
  {
    id: 'new-session',
    labelKey: 'newSession',
    icon: CalendarPlus,
    href: `/schedule?${QUICK_ACTION_PARAM}=1`,
  },
  {
    id: 'new-contact',
    labelKey: 'newContact',
    icon: UserPlus,
    href: `/contacts?${QUICK_ACTION_PARAM}=1`,
  },
  {
    id: 'record-payment',
    labelKey: 'recordPayment',
    icon: Banknote,
    href: `/payments?${QUICK_ACTION_PARAM}=1`,
  },
  {
    id: 'new-activity',
    labelKey: 'newActivity',
    icon: Dumbbell,
    href: `/offer/activities?${QUICK_ACTION_PARAM}=1`,
  },
  // The one that does NOT navigate: the QR is a dialog with nothing behind it,
  // so sending someone to a page to see it would be the bare-link failure this
  // catalog exists to avoid.
  { id: 'studio-qr', labelKey: 'studioQr', icon: QrCode, href: null },
]

/**
 * What a new studio gets. Two, not five: the bar is meant to be curated, and
 * handing somebody five pills they did not choose teaches them it is decoration.
 */
export const DEFAULT_QUICK_ACTION_IDS = ['new-session', 'new-contact']

/** The automation entry for a rule id, and the reverse. One spelling, so the
 *  picker and the bar cannot disagree about what an id means. */
export function quickActionForAutomation(ruleId: string, name: string): QuickActionDef {
  return {
    id: `${QUICK_ACTION_AUTOMATION_PREFIX}${ruleId}`,
    label: name,
    icon: Zap,
    // Lands on the automations page with THIS rule's run confirmation open —
    // never a blind fire. The dialog previews who it would reach before the
    // studio commits, which is the whole reason running one is not a one-click
    // action in the first place.
    href: `/automations?run=${encodeURIComponent(ruleId)}`,
  }
}

/** The rule id behind an automation entry, or null for a catalog action. */
export function quickActionAutomationRuleId(id: string): string | null {
  return id.startsWith(QUICK_ACTION_AUTOMATION_PREFIX)
    ? id.slice(QUICK_ACTION_AUTOMATION_PREFIX.length) || null
    : null
}
