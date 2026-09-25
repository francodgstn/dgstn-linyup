import type { TeamRole } from './team'
import type { Timestamp } from './common'

// ─────────────────────────────────────────────────────────────────────────────
// Team capability model — the single source of truth for what each role can do.
//
// Pure data + pure functions (no I/O), mirroring plan.ts. The web hook
// (useCapabilities), the Cloud Function guard (requireCapability) and the
// Firestore rules all derive from THESE definitions so there is one place to
// reason about permissions.
//
// A team member's access has two axes:
//   1. CAPABILITIES — which actions the member may perform (a set of Capability).
//   2. DATA SCOPE   — whether the (scoped) capabilities apply to ALL team records
//      or only to the member's OWN records (assigned/created). `own` is what makes
//      a Coach a coach: contacts.manage with scope 'own' = "manage MY contacts".
//
// System roles (owner/manager/viewer) have FIXED capability sets defined here and
// are always `all`-scoped. The Coach role has a customizable set (defaulting to
// COACH_DEFAULT_CAPABILITIES, overridable per team at teams/{id}/role_config/coach)
// and is `own`-scoped. Custom roles are a later phase; this model already fits them.
// ─────────────────────────────────────────────────────────────────────────────

export type DataScope = 'all' | 'own'

// Capability ids are `domain.action`. `*.view.all` variants let an otherwise
// own-scoped member read a whole domain (a coach may read the full studio calendar
// to avoid clashes, while still only editing their own sessions).
export type Capability =
  // Contacts (scoped)
  | 'contacts.view'
  | 'contacts.manage'
  | 'contacts.delete'
  | 'contacts.view.all'
  // Schedule = sessions / bookings / check-in (scoped)
  | 'schedule.view'
  | 'schedule.manage'
  | 'schedule.view.all'
  // Activities catalog (unscoped)
  | 'activities.manage'
  // Events (unscoped)
  | 'events.manage'
  // Offerings = subscription types, products, courses, coach availability,
  // affiliation types (unscoped; manager+ today)
  | 'offerings.manage'
  // Outreach templates + automation flows (unscoped; manager+ today)
  | 'outreach.manage'
  // Advanced reports + activity log (unscoped; manager+ today)
  | 'reports.view'
  // Manage coaches — invite/remove the team's coaches (unscoped; owner+manager by
  // default, assignable to the coach role but OFF by default)
  | 'coaches.manage'
  // Owner-only surfaces (unscoped)
  | 'members.manage'
  | 'team.settings'
  | 'billing.manage'
  | 'integrations.manage'
  | 'plugins.manage'

export type CapabilityDomain =
  | 'contacts'
  | 'schedule'
  | 'activities'
  | 'events'
  | 'offerings'
  | 'outreach'
  | 'reports'
  | 'coaches'
  | 'members'
  | 'team'
  | 'billing'
  | 'integrations'
  | 'plugins'

export interface CapabilityMeta {
  id: Capability
  domain: CapabilityDomain
  // Whether the capability respects DATA SCOPE (own vs all). Unscoped capabilities
  // are team-wide by nature (you either can manage offerings or you can't).
  scoped: boolean
  // i18n key under the `Capabilities` namespace (label shown in the role editor).
  labelKey: string
}

export const CAPABILITY_CATALOG: CapabilityMeta[] = [
  { id: 'contacts.view', domain: 'contacts', scoped: true, labelKey: 'contacts_view' },
  { id: 'contacts.manage', domain: 'contacts', scoped: true, labelKey: 'contacts_manage' },
  { id: 'contacts.delete', domain: 'contacts', scoped: true, labelKey: 'contacts_delete' },
  { id: 'contacts.view.all', domain: 'contacts', scoped: false, labelKey: 'contacts_view_all' },
  { id: 'schedule.view', domain: 'schedule', scoped: true, labelKey: 'schedule_view' },
  { id: 'schedule.manage', domain: 'schedule', scoped: true, labelKey: 'schedule_manage' },
  { id: 'schedule.view.all', domain: 'schedule', scoped: false, labelKey: 'schedule_view_all' },
  { id: 'activities.manage', domain: 'activities', scoped: false, labelKey: 'activities_manage' },
  { id: 'events.manage', domain: 'events', scoped: false, labelKey: 'events_manage' },
  { id: 'offerings.manage', domain: 'offerings', scoped: false, labelKey: 'offerings_manage' },
  { id: 'outreach.manage', domain: 'outreach', scoped: false, labelKey: 'outreach_manage' },
  { id: 'reports.view', domain: 'reports', scoped: false, labelKey: 'reports_view' },
  { id: 'coaches.manage', domain: 'coaches', scoped: false, labelKey: 'coaches_manage' },
  { id: 'members.manage', domain: 'members', scoped: false, labelKey: 'members_manage' },
  { id: 'team.settings', domain: 'team', scoped: false, labelKey: 'team_settings' },
  { id: 'billing.manage', domain: 'billing', scoped: false, labelKey: 'billing_manage' },
  {
    id: 'integrations.manage',
    domain: 'integrations',
    scoped: false,
    labelKey: 'integrations_manage',
  },
  { id: 'plugins.manage', domain: 'plugins', scoped: false, labelKey: 'plugins_manage' },
]

