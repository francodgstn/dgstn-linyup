import type { SubscriptionCancellationDetails } from '@linyup/shared'

export type WebhookEventType =
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.cancelled'
  | 'payment.succeeded'
  | 'payment.failed'

export interface WebhookEvent {
  type: WebhookEventType
  eventId: string           // gateway's unique event ID — used for idempotency
  teamId?: string
  orgId?: string
  customerId?: string
  subscriptionId?: string
  plan?: string
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  /**
   * The subscription is scheduled to end rather than renew — true for BOTH ways
   * a gateway can express that (a boolean flag, or a scheduled end instant). The
   * adapter normalizes; nobody downstream should have to know which it was.
   */
  cancelAtPeriodEnd?: boolean
  /** WHEN it ends, when the gateway said so explicitly. */
  cancelAt?: Date
  /** WHEN the cancellation was requested — the start of the notice period. */
  canceledAt?: Date
  /**
   * WHY it is ending. `null` means the gateway told us nothing; `undefined`
   * means the event does not carry the field at all, and the two are different:
   * `undefined` must never clear a stored record.
   *
   * `null` clears it only on a LIVE event (`subscription.created|updated`),
   * where it is what a reactivation uses to erase a dead reason. On
   * `subscription.cancelled` the handler clears nothing — a `deleted` payload
   * that states no reason must not erase the one an earlier `updated` recorded.
   * Both behaviors are pinned in connect/dahliaReads.test.ts.
   */
  cancellationDetails?: SubscriptionCancellationDetails | null
  amount?: number           // smallest currency unit (cents / rappen)
  currency?: string
  lastInvoiceId?: string
  lastPaymentStatus?: string
  // Subscription line items (present on subscription.created/updated) — used to
  // reconcile plugin add-ons. Each carries its Stripe item id + price lookup key.
  items?: Array<{ itemId: string; lookupKey?: string }>
  raw: unknown
}

export interface CheckoutSession {
  url: string
  sessionId: string
}

export interface Invoice {
  id: string
  amount: number            // smallest currency unit
  currency: string
  status: string
  created: Date
  hostedUrl?: string
  pdfUrl?: string
}

export interface GatewayAdapter {
  createCheckoutSession(params: {
    teamId?: string
    orgId?: string
    plan: string
    customerEmail: string
    successUrl: string
    cancelUrl: string
    idempotencyKey: string
  }): Promise<CheckoutSession>

  cancelSubscription(params: { subscriptionId: string }): Promise<void>

  parseWebhook(params: {
    payload: string | Buffer
    signature: string
    secret: string
  }): Promise<WebhookEvent>

  fetchInvoices(params: { customerId: string; limit?: number }): Promise<Invoice[]>
}
