// Asset register — the finance plugin's equipment list (docs/finance-accrual.md
// §4, the register-only slice).
//
// REGISTER-ONLY IN CASH MODE: registering, editing or disposing an asset writes
// NOTHING to the ledger — on a cash basis the purchase was already expensed at
// payment time, and a posting on registration would double-count it or
// retroactively capitalize it (which IS the accrual move). Book values here are
// INDICATIVE: straight-line arithmetic computed client-side for the register
// page and the statement-of-assets report (the Art. 957 simplified-accounting
// piece). When accrual mode lands, capitalization / monthly depreciation /
// disposal postings will DERIVE from these records; until then this is a list
// with arithmetic.
//
// REGISTRATION ≠ PURCHASE: `acquired_at` — not record-creation time — drives
// the schedule, so pre-existing equipment registered later is already partly or
// fully depreciated by construction, never "bought today".
//
// Storage: teams/{teamId}/asset_register/{assetId}. Owner-written from the
// client (rules-enforced), managers read. The accrual phase may route writes
// through callables once postings depend on these fields; deliberately not yet.

import type { Timestamp } from './common'

export type AssetCategory = 'equipment' | 'leasehold' | 'vehicles' | 'it' | 'other'

/** Ordered for pickers. */
export const ASSET_CATEGORIES: AssetCategory[] = [
  'equipment',
  'leasehold',
  'vehicles',
  'it',
  'other',
]

/**
 * Default useful life per category, in months — a PICKER DEFAULT, editable per
 * asset, aligned with common Swiss small-entity practice (equipment/vehicles
 * 5y, leasehold improvements 10y, IT 3y). The advisor review scoped in
 * docs/finance-accrual.md covers these before accrual-mode postings rely on
 * them; indicative values are the only consumer today.
 */
export const DEFAULT_USEFUL_LIFE_MONTHS: Record<AssetCategory, number> = {
  equipment: 60,
  leasehold: 120,
  vehicles: 60,
  it: 36,
  other: 60,
}

export type AssetStatus = 'active' | 'disposed'

export type AssetDisposalKind = 'sold' | 'scrapped'

export interface Asset {
  /** Doc id. */
  id: string
  teamId: string
  name: string
  category: AssetCategory
  /** Acquisition date — drives the depreciation schedule (see header). */
  acquired_at: Timestamp
  /** Original cost of the WHOLE ROW, integer MINOR units (Rappen) —
   * ledger-ready for the future capitalization postings; the UI converts from
   * major-unit input.
   *
   * ROW TOTAL, NOT UNIT PRICE — see `quantity`. */
  cost_minor: number
  /**
   * How many units this row covers (a batch bought together: 20 pairs of
   * gloves, 8 kick shields). Absent or 1 = a single item.
   *
   * DESCRIPTIVE ONLY — `cost_minor` stays the row TOTAL and the depreciation
   * schedule is unchanged, because a batch acquired on one date for one price
   * IS one schedule. Making cost a unit price instead would multiply through
   * `assetBookValue`, every total and the future capitalization postings, to
   * answer a question ("how many do we have") that does not need arithmetic at
   * all. Unit cost is derived for display (`cost_minor / quantity`), never
   * stored — two fields that can disagree about one number is a defect waiting
   * to happen.
   */
  quantity?: number
  /** Straight-line to zero over this many months (category default, editable).
   * No residual values, no component accounting — docs/finance-accrual.md → "Assets". */
  useful_life_months: number
  /** Free-text location ("main room", "storage") — multi-club orgs have a team
   * per club, so this stays a label, not a Place reference. */
  location?: string | null
  note?: string | null
  /** Download URL of the optional photo (insurance side-benefit). Lives under
   * teams/{teamId}/asset_register/{assetId}/… in Storage — staff-only via the
   * broad team-member match; never mirrored publicly. */
  photoUrl?: string | null
  status: AssetStatus
  disposed_at?: Timestamp | null
  /** Recorded only in cash mode; the accrual phase derives the gain/loss
   * posting from kind + proceeds. */
  disposal_kind?: AssetDisposalKind | null
  /** Sale proceeds, minor units (sold only). */
  disposal_proceeds_minor?: number | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by?: string
}

/** Units this row covers — the stored `quantity`, defaulting to 1. */
export function assetQuantity(asset: Pick<Asset, 'quantity'>): number {
  const q = Math.floor(asset.quantity ?? 1)
  return q >= 1 ? q : 1
}

/**
 * Cost per unit, integer minor units — DERIVED, never stored (see `quantity`).
 * Floor-divided, so a batch whose total does not divide evenly shows a unit
 * cost that is at most one Rappen light rather than one that multiplies back
 * up past the row total.
 */
export function assetUnitCostMinor(asset: Pick<Asset, 'cost_minor' | 'quantity'>): number {
  return Math.floor(Math.max(0, asset.cost_minor) / assetQuantity(asset))
}
