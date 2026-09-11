'use client'

// Places — Firestore CRUD for a team's (and an org's) physical locations.
//   team places → teams/{teamId}/team_places/{placeId}
//   org places  → organizations/{orgId}/org_places/{placeId}  (read-only for sub-teams)
// The primary team place is denormalised to public_profile.mainAddress by a Cloud
// Function for the bio-link.

import { useQuery } from '@tanstack/react-query'
import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  getCountFromServer,
  getDoc,
  query,
  where,
  writeBatch,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  TEAMS_COLLECTION,
  TEAM_PLACES_SUBCOLLECTION,
  ORGANIZATIONS_COLLECTION,
  ORG_PLACES_SUBCOLLECTION,
  ORG_TEAMS_SUBCOLLECTION,
  PUBLIC_PROFILE_SUBCOLLECTION,
} from '@linyup/shared'
import type { OrgTeam, Place } from '@linyup/shared'

export function teamPlacesCol(teamId: string) {
  return collection(db, TEAMS_COLLECTION, teamId, TEAM_PLACES_SUBCOLLECTION)
}
export function orgPlacesCol(orgId: string) {
  return collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_PLACES_SUBCOLLECTION)
}

function sortPlaces(a: Place, b: Place): number {
  if (!!a.isPrimary !== !!b.isPrimary) return a.isPrimary ? -1 : 1
  const ao = a.order ?? Number.MAX_SAFE_INTEGER
  const bo = b.order ?? Number.MAX_SAFE_INTEGER
  if (ao !== bo) return ao - bo
  return (a.name ?? '').localeCompare(b.name ?? '')
}

/** A team's own places plus any inherited org-wide places (org ones are read-only). */
export function usePlaces(teamId: string | null, orgId?: string | null) {
  return useQuery<Place[]>({
    queryKey: ['places', teamId, orgId ?? null],
    enabled: !!teamId,
    queryFn: async () => {
      const teamSnap = await getDocs(teamPlacesCol(teamId!))
      const team = teamSnap.docs
        .map((d) => ({ ...(d.data() as Omit<Place, 'id'>), id: d.id, scope: 'team' as const }))
        .sort(sortPlaces)
      let org: Place[] = []
      if (orgId) {
        try {
          const orgSnap = await getDocs(orgPlacesCol(orgId))
          org = orgSnap.docs
            .map((d) => ({ ...(d.data() as Omit<Place, 'id'>), id: d.id, scope: 'org' as const }))
            .sort(sortPlaces)
        } catch {
          org = []
        }
      }
      return [...team, ...org]
    },
  })
}

/** An org's own places (org-admin management). */
export function useOrgPlaces(orgId: string | null) {
  return useQuery<Place[]>({
    queryKey: ['org-places', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const snap = await getDocs(orgPlacesCol(orgId!))
      return snap.docs
        .map((d) => ({ ...(d.data() as Omit<Place, 'id'>), id: d.id, scope: 'org' as const }))
        .sort(sortPlaces)
    },
  })
}

/** A member studio's own place, as the org console sees it. */
export interface OrgTeamPlace extends Place {
  teamId: string
  teamName?: string
}

/**
 * EVERY MEMBER STUDIO'S OWN PLACES, for the organisation's Places page.
 *
 * Read-only by construction: `firestore.rules` admits an org ADMIN to
 * `teams/{id}/team_places` for reading and leaves `write` to that studio's own
 * managers. A studio's locations stay the studio's to edit.
 *
 * A FAN-OUT, NOT A COLLECTIONGROUP. A collection-group read is matched only by a
 * `{path=**}` rule, and the gate this needs — "is the caller an org admin of the
 * team that owns this document" — is a cross-document `get()` keyed on the
 * candidate, which a LIST rule cannot satisfy. The fan-out is bounded: MAX_PLACES
 * caps each studio at 25, and the studio count is the organisation's own.
 *
 * EVERY READ IS GUARDED INDIVIDUALLY. The caller is not a member of these
 * studios, so one denial inside a bare `Promise.all` would reject the whole query
 * and the page would render as an organisation with no places at all — the
 * silent-empty failure the Studios page shipped once already.
 */
