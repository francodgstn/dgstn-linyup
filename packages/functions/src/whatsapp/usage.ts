// What WhatsApp costs the studio this month — docs/whatsapp-outbound.md → "6e".
// Meta bills the studio directly; Linyup only counts, from the send log, the
// messages Meta confirmed and how it priced them (`wa_category`, written by the
// status webhook). The send log is denied to clients, hence a callable.
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { MAIL_SENDS_COLLECTION } from '@linyup/shared'
import { isTeamMember, requireCapability } from '../utils/teams'

const CATEGORIES = ['utility', 'marketing', 'service', 'authentication'] as const

/** The first instant of this month in the studio's clock. */
export function monthStartZurich(now: Date): Date {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit' })
    .format(now)
    .split('-')
    .map(Number)
  // Midnight Zurich is 22:00 or 23:00 UTC the day before; find it exactly.
  const guess = Date.UTC(y, m - 1, 1)
  const offsetH = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: 'numeric', hour12: false }).format(new Date(guess)),
  )
  return new Date(guess - offsetH * 3_600_000)
}

export const getWhatsAppUsage = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.')
  const teamId = (request.data as { teamId?: string })?.teamId
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required.')
  if (!(await isTeamMember(request.auth.uid, teamId))) {
    throw new HttpsError('permission-denied', 'You are not a member of this team.')
  }
  await requireCapability(request.auth.uid, teamId, 'outreach.manage')

  const since = Timestamp.fromDate(monthStartZurich(new Date()))
  const base = admin
    .firestore()
    .collection(MAIL_SENDS_COLLECTION)
    .where('team_id', '==', teamId)
    .where('channel', '==', 'whatsapp')
  const counts = await Promise.all(
    CATEGORIES.map(async (category) => {
      const snap = await base.where('wa_category', '==', category).where('created_at', '>=', since).count().get()
      return [category, snap.data().count] as const
    }),
  )
  return { since: since.toDate().toISOString(), byCategory: Object.fromEntries(counts) }
})
