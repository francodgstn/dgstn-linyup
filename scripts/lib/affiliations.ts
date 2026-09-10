/**
 * Shared affiliation-seeding helpers for the seed scripts.
 *
 * Phase 2 replaced the single-valued org-membership fields
 * (membership_status / org_membership_status / *_active / *_expiration) on the
 * contact doc with a multi-valued AFFILIATION set: each affiliation is its own
 * doc under contacts/{id}/affiliations, plus an org/team affiliation_types
 * catalog and the reused org affiliation_statuses status defs.
 *
 * Path constants + status defs mirror @linyup/shared (CONTACT_AFFILIATIONS_SUBCOLLECTION,
 * AFFILIATION_TYPES_SUBCOLLECTION, ORG_AFFILIATION_STATUSES_SUBCOLLECTION,
 * DEFAULT_ORG_AFFILIATION_STATUSES, Affiliation, AffiliationType). They are
 * re-declared here because the seed scripts compile under tsconfig.scripts.json,
 * which does not resolve the @linyup/shared workspace import.
 */

// ── Firestore path constants (mirror @linyup/shared/paths) ─────────────────────
export const CONTACT_AFFILIATIONS_SUBCOLLECTION = 'affiliations'
export const AFFILIATION_TYPES_SUBCOLLECTION = 'affiliation_types'
export const ORG_AFFILIATION_STATUSES_SUBCOLLECTION = 'affiliation_statuses'

// ── Default org membership status defs (mirror @linyup/shared DEFAULT_ORG_AFFILIATION_STATUSES) ──
// The built-in fallback status vocabulary, reused as affiliation statuses. Only
// `active` counts as active; `expired` is final. The same shape an org carries at
// organizations/{orgId}/affiliation_statuses.
//
// NO 'guest'. Not belonging is the ABSENCE of an affiliation row, never a status
// — see the long note on the shared constant this mirrors. The seeders' own
// `status: 'guest'` fixture label is a different thing: it is an INPUT meaning
// "give this persona no affiliation", and each seeder already honours it that
// way.
export const DEFAULT_ORG_AFFILIATION_STATUSES = [
  {
    id: 'requested',
    label: 'Requested',
    description: 'Member has submitted a request, awaiting review.',
    color: 'yellow',
    order: 0,
    isBuiltIn: true,
    countsAsActive: false,
    isFinal: false,
  },
  {
    id: 'under_review',
    label: 'Under review',
    description: 'Documents are being reviewed by the organisation.',
    color: 'blue',
    order: 1,
    isBuiltIn: true,
    countsAsActive: false,
    isFinal: false,
  },
  {
    id: 'almost_ready',
    label: 'Almost ready',
    description: 'Review complete, awaiting final confirmation.',
    color: 'purple',
    order: 2,
    isBuiltIn: true,
    countsAsActive: false,
    isFinal: false,
  },
  {
    id: 'active',
    label: 'Active',
    description: 'Valid membership, recognised by the federation.',
    color: 'green',
    order: 3,
    isBuiltIn: true,
    countsAsActive: true,
    isFinal: false,
  },
  {
    id: 'expired',
    label: 'Expired',
    description: 'Membership period has ended. Renewal required.',
    color: 'red',
    order: 4,
    isBuiltIn: true,
    countsAsActive: false,
    isFinal: true,
  },
] as const

// Set of status ids whose `countsAsActive` is true — drives the affiliation's
// denormalized `active` boolean and the summary `has_active` rollup.
const ACTIVE_COUNTING_STATUS_IDS: ReadonlySet<string> = new Set(
  DEFAULT_ORG_AFFILIATION_STATUSES.filter((s) => s.countsAsActive).map((s) => s.id)
)

/** True when the given status id counts as an active affiliation. */
export function statusCountsAsActive(statusId: string): boolean {
  return ACTIVE_COUNTING_STATUS_IDS.has(statusId)
}

// ── Affiliation type catalog defs ──────────────────────────────────────────────
export type SeedIssuer = 'team' | 'org' | 'external'

export interface SeedAffiliationType {
  id: string
  key: string
  label: string
  default_issuer: SeedIssuer
  org_id?: string
  default_validity_months?: number
  active: boolean
  order: number
}

/**
 * Org-level affiliation types for a team that belongs to an organisation:
 * a federation licence + a club membership, both issued by the org.
 */
export function orgAffiliationTypes(orgId: string): SeedAffiliationType[] {
  return [
    {
      id: 'federation_licence',
      key: 'federation_licence',
      label: 'Federation licence',
      default_issuer: 'org',
      org_id: orgId,
      default_validity_months: 12,
      active: true,
      order: 0,
    },
    {
      id: 'club',
      key: 'club',
      label: 'Club membership',
      default_issuer: 'org',
      org_id: orgId,
      active: true,
      order: 1,
    },
  ]
}

