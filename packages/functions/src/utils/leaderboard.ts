import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { to } from './async'
import {
  CONTACTS_COLLECTION,
  TEAMS_COLLECTION,
  TEAM_LEADERBOARD_SUBCOLLECTION,
  TEAM_LEADERBOARD_CURRENT_DOC,
  TEAM_LEADERBOARD_HISTORY_SUBCOLLECTION,
} from '@linyup/shared'

const MONTHLY_SCORES_SUBCOLLECTION = 'monthly_scores'

export async function updateTeamLeaderboard(teamId: string, month: string): Promise<void> {
  if (!teamId || !month) return
  const db = admin.firestore()

  const [queryErr, contactsSnap] = await to(
    db.collection(CONTACTS_COLLECTION)
      .where('teamId', '==', teamId)
      .where('deleted_at', '==', null)
      .where('current_month_score', '>', 0)
      .orderBy('current_month_score', 'desc')
      .limit(50)
      .get(),
  )
  if (queryErr) { console.error(`updateTeamLeaderboard query error:`, queryErr); return }

  const rawEntries = (contactsSnap?.docs ?? []).map((doc) => {
    const data = doc.data()
    return {
      contact_id: doc.id,
      firstname: (data.firstname as string) || '',
      lastname: (data.lastname as string) || '',
      // Denormalized so the student app can anonymise not-yet-joined (trial) members.
      acquisition_stage: (data.acquisition_stage as string) || '',
      score: (data.current_month_score as number) || 0,
      streak: (data.current_streak as number) || 0,
      max_streak: (data.max_streak as number) || 0,
    }
  })

  let currentRank = 1
  const entries = rawEntries.map((entry, index) => {
    if (index > 0 && entry.score < rawEntries[index - 1].score) currentRank = index + 1
    return { ...entry, rank: currentRank }
  })

  const scoreHistory: Record<string, Array<{ month: string; score: number }>> = {}
  for (const entry of entries) {
    const [histErr, histSnap] = await to(
      db.collection(CONTACTS_COLLECTION).doc(entry.contact_id)
        .collection(MONTHLY_SCORES_SUBCOLLECTION)
        .where('team_id', '==', teamId)
        .orderBy('month', 'desc')
        .limit(12)
        .get(),
    )
    if (!histErr && histSnap && !histSnap.empty) {
      scoreHistory[entry.contact_id] = histSnap.docs
        .map((d) => ({ month: d.data().month as string, score: (d.data().final_score as number) || 0 }))
        .reverse()
    }
  }

  const leaderboardRef = db.collection(TEAMS_COLLECTION).doc(teamId).collection(TEAM_LEADERBOARD_SUBCOLLECTION).doc(TEAM_LEADERBOARD_CURRENT_DOC)
  const [writeErr] = await to(
    leaderboardRef.set({
      month,
      entries,
      entries_count: entries.length,
      score_history: scoreHistory,
      updated_at: FieldValue.serverTimestamp(),
    }),
  )
  if (writeErr) console.error(`updateTeamLeaderboard write error:`, writeErr)
}

export async function incrementLeaderboardCounters(leaderId: string | null, top5Ids: string[]): Promise<void> {
  if (!top5Ids || top5Ids.length === 0) return
  const db = admin.firestore()
  for (const contactId of top5Ids) {
    const updates: Record<string, FieldValue> = {
      times_top5: FieldValue.increment(1),
    }
    if (contactId === leaderId) updates.times_leader = FieldValue.increment(1)
    const [err] = await to(db.collection(CONTACTS_COLLECTION).doc(contactId).update(updates))
    if (err) console.error(`incrementLeaderboardCounters error for ${contactId}:`, err)
  }
}

/**
 * Returns the leader and top-5 contact IDs for a given team+month,
 * derived from each contact's monthly_scores subcollection.
 */
export async function getMonthlyLeaderboardPositions(
  teamId: string,
  month: string
): Promise<{ leaderId: string | null; top5Ids: string[] }> {
  if (!teamId || !month) return { leaderId: null, top5Ids: [] }
  const db = admin.firestore()

  const [queryErr, contactsSnap] = await to(
    db.collection(CONTACTS_COLLECTION).where('teamId', '==', teamId).where('deleted_at', '==', null).get()
  )
  if (queryErr || !contactsSnap || contactsSnap.empty) return { leaderId: null, top5Ids: [] }

  const scored: Array<{ contactId: string; score: number }> = []
  for (const contactDoc of contactsSnap.docs) {
    const [msErr, msSnap] = await to(
      contactDoc.ref.collection(MONTHLY_SCORES_SUBCOLLECTION).where('month', '==', month).where('team_id', '==', teamId).limit(1).get()
    )
    if (!msErr && msSnap && !msSnap.empty) {
      const finalScore = (msSnap.docs[0].data().final_score as number) || 0
      if (finalScore > 0) scored.push({ contactId: contactDoc.id, score: finalScore })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return {
    leaderId: scored.length > 0 ? scored[0].contactId : null,
    top5Ids: scored.slice(0, 5).map((e) => e.contactId),
  }
}

/**
 * Snapshots ranked leaderboard data for a month into
 * teams/{teamId}/leaderboard_history/{YYYY-MM}.
 * Safe to call multiple times — overwrites.
 */
export async function snapshotLeaderboardHistory(teamId: string, month: string): Promise<void> {
  if (!teamId || !month) return
  const db = admin.firestore()

  const [queryErr, contactsSnap] = await to(
    db.collection(CONTACTS_COLLECTION).where('teamId', '==', teamId).where('deleted_at', '==', null).get()
  )
  if (queryErr || !contactsSnap || contactsSnap.empty) return

  const scored: Array<{ contact_id: string; score: number }> = []
  for (const contactDoc of contactsSnap.docs) {
    const [msErr, msSnap] = await to(
      contactDoc.ref.collection(MONTHLY_SCORES_SUBCOLLECTION).where('month', '==', month).where('team_id', '==', teamId).limit(1).get()
    )
    if (!msErr && msSnap && !msSnap.empty) {
      const finalScore = (msSnap.docs[0].data().final_score as number) || 0
      if (finalScore > 0) scored.push({ contact_id: contactDoc.id, score: finalScore })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  let currentRank = 1
  const entries = scored.map((entry, index) => {
    if (index > 0 && entry.score < scored[index - 1].score) currentRank = index + 1
    return { ...entry, rank: currentRank }
  })

  const histRef = db.collection(TEAMS_COLLECTION).doc(teamId).collection(TEAM_LEADERBOARD_HISTORY_SUBCOLLECTION).doc(month)
  const [writeErr] = await to(
    histRef.set({ month, entries, entries_count: entries.length, generated_at: FieldValue.serverTimestamp() })
  )
  if (writeErr) console.error(`snapshotLeaderboardHistory write error for ${teamId}/${month}:`, writeErr)
}

export async function clearTeamLeaderboard(teamId: string, month: string): Promise<void> {
  if (!teamId) return
  const db = admin.firestore()
  const leaderboardRef = db.collection(TEAMS_COLLECTION).doc(teamId).collection(TEAM_LEADERBOARD_SUBCOLLECTION).doc(TEAM_LEADERBOARD_CURRENT_DOC)
  const [writeErr] = await to(
    leaderboardRef.set({
      month,
      entries: [],
      entries_count: 0,
      score_history: {},
      updated_at: FieldValue.serverTimestamp(),
    }),
  )
  if (writeErr) console.error(`clearTeamLeaderboard write error:`, writeErr)
}
