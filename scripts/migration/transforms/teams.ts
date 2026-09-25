import { ORG_ID } from '../config'

// HMD bio-link links use the old per-surface boolean flags; Linyup uses a single
// `target` page-link discriminator. Map them over (HMD only had booking/membership).
function migrateLinks(raw: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.map((l) => {
    const link = l as Record<string, unknown>
    const { isBookingLink, isMembershipLink, isCoursesLink, isShopLink, ...rest } = link
    const target = isBookingLink
      ? 'booking'
      : isMembershipLink
        ? 'signup'
        : isCoursesLink
          ? 'space'
          : isShopLink
            ? 'shop'
            : undefined
    return target ? { ...rest, target } : rest
  })
}

export function transformTeam(id: string, src: Record<string, unknown>): Record<string, unknown> {
  const links = migrateLinks(src.links)
  return {
    ...src,
    // SaaS fields — conservative defaults; adjust after billing setup
    plan: 'studio',
    plan_status: 'active',
    trial_ends_at: null,
    stripe_customer_id: null,
    // Organization link
    organizationId: ORG_ID,
    org_id: ORG_ID,
    // Defaults for new required fields
    sport_type: src.sport_type ?? 'Martial arts',
    language: src.language ?? 'de',
    // Bio-link links: map legacy is{...}Link booleans → `target` (override the spread).
    ...(links ? { links } : {}),
  }
}
