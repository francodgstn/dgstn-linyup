import type { AffiliationValidityMode } from '../utils/affiliationValidity'
import type { Timestamp } from './common'

// ─── Affiliation axis — "do they belong, and to what?" ───────────────────────
//
// Generalises the old single-valued org-membership into a SET: a contact may hold
// several affiliations at once (a club membership + a federation licence + a
// grading), each its own record with an issuer, a (configurable) status, and a
// validity window. Belonging never freezes — that's the subscription axis.
//
// Status vocabulary is REUSED across all affiliation types — the configurable
// OrgAffiliationStatusDef defs (below) are the single canonical set; there is no
// parallel enum. Each affiliation stores its `status_id` plus a denormalised
// `active` boolean (from the status def's countsAsActive) that drives the rollups.

// Who grants / issues the affiliation:
//  - 'team'     the studio grants it itself (an internal club membership)
//  - 'org'      scoped to a linked organisation (a federation / Verein the team belongs to)
//  - 'external' a governing body the studio only TRACKS (it issues, the studio records validity)
export const AFFILIATION_ISSUERS = ['team', 'org', 'external'] as const
export type AffiliationIssuer = (typeof AFFILIATION_ISSUERS)[number]

// A single affiliation a contact holds — contacts/{contactId}/affiliations/{id}.
export interface Affiliation {
  id: string
  teamId: string
  affiliation_type_id: string // FK to the type catalog (org-wide or team-local)
  type_key?: string // denormalized machine key (e.g. 'club' | 'federation_licence' | 'grading')
  label?: string // denormalized display label
  issuer: AffiliationIssuer
  org_id?: string // set when issuer === 'org' — references organizations/{orgId}
  issuer_name?: string // governing-body name when issuer === 'external'
  status_id: string // a configurable status def (org's affiliation_statuses, or the built-in defaults)
  active: boolean // denormalized from the status def's countsAsActive — drives rollups
  reference?: string // licence / registration number
  valid_from?: Timestamp
  valid_until?: Timestamp
  /**
   * IS THE PERSON THIS ROW BELONGS TO STILL SOMEBODY THE STUDIO LOOKS AFTER?
   * Denormalised from the parent contact — `!deleted_at && !archived_at`, the
   * same pair `liveContactConstraints()` puts on every contact query.
   *
   * It exists because a collection-group query over affiliations CANNOT REACH
   * THE PARENT. The organisation's status breakdown counts rows here, and
   * without this an ex-member's licence sat in the federation's queue for ever
   * — "34 records" on a page whose headcount was 31 (#249).
   *
   * #249 solved that by moving the breakdown onto the CONTACT, filtering a
   * denormalised `org:status` key that composed with `archived_at` natively.
   * `orgAdminMayReadContact` then made that query unprovable: Firestore matches
   * a query against a rule by VALUE, and that key has a tenant-configurable half
   * no rule can name. So the breakdown came back to this collection group, where
   * the rule proves it on `org_id` alone — and the liveness it cannot see had to
   * come with it. (The key itself is gone; nothing read it once the breakdown
   * moved.)
   *
   * WRITTEN BY: `syncAffiliationContactLive` (the contact-side trigger, which
   * owns transitions), `upsertAffiliation` at create time — so a row is never
   * uncounted by accident before the trigger has any reason to fire — and the
   * two dataset builders, `scripts/lib/affiliations.ts` for all four seeders and
   * `scripts/migration/transforms/contacts.ts` for HMD.
   *
   * NO BACKFILL EXISTS, DELIBERATELY. An equality filter never matches a missing
   * field, so a row written before this field simply does not count — visibly
   * low rather than invisibly high, the safe direction. Every dataset that holds
   * affiliations today is REPRODUCIBLE (seeds, leads, the HMD migration), so
   * re-seeding or re-running the migration is the migration. Should that stop
   * being true — real tenant data with affiliations — a backfill becomes a
   * deploy precondition and this note is the reason it was not needed before.
   */
  contact_live?: boolean
  // Display-only bookkeeping: the fee is paid directly to the issuer (not via Linyup).
  // `fee_paid` is a manual "fee received" flag a manager toggles for their own records.
  fee_paid?: boolean
  fee_paid_at?: Timestamp
  created_at?: Timestamp
  updated_at?: Timestamp
  created_by?: string
}

// A configurable affiliation TYPE — defined org-wide
// (organizations/{orgId}/affiliation_types) AND team-local
// (teams/{teamId}/affiliation_types), mirroring how ranking_systems work.
export interface AffiliationType {
  id: string
  key: string // stable machine key
  label: string // display
  default_issuer: AffiliationIssuer
  issuer_name?: string // governing body, for 'external' types
  org_id?: string // for 'org' types — which org this type belongs to
  /**
   * HOW this type decides when membership lapses. Absent ⇒ 'months', which is
   * every type that exists today.
   *
   * `fixed_date` is the federation model: everyone renews on the same day
   * regardless of when they joined, which is how HMD works — 1 September, every
   * year, whoever you are (Franco, 2026-09-05). Someone joining in August gets
   * a short first term, deliberately: one clock for the whole roster is the
   * point, and pro-rating it would put them back on their own.
   */
  validity_mode?: AffiliationValidityMode
  default_validity_months?: number
  /** `fixed_date` mode: the reset day as `MM-DD` (e.g. '09-01' for 1 September). */
  reset_month_day?: string
  // Display-only fee metadata. Linyup never charges this — the member pays the issuer
  // directly. `fee_amount` is in major currency units (shown with the team's default_currency);
  // `issuer_url` optionally points to where the member pays / renews with the issuer.
  fee_amount?: number
  issuer_url?: string
  active?: boolean
  order?: number
}