export const ALL_CAPABILITIES: Capability[] = CAPABILITY_CATALOG.map((c) => c.id)

// ─── Display grouping ───────────────────────────────────────────────────────────
// How the role editor arranges the catalog. A GROUP is coarser than a domain —
// thirteen domain headings over eighteen rows is not a grouping, it is a list with
// extra lines. The map is a Record over CapabilityDomain, so a new domain fails
// `turbo run typecheck` rather than silently dropping out of the UI, which is what
// a `.filter()` over a hand-written list would have done.

export type CapabilityGroup = 'contacts' | 'schedule' | 'studio' | 'administration'

/** Render order. */
export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  'contacts',
  'schedule',
  'studio',
  'administration',
]

const GROUP_OF_DOMAIN: Record<CapabilityDomain, CapabilityGroup> = {
  contacts: 'contacts',
  schedule: 'schedule',
  activities: 'studio',
  events: 'studio',
  offerings: 'studio',
  outreach: 'studio',
  reports: 'studio',
  coaches: 'studio',
  members: 'administration',
  team: 'administration',
  billing: 'administration',
  integrations: 'administration',
  plugins: 'administration',
}

export function capabilityGroup(domain: CapabilityDomain): CapabilityGroup {
  return GROUP_OF_DOMAIN[domain]
}

// ─── Where each capability actually BITES ───────────────────────────────────────
// Not every id in the catalog gates something in the app, and the role editor
// used to present all eighteen as though they did. Three answers:
//
//   'app' — refused by firestore.rules, by a callable's `requireCapability`, or
//           by the web UI's `can(...)`. Turning it off changes what happens in
//           the product.
//   'api' — read ONLY by the public-API scope table (packages/shared/src/types/
//           api.ts) and the API principal. Reading a contact in the web app is
//           `canAccessContact` — team membership plus own-scope — and asks for no
//           capability at all, so switching `contacts.view` off narrows an API
//           key and nothing else. The editor says so on the row rather than
//           implying a restriction that is not there.
//   'none' — not capability-gated anywhere. The surface is gated on the OWNER
//           ROLE directly (installed_plugins is `hasTeamRole(teamId, 'owner')`),
//           which is correct behavior; the capability id is simply not the thing
//           enforcing it.
//
// This is a claim about other files, so it is not left to prose: it is re-derived
// from the source and compared against this map by
// packages/functions/src/utils/capabilityEnforcement.test.ts, which owns the
// recipe. Move an enforcement point and that test fails.

export type CapabilityEnforcement = 'app' | 'api' | 'none'

const CAPABILITY_ENFORCEMENT: Record<Capability, CapabilityEnforcement> = {
  'contacts.view': 'api',
  'contacts.manage': 'app',
  'contacts.delete': 'app',
  'contacts.view.all': 'api',
  'schedule.view': 'api',
  'schedule.manage': 'app',
  'schedule.view.all': 'api',
  'activities.manage': 'app',
  'events.manage': 'app',
  'offerings.manage': 'app',
  'outreach.manage': 'app',
  'reports.view': 'app',
  'coaches.manage': 'app',
  'members.manage': 'app',
  'team.settings': 'app',
  'billing.manage': 'none',
  'integrations.manage': 'app',
  'plugins.manage': 'none',
}

export function capabilityEnforcement(cap: Capability): CapabilityEnforcement {
  return CAPABILITY_ENFORCEMENT[cap]
}

const SCOPED_CAPABILITIES: ReadonlySet<Capability> = new Set(
  CAPABILITY_CATALOG.filter((c) => c.scoped).map((c) => c.id)
)

