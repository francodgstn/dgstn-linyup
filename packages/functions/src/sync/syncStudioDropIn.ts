// When the studio's default drop-in price changes, every class that FOLLOWS the
// studio has a new price — and the public mirror of each of them carries the
// RESOLVED price (see utils/dropIn.ts in @linyup/shared), so each mirror has to
// be rewritten. The activity documents themselves do not change: a class that
// follows the studio stores no price of its own, which is the whole point.
//
// Listens on the team's public profile document, where the booking settings
// live (booking/bookingSettings.ts). That document is rewritten often —
// `syncTeamPublicProfile` touches it on every team write — so the trigger
// compares the one field it cares about and returns before reading anything
// when it did not move.
import * as admin from 'firebase-admin'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { dropInModeOf, sameDropInPrice, studioDropInOf } from '@linyup/shared'
import { bookingSettingsFrom } from '../booking/bookingSettings'
import { buildActivityPublicProfile } from './syncActivityPublicProfile'

/** Firestore's per-batch ceiling. */
const BATCH_LIMIT = 400

export const syncStudioDropIn = onDocumentWritten(
  'teams/{teamId}/public_profile/{profileId}',
  async (event) => {
    const { teamId, profileId } = event.params
    // The booking settings live on the doc whose id IS the team id.
    if (teamId !== profileId) return

    const before = studioDropInOf(bookingSettingsFrom(event.data?.before.data()))
    const after = studioDropInOf(bookingSettingsFrom(event.data?.after.data()))
    if (sameDropInPrice(before, after)) return

    const db = admin.firestore()
    const activities = await db.collection('activities').where('teamId', '==', teamId).get()

    let batch = db.batch()
    let inBatch = 0
    let rewritten = 0
    for (const snap of activities.docs) {
      const data = snap.data()
      // The same exclusions the per-activity sync applies: a deactivated class
      // has no mirror to refresh, an appointment has no drop-in.
      if (data.isActive === false || data.type === 'appointment') continue
      // Only the classes that FOLLOW the studio changed price. A 'custom' or
      // 'off' class mirrors the same thing before and after.
      if (dropInModeOf(data.dropIn) !== 'studio') continue
      batch.set(
        snap.ref.collection('public_profile').doc(snap.id),
        buildActivityPublicProfile(data, after)
      )
      rewritten += 1
      inBatch += 1
      if (inBatch === BATCH_LIMIT) {
        await batch.commit()
        batch = db.batch()
        inBatch = 0
      }
    }
    if (inBatch > 0) await batch.commit()
    console.log(
      `[syncStudioDropIn] team=${teamId} default=${after ? after.priceAmount : 'none'} mirrors rewritten=${rewritten}`
    )
  }
)
