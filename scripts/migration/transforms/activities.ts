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
  // The field shape is the one `ActivityPricingForm` writes, deliberately:
  // `audience` + `requirePlan` are what the gate decides on, and `type` is the
  // display projection kept in step so no surface disagrees with them.
  //
  // CLASSES ONLY. `Activity.accessRule` is class-only by design — appointment
  // paths ignore it, and the price is the gate there.
  if (planIds && out.type !== 'appointment') {
    out.accessRule = {
      type:                'subscription',
      audience:            'members',
      requirePlan:         true,
      subscriptionTypeIds: [...planIds],
    }
    out.isFreeTrial  = false
    out.trialEnabled = true
  }

  return out
}
