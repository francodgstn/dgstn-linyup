/* eslint-disable no-console */
// ─── claimCheckoutSession — sign the buyer in from the checkout they just paid ──
//
// THE PAYMENT ALREADY IDENTIFIED THEM. A newcomer who books and pays used to
// land on /pay/result and be asked to sign in before they could see what they
// had bought (UX-88) — the worst moment in the product to demand a credential,
// and it landed immediately after `checkout_contact_mode` had deliberately kept
// the door short. This callable is what closes that: the success page hands back
// the Checkout Session id Stripe put in the redirect, and gets a contact session
// for the person who paid.
//
// IT MINTS THROUGH `buildContactSession`, LIKE EVERY OTHER SIGN-IN. The claims
// it produces — { contactId, teamId, sessionExpires } — are what firestore.rules
// and storage.rules check (`isContactOfTeam`, `canReadPublishedCourse`,
// `isContactSessionForTeam`). There is no client-side shortcut and there must
// never be one: a session assembled anywhere else would be a session the rules
// were not written against.
//
// WHAT MAKES IT SAFE TO HAND OUT A SESSION FOR A URL PARAMETER:
//   1. The session must be COMPLETE and PAID on the studio's own connected
//      account — a `cs_…` from another tenant retrieves as not-found.
//   2. It must be RECENT (`CLAIM_WINDOW_MS`). Stripe redirects the moment the
//      payment lands, so a claim is seconds old in practice; an id later
//      recovered from a browser history or a referrer header is not.
//   3. The buyer's email on the checkout must be the contact's own address or on
//      its login allow-list — `buildContactSession({ allowedEmail })`, the same
//      guard the passwordless login uses. Paying does not let you become
//      somebody else.
// Any of those failing returns a REFUSAL, never an error the buyer has to read:
// the page falls back to the sign-in it showed before.
//
// SIGNED IN IS NOT JOINED. A shop or drop-in buyer's contact may exist with no
// `acquisition_stage` at all (UX-82/83), so this reports `joined` and
// `pendingSignup` as separate facts and the success page states only what they
// say. Nothing here promotes a stage, writes a contact, or confirms anything —
// the webhook owns all of that, and this callable is a READER.

import * as admin from 'firebase-admin'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { CONTACTS_COLLECTION, TEAMS_COLLECTION, parseSlug } from '@linyup/shared'
import { getConnectStripe } from '../utils/connect/client'
import { buildContactSession } from '../utils/contactSession'
import { bucketRateLimit } from '../utils/rateLimit'
import { to } from '../utils/async'

/**
 * How old a completed Checkout Session may be and still be claimable.
 *
 * Generous against the flow it serves (Stripe redirects immediately) and tight
 * against the one thing it guards: an id that leaked out of a URL long after the
 * fact. Not a security boundary on its own — the email match above is — but it
 * bounds the window in which a leaked link is worth anything.
 */
const CLAIM_WINDOW_MS = 60 * 60 * 1000

const CLAIM_ATTEMPTS_PER_IP = 30
const CLAIM_WINDOW_RATE_MS = 15 * 60 * 1000

/** Refusals the client can act on. Never thrown — a buyer who cannot be signed
 *  in still needs the receipt page to render. */
type ClaimRefusal =
  /** The webhook has not linked/created the contact yet. The client retries. */
  | 'pending'
  /** Nothing to claim: not paid, too old, no email, or the email is not this
   *  contact's. Terminal — the page shows the ordinary sign-in. */
  | 'unavailable'

interface ClaimedContact {
  id: string
  firstname: string
  lastname: string
  email: string | null
  /** The plan types held now — the contact's `held_plan_type_ids` mirror. */
  held_plan_type_ids: string[]
}

/**
 * Resolve a public tenant slug → teamId through `public_profile`, the same
 * collection-group query every other public callable uses. Never query the main
 * `teams` collection by slug from a public-facing callable.
 */
