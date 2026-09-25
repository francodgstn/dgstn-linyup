import { callFunction } from '@/lib/callFunction'

/**
 * Is this slug free? — asked of the server, which is the only place that can
 * answer it.
 *
 * THE SLUG IS THE TENANT'S ADDRESS. Every public route resolves a studio with
 * `collectionGroup('public_profile').where('slug','==',slug).limit(1)`, so two
 * studios holding one slug do not collide loudly: `/public/{slug}` resolves to
 * whichever document the index happens to hand back, and the loser's members
 * land on a stranger's booking page. One login meant one studio for a long
 * time, which hid this; the account menu's "create another studio" does not.
 *
 * WHY A CALLABLE AND NOT A CLIENT QUERY. `teams` is readable only by a member
 * or the creator (`firestore.rules`, `match /teams/{teamId}`), and a list query
 * is refused outright when any matching document fails that rule. So a client
 * `where('slug','==',…)` over `teams` is rejected by EXACTLY the case it exists
 * to detect — a slug held by somebody else's studio — and returns a permission
 * error rather than "taken". `validateTeamSlug` runs in the Admin SDK, which
 * bypasses rules, sees every team, and reads `teams.slug` itself rather than a
 * mirror that lags behind it.
 *
 * It also owns the normalization and the reserved-word list, so callers get the
 * slug the server would actually store instead of re-deriving it and drifting.
 */
export type SlugCheck = {
  available: boolean
  /** The slug the server would store. Absent when `available` is false. */
  normalizedSlug?: string
  /** Server-side English explanation; callers show their own localized copy. */
  reason?: string
}

export async function checkTeamSlug(slug: string, teamId?: string): Promise<SlugCheck> {
  const res = await callFunction<{ slug: string; teamId?: string }, SlugCheck>(
    'validateTeamSlug'
  )({ slug, teamId })
  return res.data
}
