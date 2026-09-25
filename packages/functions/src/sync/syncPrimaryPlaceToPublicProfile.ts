/**
 * Denormalises a team's places to its public_profile so public surfaces (which
 * only read the world-readable public_profile) can show them without reading
 * the private team_places collection. Two answers, both written here:
 *
 *   mainAddress  WHERE IS THE STUDIO. The primary place, for the bio-link's
 *                "Main Address" + map.
 *   places       WHERE IS THIS SESSION. Every place, by id, because a session
 *                mirror carries `placeId` and nothing that can name it. The
 *                booking funnel's place step reads the whole list at once.
 *
 * Both in ONE merge write, from one read of the collection: a second trigger on
 * the same path would interleave with this one's merge.
 *
 * Triggered on any write to teams/{teamId}/team_places/{placeId}. Picks the place
 * flagged isPrimary (else the first by order/name) and writes its public fields to
 * teams/{teamId}/public_profile/{teamId}.mainAddress (merge), or null when none.
 *
 * Mirrors syncProductsToPublicProfile: in-memory pick (no composite index) + a
 * merge write so sibling syncs (products, aggregator_subscription_types) aren't clobbered.
 */
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import * as admin from 'firebase-admin'
import { to } from '../utils/async'
import { TEAMS_COLLECTION, TEAM_PLACES_SUBCOLLECTION } from '@linyup/shared'

export const syncPrimaryPlaceToPublicProfile = onDocumentWritten(
  `${TEAMS_COLLECTION}/{teamId}/${TEAM_PLACES_SUBCOLLECTION}/{placeId}`,
  async (event) => {
    const { teamId } = event.params
    const db = admin.firestore()

    const publicProfileRef = db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection('public_profile')
      .doc(teamId)

    const [queryErr, snapshot] = await to(
      db.collection(TEAMS_COLLECTION).doc(teamId).collection(TEAM_PLACES_SUBCOLLECTION).get()
    )
    if (queryErr) {
      console.error(`Error fetching places for team ${teamId}:`, queryErr)
      throw queryErr
    }

    const docs = snapshot!.docs
    const primary =
      docs.find((d) => d.data().isPrimary === true) ??
      [...docs].sort((a, b) => {
        const ao = (a.data().order as number | undefined) ?? Number.MAX_SAFE_INTEGER
        const bo = (b.data().order as number | undefined) ?? Number.MAX_SAFE_INTEGER
        if (ao !== bo) return ao - bo
        return String(a.data().name ?? '').localeCompare(String(b.data().name ?? ''))
      })[0]

    const mainAddress = primary
      ? {
          name: (primary.data().name as string) ?? '',
          address: (primary.data().address as string | undefined) ?? null,
          mapsLink: (primary.data().mapsLink as string | undefined) ?? null,
        }
      : null

    // Sorted the way the studio ordered them, so every surface lists them the
    // same way and a place does not move between visits.
    const places = [...docs]
      .sort((a, b) => {
        const ao = (a.data().order as number | undefined) ?? Number.MAX_SAFE_INTEGER
        const bo = (b.data().order as number | undefined) ?? Number.MAX_SAFE_INTEGER
        if (ao !== bo) return ao - bo
        return String(a.data().name ?? '').localeCompare(String(b.data().name ?? ''))
      })
      .map((d) => ({
        id: d.id,
        name: (d.data().name as string) ?? '',
        address: (d.data().address as string | undefined) ?? null,
        mapsLink: (d.data().mapsLink as string | undefined) ?? null,
      }))

    const [updateErr] = await to(publicProfileRef.set({ mainAddress, places }, { merge: true }))
    if (updateErr) {
      console.error(`Error updating public profile (mainAddress) for team ${teamId}:`, updateErr)
      throw updateErr
    }

    console.log(
      `Synced mainAddress (${mainAddress ? 'set' : 'cleared'}) and ${places.length} place(s) for team ${teamId}`
    )
  }
)
