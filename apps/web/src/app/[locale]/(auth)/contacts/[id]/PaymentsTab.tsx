'use client'

// The PAYMENTS segment of the "Plans & Payments" tab — this contact's payments
// across both rails (Connect member_payments + BYO payment_events), merged into
// one timeline. A manager can edit the comment or reassign the payment to another
// contact (same updatePaymentRecord callable as the general payments page).
//
// It no longer surfaces the Stripe recurring subscriptions: that section was
// rendered here AND on the Plans side, and now lives once, with Plans — see
// components/contacts/MemberSubscriptionsSection.tsx.

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CreditCard, FileText, Plus } from 'lucide-react'
import type { Contact } from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { useContactPayments } from '@/hooks/useConnect'
import {
  connectToUnified,
  byoToUnified,
  mergePaymentRows,
  formatMoneyMinor,
  type UnifiedPaymentRow,
} from '@/lib/payments'
import {
  AssignPaymentDialog,
  type AssignPaymentTarget,
} from '@/components/payments/AssignPaymentDialog'
import { RecordPaymentDialog } from '@/components/payments/RecordPaymentDialog'
import { VoidPaymentDialog } from '@/components/payments/VoidPaymentDialog'
import { RefundPaymentDialog } from '@/components/payments/RefundPaymentDialog'
import { useFinanceJournal } from '@/plugins/finance/hooks'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { PaymentsTable } from '@/components/payments/PaymentsTable'
import { CreateInvoiceDialog } from '@/plugins/qr-invoices/CreateInvoiceDialog'
import { InvoiceActions, InvoiceStatusBadge } from '@/plugins/qr-invoices/InvoiceActions'
import { useContactInvoices } from '@/plugins/qr-invoices/hooks'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'


// ─── main component ────────────────────────────────────────────────────────────

export function PaymentsTab({
  contact,
  teamId,
}: {
  contact: Contact & { id: string }
  teamId: string | null | undefined
}) {
  const t = useTranslations('PaymentsDashboard')
  const tInvoices = useTranslations('QrInvoices')
  const tid = teamId ?? null
  const { teamRole } = useAuth()
  const canManage = teamRole === 'owner' || teamRole === 'manager'
  const { data, isLoading } = useContactPayments(tid, contact.id)
  const [assignTarget, setAssignTarget] = useState<AssignPaymentTarget | null>(null)
  const [voidTarget, setVoidTarget] = useState<UnifiedPaymentRow | null>(null)
  const [refundTarget, setRefundTarget] = useState<UnifiedPaymentRow | null>(null)
  const { isInstalled } = useInstalledPlugins()
  const { data: journal } = useFinanceJournal(tid, null, isInstalled('finance'))
  const [recordOpen, setRecordOpen] = useState(false)
  const invoicesInstalled = isInstalled('qr-invoices')
  const [createInvoiceOpen, setCreateInvoiceOpen] = useState(false)
  const { data: invoices = [] } = useContactInvoices(tid, invoicesInstalled ? contact.id : null)
  const contactName = `${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim() || contact.email

  const rows = useMemo(
    () =>
      mergePaymentRows(connectToUnified(data?.payments ?? []), byoToUnified(data?.events ?? [])),
    [data]
  )

  if (isLoading) {
    return (
      <div className="p-5">
        <Skeleton className="h-24 rounded" />
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-5 space-y-6">
      {/* The "Stripe billing" section used to be repeated here, identical to the
          copy on the Plans segment — same hook, same heading, same freeze/resume/
          cancel buttons. It now lives once, with Plans, because it describes the
          recurring AGREEMENT (what will be billed next month) rather than money
          that has already moved. Its heading key `memberSubscriptionsHeading` is
          left unused in the locale files rather than deleted: the four message
          files are edited only through the _pending fragment contract, and there
          is no unused-key check to fail. */}

      {/* ── Payment history ── */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('paymentsHeading')}
        </p>
        <div className="flex items-center gap-2">
          {tid && invoicesInstalled && canManage && (
            <Button size="sm" variant="outline" onClick={() => setCreateInvoiceOpen(true)}>
              <FileText className="h-4 w-4 mr-1" />
              {tInvoices('createButton')}
            </Button>
          )}
          {tid && (
            <Button size="sm" variant="outline" onClick={() => setRecordOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('recordButton')}
            </Button>
          )}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          <CreditCard className="h-6 w-6 mx-auto mb-2 opacity-40" />
          {t('contactNoPayments')}
        </div>
      ) : (
        // Same table as the general /payments page, minus the (redundant)
        // contact column — one shared component so the two views never drift.
        //
        // WITH REFUND, since 2026-08-23. The component was already shared but
        // this mount left `onRefund` off, so the button simply did not render
        // here: a studio looking at the member whose charge they wanted to
        // reverse could see it and not act on it, and had to go and find the
        // same row again on /payments. Sharing a table is not sharing a
        // surface unless the actions come with it.
        <PaymentsTable
          rows={rows}
          // ALL TIME here, unlike the payments page: a contact's list is bounded
          // by one person's history, and windowing it would hide the very rows
          // somebody opened this tab to find.
          journal={journal}
          showContact={false}
          onAssign={setAssignTarget}
          onRefund={setRefundTarget}
          onVoid={setVoidTarget}
        />
      )}

      {/* ── QR-bill invoices ── the claim BEFORE a payment; only when the plugin
          is installed, and never for a contact page nobody manages. */}
      {tid && invoicesInstalled && (
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {tInvoices('invoicesTitle')}
          </p>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tInvoices('contactInvoicesEmpty')}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {invoices.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{inv.number}</span>
                      <InvoiceStatusBadge status={inv.status} />
                    </div>
                    {inv.description && (
                      <div className="truncate text-xs text-muted-foreground">{inv.description}</div>
                    )}
                    <div className="text-xs text-muted-foreground">{inv.due_on}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm font-medium tabular-nums">
                      {formatMoneyMinor(inv.amount_minor, inv.currency)}
                    </span>
                    <InvoiceActions teamId={tid} invoice={inv} canManage={canManage} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tid && (
        <AssignPaymentDialog
          teamId={tid}
          target={assignTarget}
          onClose={() => setAssignTarget(null)}
        />
      )}

      {tid && (
        <RefundPaymentDialog
          teamId={tid}
          target={refundTarget}
          memberName={`${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim() || contact.email}
          onClose={() => setRefundTarget(null)}
        />
      )}

      {tid && (
        <VoidPaymentDialog
          teamId={tid}
          target={voidTarget}
          memberName={`${contact.firstname ?? ''} ${contact.lastname ?? ''}`.trim() || contact.email}
          onClose={() => setVoidTarget(null)}
        />
      )}

      {tid && (
        <RecordPaymentDialog
          teamId={tid}
          open={recordOpen}
          onClose={() => setRecordOpen(false)}
          contactId={contact.id}
        />
      )}

      {tid && invoicesInstalled && (
        <CreateInvoiceDialog
          teamId={tid}
          contactId={contact.id}
          contactName={contactName}
          open={createInvoiceOpen}
          onOpenChange={setCreateInvoiceOpen}
        />
      )}
    </div>
  )
}
