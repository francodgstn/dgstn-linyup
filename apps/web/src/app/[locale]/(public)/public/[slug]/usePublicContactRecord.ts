'use client'

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { CONTACTS_COLLECTION } from '@linyup/shared'
import type { Contact } from '@linyup/shared'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { usePublicContactAuth } from './PublicContactAuthProvider'

// THE SIGNED-IN CONTACT'S OWN RECORD, read live — the counterpart to the
// minimal contact that rides on the persisted session.
//
// WHY IT IS NOT THE SESSION'S CONTACT. `PublicContactAuthProvider` restores a
// contact that was serialized into localStorage when the session was minted and
// is never refreshed for the SEVEN DAYS the token is good for. That copy carries
// the plan types held at sign-in (`held_plan_type_ids`), frozen there. Anything that only
// names the member is fine with it; anything that PRICES them is not, because
// the divergence points the unsafe way — a lapsed or changed subscription still
// reads as held, and the screen quotes a benefit the server will not honor.
//
// Reading `contacts/{contactId}` from a public surface is the `isSelfContact`
// get: the one exception to "public routes read `public_profile` only", allowed
// because the subject of the read is the reader. It is a single doc get, cached
// by contact id and shared by every consumer on the page.
//
// EVERY consumer must read `isError`, not just `data`: this doc is where a
// member's subscriptions and credits live, so a failed read means "we don't know
// what you hold", which is NOT the same claim as "you hold nothing" — it must
// never be flattened into an empty entitlement (see `lib/publicQueryError.ts`).
export function usePublicContactRecord() {
  const { contact, isAuthenticated } = usePublicContactAuth()
  const contactId = contact?.id ?? null

  return useQuery<Contact | null>({
    queryKey: ['public-contact-record', contactId],
    enabled: isAuthenticated && !!contactId,
    queryFn: async () => {
      try {
        const snap = await getDoc(doc(db, CONTACTS_COLLECTION, contactId!))
        return snap.exists() ? ({ ...snap.data(), id: snap.id } as Contact) : null
      } catch (err: unknown) {
        // Log and rethrow: the trace is for the developer, `isError` for the
        // visitor. Neither substitutes for the other.
        reportPublicLoadFailure('public-contact/record', err)
        throw err
      }
    },
  })
}
