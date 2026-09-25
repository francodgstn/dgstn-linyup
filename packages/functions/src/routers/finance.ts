// The studio's finance desk, behind one function: the accounting journal, the
// monthly export, QR invoices and Tarif 595 receipts, and the STAFF side of member
// payments — Connect onboarding, subscriptions, refunds, manual payments, gift
// cards and promo codes. (What a MEMBER calls to pay is Phase 3, not here.) Staff-only and low
// traffic, and the first router with real studio traffic behind it
// (docs/functions-consolidation-plan.md → "Phase 2").
//
// WHO IS NOT HERE, on purpose:
//   - `rebuildAccountingLedger` and `startTarif595BulkIssue` run for minutes.
//     The ROUTER's timeout governs, so they belong with the other long jobs
//     rather than stretching this one's timeout for every quick call beside them.
//   - `listMyTarif595Receipts` is the MEMBER's own copy, called from the Space
//     with a contact session — a different audience and a different blast radius.
//
// Every member ALSO stays exported standalone from src/index.ts until its alias
// is provably unused (utils/frozenFunctions.test.ts says why). Authorization is
// each member's own; the router adds none and removes none. This module must
// NOT call `setGlobalOptions` — src/index.ts owns it.

import { callableRouter } from '../utils/callableRouter'
import { exportFinanceReport } from '../finance/exportReport'
import { createManualEntry, reverseEntry } from '../accounting/manualEntries'
import { closeFiscalYear } from '../accounting/close'
import { setChartTemplate } from '../accounting/settings'
import {
  createInvoice,
  voidInvoice,
  downloadInvoice,
  emailInvoice,
  markInvoicePaid,
} from '../invoices'
import {
  previewTarif595Receipt,
  issueTarif595Receipt,
  voidTarif595Receipt,
  downloadTarif595Receipt,
  emailTarif595Receipt,
  suggestTarif595Mappings,
} from '../tarif595'
import { disconnectConnectAccount, getConnectStatus, startConnectOnboarding } from '../connect'
import { issueGiftCard, voidGiftCard } from '../connect/giftCards'
import {
  cancelMemberSubscription,
  createMemberPayment,
  createMembershipPayment,
  createMemberSubscription,
  pauseMemberSubscription,
  resumeMemberSubscription,
} from '../connect/payments'
import {
  clearPromoRedemption,
  createPromoCode,
  releasePromoReservations,
  setPromoCodeStatus,
  updatePromoCode,
} from '../connect/promoCodes'
import { getPaymentReceiptUrl } from '../connect/receiptUrl'
import { refundMemberPayment } from '../connect/refunds'
import { updatePaymentRecord } from '../connect/updatePayment'
import { recordManualPayment } from '../payments/recordManualPayment'
import { voidManualPayment } from '../payments/voidManualPayment'

export const rpcFinance = callableRouter(
  'rpcFinance',
  {
    // The max of the members': `suggestTarif595Mappings` asks for 512MiB and
    // 120s (it waits on a model), and the PDF renders want the headroom too.
    memory: '512MiB',
    timeoutSeconds: 120,
    // A router's ceiling is concurrency × maxInstances for its WHOLE domain.
    // Finance is a few staff per studio, a few times a day; the global
    // maxInstances is plenty, so only the concurrency is stated.
    cpu: 1,
    concurrency: 40,
  },
  {
    exportFinanceReport,
    createManualEntry,
    reverseEntry,
    closeFiscalYear,
    setChartTemplate,
    createInvoice,
    voidInvoice,
    downloadInvoice,
    emailInvoice,
    markInvoicePaid,
    previewTarif595Receipt,
    issueTarif595Receipt,
    voidTarif595Receipt,
    downloadTarif595Receipt,
    emailTarif595Receipt,
    suggestTarif595Mappings,
    cancelMemberSubscription,
    clearPromoRedemption,
    createMemberPayment,
    createMembershipPayment,
    createMemberSubscription,
    createPromoCode,
    disconnectConnectAccount,
    getConnectStatus,
    issueGiftCard,
    pauseMemberSubscription,
    refundMemberPayment,
    getPaymentReceiptUrl,
    releasePromoReservations,
    resumeMemberSubscription,
    setPromoCodeStatus,
    startConnectOnboarding,
    updatePaymentRecord,
    updatePromoCode,
    voidGiftCard,
    recordManualPayment,
    voidManualPayment,
  }
)