/** Team-local affiliation type for a standalone studio: an internal club membership. */
export function teamAffiliationTypes(): SeedAffiliationType[] {
  return [
    {
      id: 'club',
      key: 'club',
      label: 'Club membership',
      default_issuer: 'team',
      active: true,
      order: 0,
    },
  ]
}

// ── Affiliation doc builder ────────────────────────────────────────────────────

export interface BuildAffiliationOpts {
  teamId: string
  /** chosen type from the seeded catalog (org-level or team-local) */
  type: SeedAffiliationType
  /** prior membership status id — 'active' | 'expired' | 'requested' | … */
  statusId: string
  /** set when the team is in an org → issuer 'org' + org_id; else issuer 'team' */
  orgId?: string
  /** mapped from the prior expiration, if any */
  validUntil?: unknown
  validFrom?: unknown
  createdAt?: unknown
  createdBy?: string
  /**
   * Is the parent contact live — not deleted, not archived?
   *
   * DEFAULTS TO TRUE, and that is safe only because every seeder writes
   * `archived_at: null` and `deleted_at: null` on every contact it creates: no
   * seeded persona has ever left. A seeder that starts creating archived
   * personas MUST pass this, or the organisation's status breakdown counts
   * people who are gone — the exact defect #249 fixed.
   */
  contactLive?: boolean
}

/**
 * Build a single affiliation doc body for contacts/{id}/affiliations/{affId}.
 * `active` is denormalized from the status def's countsAsActive. Issuer is 'org'
 * when the team belongs to an org (carrying org_id), else 'team'.
 */
export function buildAffiliationDoc(opts: BuildAffiliationOpts): Record<string, unknown> {
  const { teamId, type, statusId, orgId, validUntil, validFrom, createdAt, createdBy } = opts
  const issuer: SeedIssuer = orgId ? 'org' : 'team'
  const doc: Record<string, unknown> = {
    teamId,
    affiliation_type_id: type.id,
    type_key: type.key,
    label: type.label,
    issuer,
    status_id: statusId,
    active: statusCountsAsActive(statusId),
    // Denormalised liveness — the organisation's status breakdown counts these
    // rows through a collection group, which cannot reach the parent contact to
    // see `archived_at`. See `Affiliation.contact_live` in shared. Writing it
    // HERE is why no backfill exists: every seeded dataset is reproducible, so
    // re-seeding is the migration.
    contact_live: opts.contactLive ?? true,
    created_at: createdAt ?? null,
    updated_at: createdAt ?? null,
  }
  if (orgId) doc.org_id = orgId
  if (validUntil != null) doc.valid_until = validUntil
  if (validFrom != null) doc.valid_from = validFrom
  if (createdBy) doc.created_by = createdBy
  return doc
}

/**
 * Best-effort Contact.affiliation_summary (normally computed by a Cloud Function
 * trigger). Seeds set it so the contacts list / UI shows something even when the
 * seed runs without functions. Takes the affiliation doc bodies a contact holds.
 */
/**
 * What `buildAffiliationSummary` needs off an affiliation doc — named, because
 * every seeder and the migration cast to it and four copies of the same inline
 * object is how one of them silently stops passing a field the summary needs.
 * That already happened once: `status_id` was present at runtime and absent
 * from the cast.
 *
 * A TYPE ALIAS AND NOT AN INTERFACE, which is load-bearing rather than style:
 * every call site reaches it by casting a `Record\<string, unknown\>` read out
 * of a seed object, and only an object type gets the implicit index signature
 * that makes such a conversion legal. As an interface `pnpm typecheck:seeds`
 * rejects all five with TS2352 — and that target is not part of
 * `pnpm typecheck`, so it fails in CI rather than locally.
 */
export type AffiliationSummaryInput = {
  active: boolean
  type_key?: string
  org_id?: string
  status_id?: string
}

export function buildAffiliationSummary(affiliations: AffiliationSummaryInput[]): {
  has_active: boolean
  types: string[]
  org_ids: string[]
  active_org_ids: string[]
} {
  const types = new Set<string>()
  const orgIds = new Set<string>()
  const activeOrgIds = new Set<string>()
  let hasActive = false
  for (const a of affiliations) {
    if (a.active) hasActive = true
    if (a.type_key) types.add(a.type_key)
    if (a.org_id) orgIds.add(a.org_id)
    // NOW vs EVER — the distinction the org's counts hang on. Kept in step with
    // `onAffiliationWrite`, which is the real writer; a seed that disagreed with
    // it would produce demo numbers no deployment could reproduce.
    if (a.org_id && a.active) activeOrgIds.add(a.org_id)
  }
  return {
    has_active: hasActive,
    types: [...types],
    org_ids: [...orgIds],
    active_org_ids: [...activeOrgIds],
  }
}