export function capabilityIsScoped(cap: Capability): boolean {
  return SCOPED_CAPABILITIES.has(cap)
}

// ─── Fixed capability sets for the SYSTEM roles ─────────────────────────────────
// These reproduce today's EFFECTIVE permissions exactly (Phase 1 is behavior-
// preserving), so migrating a check to a capability is a no-op for these roles:
//   • owner   → everything.
//   • manager → everything except the owner-only surfaces
//     (members / team settings / billing / integrations / plugins).
//   • viewer  → READ-ONLY: view contacts + the schedule, nothing more. (Historically
//     any team member could edit contacts/sessions; viewer is now genuinely
//     view-only, enforced by the capability gates in firestore.rules.)

// Surfaces only an owner may touch today (team-doc settings, billing, integrations,
// plugin install). NOTE: members.manage is NOT here — managers manage members below
// them via the manageTeamMember callable (rank precedence decides WHO), matching the
// members UI's `canManage = owner || manager`.
const OWNER_ONLY: Capability[] = [
  'team.settings',
  'billing.manage',
  'integrations.manage',
  'plugins.manage',
]

const MANAGER_CAPABILITIES: Capability[] = ALL_CAPABILITIES.filter((c) => !OWNER_ONLY.includes(c))

const VIEWER_CAPABILITIES: Capability[] = [
  'contacts.view',
  'contacts.view.all',
  'schedule.view',
  'schedule.view.all',
]

export const SYSTEM_ROLE_CAPABILITIES: Record<'owner' | 'manager' | 'viewer', Capability[]> = {
  owner: ALL_CAPABILITIES,
  manager: MANAGER_CAPABILITIES,
  viewer: VIEWER_CAPABILITIES,
}

// ─── Coach role (predefined, team-customizable) ─────────────────────────────────
// Default Coach set: view + manage their OWN contacts and their OWN schedule, plus
// read-only access to the whole studio calendar (schedule.view.all) so they can see
// around clashes. No offerings/members/billing/etc. Scope is `own`. Owners/managers
// can override the set per team (teams/{id}/role_config/coach), never the scope.
export const COACH_DEFAULT_CAPABILITIES: Capability[] = [
  'contacts.view',
  'contacts.manage',
  'schedule.view',
  'schedule.view.all',
  'schedule.manage',
]

// Which capabilities a team may toggle for the Coach role (the customizable menu).
// Owner-only surfaces AND members.manage are intentionally excluded — a coach can
// never be granted members / billing / integrations / plugins / team-settings.
const COACH_NEVER: Capability[] = [...OWNER_ONLY, 'members.manage']
export const COACH_ASSIGNABLE_CAPABILITIES: Capability[] = ALL_CAPABILITIES.filter(
  (c) => !COACH_NEVER.includes(c)
)

/**
 * WHY a capability cannot be granted to the Coach role, or null when it can.
 *
 * The editor shows the WHOLE catalog for every role, including the rows a coach
 * can never hold — a list of only what a role can do cannot answer "can a coach do
 * X" for any X outside it, and the reader is left unable to tell "no" from "not
 * listed here". Those rows are locked, and a lock with no reason beside it is just
 * a dead control, so this says which wall it is.
 *
 * DERIVED from the sets above rather than retyped: `members.manage` is the one
 * that is not owner-only (a manager holds it; a coach never does), and if that
 * ever changes this moves with it.
 */
export type CoachLockReason = 'owners_only' | 'owners_and_managers'

export function coachLockReason(cap: Capability): CoachLockReason | null {
  if (COACH_ASSIGNABLE_CAPABILITIES.includes(cap)) return null
  return OWNER_ONLY.includes(cap) ? 'owners_only' : 'owners_and_managers'
}

// ─── Role rank (member-management PRECEDENCE only) ──────────────────────────────
// NOT a capability hierarchy (a coach is not a superset of a viewer). Used solely to
// decide who may add/edit/remove whom: you can only manage members ranked below you.
export const ROLE_RANK: Record<TeamRole, number> = {
  owner: 4,
  manager: 3,
  coach: 2,
  viewer: 1,
}

// Roles that can be assigned via the members UI / invitations (owner is never
// invitable — ownership transfer is a separate, deliberate flow).
export const ASSIGNABLE_ROLES: TeamRole[] = ['manager', 'coach', 'viewer']

// ─── Pure resolvers ─────────────────────────────────────────────────────────────

