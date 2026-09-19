import {
  CONNECT_REQUIREMENT_KINDS,
  connectRequirementKind,
  type ConnectRequirementKind,
} from '@linyup/shared'

// The operator console's view of what a studio's Stripe account still needs.
// The CLASSIFICATION is the shared one (`connectRequirementKind`) — the same
// grouping the studio sees on Settings → Payments, so an operator on a support
// call reads the lines the owner is reading. Only the words live here, because
// the console is English-only and the web app's copy sits in its message files.
//
// A `Record` over the kind union, so a new kind fails to compile until it has a
// label. Stripe's exact field names are kept per group for the operator.

const LABELS: Record<ConnectRequirementKind, string> = {
  bank_account: 'Bank account for payouts',
  id_document: 'ID photo or supporting document',
  personal_id_number: 'Personal ID number',
  personal_details: 'Personal details (name, date of birth, address)',
  business_owners: 'Owners or directors',
  business_tax_id: 'Business registration or VAT number',
  business_details: 'Business details (name, address, phone)',
  business_type: 'Type of business',
  website: 'Website or description of what they offer',
  statement_descriptor: 'Card statement name',
  customer_support: 'Customer contact details',
  terms: "Accept Stripe's terms",
  other: 'Other detail',
}

export interface ConnectRequirementGroup {
  kind: ConnectRequirementKind
  label: string
  /** Stripe's raw requirement strings in this group, as stored. */
  fields: string[]
}

export function groupConnectRequirements(
  requirements: readonly string[] | null | undefined
): ConnectRequirementGroup[] {
  const byKind = new Map<ConnectRequirementKind, string[]>()
  for (const r of requirements ?? []) {
    const kind = connectRequirementKind(r)
    byKind.set(kind, [...(byKind.get(kind) ?? []), r])
  }
  return CONNECT_REQUIREMENT_KINDS.filter((k) => byKind.has(k)).map((kind) => ({
    kind,
    label: LABELS[kind],
    fields: byKind.get(kind)!,
  }))
}