export function useOrgTeamPlaces(orgId: string | null) {
  return useQuery<OrgTeamPlace[]>({
    queryKey: ['org-team-places', orgId],
    enabled: !!orgId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const teamsSnap = await getDocs(
        query(
          collection(db, ORGANIZATIONS_COLLECTION, orgId!, ORG_TEAMS_SUBCOLLECTION),
          where('status', '==', 'active'),
        ),
      )
      const teamIds = teamsSnap.docs
        .map((d) => (d.data() as OrgTeam).teamId ?? d.id)
        .filter(Boolean)

      const perTeam = await Promise.all(
        teamIds.map(async (teamId): Promise<OrgTeamPlace[]> => {
          try {
            // The studio's NAME comes from its public_profile, not from
            // `teams/{id}`: an org admin cannot read the team document of a
            // studio it does not belong to, but the public profile is
            // world-readable and carries the name. Spelled inline as every other
            // hook that reads it does — there is no shared constant for the team
            // one.
            const [placesSnap, profileSnap] = await Promise.all([
              getDocs(teamPlacesCol(teamId)),
              getDoc(doc(db, TEAMS_COLLECTION, teamId, PUBLIC_PROFILE_SUBCOLLECTION, teamId)).catch(
                () => null,
              ),
            ])
            const teamName = (profileSnap?.data()?.name as string | undefined) ?? undefined
            return placesSnap.docs.map((d) => ({
              ...(d.data() as Omit<Place, 'id'>),
              id: d.id,
              scope: 'team' as const,
              teamId,
              teamName,
            }))
          } catch {
            return []
          }
        }),
      )
      return perTeam.flat().sort(sortPlaces)
    },
  })
}

export type PlaceInput = Pick<Place, 'name' | 'address' | 'mapsLink' | 'isPrimary' | 'rooms' | 'order'>

// ─── team places ────────────────────────────────────────────────────────────────

export async function createPlace(opts: { teamId: string; userId: string; data: PlaceInput }): Promise<string> {
  const ref = doc(teamPlacesCol(opts.teamId))
  await setDoc(ref, {
    teamId: opts.teamId,
    scope: 'team',
    ...stripUndefined(opts.data),
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
    createdBy: opts.userId,
  })
  return ref.id
}

export async function updatePlace(teamId: string, placeId: string, patch: Partial<PlaceInput>): Promise<void> {
  await updateDoc(doc(teamPlacesCol(teamId), placeId), {
    ...stripUndefined(patch),
    updated_at: serverTimestamp(),
  })
}

export async function deletePlace(teamId: string, placeId: string): Promise<void> {
  await deleteDoc(doc(teamPlacesCol(teamId), placeId))
}

/** Make one place primary, clearing the flag on every other team place. */
export async function setPrimaryPlace(teamId: string, placeId: string): Promise<void> {
  const snap = await getDocs(teamPlacesCol(teamId))
  const batch = writeBatch(db)
  snap.docs.forEach((d) => {
    const shouldBe = d.id === placeId
    if (!!d.data().isPrimary !== shouldBe) {
      batch.update(d.ref, { isPrimary: shouldBe, updated_at: serverTimestamp() })
    }
  })
  await batch.commit()
}

export async function countPlaces(teamId: string): Promise<number> {
  const snap = await getCountFromServer(teamPlacesCol(teamId))
  return snap.data().count
}

// ─── org places ─────────────────────────────────────────────────────────────────

export async function createOrgPlace(opts: { orgId: string; userId: string; data: PlaceInput }): Promise<string> {
  const ref = doc(orgPlacesCol(opts.orgId))
  // Org places are shared; `isPrimary` is a team-only concept and is dropped.
  const { isPrimary: _drop, ...data } = opts.data
  await setDoc(ref, {
    orgId: opts.orgId,
    scope: 'org',
    ...stripUndefined(data),
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
    createdBy: opts.userId,
  })
  return ref.id
}

export async function updateOrgPlace(orgId: string, placeId: string, patch: Partial<PlaceInput>): Promise<void> {
  const { isPrimary: _drop, ...data } = patch
  await updateDoc(doc(orgPlacesCol(orgId), placeId), {
    ...stripUndefined(data),
    updated_at: serverTimestamp(),
  })
}

export async function deleteOrgPlace(orgId: string, placeId: string): Promise<void> {
  await deleteDoc(doc(orgPlacesCol(orgId), placeId))
}

export async function countOrgPlaces(orgId: string): Promise<number> {
  const snap = await getCountFromServer(orgPlacesCol(orgId))
  return snap.data().count
}

// Firestore rejects `undefined` field values; drop them before writing.
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}