/** The DATA SCOPE for a role. Coach is own-scoped; every system role is all-scoped. */
export function dataScopeForRole(role: TeamRole): DataScope {
  return role === 'coach' ? 'own' : 'all'
}

/**
 * The effective capability set for a role. For 'coach', pass the team's override
 * (role_config/coach.capabilities) to honor customization; omit to get the default.
 * Unknown/invalid override entries are ignored.
 */
export function resolveRoleCapabilities(
  role: TeamRole,
  coachOverride?: Capability[] | null
): Capability[] {
  if (role === 'coach') {
    // AN EMPTY OVERRIDE IS AN ANSWER, NOT THE ABSENCE OF ONE.
    //
    // This read `coachOverride && coachOverride.length ? …`, so a studio that
    // switched every coach capability off and saved got the five DEFAULTS back:
    // the editor writes `capabilities: []`, `syncMemberCapabilities` resolved that
    // to the default set and denormalized it onto every coach's member document,
    // and `hasTeamCapability` in firestore.rules — which reads that document, not
    // this function — then granted them. The page reloaded showing every switch
    // off (it distinguishes null from [] correctly), so the screen and the
    // enforcement disagreed silently, permanently, and in the permissive
    // direction.
    //
    // `Array.isArray` is the shape `memberCapabilityList` in ./api.ts already
    // uses for the same question. A doc with no `capabilities` field at all —
    // written by a future editor that only sets `coachRoles` — is undefined, not
    // empty, and still falls through to the defaults.
    //
    // A team that reaches zero capabilities now has coaches who can do nothing,
    // which is what it asked for and what its screen already showed. That is the
    // same direction firestore.rules chose when it closed the missing-field
    // fallthrough: under-privileged is visibly wrong, over-privileged is silently
    // wrong.
    const base = Array.isArray(coachOverride) ? coachOverride : COACH_DEFAULT_CAPABILITIES
    // Never let an override grant an owner-only capability, whatever is stored.
    return base.filter((c) => COACH_ASSIGNABLE_CAPABILITIES.includes(c))
  }
  return SYSTEM_ROLE_CAPABILITIES[role]
}

/** Does a role (with optional coach override) hold a capability? */
export function roleHasCapability(
  role: TeamRole,
  cap: Capability,
  coachOverride?: Capability[] | null
): boolean {
  // Owner is always all-capable, defensively, regardless of any stored set.
  if (role === 'owner') return true
  return resolveRoleCapabilities(role, coachOverride).includes(cap)
}

/** Can a member of `actorRole` manage (add/edit/remove) a member of `targetRole`? */
export function canManageRole(actorRole: TeamRole, targetRole: TeamRole): boolean {
  return ROLE_RANK[actorRole] > ROLE_RANK[targetRole]
}

// ─── Per-team role override doc ─────────────────────────────────────────────────
// Stored at teams/{teamId}/role_config/{roleId}. Today only 'coach' is customizable;
// the shape is role-agnostic so custom roles slot in later. `scope` is reserved for
// the future — the Coach role stays own-scoped for now (dataScopeForRole).
export interface RoleConfig {
  role: TeamRole
  capabilities: Capability[]
  scope?: DataScope
  // Which roles are "coaches" — assignable to a contact + shown in the coach picker.
  // The Coach role is always a coach; owner/manager are opt-out (default on). This is
  // an eligibility/relationship flag only: owner/manager stay all-scoped. Stored on the
  // role_config/coach doc; absent ⇒ DEFAULT_COACH_ROLES. See coachRolesFrom().
  coachRoles?: TeamRole[]
  updatedBy?: string
  updated_at?: Timestamp
}

// Roles eligible to be selected as a contact's coach when a team hasn't customized it.
// Coach is always included; owner/manager default on (removable in Settings → Roles).
export const DEFAULT_COACH_ROLES: TeamRole[] = ['owner', 'manager', 'coach']

// The optional 'owner'/'manager' toggles the roles UI exposes ('coach' is implicit).
export const TOGGLEABLE_COACH_ROLES: TeamRole[] = ['owner', 'manager']

/** Resolve a team's coach-eligible roles from its stored config (coach always included). */
export function coachRolesFrom(stored: TeamRole[] | null | undefined): TeamRole[] {
  if (!stored) return DEFAULT_COACH_ROLES
  const set = new Set<TeamRole>(stored)
  set.add('coach')
  return [...set]
}
