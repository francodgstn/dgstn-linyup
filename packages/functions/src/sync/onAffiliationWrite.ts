// Sync trigger: recomputes Contact.affiliation_summary whenever any affiliation
// doc under contacts/{contactId}/affiliations/{affiliationId} is written/deleted.
// Also fires delta-aware affiliation_added / affiliation_removed automation triggers
// (one event per type_key that changed), plus the legacy coarse affiliation_changed
// trigger for back-compat with existing rules.

import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { to } from '../utils/async'
import { fireEventRules, type ContactData, type EventDelta } from '../utils/automationEngine'
import {
  CONTACTS_COLLECTION,
  CONTACT_AFFILIATIONS_SUBCOLLECTION,
  type Affiliation,
  type AffiliationSummary,
} from '@linyup/shared'

export const onAffiliationWrite = onDocumentWritten(
  `${CONTACTS_COLLECTION}/{contactId}/${CONTACT_AFFILIATIONS_SUBCOLLECTION}/{affiliationId}`,
  async (event) => {
    const { contactId } = event.params

    // Determine teamId from the written data (after > before for deletes)
    const afterData = event.data?.after?.data() as Affiliation | undefined
    const beforeData = event.data?.before?.data() as Affiliation | undefined
    const teamId = (afterData?.teamId ?? beforeData?.teamId) as string | undefined

    if (!teamId) {
      console.log(`[onAffiliationWrite] contact=${contactId}: no teamId found, skipping`) // eslint-disable-line no-console
      return
    }

    const db = admin.firestore()

    // ── 1. Snapshot the PREVIOUS summary before recomputing ───────────────────
    // We read the contact doc once and reuse it for both the idempotency check
    // and the automation context below.
    const [, contactSnap] = await to(
      db.collection(CONTACTS_COLLECTION).doc(contactId).get(),
    )
    const contactData = contactSnap?.data()
    const existingSummary = contactData?.affiliation_summary as AffiliationSummary | undefined
    const previousTypes = new Set<string>(existingSummary?.types ?? [])

    // ── 2. Recompute affiliation_summary from all current affiliations ─────────
    const [snapErr, affiliationsSnap] = await to(
      db
        .collection(CONTACTS_COLLECTION)
        .doc(contactId)
        .collection(CONTACT_AFFILIATIONS_SUBCOLLECTION)
        .get(),
    )

    if (snapErr) {
      console.error(`[onAffiliationWrite] failed to load affiliations for ${contactId}:`, snapErr) // eslint-disable-line no-console
      return
    }

    const affiliations = (affiliationsSnap?.docs ?? []).map(
      (d) => d.data() as Affiliation,
    )

    const has_active = affiliations.some((a) => a.active === true)
    const types = [
      ...new Set(affiliations.map((a) => a.type_key).filter((k): k is string => Boolean(k))),
    ]
    const orgIssued = affiliations.filter((a) => a.issuer === 'org' && a.org_id)
    // EVER — every org that has ever put this person on its books.
    const org_ids = [...new Set(orgIssued.map((a) => a.org_id as string))]
    // NOW — the same list narrowed to affiliations that currently count. The two
    // are separate fields because they answer different questions and a
    // federation's headline numbers were reading the first as the second; see
    // `AffiliationSummary` in shared for the whole story.
    const active_org_ids = [
      ...new Set(orgIssued.filter((a) => a.active === true).map((a) => a.org_id as string)),
    ]

    const newSummary: AffiliationSummary = { has_active, types, org_ids, active_org_ids }
    const newTypes = new Set<string>(types)

    // Idempotent: only write if the summary actually changed
    const summaryChanged =
      !existingSummary ||
      existingSummary.has_active !== newSummary.has_active ||
      JSON.stringify([...newSummary.types].sort()) !==
        JSON.stringify([...(existingSummary.types ?? [])].sort()) ||
      JSON.stringify([...newSummary.org_ids].sort()) !==
        JSON.stringify([...(existingSummary.org_ids ?? [])].sort()) ||
      // Compared like the others, and it MUST be: an affiliation expiring is a
      // write that changes this list and nothing else on the summary, so an
      // omitted comparison would leave the count reading last season's answer
      // for as long as nobody touched that contact again.
      JSON.stringify([...active_org_ids].sort()) !==
        JSON.stringify([...(existingSummary.active_org_ids ?? [])].sort())

    if (summaryChanged) {
      const [updateErr] = await to(
        db.collection(CONTACTS_COLLECTION).doc(contactId).update({
          affiliation_summary: newSummary,
          updated_at: FieldValue.serverTimestamp(),
        }),
      )
      if (updateErr) {
        console.error(`[onAffiliationWrite] failed to update affiliation_summary for ${contactId}:`, updateErr) // eslint-disable-line no-console
      }
    }

    // ── 3. Fire automation triggers ───────────────────────────────────────────
    if (!contactData) return

    const contact: ContactData = {
      id: contactId,
      ...(contactData as Omit<ContactData, 'id'>),
      // Ensure the updated summary is reflected in the automation context
      affiliation_summary: newSummary,
    }

    // Delta events — one per type_key added or removed
    const addedKeys: string[] = []
    const removedKeys: string[] = []

    for (const key of newTypes) {
      if (!previousTypes.has(key)) addedKeys.push(key)
    }
    for (const key of previousTypes) {
      if (!newTypes.has(key)) removedKeys.push(key)
    }

    for (const key of addedKeys) {
      const delta: EventDelta = { affiliationTypeKey: key }
      console.log(`[onAffiliationWrite] contact=${contactId} team=${teamId} trigger=affiliation_added key=${key}`) // eslint-disable-line no-console
      await fireEventRules(teamId, 'affiliation_added', [contact], { eventId: event.id }, delta)
    }
    for (const key of removedKeys) {
      const delta: EventDelta = { affiliationTypeKey: key }
      console.log(`[onAffiliationWrite] contact=${contactId} team=${teamId} trigger=affiliation_removed key=${key}`) // eslint-disable-line no-console
      await fireEventRules(teamId, 'affiliation_removed', [contact], { eventId: event.id }, delta)
    }

    // Legacy coarse trigger — fires whenever the summary changed (any add or remove),
    // so existing 'affiliation_changed' rules keep working without migration.
    if (summaryChanged) {
      await fireEventRules(teamId, 'affiliation_changed', [contact], { eventId: event.id })
    }
  },
)
