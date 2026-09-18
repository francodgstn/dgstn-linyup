import { activityDocForWrite, type ClassAccessInput } from '@linyup/shared'

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * @param planIds  Every plan this studio will have — the canonical ids plus the
 *   source types that survive the duplicate skip. Absent leaves the access rule
 *   alone (the shape before HMD's policy was recorded).
 */
export function transformActivity(
  src: Record<string, unknown>,
  planIds?: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...src }

  delete out.is_paid  // not in new schema

  out.slug            = out.slug            ?? slugify(String(src.name ?? ''))
  out.type            = out.type            ?? 'class'
  out.isActive        = out.archived_at     ? false : (out.isActive ?? true)
  // `level` was DROPPED from the schema (replaced by `tags`), so never default or
  // carry one: strip it, but preserve a real source level as a tag rather than
  // losing the information ('all' is not a meaningful tag).
  if (typeof out.level === 'string' && out.level.trim() && out.level !== 'all') {
    const existing = Array.isArray(out.tags) ? (out.tags as unknown[]) : []
    out.tags = [...existing, out.level.trim()]
  }
  delete out.level
  out.alternativeName = out.alternativeName ?? null
  out.base_score      = out.base_score      ?? null

  // ── HMD'S DOOR: EVERY PLAN GETS EVERY CLASS, AND THE TRIAL IS THE PUBLIC WAY IN
  //
  // hmd-lineup had no access model, so a migrated class arrived with no
  // `accessRule` at all — which reads as legacy `open`: anybody books, free,
  // forever, and no plan is ever part of the transaction. That is not what the
  // studio sells, and it also makes a plan's usage cap unenforceable, because
  // `resolvePaymentOptions` only consults an allowance for a plan the activity
  // actually lists (Essential's 4-per-month would never bind).
  //
  // So the classes are plan-gated and `trialEnabled` carries the newcomer:
  // "public booking is done by enabling the trial, only trials can book free"
  // (Franco, 2026-09-08). A trial is once per person — `Contact.trial_used_at` —
  // so this is a door, not a hole.
  //
  // Stated here in the LEGACY vocabulary on purpose (`requirePlan: true`) and
  // converted below by `activityDocForWrite`, which stores the DERIVED shape
  // (docs/class-access-derived.md): `audience: 'members'` + the included plans,
  // no drop-in price ⇒ plan-holders-only, with `requirePlan` derived rather than
  // stored. Handing the mapping the derived shape directly would be read as
  // "plans listed, plan not required" and have its plan list cleared.
  //
  // CLASSES ONLY. `Activity.accessRule` is class-only by design — appointment
  // paths ignore it, and the price is the gate there.
  if (planIds && out.type !== 'appointment') {
    out.accessRule = {
      audience:            'members',
      requirePlan:         true,
      subscriptionTypeIds: [...planIds],
    }
    out.trialEnabled = true
  }

  // EVERY activity leaves in the derived shape, through the same mapping the
  // stage-5 backfill runs: a class that was not plan-gated keeps what its source
  // fields meant (hmd-lineup's `isFreeTrial` — false read as members-only, else
  // free to anyone) with `dropIn.mode` stated; the legacy `isFreeTrial` is
  // dropped; an appointment carries no access rule and no drop-in. HMD's
  // bookingSettings set no usual drop-in price, hence `null`.
  return activityDocForWrite(out as ClassAccessInput & Record<string, unknown>, null)
}
