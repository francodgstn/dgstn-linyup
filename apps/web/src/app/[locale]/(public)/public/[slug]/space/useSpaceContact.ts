'use client'

export { usePublicContactRecord as useSpaceContact } from '../usePublicContactRecord'

// The session `contact` is a snapshot frozen at sign-in. Modules that
// need the full record (membership, profile) read the own contact doc — permitted
// by the `isSelfContact` Firestore rule. Cached + shared across modules.
//
// THE READ ITSELF NOW LIVES ONE LEVEL UP, in `usePublicContactRecord`, because
// Space stopped being the only surface that needs it: the appointment picker
// prices a member off what they hold, and the session's frozen
// plan list is not that. Two copies of this query would have been
// two cache keys and two answers to "what does this contact hold" on the same
// page. This file stays as the name Space already calls it by.
//
// EVERY consumer must read `isError`, not just `data`: this doc is where a
// member's subscriptions and credits live, so a failed read means "we don't know
// what you hold", which is NOT the same claim as "you hold nothing" — and it also
// silently shrinks the subscription-tier courses in "My courses". Both SpaceHome
// and AccountHome surface it; see `lib/publicQueryError.ts`.
