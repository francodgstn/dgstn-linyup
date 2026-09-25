/* eslint-disable @typescript-eslint/no-explicit-any */
import Stripe from 'stripe'
import type { StripeGatewayConfig } from '@linyup/shared'
import type { GatewayAdapter, CheckoutSession, Invoice, WebhookEvent } from './interface'
// The SaaS rail reads the same fields Stripe moved on the Connect rail, and had
// the same three silent failures — an unset "next billing date" in the studio UI
// and the operator console, and a portal cancellation that left the studio being
// offered "Cancel subscription" a second time. See utils/stripe/objectShape.ts.
import {
  invoiceBillsSubscription,
  readInvoiceSubscriptionId,
  readOrReport,
  readSubscriptionCancellation,
  readSubscriptionPeriod,
  reportStripeShape,
  type StripeInvoiceObject,
  type StripeSubscriptionObject,
  type StripeWebhookPayload,
} from '../stripe/objectShape'

// InstanceType extracts the instance type from the callable constructor
type StripeInstance = InstanceType<typeof Stripe>

// Price lookup key convention: `linyup_${plan}_monthly`
// Configure these lookup keys in your Stripe dashboard.
function priceKeyForPlan(plan: string): string {
  return `linyup_${plan}_monthly`
}

export class StripeAdapter implements GatewayAdapter {
  private stripe: StripeInstance
  private config: StripeGatewayConfig

  private constructor(config: StripeGatewayConfig, secretKey: string) {
    this.config = config
    this.stripe = new Stripe(secretKey)
  }

  static withSecretKey(config: StripeGatewayConfig, secretKey: string): StripeAdapter {
    return new StripeAdapter(config, secretKey)
  }

