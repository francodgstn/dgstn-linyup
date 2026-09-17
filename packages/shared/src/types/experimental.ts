// ─── Experimental features ───────────────────────────────────────────────────
//
// An opt-in for work that is BUILT AND WORKING but not yet settled — a surface
// whose model is still being tuned, whose shape may change, and which may be
// withdrawn. It is deliberately NOT a plugin: an install spends a slot under
// `pluginInstallLimit`, and charging a Coach their single explore slot to look
// at an experiment is the mistake UX-39 avoided when it demoted ranks rather
// than making them a plugin. It is also not a plan feature — nothing here is
// part of what a tier promises.
//
// THIS FILE IS THE REGISTRY. Adding the next experiment is one entry below plus
// the read at its own surface, in the same change. A registry entry with no
// reader is the `LibraryItem.requires_plan` failure — a field declared for one
// case and then never consulted — so the rule is: never land an entry whose
// `surface` you cannot point at.
//
// STORAGE: `teams/{teamId}.settings.experimentalFeatures` — a map of feature id
// → boolean, absent meaning off. Same home as `settings.bookingCancellationPolicy`
// and `settings.productCollectionNote`, and covered by the same rule: the team
// doc is `allow update: if hasTeamRole(teamId, 'owner') && paymentsUnchanged()`.
// So OWNER-ONLY, no rules change, and nothing here touches `payments`.
//
// …for every entry EXCEPT one. An experiment whose switch was already a stored
// field with its own readers keeps that field — see `ExperimentalFeatureStore`.
// `resolveExperimentalFeatures` below therefore answers for the entries this map
// owns and NOT for the others: ask each of those where it actually lives.
//
// OFF BY DEFAULT, ALWAYS. An experimental feature that arrives switched on is
// just a feature — and one nobody agreed to.

import type { SaasPlan } from './team'

/**
 * Stable machine identifier for one experiment. Kebab-case, matching plugin ids.
 * These are stored in Firestore, so a rename is a migration, not an edit.
 */
export type ExperimentalFeatureId =
  | 'extra-dashboard'
  | 'waitlist'

/**
 * WHERE an experiment's on/off state lives.
 *
 * `team-settings` is the default and the home this module documents above:
 * `teams/{teamId}.settings.experimentalFeatures`, owned by this registry.
 *
 * `booking-settings` is the exception, and it exists because one experiment's
 * switch was ALREADY a stored field with readers: `waitlist` is
 * `bookingSettings.waitlistEnabled` on the team's public profile, read by the
 * activity editor and (with its claim window) by the promoter server-side.
 * Copying that state into this map would have created a second answer to one
 * question — the failure mode this codebase spends most of its comments
 * avoiding — so the settings LIST is unified here while the STORE stays where
 * its readers already look. Nothing else about the entry differs.
 */
export type ExperimentalFeatureStore = 'team-settings' | 'booking-settings'

export interface ExperimentalFeature {
  id: ExperimentalFeatureId
  /**
   * Key in the `SettingsExperimental` i18n namespace holding the feature's
   * name. Keys rather than strings: this module is shared with Cloud Functions
   * and must not import next-intl or hold English copy.
   */
  nameKey: string
  /** Key in `SettingsExperimental` — what it does and what is unsettled about it. */
  descriptionKey: string
  /**
   * Key in `SettingsExperimental` naming WHERE it appears once switched on. A
   * toggle whose effect the reader has to hunt for is a toggle nobody flips.
   */
  surfaceKey: string
  /**
   * The plan the SURFACE this experiment lives on requires, when it lives on a
   * gated one. It does NOT gate the toggle — an experiment is never sold, and
   * refusing the switch would read as an upsell. It only lets the settings list
   * say so, resolved through usePlanName(), so a studio below the tier is not
   * left hunting for something that was never going to appear for them.
   */
  minPlan?: SaasPlan
  /**
   * Which document holds this experiment's flag. Absent ⇒ `team-settings`, the
   * map this module owns. See `ExperimentalFeatureStore` for the one exception
   * and why it is one.
   */
  store?: ExperimentalFeatureStore
}

/**
 * Every experiment a studio may opt into. Order here is the order of the
 * settings list.
 */
