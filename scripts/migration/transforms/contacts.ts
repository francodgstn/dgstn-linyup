import { RANKING_HMD, RANKING_KD, ORG_ID, rankingSystemLevelValues } from '../config'
import { matchSubscriptionType, pickSubscriptionPrice } from './subscriptions'
import { buildAffiliationSummary } from '../../lib/affiliations'

// ── Affiliation mapping (Phase 2) ─────────────────────────────────────────────
//
// HMD's single-valued membership_status / org_membership_status fields are
// replaced by the multi-valued AFFILIATION set (contacts/{id}/affiliations).
// The status vocabulary is reused as-is (active/expired/requested/…); only the
// 'active' status counts as active. Affiliation docs are NOT a subcollection on
// the HMD source, so the transform derives them and attaches them under the
// reserved `__affiliations` key — pass05 writes each into the affiliations
// subcollection and strips the key before persisting the contact doc.

// Reserved transform-output key the contacts pass reads to emit subcollection docs.
export const AFFILIATIONS_OUTPUT_KEY = '__affiliations'

// Affiliation type ids seeded into the type catalog by the migration. The HMD
// org-level 'club' type lives at organizations/{ORG_ID}/affiliation_types/club;
// a team-local 'club' type at teams/{teamId}/affiliation_types/club.
const ORG_CLUB_TYPE = { id: 'club', key: 'club', label: 'Club membership' }
const TEAM_CLUB_TYPE = { id: 'club', key: 'club', label: 'Club membership' }

// Only 'active' counts as an active affiliation (mirrors DEFAULT_ORG_AFFILIATION_STATUSES).
const ACTIVE_COUNTING_STATUS_IDS = new Set(['active'])

function statusCountsAsActive(statusId: string): boolean {
  return ACTIVE_COUNTING_STATUS_IDS.has(statusId)
}

// A non-guest, non-empty status is a real affiliation; guest/none → none.
function isAffiliationStatus(status: unknown): status is string {
  return typeof status === 'string' && status.length > 0 && status !== 'guest'
}

// Map an HMD acquisition channel label (free text) onto the canonical Linyup
// marketing source. Returns the nearest channel, or 'other' for anything that
// doesn't clearly fit — the original label is preserved in source_detail.
function mapAcquisitionChannel(
  channel: string
): 'website' | 'referral' | 'social' | 'event' | 'other' {
  const c = channel.toLowerCase()
  if (c.includes('website') || c.includes('web site') || c.includes('google')) return 'website'
  if (
    c.includes('word-of-mouth') ||
    c.includes('word of mouth') ||
    c.includes('passaparola') ||
    c.includes('referral')
  )
    return 'referral'
  if (c.includes('facebook') || c.includes('instagram') || c.includes('social')) return 'social'
  if (c.includes('event') || c.includes('seminar') || c.includes('camp')) return 'event'
  return 'other'
}

// ── Rank validation ──────────────────────────────────────────────────────────
//
// A rank is written straight through as a number, and a number the belt scale
// does not contain still writes cleanly: Firestore accepts it, and the app then
// floor-matches it to a lower belt or renders nothing at all. So a bad rank is
// invisible in the console and wrong on the contact's badge — the one failure
// mode nobody spots.
//
// It is NEVER a throw. A migration that dies on one bad row abandons a run that
// has already written thousands of good ones; the operator needs the list, not
// a stack trace. Each one is named as it happens and the total is printed once
// when the run ends, so a warning that scrolled past mid-migration still gets
// counted at the bottom.

let invalidRankCount = 0
let totalRegistered = false

