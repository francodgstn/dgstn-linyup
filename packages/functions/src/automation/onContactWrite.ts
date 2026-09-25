// Tier 1 event trigger — fires automation rules in real-time when a contact document
// is created or has key fields updated.
//
// It also owns the two BILLING triggers (`subscription_cancel_requested`,
// `subscription_payment_failed`). They live here rather than in the Stripe
// webhook because the rollup already lands both facts on the contact document
// from every write path — see the note beside them in ./contactEvents.ts.
//
// The events themselves — plan added/removed/changed, cancel requested, payment
// failed — are computed by the pure `resolveContactEvents` (./contactEvents.ts),
// which diffs the contact's stored plan-list mirror.
//
// Trigger path: contacts/{contactId}
// Contacts are top-level with a teamId field — teamId is read from the document.
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { fireEventRules, type ContactData } from '../utils/automationEngine'
import { resolveContactEvents } from './contactEvents'

export const onContactWrite = onDocumentWritten(
  'contacts/{contactId}',
  async (event) => {
    const before = event.data?.before?.data()
    const after = event.data?.after?.data()

    const contactEvents = resolveContactEvents(before, after)
    if (contactEvents.length === 0) return

    const teamId = (after?.teamId || before?.teamId) as string | undefined
    if (!teamId) {
      console.log(`[onContactWrite] contact=${event.params.contactId}: no teamId, skipping`) // eslint-disable-line no-console
      return
    }

    // Skip deleted, archived or external contacts on update triggers — an
    // external buying a partner-app plan must not fire the welcome sequence.
    if (after && (after.deleted_at || after.archived_at || after.external)) return

    const contact: ContactData = {
      id: event.params.contactId,
      ...(after as Omit<ContactData, 'id'>),
    }

    for (const { triggerType, delta } of contactEvents) {
      console.log(`[onContactWrite] contact=${event.params.contactId} team=${teamId} trigger=${triggerType}${delta?.subscriptionTypeId ? ` subId=${delta.subscriptionTypeId}` : ''}`) // eslint-disable-line no-console
      // event.id is the CloudEvent id of this write — stable across a duplicate
      // delivery, and the occurrence half of a delayed rule's dedup key.
      await fireEventRules(teamId, triggerType, [contact], { eventId: event.id }, delta)
    }
  }
)
