'use client'

// The studio's legal profile (creditor identity printed on receipts and
// invoices) — teams/{teamId}/settings/legal_profile. SHARED by the Tarif 595
// and QR-invoice plugins; edited on Settings → Payments (owner), read by both.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import {
  LEGAL_PROFILE_SETTINGS_DOC_ID,
  TEAMS_COLLECTION,
  TEAM_SETTINGS_SUBCOLLECTION,
  type StudioLegalProfile,
} from '@linyup/shared'
import { db } from '@/lib/firebase'

export const LEGAL_PROFILE_QUERY_KEY = 'legal-profile'

export function legalProfileRef(teamId: string) {
  return doc(db, TEAMS_COLLECTION, teamId, TEAM_SETTINGS_SUBCOLLECTION, LEGAL_PROFILE_SETTINGS_DOC_ID)
}

export function useLegalProfile(teamId: string | null) {
  return useQuery<StudioLegalProfile | null>({
    queryKey: [LEGAL_PROFILE_QUERY_KEY, teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDoc(legalProfileRef(teamId!))
      return snap.exists() ? (snap.data() as StudioLegalProfile) : null
    },
  })
}

/** Owner-only write (the settings rule); merges so a partial card save never
 *  blanks a field another card owns. Callers invalidate via useInvalidateLegalProfile. */
export async function saveLegalProfile(
  teamId: string,
  uid: string | null,
  profile: Omit<StudioLegalProfile, 'updated_at' | 'updated_by'>
): Promise<void> {
  await setDoc(
    legalProfileRef(teamId),
    { ...profile, updated_at: serverTimestamp(), updated_by: uid ?? null },
    { merge: true }
  )
}

export function useInvalidateLegalProfile(teamId: string | null) {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: [LEGAL_PROFILE_QUERY_KEY, teamId] })
}