export const EXPERIMENTAL_FEATURES: readonly ExperimentalFeature[] = [
  {
    // Reader: apps/web/src/components/dashboard-preview/ExtraSection.tsx,
    // mounted at the foot of the dashboard. Visibility only — every card inside
    // is untouched working code, which is the point: this is the shelf for work
    // that is BUILT and deliberately not shown.
    //
    // It replaced the narrower `engagement-matrix` id when the two dashboards
    // were consolidated. The matrix now lives INSIDE this section, so a second
    // per-card flag would have been two switches for one card. Studios that had
    // the old id switched on read as off — `resolveExperimentalFeatures` drops
    // ids it does not recognise, which is the safe direction for an opt-in.
    id: 'extra-dashboard',
    nameKey: 'extraDashboardName',
    descriptionKey: 'extraDashboardDescription',
    surfaceKey: 'extraDashboardSurface',
    // A NOTE, not a gate: the cards inside read the trends dataset and the
    // finance plugin, both Studio+ surfaces. The switch itself stays live below
    // the tier — refusing it would read as an upsell for something never sold.
    minPlan: 'studio',
  },
  {
    // Reader: the per-activity waitlist toggle in
    // apps/web/src/app/[locale]/(auth)/offer/activities/page.tsx, which shows
    // the control only while this is on — plus the claim-window control that
    // renders beside this switch.
    //
    // It moved here from Settings → Booking, where it wore a "Beta" chip
    // (2026-08-31). A maturity chip on one row of a settings panel says the
    // same thing this page says, in a place nobody can switch it off from, and
    // it left the reader to work out that "may change" meant "opt-in". A queue
    // is also not a booking-page SETTING in the way the window and the cutoff
    // are: those configure a flow every studio has, this decides whether a
    // whole feature exists for them.
    //
    // STORE: `booking-settings` — see ExperimentalFeatureStore. The flag keeps
    // its home on the public profile because the activity editor and the
    // promoter already read it there.
    id: 'waitlist',
    nameKey: 'waitlistName',
    descriptionKey: 'waitlistDescription',
    surfaceKey: 'waitlistSurface',
    store: 'booking-settings',
  },
  // `offer-drafting` lived here until 2026-09-17 and GRADUATED the same way as
  // `contact-summary` below: it is the `ai-offer-drafting` module of the AI insights
  // plugin container (types/aiInsights.ts), so every AI feature a studio
  // switches on sits in one card (Franco, 2026-09-17). Its owner-only pairing
  // survived the move — the install document is owner-written too.
  //
  // `contact-summary` lived here from 2026-09-11 to 2026-09-16. It GRADUATED
  // into the `ai-contact-summary` module of the AI insights plugin container
  // (types/aiInsights.ts) once a coach briefing, a member recap and a team
  // reading were three things a studio chooses between. A team that had it
  // switched on reads as off — `resolveExperimentalFeatures` drops ids it does
  // not recognise, the safe direction for an opt-in — and installs the plugin.
]

/** The shape stored at `teams/{teamId}.settings.experimentalFeatures`. */
export type ExperimentalFeatureSettings = Partial<Record<ExperimentalFeatureId, boolean>>

/** The settings-bag slice this feature owns. Cast at the read site, as the
 *  `Team.settings` comment prescribes. */
interface TeamWithExperimental {
  settings?: { experimentalFeatures?: unknown } | Record<string, unknown> | null
}

/**
 * Read the stored map off a team doc. Unknown ids are dropped and non-boolean
 * values ignored, so a hand-edited doc cannot switch anything on by accident.
 *
 * It answers only for entries stored in THIS map. An entry with another `store`
 * is absent from the result rather than reported as off, because "off" would be
 * a claim about a document this function never read — and a team with the
 * waitlist switched on would read as having it off, confidently and wrongly.
 */
export function resolveExperimentalFeatures(
  team: TeamWithExperimental | null | undefined
): ExperimentalFeatureSettings {
  const raw = (team?.settings as { experimentalFeatures?: unknown } | undefined)
    ?.experimentalFeatures
  if (!raw || typeof raw !== 'object') return {}
  const stored = raw as Record<string, unknown>
  const out: ExperimentalFeatureSettings = {}
  for (const feature of EXPERIMENTAL_FEATURES) {
    if (featureStore(feature) !== 'team-settings') continue
    // Strictly `=== true`: absent, null, 0 and "false" all mean off.
    if (stored[feature.id] === true) out[feature.id] = true
  }
  return out
}

/** Where one entry's flag lives. Absent ⇒ the map this module owns. */
export function featureStore(feature: ExperimentalFeature): ExperimentalFeatureStore {
  return feature.store ?? 'team-settings'
}

/**
 * Is `id` switched on for this team? Off unless explicitly stored as `true`.
 *
 * Only for entries stored in `settings.experimentalFeatures`; it cannot answer
 * for an entry with another `store` and would say "off" for one that is on, so
 * asking it for `waitlist` is a bug. That one is
 * `bookingSettings.waitlistEnabled` on the team's public profile.
 */
export function isExperimentalFeatureEnabled(
  team: TeamWithExperimental | null | undefined,
  id: ExperimentalFeatureId
): boolean {
  return resolveExperimentalFeatures(team)[id] === true
}