  async createCheckoutSession(params: {
    teamId?: string
    orgId?: string
    plan: string
    customerEmail: string
    successUrl: string
    cancelUrl: string
    idempotencyKey: string
    // Add-on price lookup keys to bill alongside the plan (e.g. Coach carrying
    // trial add-ons into the paid subscription).
    addonLookupKeys?: string[]
  }): Promise<CheckoutSession> {
    const priceId = await this.resolvePriceByLookupKey(priceKeyForPlan(params.plan))

    const addonPriceIds = await Promise.all(
      (params.addonLookupKeys ?? []).map((k) => this.resolvePriceByLookupKey(k)),
    )

    const entityMeta: Record<string, string> = { plan: params.plan }
    if (params.teamId) entityMeta.teamId = params.teamId
    if (params.orgId) entityMeta.orgId = params.orgId

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer_email: params.customerEmail,
        line_items: [
          { price: priceId, quantity: 1 },
          ...addonPriceIds.map((id) => ({ price: id, quantity: 1 })),
        ],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata: entityMeta,
        subscription_data: { metadata: entityMeta },
      },
      { idempotencyKey: params.idempotencyKey }
    )

    if (!session.url) throw new Error('Stripe checkout session URL missing')
    return { url: session.url, sessionId: session.id }
  }

  private async resolvePriceByLookupKey(lookupKey: string): Promise<string> {
    const prices = await this.stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })
    if (!prices.data.length) {
      throw new Error(`No Stripe price found for lookup key: ${lookupKey}`)
    }
    return prices.data[0].id
  }

  /** Add a subscription item (add-on, or quantity-based overage) to a subscription. */
  async addSubscriptionItem(params: { subscriptionId: string; lookupKey: string; quantity?: number }): Promise<{ itemId: string }> {
    const priceId = await this.resolvePriceByLookupKey(params.lookupKey)
    const item = await this.stripe.subscriptionItems.create({
      subscription: params.subscriptionId,
      price: priceId,
      quantity: params.quantity ?? 1,
      proration_behavior: 'create_prorations',
    })
    return { itemId: item.id }
  }

  /** Update a subscription item's quantity (overage count changes). */
  async updateSubscriptionItemQuantity(params: { itemId: string; quantity: number }): Promise<void> {
    await this.stripe.subscriptionItems.update(params.itemId, {
      quantity: params.quantity,
      proration_behavior: 'create_prorations',
    })
  }

  /** Remove a subscription item (add-on deactivation, or overage back to zero). */
  async removeSubscriptionItem(params: { itemId: string }): Promise<void> {
    await this.stripe.subscriptionItems.del(params.itemId, {
      proration_behavior: 'create_prorations',
    })
  }

  async cancelSubscription(params: { subscriptionId: string }): Promise<void> {
    await this.stripe.subscriptions.update(params.subscriptionId, {
      cancel_at_period_end: true,
    })
  }

  async reactivateSubscription(params: { subscriptionId: string }): Promise<void> {
    // ONE PARAMETER, NEVER BOTH. Stripe rejects the pair outright:
    //
    //   update{cancel_at_period_end:false, cancel_at:''}
    //     → invalid_request_error "Received both cancel_at_period_end and
    //       cancel_at parameters. Please pass in only one."
    //
    // so sending both does not "clear whichever one expressed it", it fails
    // every reactivation — the studio stays canceled and the callable throws.
    //
    // `cancel_at_period_end: false` alone is sufficient for BOTH expressions.
    // Verified on a live Stripe test account (2026-04-22.dahlia): from an
    // API cancel, from an explicit `cancel_at: <timestamp>` (the billing-portal
    // shape), and from `cancel_at: 'max_period_end'`, this single parameter
    // comes back with cancel_at, canceled_at AND cancellation_details all
    // cleared. It is also the exact inverse of `cancelSubscription` above, which
    // is the property worth keeping: the two cannot drift apart.
    await this.stripe.subscriptions.update(params.subscriptionId, {
      cancel_at_period_end: false,
    })
  }

  async createBillingPortalSession(params: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: params.customerId,
      return_url: params.returnUrl,
    })
    return { url: session.url }
  }

  async parseWebhook(params: {
    payload: string | Buffer
    signature: string
    secret: string
  }): Promise<WebhookEvent> {
    let event: any
    try {
      event = await this.stripe.webhooks.constructEventAsync(
        params.payload,
        params.signature,
        params.secret
      )
    } catch (err) {
      throw new Error(`Webhook signature verification failed: ${(err as Error).message}`)
    }

    return this.mapStripeEvent(event)
  }

  /**
   * Derive the plan name from the subscription's price lookup key.
   * This is reliable even when the subscription is modified from the Stripe
   * portal, which changes the price but does NOT update subscription metadata.
   * Falls back to metadata.plan (set at checkout creation) for backwards compat.
   *
   * Lookup key convention: linyup_{plan}_monthly  →  plan = 'coach' | 'studio' | 'organization'
   */
  private extractPlanFromSubscription(
    sub: StripeWebhookPayload<StripeSubscriptionObject>
  ): string | undefined {
    const items = sub.items?.data ?? []
    if (items.length > 0) {
      const lookupKey = items[0]?.price?.lookup_key as string | undefined
      if (lookupKey) {
        const match = lookupKey.match(/^linyup_(.+)_monthly$/)
        if (match) return match[1]
      }
    }
    // Fallback: metadata set at checkout time (stale after portal plan changes)
    return sub.metadata?.plan as string | undefined
  }

  private extractItems(
    sub: StripeWebhookPayload<StripeSubscriptionObject>
  ): Array<{ itemId: string; lookupKey?: string }> {
    const items = sub.items?.data ?? []
    return items.map((it) => ({
      itemId: it.id as string,
      lookupKey: (it.price?.lookup_key as string | undefined) ?? undefined,
    }))
  }

  /**
   * The subscription lifecycle fields, from wherever the current API version
   * keeps them. Shared by created/updated so the two can never disagree.
   */
  private subscriptionLifecycle(
    obj: StripeWebhookPayload<StripeSubscriptionObject>,
    eventId: string
  ) {
    const period = readSubscriptionPeriod(obj)
    // An ENDED subscription has no current period — that absence is the truth,
    // not a shape surprise.
    if (obj.status !== 'canceled' && obj.status !== 'incomplete_expired') {
      reportStripeShape('subscription.current_period_end', obj.id, period.source, `event ${eventId}`)
    }
    return {
      currentPeriodStart: period.start === null ? undefined : new Date(period.start * 1000),
      currentPeriodEnd: period.end === null ? undefined : new Date(period.end * 1000),
      ...this.cancellation(obj),
    }
  }

  /**
   * The cancellation record. Split out from `subscriptionLifecycle` because
   * `customer.subscription.deleted` needs it WITHOUT the period (an ended
   * subscription has no current period, and reporting its absence would cry wolf
   * on every cancellation) — and that event is the one carrying the final reason.
   *
   * `cancellationDetails` is always present in the returned object, `null`
   * included: null is what CLEARS a stored record on reactivation, and an
   * omitted key would leave the old one standing.
   */
  private cancellation(obj: StripeWebhookPayload<StripeSubscriptionObject>) {
    const c = readSubscriptionCancellation(obj)
    return {
      cancelAtPeriodEnd: c.cancelsAtPeriodEnd,
      cancelAt: c.cancelAt === null ? undefined : new Date(c.cancelAt * 1000),
      canceledAt: c.canceledAt === null ? undefined : new Date(c.canceledAt * 1000),
      cancellationDetails: c.details,
    }
  }

  /**
   * The subscription an invoice bills for. `invoice.subscription` is gone; the
   * link hangs off `parent` now. A one-off invoice has none by design and is not
   * reported as a surprise.
   */
  private invoiceSubscriptionId(
    obj: StripeWebhookPayload<StripeInvoiceObject>,
    eventId: string
  ): string | undefined {
    const read = readInvoiceSubscriptionId(obj)
    if (invoiceBillsSubscription(obj)) {
      readOrReport(read, 'invoice.subscription', obj.id, `event ${eventId}`)
    }
    return read.value ?? undefined
  }

  private mapStripeEvent(event: any): WebhookEvent {
    const base = { eventId: event.id as string, raw: event }
    const obj = event.data?.object ?? {}

    switch (event.type as string) {
      case 'customer.subscription.created':
        return {
          ...base,
          type: 'subscription.created',
          customerId: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id,
          subscriptionId: obj.id as string,
          teamId: obj.metadata?.teamId as string | undefined,
          orgId: obj.metadata?.orgId as string | undefined,
          plan: this.extractPlanFromSubscription(obj),
          items: this.extractItems(obj),
          ...this.subscriptionLifecycle(obj, base.eventId),
        }

      case 'customer.subscription.updated':
        return {
          ...base,
          type: 'subscription.updated',
          customerId: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id,
          subscriptionId: obj.id as string,
          teamId: obj.metadata?.teamId as string | undefined,
          orgId: obj.metadata?.orgId as string | undefined,
          plan: this.extractPlanFromSubscription(obj),
          items: this.extractItems(obj),
          ...this.subscriptionLifecycle(obj, base.eventId),
        }

      case 'customer.subscription.deleted':
        return {
          ...base,
          type: 'subscription.cancelled',
          customerId: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id,
          subscriptionId: obj.id as string,
          teamId: obj.metadata?.teamId as string | undefined,
          orgId: obj.metadata?.orgId as string | undefined,
          // The moment a studio actually leaves is the moment its reason matters
          // most, and this payload carries it. Without this the operator console
          // can only say a studio is gone, never whether it chose to go.
          ...this.cancellation(obj),
        }

      // `invoice.subscription` is gone; the link hangs off `parent` now. Nothing
      // in saas-billing/ consumes subscriptionId on these two branches today —
      // but the WebhookEvent contract promises it, and a contract that quietly
      // lies is the next reader's bug.
      case 'invoice.payment_succeeded':
        return {
          ...base,
          type: 'payment.succeeded',
          customerId: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id,
          subscriptionId: this.invoiceSubscriptionId(obj, base.eventId),
          amount: obj.amount_paid as number,
          currency: obj.currency as string,
          lastInvoiceId: obj.id as string,
          lastPaymentStatus: 'succeeded',
        }

      case 'invoice.payment_failed':
        return {
          ...base,
          type: 'payment.failed',
          customerId: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id,
          subscriptionId: this.invoiceSubscriptionId(obj, base.eventId),
          amount: obj.amount_due as number,
          currency: obj.currency as string,
          lastInvoiceId: obj.id as string,
          lastPaymentStatus: 'failed',
        }

      default:
        return { ...base, type: 'subscription.updated' }
    }
  }

  async fetchInvoices(params: { customerId: string; limit?: number }): Promise<Invoice[]> {
    const invoices = await this.stripe.invoices.list({
      customer: params.customerId,
      limit: params.limit ?? 10,
    })

    return invoices.data.map((inv: any) => ({
      id: inv.id as string,
      amount: inv.amount_paid as number,
      currency: inv.currency as string,
      status: (inv.status ?? 'unknown') as string,
      created: new Date((inv.created as number) * 1000),
      hostedUrl: inv.hosted_invoice_url ?? undefined,
      pdfUrl: inv.invoice_pdf ?? undefined,
    }))
  }
}
