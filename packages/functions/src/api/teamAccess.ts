// ─── The per-team block on the public API ────────────────────────────────────
//
// docs/public-api.md → "Blocked tenants". Some studios must never hand out API
// credentials at all: the `/try` demo playground on sandbox has SHARED PUBLIC
// LOGINS, so anyone who opens the demo could mint a key and read (and bill) our
// Firestore through it for as long as they liked.
//
// The block sits where the plugin gate sits — at CREATION, never consumption:
// refuse to mint a key and refuse to approve an OAuth grant, and no credential
// exists for the principal resolver to accept later. Installing the plugin on
// such a team therefore changes nothing, which matters because a demo visitor
// signs in as the owner and can install it themselves.
//
// Lead tenants (`lead-*`) are deliberately NOT blocked: showing a prospect their
// own studio answering in Claude is the point of the demo.

import * as admin from 'firebase-admin'
import { HttpsError } from 'firebase-functions/v2/https'
import { TEAMS_COLLECTION, apiAccessBlocked, type Team } from '@linyup/shared'

/** Refuses when the team is flagged (`Team.api_access_blocked`). */
export async function assertApiAccessAllowed(teamId: string): Promise<void> {
  const snap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).get()
  if (!apiAccessBlocked(snap.data() as Team | undefined)) return
  throw new HttpsError('failed-precondition', 'This studio cannot use the public API', {
    reason: 'api_access_blocked',
  })
}
