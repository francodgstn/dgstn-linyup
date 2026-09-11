import * as admin from 'firebase-admin'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getTeamRole } from '../utils/teams'
import { to } from '../utils/async'
import { userFullName, type UserNameFields } from '@linyup/shared'

export interface TeamMemberRecord {
  userId: string
  role: string
  joined: string | null
  addedBy: string | null
  displayName: string | null
  email: string | null
  // Coach-roster membership. Absent on the doc ⇒ true (all members are coaches by
  // default); only an explicit `false` opts out. Always a definite boolean here.
  isCoach: boolean
}

// Returns the member list of a team with display names resolved from users/{uid}.
// Caller must be a member of the team (any role). User profiles are read via the
// Admin SDK because Firestore rules deny cross-user reads client-side
// (users/{userId} rule at line 221).
export const listTeamMembers = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')

  const { teamId } = request.data as { teamId?: string }
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  // Verify caller is a member of the team (any role sufficient for read).
  const [roleErr, callerRole] = await to(getTeamRole(request.auth.uid, teamId))
  if (roleErr) throw new HttpsError('internal', 'Failed to verify team membership')
  if (!callerRole) throw new HttpsError('permission-denied', 'You are not a member of this team')

  const db = admin.firestore()

  // Read the team_members subcollection.
  const [snapErr, snap] = await to(
    db.collection('teams').doc(teamId).collection('team_members').get()
  )
  if (snapErr || !snap) throw new HttpsError('internal', 'Failed to read team members')

  if (snap.empty) return { members: [] }

  // Bulk-fetch user profiles with getAll() — single RPC regardless of member count.
  const userRefs = snap.docs.map((d) => db.collection('users').doc(d.id))
  const [usersErr, userDocs] = await to(db.getAll(...userRefs))
  if (usersErr || !userDocs) throw new HttpsError('internal', 'Failed to read user profiles')

  // Index user docs by id for O(1) lookup below.
  const userById = new Map(userDocs.map((d) => [d.id, d]))

  const members: TeamMemberRecord[] = snap.docs.map((memberDoc) => {
    const m = memberDoc.data()
    const userDoc = userById.get(memberDoc.id)
    const u = userDoc?.exists ? userDoc.data()! : null

    // Firestore Timestamps — serialize to ISO string; null when absent.
    const joined = m.joined?.toDate?.()?.toISOString?.() ?? null

    return {
      userId: memberDoc.id,
      role: m.role as string,
      joined,
      addedBy: (m.addedBy as string | undefined) ?? null,
      // firstname+lastname first — a migrated account has those and no
      // `displayName`, which is why this page showed coaches by email.
      displayName: userFullName(u as UserNameFields | null),
      email: (u?.email as string | undefined) ?? null,
      isCoach: m.is_coach !== false, // absent ⇒ coach by default
    }
  })

  return { members }
})
