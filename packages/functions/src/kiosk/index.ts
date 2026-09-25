// Kiosk mode — entrance-tablet PIN unlock.
//
// A team's kiosk tablet is a shared, public device: it never signs in as a
// contact. This callable resolves the team by slug, verifies the kiosk plugin
// is installed + PIN-locked, timing-safe compares the submitted PIN, and mints
// a custom token that identifies the caller as a KIOSK DEVICE (`kiosk: true`,
// `kioskTeam`, `kioskEpoch`) — never a `contactId` claim.
//
// The public booking callables (`bookSession`, `bookAppointment`) DO read
// `request.auth`, to honor a signed-in contact session. A kiosk token can never
// be mistaken for one: `optionalContactSessionFromRequest` requires both a
// `contactId` and a `teamId` claim, and this token deliberately carries neither
// (its team is namespaced as `kioskTeam`). So a kiosk-signed-in caller still
// books exactly like an anonymous walk-in guest — the intended behavior. Keep
// it that way: never add `contactId`/`teamId` claims to this token.
import * as admin from 'firebase-admin'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import type { KioskConfig } from '@linyup/shared'
import { timingSafeEqualStr } from '../utils/secureCompare'
import { bucketRateLimit } from '../utils/rateLimit'
import { resolveActivePluginInstall } from '../utils/plugins'

const UNLOCK_RATE_LIMIT_MAX = 10
const UNLOCK_RATE_WINDOW_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Resolve a public tenant slug → teamId via the `public_profile` collection-group
 * query — the same pattern used by the other public callables (see
 * `sessions/index.ts` selfCheckIn). Never query the main `teams` collection by
 * slug from a public-facing callable.
 */
async function resolveTeamIdBySlug(slug: string): Promise<string | null> {
  const db = admin.firestore()
  const slugSnap = await db.collectionGroup('public_profile').where('slug', '==', slug).limit(5).get()
  const teamDoc = slugSnap.docs.find((d) => {
    const segs = d.ref.path.split('/')
    return segs[0] === 'teams' && segs.length === 4
  })
  return teamDoc ? teamDoc.ref.parent.parent!.id : null
}

export const unlockKiosk = onCall(async (request) => {
  const { slug, pin } = (request.data ?? {}) as { slug?: string; pin?: string }
  if (!slug || typeof slug !== 'string') {
    throw new HttpsError('invalid-argument', 'slug is required')
  }
  if (!pin || typeof pin !== 'string') {
    throw new HttpsError('invalid-argument', 'pin is required')
  }

  const teamId = await resolveTeamIdBySlug(slug.trim())
  if (!teamId) throw new HttpsError('not-found', 'Team not found')

  // Rate-limit BEFORE reading config / comparing the PIN — a team+IP bucket,
  // index-free (mirrors the booking callables' rate-limit pattern).
  const ip = request.rawRequest?.ip || 'unknown'
  await bucketRateLimit({
    collection: 'kiosk_unlock_attempts',
    key: `${teamId}:${ip}`,
    limit: UNLOCK_RATE_LIMIT_MAX,
    windowMs: UNLOCK_RATE_WINDOW_MS,
    message: 'Too many attempts. Please try again later.',
  })

  // Through the ONE resolver, so an ORG-level install counts. It returns the
  // install document rather than a boolean because the PIN lives in its config.
  const install = await resolveActivePluginInstall(teamId, 'kiosk')
  if (!install) {
    throw new HttpsError('failed-precondition', 'Kiosk mode is not enabled for this team.')
  }

  const config = install.config as KioskConfig | undefined
  if (!config?.lock?.enabled) {
    throw new HttpsError('failed-precondition', 'Kiosk lock is not enabled for this team.')
  }

  if (!timingSafeEqualStr(pin, config.lock.pin ?? '')) {
    throw new HttpsError('permission-denied', 'Invalid PIN')
  }

  // Stable uid per team — fine to reuse across pairings. `kioskEpoch` (bumped by
  // a rotate/sign-out-all in the admin panel) is what actually revokes an
  // already-paired device; the uid itself is not a secret.
  const token = await admin.auth().createCustomToken(`kiosk:${teamId}`, {
    kioskTeam: teamId,
    kioskEpoch: config.lock.epoch,
    kiosk: true,
  })

  return { token }
})