async function resolveTeamIdBySlug(slug: string): Promise<string | null> {
  const snap = await admin
    .firestore()
    .collectionGroup('public_profile')
    .where('slug', '==', slug)
    .limit(5)
    .get()
  const teamDoc = snap.docs.find((d) => {
    const segs = d.ref.path.split('/')
    return segs[0] === 'teams' && segs.length === 4
  })
  return teamDoc ? teamDoc.ref.parent.parent!.id : null
}

/** The contact the checkout belongs to, or null when nothing links it yet. */
async function resolveBuyerContactId(
  teamId: string,
  metadataContactId: string | null,
  email: string
): Promise<string | null> {
  const db = admin.firestore()
  if (metadataContactId) {
    // Re-verified rather than trusted: checkout metadata is client-supplied at
    // creation, so a contact id in it proves nothing about ownership until the
    // document has been read and found to be this tenant's.
    const snap = await db.collection(CONTACTS_COLLECTION).doc(metadataContactId).get()
    const c = snap.data()
    if (snap.exists && c?.teamId === teamId && c?.archived_at == null && c?.deleted_at == null) {
      return snap.id
    }
  }
  if (!email) return null
  // The anonymous/guest shape: the webhook has linked or created a contact for
  // the address the buyer paid with. Same match rule as the passwordless login —
  // primary address first, then the login-email allow-list (a parent paying for
  // a child's booking).
  //
  // THE SHAPE IS COPIED FROM `loginContactWithCode`, INDEX AND ALL: an equality
  // pair (`email` + `teamId`) that Firestore serves without a composite, and an
  // `array-contains` on its own with the team filtered in memory — because
  // `array-contains` PLUS an equality would need a composite index this repo
  // does not deploy, and a missing index is the failure that passes in the
  // emulator and throws on a real project.
  const [primary, allowed] = await Promise.all([
    db
      .collection(CONTACTS_COLLECTION)
      .where('email', '==', email)
      .where('teamId', '==', teamId)
      .limit(5)
      .get(),
    db.collection(CONTACTS_COLLECTION).where('login_emails', 'array-contains', email).limit(20).get(),
  ])
  const active = [...primary.docs, ...allowed.docs].filter((d) => {
    const c = d.data()
    return c.teamId === teamId && c.archived_at == null && c.deleted_at == null
  })
  // MORE THAN ONE MATCH IS A REFUSAL, not a guess. Two contacts share an address
  // when a parent's mailbox is on several children's profiles, and picking one is
  // exactly the choice `loginContactWithCode` makes the human make.
  const ids = new Set(active.map((d) => d.id))
  if (ids.size !== 1) return null
  return active[0].id
}

