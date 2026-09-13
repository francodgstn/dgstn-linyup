// QR-bill invoices — a numbered invoice with a Swiss QR-bill payment part for
// a member who pays by bank transfer; "mark as paid" records the manual payment
// through the same writer the Record-payment dialog uses. The claim BEFORE the
// payment; no reminders, no dunning, no bank-file reconciliation — the recorded
// exception to the "no AR" non-goal, and it stops here (docs/tarif-595.md,
// types/invoice.ts). Included from Coach with no add-on; remember the
// CLIENT_INSTALLABLE_FROM / clientInstallableRank pair. Creditor identity is
// the SHARED legal profile under Settings → Payments.

import type { PluginManifest } from '@linyup/shared'

export const qrInvoicesManifest: PluginManifest = {
  id: 'qr-invoices',
  nameKey: 'qrInvoicesName',
  descriptionKey: 'qrInvoicesDescription',
  category: 'commerce',
  minPlan: 'coach',
  status: 'beta',
  iconName: 'FileText',
  navContributions: [
    {
      href: '/plugins/qr-invoices',
      labelKey: 'qrInvoicesNavLabel',
      icon: 'FileText',
      section: 'manage',
    },
  ],
}
