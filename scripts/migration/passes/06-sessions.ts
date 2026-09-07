import type { MigrationConfig } from '../config'
import { sourceDb, targetDb } from '../config'
import { BatchWriter } from '../batch-writer'
import { transformSession, transformParticipant, transformBooking } from '../transforms/sessions'
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore'

// Sessions in hmd-lineup may use teamId (new) or teacher (legacy) to identify
// the owning team. We fetch both and deduplicate by document ID.
async function fetchTeamSessions(
  teamId: string,
): Promise<Map<string, QueryDocumentSnapshot>> {
  const src = sourceDb()
  const map = new Map<string, QueryDocumentSnapshot>()

  const [byTeamId, byTeacher] = await Promise.all([
    src.collection('sessions').where('teamId',  '==', teamId).get(),
    src.collection('sessions').where('teacher', '==', teamId).get(),
  ])

  for (const d of byTeamId.docs)  map.set(d.id, d)
  for (const d of byTeacher.docs) map.set(d.id, d)   // deduplicates by ID

  return map
}

export async function pass06Sessions(
  cfg: MigrationConfig,
  teamIds: string[],
  activityMap: Map<string, { name: string; type: string }>,
): Promise<void> {
  console.log('Pass 6: sessions + participants + bookings')
  const tgt = targetDb()

  for (const teamId of teamIds) {
    if (cfg.fromTeam && teamId < cfg.fromTeam) continue

    const sessionDocs = await fetchTeamSessions(teamId)
    console.log(`  team ${teamId}: ${sessionDocs.size} sessions`)

    const bw = new BatchWriter(tgt, cfg.dryRun)

    for (const [, d] of sessionDocs) {
      const tgtRef = tgt.collection('sessions').doc(d.id)

      // Participants
      const partSnap = await sourceDb().collection('sessions').doc(d.id).collection('participants').get()
      for (const pd of partSnap.docs) {
        const pRef = tgt.collection('sessions').doc(d.id).collection('participants').doc(pd.id)
        if (!cfg.dryRun) {
          const existing = await pRef.get()
          if (existing.exists && !cfg.overwrite) { bw.skip(); continue }
        }
        // `checkedInAt` is the SESSION'S start: hmd-lineup recorded attendance as
        // the row's existence and no time at all. See `transformParticipant`.
        bw.set(
          pRef,
          transformParticipant(
            pd.id,
            pd.data() as Record<string, unknown>,
            teamId,
            d.id,
            (d.data() as Record<string, unknown>).start ?? null
          )
        )
      }

      // Bookings — always walk subcollection so post-migration bookings are picked up on re-runs
      const bookSnap = await sourceDb().collection('sessions').doc(d.id).collection('bookings').get()
      let bookingsCount = 0
      let trialBookingsCount = 0
      for (const bd of bookSnap.docs) {
        bookingsCount++
        if (bd.data().is_new_contact !== false) trialBookingsCount++
        const bRef = tgt.collection('sessions').doc(d.id).collection('bookings').doc(bd.id)
        if (!cfg.dryRun) {
          const existing = await bRef.get()
          if (existing.exists && !cfg.overwrite) { bw.skip(); continue }
        }
        bw.set(bRef, transformBooking(bd.id, bd.data() as Record<string, unknown>, teamId))
      }

      // Write session doc — skip if already exists but still update counts via merge
      if (!cfg.dryRun) {
        const existing = await tgtRef.get()
        // NOT under --overwrite, deliberately. `bookings_count` on a live
        // session is written by trackBookings from the bookings subcollection
        // (see CLAUDE.md → "ONE SEAT WRITER"); re-setting the whole doc from the
        // source would stamp a stale absolute count over the live one and can
        // resell a held seat. The counts merged here are the source's own.
        if (existing.exists) {
          bw.merge(tgtRef, { bookings_count: bookingsCount, trial_bookings_count: trialBookingsCount })
          continue
        }
      }

      // Ensure teamId is always set (legacy sessions may only have teacher)
      const data = d.data() as Record<string, unknown>
      if (!data.teamId) data.teamId = teamId

      bw.set(tgtRef, {
        ...transformSession(data, activityMap),
        bookings_count: bookingsCount,
        trial_bookings_count: trialBookingsCount,
      })
    }
    await bw.done()
  }
}
