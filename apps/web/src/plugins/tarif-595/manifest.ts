// Tarif 595 — Swiss health-insurance reimbursement receipts (Rückforderungsbeleg)
// in the Forum Datenaustausch XML 5.0 format, mandatory for label-certified
// health-promotion providers from 1 January 2027.
//
// A RECEIPT IS AN ATTESTATION, NEVER A MONEY EVENT: the plugin writes no finance
// journal row and prices nothing — it states what a member bought so their
// supplementary insurer can reimburse them. Full doc: docs/tarif-595.md.
//
// Included from Coach with no add-on (a solo yoga teacher with a Qualitop label
// needs it exactly as much as a fitness centre does); remember the
// CLIENT_INSTALLABLE_FROM / clientInstallableRank pair. Its creditor identity
// (name, address, IBAN, VAT) is the SHARED legal profile under Settings →
// Payments, not plugin config.

import type { PluginManifest } from '@linyup/shared'

export const tarif595Manifest: PluginManifest = {
  id: 'tarif-595',
  nameKey: 'tarif595Name',
  descriptionKey: 'tarif595Description',
  category: 'data',
  minPlan: 'coach',
  status: 'beta',
  iconName: 'HeartPulse',
  navContributions: [
    {
      href: '/plugins/tarif-595',
      labelKey: 'tarif595NavLabel',
      icon: 'HeartPulse',
      section: 'manage',
    },
  ],
}
