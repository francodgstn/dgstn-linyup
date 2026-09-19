// ─── What Stripe still needs, in the owner's words ──────────────────────────────
// `ConnectAccount.requirements_currently_due` holds Stripe's MACHINE strings —
// `external_account`, `identity.individual.verification.document`,
// `defaults.profile.business_url` — which a studio owner can neither read nor
// act on. This turns them into a short list of plain-language KINDS of thing to
// provide; each surface renders a kind through its own translated copy.
//
// Why kinds rather than one label per string:
//   • Stripe asks field by field (`…date_of_birth.day`, `.month`, `.year`,
//     `…address.line1`, `.city`, …). The owner fills all of those on ONE screen of
//     Stripe's form, so listing them separately is noise. Near-duplicates group.
//   • The strings come in two spellings. The account is read through Accounts v2
//     (`utils/connect/client.ts`), whose entries name v2 paths
//     (`identity.business_details.address.city`), while an account touched by v1
//     tooling — or the same requirement described by Stripe's own v1 docs — says
//     `company.address.city`. Matching is on the meaningful SEGMENTS of the path,
//     so both spellings (and a prefix such as `person_abc.` or a v1
//     `{requirement_id}.` token) land in the same kind.
//   • An unrecognised string becomes `other` — ONE generic line however many
//     there are. The raw string is never meant to reach the owner: Stripe's
//     hosted form shows them exactly what is missing, which is why "Finish setup"
//     remains the way to act.
//
// Pure and client-safe. Fixtures: packages/functions/src/connect/connectRequirements.test.ts

export type ConnectRequirementKind =
  | 'bank_account'
  | 'id_document'
  | 'personal_id_number'
  | 'personal_details'
  | 'business_owners'
  | 'business_tax_id'
  | 'business_details'
  | 'business_type'
  | 'website'
  | 'statement_descriptor'
  | 'customer_support'
  | 'terms'
  | 'other'

/** Display order — roughly the order Stripe's form walks through, `other` last. */
export const CONNECT_REQUIREMENT_KINDS: readonly ConnectRequirementKind[] = [
  'business_type',
  'business_details',
  'business_tax_id',
  'website',
  'personal_details',
  'personal_id_number',
  'id_document',
  'business_owners',
  'bank_account',
  'statement_descriptor',
  'customer_support',
  'terms',
  'other',
]

/** Segments naming a person who is NOT the business itself. */
const PERSON_SEGMENTS = new Set([
  'individual',
  'representative',
  'owners',
  'directors',
  'executives',
  'person',
  'persons',
])
/** Segments naming the business itself (v1 `company`, v2 `business_details`). */
const BUSINESS_SEGMENTS = new Set(['company', 'business_details'])

/** Classify ONE Stripe requirement string. Never throws; unknown ⇒ `other`. */
export function connectRequirementKind(raw: string): ConnectRequirementKind {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return 'other'
  const parts = s.split('.')
  const has = (seg: string) => parts.includes(seg)
  const hasAny = (segs: readonly string[]) => segs.some(has)

  // Payouts. v1 and v2 both say `external_account`; the other spellings are
  // Stripe's bank-verification inquiries and v2 payout-destination paths.
  if (
    hasAny(['external_account', 'bank_account', 'bank_account_verification', 'default_outbound_destination']) ||
    s.includes('payout')
  ) {
    return 'bank_account'
  }

  // A photo of an ID or a supporting document — before the person/business
  // branches, which would otherwise swallow `individual.verification.document`.
  if (
    hasAny(['verification', 'document', 'additional_document', 'proof_of_liveness', 'identity_verification'])
  ) {
    return 'id_document'
  }

  if (hasAny(['terms_of_service', 'tos_acceptance'])) return 'terms'

  if (has('statement_descriptor') || has('statement_descriptor_prefix')) return 'statement_descriptor'

  if (hasAny(['support_phone', 'support_email', 'support_url', 'support_address', 'customer_support'])) {
    return 'customer_support'
  }

  if (hasAny(['url', 'business_url', 'url_inquiry', 'product_description'])) return 'website'

  if (hasAny(['mcc', 'business_type', 'structure', 'restricted_or_prohibited_industry_diligence'])) {
    return 'business_type'
  }

  // Who owns / runs the business. `persons_provided`, `owners_provided`,
  // `directors_provided`… are attestations that the list is complete.
  if (
    hasAny(['owners', 'directors', 'executives', 'persons_provided']) ||
    parts.some((p) => p.endsWith('_provided'))
  ) {
    return 'business_owners'
  }

  const isId = (p: string) =>
    p === 'id_number' || p === 'id_numbers' || p === 'tax_id' || p === 'vat_id' || p.startsWith('ssn')
  const isPerson = parts.some((p) => PERSON_SEGMENTS.has(p)) || /^person_/.test(parts[0])
  const isBusiness = parts.some((p) => BUSINESS_SEGMENTS.has(p))

  if (isBusiness && parts.some(isId)) return 'business_tax_id'
  if (isPerson && parts.some(isId)) return 'personal_id_number'
  if (isBusiness) return 'business_details'
  if (isPerson) return 'personal_details'
  if (has('business_profile') || has('profile')) return 'business_details'

  return 'other'
}

/**
 * The owner-facing list: each kind at most once, in display order. An empty or
 * missing input yields an empty list.
 */
export function connectRequirementKinds(
  requirements: readonly string[] | null | undefined
): ConnectRequirementKind[] {
  const found = new Set<ConnectRequirementKind>()
  for (const r of requirements ?? []) found.add(connectRequirementKind(r))
  return CONNECT_REQUIREMENT_KINDS.filter((k) => found.has(k))
}
