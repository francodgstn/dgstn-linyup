// Tier 1 event trigger — fires automation rules in real-time when a Stripe Connect
// payment row changes: money received, money given back, money disputed.
//
// Trigger path: teams/{teamId}/member_payments/{paymentIntentId}
//
// It fires from the FIRESTORE WRITE, not from the Stripe webhook, which is the same
// choice every other trigger in this directory makes and here it buys something
// specific: the money handlers stay untouched, and every write path reaches automation
// — the webhook, the manager's `updatePaymentRecord`, a backfill. `connect/webhook.ts`
// and `connect/refunds.ts` are the highest-blast-radius files in the repo and this
// change does not open either of them.
//
// WHICH EDGES fire, and why each is keyed the way it is, is owned by the module header
// of `paymentEvents.ts`. This file is the plumbing: resolve, load the contact, dispatch.
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import * as admin from 'firebase-admin'
import { CONTACTS_COLLECTION, MEMBER_PAYMENTS_SUBCOLLECTION, TEAMS_COLLECTION } from '@linyup/shared'
import { fireEventRules, type ContactData } from '../utils/automationEngine'
import { resolvePaymentEvents } from './paymentEvents'

export const onMemberPaymentWrite = onDocumentWritten(
  `${TEAMS_COLLECTION}/{teamId}/${MEMBER_PAYMENTS_SUBCOLLECTION}/{paymentIntentId}`,
  async (event) => {
    const { teamId, paymentIntentId } = event.params
    const before = event.data?.before?.data()
    const after = event.data?.after?.data()

    const paymentEvents = resolvePaymentEvents(before, after, paymentIntentId, Date.now())
    if (paymentEvents.length === 0) return

    // Every event this resolver emits names the same contact (the one on the row), so
    // one read serves them all.
    const contactId = paymentEvents[0].contactId
    const snap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(contactId).get()
    if (!snap.exists) {
      console.log(`[onMemberPaymentWrite] pi=${paymentIntentId} contact=${contactId} not found`) // eslint-disable-line no-console
      return
    }
    const data = snap.data()!
    // A payment row carries a contactId the rules never checked — it is written by the
    // Admin SDK from Stripe metadata. Confirm the contact really belongs to this team
    // before running that team's rules against it.
    if (data.teamId !== teamId) {
      console.log(`[onMemberPaymentWrite] pi=${paymentIntentId} contact=${contactId} team mismatch`) // eslint-disable-line no-console
      return
    }
    // Same guard onContactWrite applies: a deleted, archived or external contact is not outreached.
    if (data.deleted_at || data.archived_at || data.external) return

    const contact: ContactData = { id: contactId, ...(data as Omit<ContactData, 'id'>) }

    for (const { triggerType, delta } of paymentEvents) {
      console.log(`[onMemberPaymentWrite] pi=${paymentIntentId} team=${teamId} contact=${contactId} trigger=${triggerType} kind=${delta.payment?.kind ?? '-'}`) // eslint-disable-line no-console
      // No `payload` here, deliberately — see the EventDelta docblock. The money facts
      // go in the delta so a delayed money rule keeps its delay.
      await fireEventRules(teamId, triggerType, [contact], { eventId: event.id }, delta)
    }
  }
)