export const claimCheckoutSession = onCall(async (request) => {
  const data = (request.data ?? {}) as { checkoutSessionId?: string; slug?: string }

  const checkoutSessionId = (data.checkoutSessionId ?? '').trim()
  // Stripe's own id shape. Cheap, and it keeps junk out of an API call.
  if (!/^cs_[A-Za-z0-9_]{10,255}$/.test(checkoutSessionId)) {
    throw new HttpsError('invalid-argument', 'checkoutSessionId is required')
  }
  const slug = parseSlug(data.slug)
  if (!slug) throw new HttpsError('invalid-argument', 'slug is required')

  // A public callable that reaches Stripe: bucket by IP so a scanner cannot
  // spend the studio's API budget probing ids.
  await bucketRateLimit({
    collection: 'checkout_claim_attempts',
    key: request.rawRequest?.ip || 'unknown',
    limit: CLAIM_ATTEMPTS_PER_IP,
    windowMs: CLAIM_WINDOW_RATE_MS,
  })

  const teamId = await resolveTeamIdBySlug(slug)
  if (!teamId) throw new HttpsError('not-found', 'Team not found')

  const teamSnap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).get()
  const accountId = teamSnap.data()?.payments?.connectAccountId as string | undefined
  // No connected account ⇒ this team never created the session being claimed.
  // Deliberately NOT `requireChargeableAccount`: an account that has since
  // stopped being chargeable must still be able to identify a buyer who paid
  // while it was.
  if (!accountId) return { status: 'unavailable' as ClaimRefusal }

  const stripe = await getConnectStripe()
  const [stripeErr, session] = await to(
    stripe.checkout.sessions.retrieve(checkoutSessionId, {}, { stripeAccount: accountId })
  )
  if (stripeErr || !session) {
    // Not this account's session, or Stripe is unreachable. Both are the same
    // answer to the page: show the sign-in.
    console.log(`[connect] claim: session ${checkoutSessionId} not retrievable on ${accountId}`)
    return { status: 'unavailable' as ClaimRefusal }
  }

  const s = session as unknown as {
    status?: string | null
    payment_status?: string | null
    created?: number | null
    customer_email?: string | null
    customer_details?: { email?: string | null } | null
    metadata?: Record<string, string> | null
  }

  const paid = s.status === 'complete' || (!!s.payment_status && s.payment_status !== 'unpaid')
  if (!paid) return { status: 'unavailable' as ClaimRefusal }

  const createdMs = typeof s.created === 'number' ? s.created * 1000 : 0
  if (!createdMs || Date.now() - createdMs > CLAIM_WINDOW_MS) {
    return { status: 'unavailable' as ClaimRefusal }
  }

  const email = ((s.customer_details?.email ?? s.customer_email ?? '') as string)
    .toLowerCase()
    .trim()
  // NO ADDRESS, NO CLAIM. The email match below is the only thing standing
  // between "holds a session id" and "is this person", so a checkout that
  // carries none cannot be claimed at all — Stripe Checkout always collects one
  // on these rails, which is why refusing costs nothing real.
  if (!email) return { status: 'unavailable' as ClaimRefusal }
  const metadataContactId = (s.metadata?.contactId ?? '').trim() || null

  const contactId = await resolveBuyerContactId(teamId, metadataContactId, email)
  if (!contactId) {
    // THE REDIRECT CAN BEAT THE WEBHOOK. `checkout.session.completed` is what
    // creates or links a guest buyer's contact, and it may still be in flight —
    // so "not found yet" is a RETRY, not a failure, and the client polls.
    return { status: 'pending' as ClaimRefusal, retryable: true }
  }

  // `allowedEmail` is the load-bearing guard: paying does not make you somebody
  // else. It throws when the address on the checkout is neither the contact's
  // own nor on its login allow-list — refuse rather than propagate, so the page
  // degrades to the sign-in it used to show.
  const [sessionErr, minted] = await to(
    buildContactSession(contactId, teamId, email, { allowedEmail: email })
  )
  if (sessionErr || !minted) {
    console.log(`[connect] claim: refused for contact ${contactId} (email mismatch or missing)`)
    return { status: 'unavailable' as ClaimRefusal }
  }

  const c = minted.contact as Record<string, unknown>
  const contact: ClaimedContact = {
    id: contactId,
    firstname: ((c.firstname as string | undefined) ?? '').trim(),
    lastname: ((c.lastname as string | undefined) ?? '').trim(),
    email: (c.email as string | undefined) ?? null,
    held_plan_type_ids: Array.isArray(c.held_plan_type_ids)
      ? (c.held_plan_type_ids as unknown[]).filter((id): id is string => typeof id === 'string')
      : [],
  }

  console.log(`[connect] claim: signed in contact ${contactId} from checkout ${checkoutSessionId}`)

  return {
    status: 'signed_in' as const,
    customToken: minted.customToken,
    sessionExpires: minted.sessionExpires,
    contact,
    // TWO SEPARATE FACTS, and the page may not blur them. `joined` is the
    // acquisition stage; a shop/drop-in buyer commonly has none at all, and a
    // receipt page that implied membership would be promising access the rules
    // will refuse. `pendingSignup` is the 'full' checkout mode's outstanding
    // registration — the only thing the buyer is actually being asked to finish.
    joined: c.acquisition_stage === 'joined',
    pendingSignup: c.pending_signup === true && !c.signup_completed_at,
  }
})
