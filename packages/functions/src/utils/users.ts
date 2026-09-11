// Ported from hmd-lineup/functions/src/utils/users.js
import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { format } from 'date-fns'
import { to } from './async'
import {
  countContactsByStage,
  countContactsBySubscriptionType,
  countContactsByRecurrence,
} from './contacts'

const TEAMS_COLLECTION = 'teams'
const WEEKLY_REPORTS_SUBCOLLECTION = 'weekly_reports'
import { withLedgerExpiry } from './ledgerRetention'

const ACTIVITY_LOG_SUBCOLLECTION = 'activity_log'
const ISO_WEEK_FORMAT = `R-'W'II`

/**
 * Finds the team weekly report document for a given date (by ISO week label).
 * Returns the Firestore snapshot (may be empty if none exists yet).
 */
export async function findTeamWeeklyReport(
  db: admin.firestore.Firestore,
  teamId: string,
  date: Date,
): Promise<admin.firestore.QuerySnapshot> {
  const isoWeek = format(date, ISO_WEEK_FORMAT)
  const [err, snap] = await to(
    db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(WEEKLY_REPORTS_SUBCOLLECTION)
      .where('iso_week', '==', isoWeek)
      .get(),
  )
  if (err || !snap) throw err ?? new Error('findTeamWeeklyReport: no snapshot')
  return snap
}

/**
 * Gets or creates the team weekly report document for a given date.
 * If a report already exists, returns its reference without overwriting.
 * If none exists, creates one with fresh contact counts and returns its reference.
 */
export async function getOrCreateTeamWeeklyReport(
  db: admin.firestore.Firestore,
  teamId: string,
  date: Date,
): Promise<admin.firestore.DocumentReference> {
  // Return existing report if present (never overwrite — incremental updates must be preserved)
  const existing = await findTeamWeeklyReport(db, teamId, date)
  if (!existing.empty) return existing.docs[0].ref

  // No report for this week — compute initial snapshot counts
  const [contactsByStage, contactsBySubType, contactsByRecurrence] =
    await Promise.all([
      countContactsByStage(db, teamId),
      countContactsBySubscriptionType(db, teamId),
      countContactsByRecurrence(db, teamId),
    ])

  // Sessions in the current week
  const weekStart = Timestamp.fromMillis(date.getTime() - 7 * 24 * 3600 * 1000)
  const [, sessionsSnap] = await to(
    db
      .collection('sessions')
      .where('teamId', '==', teamId)
      .where('start', '>=', weekStart)
      .where('start', '<=', Timestamp.fromDate(date))
      .get(),
  )

  const reportRef = db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(WEEKLY_REPORTS_SUBCOLLECTION)
    .doc()

  const [setErr] = await to(
    reportRef.set({
      iso_week: format(date, ISO_WEEK_FORMAT),
      teamId,
      contacts_count_by_stage: contactsByStage,
      contacts_count_by_subscription_type: contactsBySubType,
      contacts_count_by_recurrence: contactsByRecurrence,
      sessions_count: sessionsSnap?.size ?? 0,
      created_at: FieldValue.serverTimestamp(),
    }),
  )
  if (setErr) throw setErr

  console.log(`Created team weekly report for teamId: ${teamId}, week: ${format(date, ISO_WEEK_FORMAT)}`)
  return reportRef
}

/**
 * Writes an entry to the team's activity_log subcollection — with its
 * `expires_at`, so the TTL policy retires it (LEDGER_RETENTION_DAYS).
 */
export async function logActivity(teamId: string, logData: Record<string, unknown>): Promise<void> {
  const activityLogRef = admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(ACTIVITY_LOG_SUBCOLLECTION)
    .doc()

  const [createErr] = await to(activityLogRef.set(withLedgerExpiry('activity_log', logData)))
  if (createErr) {
    console.error('Error creating activity_log entry', createErr.message || createErr)
    throw createErr
  }
}