// Denormalized onto Contact.affiliation_summary by the onAffiliationWrite trigger —
// the single shape the contacts list, Firestore rules, and "contacts in org X"
// queries read (never the affiliations subcollection directly in a list).
export interface AffiliationSummary {
  has_active: boolean
  types: string[] // distinct type_keys the contact holds
  /**
   * Distinct org_ids of the contact's org-issued affiliations, **whatever their
   * status** — expired, revoked and merely requested ones all count. It answers
   * "has this person ever been on that federation's books".
   */
  org_ids: string[]
  /**
   * The orgs whose affiliation the contact holds **right now** — the same list
   * narrowed to `active` rows (denormalised from the status def's
   * `countsAsActive`, and flipped to false by the `expireAffiliations` sweep
   * when `valid_until` passes).
   *
   * IT EXISTS BECAUSE `org_ids` ANSWERS A DIFFERENT QUESTION, and a federation's
   * headline numbers were reading it as if it answered this one: the org
   * dashboard's affiliation figure, its coverage percentage and the Studios
   * column all counted a licence that lapsed last season as current (Franco,
   * 2026-09-08 — "in the org dashboard, I see too high counts"). Narrowing
   * `org_ids` in place would have been a silent change of meaning to a field
   * whose name does not imply a status, so the current set got its own name.
   *
   * OPTIONAL, and the reason matters: a summary written before this field
   * existed simply lacks it, and a Firestore `array-contains` never matches a
   * missing field — so an un-backfilled contact drops OUT of the count rather
   * than being counted wrongly. That is the safer direction (a number that is
   * visibly too low, not invisibly too high) but it is still wrong, which is why
   * `pnpm backfill:affiliation-active-orgs` is a deploy precondition. The
   * trigger fills it for everyone it touches from here on.
   */
  active_org_ids?: string[]
}

// ─── Affiliation status defs (org-configurable) ──────────────────────────────
// The configurable status vocabulary an affiliation's `status_id` points at,
// stored at organizations/{orgId}/affiliation_statuses. Reused across every
// affiliation type; `countsAsActive` drives the denormalised `active` rollup.
// (The status `id`s below are stable identifiers referenced by Affiliation.status_id.)
//
// THERE IS NO 'guest' STATUS, AND ITS ABSENCE IS THE DESIGN.
//
// It existed in the old product, where belonging was a FIELD on the contact and
// somebody who did not belong still had to hold some value: 'guest' meant "on
// the roster, not counting". Affiliations made belonging a ROW, so not
// belonging is the absence of one and needs no vocabulary at all.
//
// Keeping it was actively harmful once `orgAdminMayReadContact` shipped: every
// writer in the product already treated 'guest' as "write no row" (the HMD
// import, all three seeders), so the ONLY way to create one was a manager
// picking it from the roster's status list — which WRITES a row, and a row is
// what discloses the contact to the organisation. The status whose label said
// "not a member" was the one control that made someone a member.
// See `docs/org-contact-visibility.md`.
//
// "No affiliation" is therefore never a `status_id`. The UI carries its own
// sentinel for the empty state (`NO_AFFILIATION`, web only) and removal is an
// explicit action — `removeAffiliation` — not a value anyone can select.

export type AffiliationStatusColor =
  | 'gray'
  | 'yellow'
  | 'blue'
  | 'purple'
  | 'green'
  | 'red'
  | 'orange'

export interface OrgAffiliationStatusDef {
  id: string
  label: string
  description: string
  color: AffiliationStatusColor
  order: number
  isBuiltIn: boolean
  countsAsActive: boolean
  isFinal: boolean
}

// `order` is a SORT KEY, not an identity, which is why renumbering after the
// removal costs nothing: an org that auto-initialised these before still holds
// docs numbered 1–5, and the two orderings interleave to the same sequence.
export const DEFAULT_ORG_AFFILIATION_STATUSES: OrgAffiliationStatusDef[] = [
  {
    id: 'requested',
    label: 'Requested',
    description: 'A request has been submitted, awaiting review.',
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
    description: 'Valid affiliation, recognised by the federation.',
    color: 'green',
    order: 3,
    isBuiltIn: true,
    countsAsActive: true,
    isFinal: false,
  },
  {
    id: 'expired',
    label: 'Expired',
    description: 'The affiliation period has ended. Renewal required.',
    color: 'red',
    order: 4,
    isBuiltIn: true,
    countsAsActive: false,
    isFinal: true,
  },
]
