import 'server-only'

import { cache } from 'react'
import { PUBLIC_PROFILE_SUBCOLLECTION } from '@linyup/shared'
import type { TeamPublicProfile } from '@linyup/shared'
import { restRunQuery } from './firestoreRest'

export interface PublicTeamResolved {
  teamId: string
  /** Decoded JSON — any Timestamp field is still a `{ __ts }` marker; the
   *  client-side `PublicTeamProvider` revives it before putting it in context. */
  team: TeamPublicProfile
}

/**
 * Resolve `/public/{slug}/**`'s team, SERVER-SIDE, over Firestore REST — the
 * SAME collection-group query `PublicTeamProvider` runs client-side (`slug ==`,
 * `type == 'team'` on `public_profile`), so it needs no index the app does not
 * already have. `cache()`d per request+slug so `layout.tsx` is free to call it
 * without worrying about a second network round trip if another server
 * component under the same render needs the team too.
 *
 * `null` on a bad slug OR a failed read (`restRunQuery` already logs) — the
 * layout falls back to `PublicTeamProvider`'s own client-side query either way,
 * so a REST outage degrades to today's spinner rather than a broken page.
 */
export const fetchPublicTeam = cache(async (slug: string): Promise<PublicTeamResolved | null> => {
  const doc = await restRunQuery({
    from: [{ collectionId: PUBLIC_PROFILE_SUBCOLLECTION, allDescendants: true }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          { fieldFilter: { field: { fieldPath: 'slug' }, op: 'EQUAL', value: { stringValue: slug } } },
          { fieldFilter: { field: { fieldPath: 'type' }, op: 'EQUAL', value: { stringValue: 'team' } } },
        ],
      },
    },
    limit: 1,
  })
  if (!doc || !doc.parentId) return null
  return { teamId: doc.parentId, team: doc.fields as unknown as TeamPublicProfile }
})