function reportInvalidRank(src: Record<string, unknown>, systemId: string, raw: unknown): void {
  invalidRankCount++

  // The transform sees the doc DATA, not the doc id, so the contact is named
  // with whatever it actually carries.
  const who =
    [src.firstname, src.lastname].filter(Boolean).join(' ').trim() ||
    (src.email as string | undefined) ||
    (src.id as string | undefined) ||
    'unnamed contact'

  console.warn(
    `  ⚠ ${who} (team ${String(src.teamId ?? '—')}): ${systemId} rank ` +
      `${JSON.stringify(raw)} is not a level in the ${systemId} scale — written as-is`,
  )

  if (!totalRegistered) {
    totalRegistered = true
    process.on('exit', () => {
      console.warn(
        `\n⚠ ${invalidRankCount} migrated rank value(s) are not levels in their ranking ` +
          `scale. Each is named above; fix them on the contact or add the missing levels ` +
          `to the ranking system.`,
      )
    })
  }
}

/** Numeric rank for `ranks[systemId]`, warning when the scale has no such level. */
function validatedRank(src: Record<string, unknown>, systemId: string, raw: unknown): number {
  const value = Number(raw)
  const levels = rankingSystemLevelValues(systemId)
  // A null `levels` means this migration does not create that system at all —
  // a different problem, and one this function is not the place to invent an
  // answer for, so the value passes through unremarked.
  if (levels && !levels.has(value)) reportInvalidRank(src, systemId, raw)
  return value
}

/**
 * @param sourceTypeNames  Source subscription-type id → its NAME, read from the
 *   source team's own `subscription_types`. See the subscription block below for
 *   why a name the contact does not carry has to be looked up.
 */
