import assert from 'node:assert/strict'
import {
  CONNECT_REQUIREMENT_KINDS,
  connectRequirementKind,
  connectRequirementKinds,
  type ConnectRequirementKind,
} from '@linyup/shared'

// Fixtures for the ONE mapping from Stripe's requirement strings to the kinds
// the Settings → Payments card names in the owner's words. Each row states a
// real string — both the Accounts v2 path we store and its v1 spelling — so a
// rename on either side fails here rather than as a generic line on screen.

const ROWS: Array<[string, ConnectRequirementKind]> = [
  // Payouts
  ['external_account', 'bank_account'],
  ['bank_account_verification', 'bank_account'],
  // ID photos / documents — before the person branch would claim them
  ['individual.verification.document', 'id_document'],
  ['identity.individual.verification.document', 'id_document'],
  ['individual.verification.additional_document', 'id_document'],
  ['person_1Abc.verification.document', 'id_document'],
  ['company.verification.document', 'id_document'],
  ['representative.verification.document', 'id_document'],
  // Personal details (v1 and v2)
  ['individual.first_name', 'personal_details'],
  ['identity.individual.given_name', 'personal_details'],
  ['identity.individual.date_of_birth.day', 'personal_details'],
  ['individual.dob.year', 'personal_details'],
  ['identity.individual.address.line1', 'personal_details'],
  ['representative.email', 'personal_details'],
  ['representative.relationship.title', 'personal_details'],
  // Personal ID numbers
  ['individual.ssn_last_4', 'personal_id_number'],
  ['identity.individual.id_numbers.us_ssn_last_4', 'personal_id_number'],
  ['individual.id_number', 'personal_id_number'],
  ['representative.id_numbers.us_ssn_last_4', 'personal_id_number'],
  // The business
  ['company.name', 'business_details'],
  ['identity.business_details.registered_name', 'business_details'],
  ['identity.business_details.address.city', 'business_details'],
  ['company.phone', 'business_details'],
  ['company.tax_id', 'business_tax_id'],
  ['identity.business_details.id_numbers.us_ein', 'business_tax_id'],
  ['company.vat_id', 'business_tax_id'],
  ['business_type', 'business_type'],
  ['business_profile.mcc', 'business_type'],
  ['configuration.merchant.mcc', 'business_type'],
  // Owners and directors
  ['owners.first_name', 'business_owners'],
  ['owners.surname', 'business_owners'],
  ['directors.dob.day', 'business_owners'],
  ['company.owners_provided', 'business_owners'],
  ['identity.attestations.persons_provided.owners', 'business_owners'],
  // Website
  ['business_profile.url', 'website'],
  ['defaults.profile.business_url', 'website'],
  ['business_profile.product_description', 'website'],
  // Statement, support, terms
  ['settings.payments.statement_descriptor', 'statement_descriptor'],
  ['configuration.merchant.statement_descriptor.descriptor', 'statement_descriptor'],
  ['business_profile.support_phone', 'customer_support'],
  ['tos_acceptance.date', 'terms'],
  ['identity.attestations.terms_of_service.account.ip', 'terms'],
  // Unknown ⇒ generic, never the raw string
  ['something.stripe.invents.tomorrow', 'other'],
  ['', 'other'],
]

describe('connectRequirementKind', () => {
  for (const [raw, kind] of ROWS) {
    it(`${raw || '(empty)'} → ${kind}`, () => {
      assert.equal(connectRequirementKind(raw), kind)
    })
  }
})

describe('connectRequirementKinds', () => {
  it('groups near-duplicates into one line each, in display order', () => {
    assert.deepEqual(
      connectRequirementKinds([
        'external_account',
        'identity.individual.date_of_birth.day',
        'identity.individual.date_of_birth.month',
        'identity.individual.date_of_birth.year',
        'defaults.profile.business_url',
        'identity.individual.verification.document',
      ]),
      ['website', 'personal_details', 'id_document', 'bank_account']
    )
  })

  it('collapses any number of unknown strings into ONE generic line, last', () => {
    assert.deepEqual(connectRequirementKinds(['x.y', 'z', 'external_account']), [
      'bank_account',
      'other',
    ])
  })

  it('is empty for nothing due', () => {
    assert.deepEqual(connectRequirementKinds([]), [])
    assert.deepEqual(connectRequirementKinds(undefined), [])
    assert.deepEqual(connectRequirementKinds(null), [])
  })

  it('orders every kind exactly once', () => {
    assert.equal(new Set(CONNECT_REQUIREMENT_KINDS).size, CONNECT_REQUIREMENT_KINDS.length)
    assert.equal(CONNECT_REQUIREMENT_KINDS[CONNECT_REQUIREMENT_KINDS.length - 1], 'other')
  })
})
