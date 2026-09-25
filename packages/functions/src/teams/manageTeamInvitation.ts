// Ported from hmd-lineup/functions/src/manageTeamInvitation/index.js
// Manages team invitations (cancel action; resend is intentionally unsupported — cancel + re-send)
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { to } from '../utils/async'
import { getTeamRole } from '../utils/teams'

export const manageTeamInvitation = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated')
    }

    const callerId = request.auth.uid
    const { teamId, invitationId, action } = request.data as {
      teamId: string
      invitationId: string
      action: string
    }

    if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')
    if (!invitationId) throw new HttpsError('invalid-argument', 'invitationId is required')
    if (!action || !['cancel', 'resend'].includes(action)) {
      throw new HttpsError('invalid-argument', 'action must be one of: cancel, resend')
    }

    const [roleErr, callerRole] = await to(getTeamRole(callerId, teamId))
    if (roleErr) {
      console.error('Error getting caller role:', roleErr)
      throw new HttpsError('internal', 'Failed to verify permissions')
    }
    if (!callerRole) throw new HttpsError('permission-denied', 'You are not a member of this team')
    if (!(['owner', 'manager'] as const).includes(callerRole as 'owner' | 'manager')) {
      throw new HttpsError('permission-denied', 'Only team owners and managers can manage invitations')
    }

    const invitationRef = admin
      .firestore()
      .collection('teams')
      .doc(teamId)
      .collection('team_invitations')
      .doc(invitationId)

    const invitationDoc = await invitationRef.get()
    if (!invitationDoc.exists) throw new HttpsError('not-found', 'Invitation not found')

    const invitation = invitationDoc.data()!

    switch (action) {
      case 'cancel': {
        if (invitation.status !== 'pending') {
          throw new HttpsError(
            'failed-precondition',
            `Cannot cancel an invitation with status: ${invitation.status}`
          )
        }
        await invitationRef.update({
          status: 'cancelled',
          cancelledAt: FieldValue.serverTimestamp(),
          cancelledBy: callerId,
        })
        return { success: true, message: 'Invitation canceled successfully' }
      }

      case 'resend': {
        // Resend is intentionally unsupported — callers should cancel + sendTeamInvitation instead.
        // Keeping the action in the allowed list to avoid client-side breakage during transition.
        throw new HttpsError(
          'unimplemented',
          'Resend is not supported. Please cancel the existing invitation and send a new one.'
        )
      }

      default:
        throw new HttpsError('invalid-argument', 'Invalid action')
    }
  }
)
