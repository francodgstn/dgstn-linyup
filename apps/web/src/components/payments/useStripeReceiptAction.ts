'use client'

// "Open Stripe receipt" — a contributed row action for the payments kebab, on
// the Connect rail only.
//
// It is CORE, not a plugin: the receipt belongs to the charge Linyup took, and
// every studio on Connect has one whether or not it installs anything.
//
// ── WHY IT FETCHES INSTEAD OF LINKING ───────────────────────────────────────
// There is no URL to put in an href. Stripe's hosted receipt link is not stored
// on the payment row and deliberately never will be — it expires 30 days after
// issue, so a stamped one is right for a month and quietly dead exactly when a
// studio wants it, at year end. `getPaymentReceiptUrl` reads it at the moment
// it is wanted; that file's header owns the reasoning, including why there is
// no "resend receipt" beside this.
//
// A popup blocker would eat the window if it were opened after the await, so
// the tab is opened FIRST, synchronously inside the click, and navigated when
// the URL lands. Closing it again is what a failure looks like — better than a
// stranded blank tab the manager has to notice and close.

import { useCallback, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Receipt } from 'lucide-react'
import { callFunction } from '@/lib/callFunction'
import type { UnifiedPaymentRow } from '@/lib/payments'
import type { PaymentRowAction } from '@/components/payments/PaymentsTable'

const callGetPaymentReceiptUrl = callFunction<
  { teamId: string; paymentIntentId: string },
  { receiptUrl: string | null; reason: 'ok' | 'no_charge' | 'no_receipt' }
>('getPaymentReceiptUrl')

/**
 * The action, or an empty list when there is no team — so a caller can spread it
 * unconditionally.
 *
 * `available` is the Connect rail and a live row. A BYO or manual row records
 * money that moved in the studio's OWN gateway and never touched Stripe from
 * here, so there is no receipt of ours to open; a voided record is inert
 * everywhere by the table's own rule.
 */
export function useStripeReceiptAction(teamId: string | null): PaymentRowAction[] {
  const t = useTranslations('PaymentsDashboard')
  const [busy, setBusy] = useState(false)

  const open = useCallback(
    async (row: UnifiedPaymentRow) => {
      if (!teamId || busy) return
      setBusy(true)
      const tab = window.open('', '_blank', 'noopener,noreferrer')
      try {
        const { data } = await callGetPaymentReceiptUrl({ teamId, paymentIntentId: row.paymentId })
        if (data.receiptUrl) {
          if (tab) tab.location.href = data.receiptUrl
          else window.open(data.receiptUrl, '_blank', 'noopener,noreferrer')
        } else {
          tab?.close()
          toast.info(t('stripeReceiptNone'))
        }
      } catch (err) {
        tab?.close()
        console.error('[payments] stripe receipt lookup failed:', err)
        toast.error(t('stripeReceiptError'))
      } finally {
        setBusy(false)
      }
    },
    [teamId, busy, t]
  )

  return useMemo(
    () =>
      teamId
        ? [
            {
              key: 'stripe-receipt',
              label: t('openStripeReceipt'),
              icon: Receipt,
              available: (row: UnifiedPaymentRow) => row.source === 'connect' && !row.voided,
              onSelect: (row: UnifiedPaymentRow) => void open(row),
            },
          ]
        : [],
    [teamId, t, open]
  )
}