export function transformContact(
  src: Record<string, unknown>,
  sourceTypeNames?: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...src }

  // Field renames
  if ('residence' in out) { out.address = out.residence; delete out.residence }
  delete out.teacher      // now derived from teamId
  delete out.notes        // old Lexical JSON is stale; new app handles notes differently

  // ── Acquisition axis ─────────────────────────────────────────────────────
  // HMD conflated the funnel into a single `type` ('trial'|'student'|'external').
  // Linyup splits this into a sticky acquisition_stage + an immutable `entry`
  // door, plus milestone timestamps. The marketing channel that HMD kept in the
  // free-text `acquisition` object is captured into the `source` axis (it used
  // to be dropped). Session activity decides whether a trial has been attended.
  const hmdType = src.type as 'trial' | 'student' | 'external' | undefined
  const totalSessions = Number(
    (src.total_sessions_count as number | undefined) ??
      (src.total_sessions as number | undefined) ??
      0
  )
  const hasAttended = totalSessions > 0 || src.last_session_at != null
  // Best available milestone timestamp: created_at is the only reliable date HMD
  // carries on a contact. Use it for whichever milestones the stage has reached.
  const milestoneTs = (src.created_at as unknown) ?? null

  if (hmdType === 'student') {
    out.acquisition_stage = 'joined'
    out.entry = 'import'
    out.converted_at = milestoneTs
  } else if (hmdType === 'external') {
    out.acquisition_stage = 'joined'
    out.entry = 'import'
    out.converted_at = milestoneTs
  } else {
    // trial (and any unknown legacy value): a booking-born trial contact
    out.entry = 'booking'
    if (hasAttended) {
      out.acquisition_stage = 'trial_attended'
      out.trial_attended_at = milestoneTs
    } else {
      out.acquisition_stage = 'trial_booked'
    }
  }
  out.acquisition_stage_updated_at = milestoneTs
  delete out.type

  // Source axis — capture the marketing channel from the old `acquisition` blob.
  const acquisition = src.acquisition as Record<string, unknown> | undefined
  const channel = (acquisition?.channel as string | undefined) ?? ''
  if (channel.trim()) {
    out.source = mapAcquisitionChannel(channel)
    if (out.source === 'other') out.source_detail = channel.trim()
  }
  // Preserve the "new contact seen" UX flag if HMD recorded it.
  if (acquisition && 'acknowledged' in acquisition) {
    out.lead_acknowledged = Boolean(acquisition.acknowledged)
  }
  delete out.acquisition

  // Build ranks map from all available rank sources:
  //   - contact.rank            → primary HMD belt rank
  //   - contact.disciplines.hmd_rank / .kd_rank  → per-discipline ranks (newer hmd-lineup)
  const ranks: Record<string, number> = {}

  const disciplines = src.disciplines as Record<string, unknown> | undefined
  const hmdRank = disciplines?.hmd_rank ?? src.rank
  const kdRank  = disciplines?.kd_rank

  if (hmdRank != null) ranks[RANKING_HMD] = validatedRank(src, RANKING_HMD, hmdRank)
  if (kdRank  != null) ranks[RANKING_KD]  = validatedRank(src, RANKING_KD,  kdRank)

  if (Object.keys(ranks).length > 0) out.ranks = ranks
  delete out.rank
  delete out.disciplines  // replaced by ranks map above

  // New required fields with safe defaults
  out.tags          = out.tags          ?? []
  // 'external' is no longer a contact status/type — represent it as a tag.
  if (hmdType === 'external') {
    const tags = out.tags as unknown[]
    if (!tags.includes('external')) tags.push('external')
  }
  out.anonymized_at = out.anonymized_at ?? null
  // Ensure these fields always exist as null so Firestore equality queries work correctly
  out.deleted_at    = out.deleted_at    ?? null
  out.archived_at   = out.archived_at   ?? null

  // ── Affiliations (replaces the removed membership_* / org_membership_* fields) ─
  // Derive affiliation docs from the HMD membership fields, then delete those
  // fields from the contact doc. pass05 reads the __affiliations array off the
  // transform output and writes each into contacts/{id}/affiliations.
  //   org_membership_status (non-guest) → issuer 'org' affiliation (the HMD org),
  //     valid_until from org_membership_expiration.
  //   membership_status     (non-guest) → 'club' issuer 'team' affiliation,
  //     valid_until from membership_expiration.
  //   guest / none → no affiliation.
  // Soft-deleted contacts are coerced to 'expired' so they never count as active.
  const teamId = typeof out.teamId === 'string' ? out.teamId : ''
  const isDeleted = out.deleted_at != null
  const createdAt = (out.created_at as unknown) ?? null
  const affiliations: Array<Record<string, unknown>> = []

  function pushAffiliation(
    statusRaw: unknown,
    issuer: 'org' | 'team',
    type: { id: string; key: string; label: string },
    expiration: unknown,
  ): void {
    if (!isAffiliationStatus(statusRaw)) return
    const statusId = isDeleted ? 'expired' : statusRaw
    const doc: Record<string, unknown> = {
      teamId,
      affiliation_type_id: type.id,
      type_key: type.key,
      label: type.label,
      issuer,
      status_id: statusId,
      active: statusCountsAsActive(statusId),
      created_at: createdAt,
      updated_at: createdAt,
      created_by: 'migration',
    }
    if (issuer === 'org') doc.org_id = ORG_ID
    if (expiration != null) doc.valid_until = expiration
    affiliations.push(doc)
  }

  // org-issued membership (newer HMD docs may carry this explicitly)
  pushAffiliation(out.org_membership_status, 'org', ORG_CLUB_TYPE, out.org_membership_expiration)
  // club / team-issued membership (the field HMD historically stores)
  pushAffiliation(out.membership_status, 'team', TEAM_CLUB_TYPE, out.membership_expiration)

  // Drop the removed membership fields from the contact doc.
  delete out.membership_status
  delete out.membership_active
  delete out.membership_expiration
  delete out.org_membership_status
  delete out.org_membership_active
  delete out.org_membership_expiration

  if (affiliations.length > 0) {
    // Best-effort summary so the contacts list shows belonging without the trigger.
    //
    // THROUGH THE SHARED BUILDER, and it was not: this was a fourth private copy
    // of the summary logic, and the copy is what made it wrong. When
    // `AffiliationSummary` gained `active_org_ids` — the orgs whose affiliation
    // is CURRENT, which the org dashboard's figures are counted from — the four
    // seeders picked it up because they call `buildAffiliationSummary`, and this
    // did not because it spelled the object out. A migrated federation would
    // have read zero affiliated: an `array-contains` never matches a missing
    // field, so every HMD contact would have dropped out of the count.
    //
    // The helper is dependency-free and compiles under tsconfig.scripts.json
    // like the rest of this directory, so there was never a reason for the copy.
    out.affiliation_summary = buildAffiliationSummary(
      affiliations as Array<{ active: boolean; type_key?: string; org_id?: string }>
    )
    out[AFFILIATIONS_OUTPUT_KEY] = affiliations
  }

  // ── Subscription type matching (HEURISTIC) ───────────────────────────────
  // Attempts to map the source subscription_type_name to a canonical Linyup
  // subscription type by keyword. This is a best-effort approximation — the
  // matched-vs-unmatched counts logged by pass05 must be reviewed against the
  // real source data to confirm accuracy before going live.
  //
  // THE CONTACT DOES NOT CARRY THE NAME. It never did: hmd-lineup stores only
  // `subscription_type_id` on a contact and keeps the name on the type document,
  // and a survey of the real source found the name on 0 of 137 contacts. So this
  // matcher — which reads a name — was handed `undefined` every single time,
  // returned null every single time, and fell through to "leave all
  // subscription_* fields unchanged".
  //
  // Nothing errored. Every migrated contact simply kept the SOURCE's type id,
  // gained no `subscription_type_name`, no price, no amount and no
  // `active_subscriptions` — and the contact page gates its subscription panel
  // on the NAME, so a member with a live plan showed "No subscription history
  // yet" while the history list right below it showed the plan as active.
  //
  // The id is the thing the source actually has, so resolve the name through it.
  const srcTypeId = out.subscription_type_id as string | undefined | null
  const srcTypeName =
    (out.subscription_type_name as string | undefined | null) ??
    (srcTypeId ? (sourceTypeNames?.get(srcTypeId) ?? null) : null)
  const match = matchSubscriptionType(srcTypeName)
  if (match !== null) {
    const price = pickSubscriptionPrice(
      match.prices,
      out.subscription_recurrence as string | undefined | null,
    )
    out.subscription_type_id   = match.typeId
    out.subscription_type_name = match.typeName
    out.subscription_price_id  = price.id
    out.subscription_amount    = price.amount
    // Keep subscription_recurrence authoritative from the chosen price
    out.subscription_recurrence = price.recurrence

    // Populate active_subscriptions with a single-entry summary so the live
    // weeklyReports Cloud Function can count subscriptions by type correctly.
    // This mirrors the shape of ActiveSubscriptionSummary (packages/shared) and
    // carries the same quality of data as the flat subscription_* snapshot fields
    // already written above — a best-effort migration record, not a Stripe object.
    // The `status` is set to 'active' because HMD did not track Stripe rollup
    // status; contacts with a subscription_type were active members by definition.
    // onMemberSubscriptionWrite will replace this array once real Stripe
    // subscriptions are created for the team.
    out.active_subscriptions = [
      {
        subscription_type_id:   match.typeId,
        subscription_type_name: match.typeName,
        recurrence:             price.recurrence,
        amount:                 price.amount,
        status:                 'active',
      },
    ]
  } else if (srcTypeName) {
    // NO CANONICAL COUNTERPART — Fitpass, ClassPass, Instructor, Free. The type
    // itself is copied to the target under this same id, so the id already
    // points at a real document and only the NAME was missing. Write it: the
    // contact page gates its subscription panel on the name, so without this a
    // partner member reads as having no plan at all.
    //
    // Nothing else is invented. These types carry no prices in the source, so
    // there is no price, amount or recurrence to state, and `active_subscriptions`
    // stays unwritten rather than claiming a shape this data cannot fill.
    out.subscription_type_name = srcTypeName
  }
  // A contact with no resolvable type name keeps every subscription_* field as
  // the source had it.

  return out
}
