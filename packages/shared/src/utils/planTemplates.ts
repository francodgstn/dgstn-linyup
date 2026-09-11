/**
 * STARTER PLANS — the three shapes almost every studio ends up with, so the
 * first one is a click instead of a blank form.
 *
 * A studio opening Plans for the first time faces an empty rail and a dialog
 * asking for a name, a source, prices, recurrences and credits — none of which
 * mean anything until you have seen one. These are the shapes, not the prices:
 * a recurring membership billed monthly or yearly, a pack of classes, and the
 * comped plan every club gives somebody.
 *
 * ── NO AMOUNTS, DELIBERATELY ────────────────────────────────────────────────
 *
 * Every price lands at 0 and the studio types the real one. A plausible-looking
 * placeholder is worse than an obvious gap: 49.00 is a number somebody can fail
 * to notice, and the studio's own currency, market and tax position are things
 * this code cannot guess. A 0 price cannot reach a member either — `public`
 * stays absent (the pricing table is opt-in) and `payments_enabled` fails
 * closed without a chargeable Connect account.
 *
 * ── WHAT IS AND IS NOT EXPRESSED ────────────────────────────────────────────
 *
 * A pack is `one_time` + `credits` — the only shape that actually grants
 * lessons; `per_class` is a display recurrence with no door semantics (see
 * `SubscriptionRecurrence`) and no template uses it. Complimentary carries NO
 * prices at all, which is what "the studio charges nothing" means here — not a
 * price of zero, which would read as a free product somebody could buy.
 */
import type { SubscriptionPrice, SubscriptionType } from '../types/contact'

export type PlanTemplateId = 'membership' | 'class_pack' | 'complimentary'

export interface PlanTemplate {
  id: PlanTemplateId
  /** How many prices it creates, and of which recurrence — for the UI's summary. */
  priceRecurrences: SubscriptionPrice['recurrence'][]
  /** Lesson credits granted by the single one_time price, when it is a pack. */
  credits?: number
}

export const PLAN_TEMPLATES: readonly PlanTemplate[] = [
  { id: 'membership', priceRecurrences: ['monthly', 'annual'] },
  { id: 'class_pack', priceRecurrences: ['one_time'], credits: 10 },
  { id: 'complimentary', priceRecurrences: [] },
]

export function planTemplate(id: PlanTemplateId): PlanTemplate | undefined {
  return PLAN_TEMPLATES.find((t) => t.id === id)
}

/**
 * The document body a template writes — everything but the id, which Firestore
 * assigns.
 *
 * `name` and `description` come from the CALLER, already translated: copy lives
 * in the message files, and a studio renames the plan afterwards anyway.
 * `newPriceId` is injected rather than called here so this stays pure and
 * testable (the web passes `crypto.randomUUID`).
 */
export function buildPlanFromTemplate(opts: {
  template: PlanTemplate
  name: string
  description?: string
  /** Appended after the studio's existing plans. */
  order: number
  newPriceId: () => string
}): Omit<SubscriptionType, 'id'> {
  const { template, name, description, order, newPriceId } = opts
  const prices: SubscriptionPrice[] = template.priceRecurrences.map((recurrence) => ({
    id: newPriceId(),
    amount: 0,
    recurrence,
    ...(template.credits && recurrence === 'one_time' ? { credits: template.credits } : {}),
  }))
  return {
    name,
    ...(description ? { description } : {}),
    source: 'internal',
    active: true,
    order,
    // `public` is deliberately absent: the pricing table is opt-in, and a plan
    // with no real price must not be the thing that opts a studio in.
    ...(prices.length > 0 ? { prices } : {}),
  }
}
