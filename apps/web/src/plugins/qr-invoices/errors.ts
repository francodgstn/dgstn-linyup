'use client'

// Shared error → copy mapping for the qr-invoices callables (pattern:
// components/booking/GiftCardRedeemField.tsx's `giftCardCheckoutErrorMessage`).
// Every callable in this plugin refuses with `failed-precondition` + a
// `details.reason` the client is expected to explain in place — see
// CreateInvoiceDialog.tsx (legal_profile_incomplete) and InvoiceActions.tsx
// (invoice_not_open / invoice_already_paid) for where each reason surfaces.

import type { FunctionsError } from 'firebase/functions'
import type { useTranslations } from 'next-intl'

export type QrInvoiceErrorReason = 'legal_profile_incomplete' | 'invoice_not_open' | 'invoice_already_paid'

export function qrInvoiceErrorReason(err: unknown): QrInvoiceErrorReason | null {
  const fnErr = err as FunctionsError
  if (fnErr?.code !== 'functions/failed-precondition') return null
  const reason = (fnErr?.details as { reason?: string } | undefined)?.reason
  if (reason === 'legal_profile_incomplete' || reason === 'invoice_not_open' || reason === 'invoice_already_paid') {
    return reason
  }
  return null
}

/** Generic (toast-friendly) message for a reason. `legal_profile_incomplete` is
 *  handled separately by CreateInvoiceDialog, which renders an inline link
 *  instead — but the fallback text here is still valid if it were ever toasted. */
export function qrInvoiceErrorMessage(err: unknown, t: ReturnType<typeof useTranslations>): string {
  const reason = qrInvoiceErrorReason(err)
  if (reason === 'legal_profile_incomplete') return t('error.legalProfileIncomplete')
  if (reason === 'invoice_not_open') return t('error.invoiceNotOpen')
  if (reason === 'invoice_already_paid') return t('error.invoiceAlreadyPaid')
  return t('error.generic')
}
