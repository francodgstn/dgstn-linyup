// Shared catalogue of "settings" destinations. Consumed by the sidebar (which shows
// the subset the user always shows, under Favourites) and by the settings rail
// (/settings/* — which lists them all, grouped, with an "always show" toggle on
// each). Keeping it in one place means the sidebar and rail never drift.
// Vocabulary: see THE NAV-MEMORY CENSUS in contexts/NavPinsContext.tsx.
import {
  Award,
  Bell,
  CalendarCheck,
  CalendarRange,
  CreditCard,
  FileText,
  FlaskConical,
  KeyRound,
  LayoutTemplate,
  ListChecks,
  ListTodo,
  Mail,
  Puzzle,
  Settings,
  ShieldCheck,
  Target,
  UserCog,
  Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type SettingsGroupKey =
  | 'account'
  | 'studio'
  | 'scheduling'
  | 'communication'

// Runtime visibility gate for items that only apply on certain plans/plugins/roles.
// The rail resolves these (plugin via useInstalledPlugins, role via
// useCapabilities) and hides items whose gate fails.
//
// `ownerOnly` — the destination is entirely read-only below the owner role:
// firestore.rules makes the team doc, alert_presets, integrations and billing
// owner-write (integrations owner-READ as well), so a manager who follows one of
// these rows arrives at a screen with nothing she can do. A rail item you can
// only look at is not worth a row. The controls behind them are still disabled +
// annotated for an owner-less arrival by deep link — hiding the row is
// navigation, never enforcement.
export type SettingsGate = 'ownerOnly' | 'customFields'

export interface SettingsNavItem {
  id: string // stable id used in the pin set + as React key
  href: string
  labelKey: string // key in the `Nav` i18n namespace
  icon: LucideIcon
  group: SettingsGroupKey
  exact?: boolean // active only on exact path match (hub routes like /public-page)
  gate?: SettingsGate // hidden unless the runtime condition holds
  /** Pin to the head of its group, ahead of the alphabetical run. Read
   *  `lib/navSort.ts` before adding one. */
  lead?: boolean
}

// ORDER WITHIN A GROUP IS ALPHABETICAL BY TRANSLATED LABEL, except for rows
// marked `lead` — the rule lives in `lib/navSort.ts` and the rail applies it.
// DECLARATION ORDER BELOW MEANS NOTHING: it groups related rows together for
// whoever is reading this file, and nothing else. Put a new row wherever it
// reads best here.
//
// (The PINNED sidebar list is a different thing and is not sorted: those are in
// the order the studio itself dragged them into — census item 3 in
// contexts/NavPinsContext.tsx.)
//
// Activities + Subscriptions live in the main nav's "Offer" section now. Most items
// render under a shared /settings/* layout (the master-detail rail + detail pane);
// legacy paths (/team/settings, /billing, …) resolve via redirect stubs.
export const SETTINGS_ITEMS: SettingsNavItem[] = [
  // ── Account — workspace admin: who is here, what we pay, what we opted into.
  { id: 'managers', href: '/settings/members', labelKey: 'managers', icon: UserCog, group: 'account' },
  { id: 'roles', href: '/settings/roles', labelKey: 'roles', icon: ShieldCheck, group: 'account' },
  { id: 'billing', href: '/settings/billing', labelKey: 'billing', icon: CreditCard, group: 'account', gate: 'ownerOnly' },
  // Experimental features — the studio's opt-in for surfaces that are built and
  // working but not yet settled. Account, not Studio: it is a workspace-wide
  // "what have we turned on". Owner-only because the switch is a team-doc write
  // (firestore.rules), so a manager who reached it could only look at it. NOT a
  // plugin, deliberately — see the registry header in
  // packages/shared/src/types/experimental.ts.
  { id: 'experimental', href: '/settings/experimental', labelKey: 'experimentalFeatures', icon: FlaskConical, group: 'account', gate: 'ownerOnly' },

  // ── Studio — the studio's own configuration: who it is, how it takes money,
  // how it ranks and describes people, what it has installed. Each team
  // sub-section is its own rail item (selected by ?tab= on /settings/team).
  //
  // It used to hold the email and public-surface rows too, which made it long
  // enough that a reader arrived here by elimination. Those became their own
  // groups — see the note on SETTINGS_GROUPS below.
  // LEAD of Studio: it is the studio's identity — name, logo, branding — and the
  // most-opened settings page there is. Alphabetically "General" would land
  // mid-group in English and elsewhere again in German ("Allgemein" first,
  // "Générale" mid-list in French), so the one page a studio comes here for
  // would move depending on the language it reads in.
  { id: 'teamGeneral', href: '/settings/team', labelKey: 'teamGeneral', icon: Settings, group: 'studio', exact: true, lead: true },
  { id: 'teamPayments', href: '/settings/team?tab=payments', labelKey: 'teamPayments', icon: Wallet, group: 'studio', gate: 'ownerOnly' },
  { id: 'teamRanking', href: '/settings/team?tab=ranking', labelKey: 'teamRanking', icon: Award, group: 'studio', gate: 'ownerOnly' },
  // Affiliations moved to the main nav's "Offer" section (/offer/affiliations).
  { id: 'teamCustomFields', href: '/settings/team?tab=custom-fields', labelKey: 'teamCustomFields', icon: ListChecks, group: 'studio', gate: 'customFields' },
  { id: 'teamCoaching', href: '/settings/coaching', labelKey: 'teamCoaching', icon: Target, group: 'studio' },
  // THE PLUGINS ROW LANDS INSIDE SETTINGS (2026-09-25). The marketplace is a
  // full page at /plugins, where its per-plugin editors live (/plugins/website,
  // /plugins/finance, …) — but this row no longer jumps there. It opens
  // /settings/plugins, a one-button stop in the shell, because a rail row that
  // leaves the shell throws the reader out of settings with no warning (the
  // Places note further down makes the same point). The extra click is the
  // studio choosing to leave.
  //
  // The row stays because this is a destination a studio looks for under
  // Settings, and because it is what puts "plugins / extensions / add-ons /
  // marketplace" in the global search index (the sidebar's own Explore-plugins
  // button is NOT indexed — see the searchEntries note in (auth)/layout.tsx).
  { id: 'plugins', href: '/settings/plugins', labelKey: 'plugins', icon: Puzzle, group: 'studio', exact: true },
  // API keys for the public API and MCP server (docs/public-api.md). Owner-only:
  // the key records are owner-READ in firestore.rules, so anyone else would
  // arrive at a page that can only explain why it is empty. Shown whether or not
  // the api-connectors plugin is installed — the page itself is the way in.
  { id: 'apiKeys', href: '/settings/api-keys', labelKey: 'apiKeys', icon: KeyRound, group: 'studio', gate: 'ownerOnly' },
  // The public-surface overview hub — the map of everything the world can see
  // (public URL, default landing, per-surface live status). Individual surfaces
  // are reachable from their own sections (Space → Grow); this ties them
  // together.
  //
  // The route stays at /public-page — it is bookmarked, and its sibling
  // /public-page/space is linked from the main nav — but it RENDERS inside the
  // settings shell (rail + detail pane) via a route-group layout at
  // (auth)/public-page/layout.tsx, so it reads like every other settings section
  // instead of dumping the reader onto a bare full page (UX-61). That shell also
  // covers /public-page/space. It is ALSO listed in the main nav's Grow section
  // under the same id, so the map is reachable from where public surfaces are
  // worked on (UX-28) — one destination, one shortcut star, listed twice.
  //
  // IN STUDIO, AND NOT A GROUP OF ITS OWN (2026-09-01). It used to lead a
  // "Public pages" group whose only other row was the Shop settings page; when
  // that page was deleted the group was a header with nothing to head — the
  // exact failure the Scheduling note below warns about. It carries no `lead`
  // either: it led that group only because Shop was a part of its whole.
  { id: 'publicPages', href: '/public-page', labelKey: 'publicPage', icon: LayoutTemplate, group: 'studio', exact: true },

  // ── Scheduling — how sessions and bookings work.
  //
  // IT STAYS ITS OWN GROUP even when short (UX-67 follow-up). The label is the
  // word a studio arrives with — someone looking for the booking window looks
  // for "Scheduling", not for "Studio" — so the group is doing search work, not
  // just visual grouping. Revisit only if it drops to one row: a group of one is
  // a header with nothing to head.
  { id: 'eventTypes', href: '/settings/event-types', labelKey: 'eventTypes', icon: CalendarRange, group: 'scheduling' },
  // Reusable event programs. Renders inside the /settings shell, so it stays a
  // rail row (unlike Places, below).
  { id: 'programTemplates', href: '/settings/program-templates', labelKey: 'programTemplates', icon: ListTodo, group: 'scheduling' },
  // Places is NOT here any more: it moved to /schedule/places, beside the calendar
  // that reads it, and is listed in the main nav's Run section (UX-67). It is not
  // kept as a rail row pointing there, deliberately — a rail row whose page lives
  // outside the /settings shell throws the reader out of settings mid-task, which
  // is exactly what UX-61 objected to. `publicPages` below reaches the shell via
  // a route group rather than a /settings/* path; `plugins` above is the one row
  // that leaves it on purpose, and says there why the rule does not bite.
  { id: 'bookingPage', href: '/settings/booking', labelKey: 'bookingPage', icon: CalendarCheck, group: 'scheduling' },

  // ── Communication — what the studio sends, and how it reads.
  //
  // Outreach folded into Emails (2026-08-25): sender identity, placeholders,
  // templates and the system toggles are one subject, and were already sharing
  // the `EmailSettings` i18n namespace. `?tab=outreach` redirects to /settings/emails,
  // so a pinned `teamOutreach` id resolves to nothing and simply drops out of the
  // pin list (the catalogue is a Map lookup) rather than breaking it.
  { id: 'teamEmails', href: '/settings/emails', labelKey: 'teamEmails', icon: Mail, group: 'communication' },
  // Split out of teamEmails (2026-08-27): the templates list + placeholder
  // reference is AUTHORING copy, while teamEmails above is CONFIGURATION
  // (sender identity, system-email toggles, booking instructions, SMS). The
  // templates list was pushing the config cards below the fold, so it earned
  // its own row rather than a tab or a disclosure on the same page.
  { id: 'teamEmailTemplates', href: '/settings/email-templates', labelKey: 'teamEmailTemplates', icon: FileText, group: 'communication' },
  // Alerts are the OTHER outbound channel — what the studio sends ITSELF (and
  // its coaches) when something happens. Same subject as the two above: a
  // message goes out and somebody reads it.
  { id: 'teamAlerts', href: '/settings/team?tab=alerts', labelKey: 'teamAlerts', icon: Bell, group: 'communication', gate: 'ownerOnly' },

]

/**
 * Group order + their `Nav` namespace label keys (rendered in the rail). Account
 * on top per product direction.
 *
 * ── WHY FOUR GROUPS (2026-08-31, revised 2026-09-01) ────────────────────────
 * "Studio" had eleven rows and every other group had two or three, which made
 * it the place a reader ended up by elimination rather than by expectation —
 * and eleven rows is past the point where a group heading helps you skip past
 * what you do not want. One coherent subject came out of it:
 *
 *  • COMMUNICATION — Emails, Email templates, Alerts. One subject already: two
 *    of them share the `EmailSettings` i18n namespace, and all three answer
 *    "what do we send, and how does it read". Somebody hunting for a reminder's
 *    wording looks for that word, not for "Studio".
 *
 * A PUBLIC PAGES group briefly held the public-surface hub and the Shop settings
 * page. Shop was deleted on 2026-09-01 — it wrote nothing, and every destination
 * on it was already reachable from /offer/* and the payment settings — which
 * left a group of one, a header with nothing to head. The hub moved back into
 * Studio (see its row above).
 *
 * What is in Studio is what is genuinely the studio's own configuration:
 * identity, how it takes money, ranks, custom fields, coaching axes, plugins,
 * and the map of what the world sees.
 *
 * GROUP ORDER is by how often a settings visit lands there: Account, then Studio
 * — General is the single most-opened settings page — then the two topic
 * groups. That is a ranking of FOUR things that changes once a year, which is
 * exactly the case where a considered order is worth keeping; the rows INSIDE
 * each group are the case where it is not, and they sort alphabetically
 * (`lib/navSort.ts`).
 */
export const SETTINGS_GROUPS: { key: SettingsGroupKey; labelKey: string }[] = [
  { key: 'account', labelKey: 'groupAccount' },
  { key: 'studio', labelKey: 'groupStudio' },
  { key: 'scheduling', labelKey: 'groupScheduling' },
  { key: 'communication', labelKey: 'groupCommunication' },
]

/**
 * The always-shown shortcuts a browser starts with. Users add/remove them from
 * the rail; the choice is per-browser. (The STORED name of this list stays
 * `defaultNavPins` — see the census in contexts/NavPinsContext.tsx for why.)
 *
 * EMPTY, DELIBERATELY. It used to seed `['publicPages','bookingPage','plugins']`
 * — a guess at what a new studio needs, arriving pre-pinned without being asked
 * for. An empty group with a visible hint ("Pages you open show up here") says
 * more than three rows nobody chose, and the recents half fills it within a
 * session of ordinary use anyway.
 */
export const DEFAULT_SHORTCUT_IDS: string[] = []

/**
 * The head tiles beside Dashboard before the studio picks its own.
 *
 * Schedule, and ONLY Schedule: it is the surface a studio opens every session,
 * and the tiles exist to put exactly that one click from anywhere. The grid
 * holds more now (census item 5, HEAD_TILES_MAX) but a default is a guess at
 * what somebody needs, and one guess is the most a new studio should have to
 * undo — the same reasoning that left DEFAULT_SHORTCUT_IDS empty above.
 *
 * Census item 5 in contexts/NavPinsContext.tsx owns the storage and the
 * absent-vs-cleared rule; this constant is only the fallback for "never
 * chosen".
 */
export const DEFAULT_HEAD_TILE_IDS: string[] = ['calendar']
