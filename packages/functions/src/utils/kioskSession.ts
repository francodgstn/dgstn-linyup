// IS THE CALLER THE STUDIO'S OWN DOORWAY TABLET?
//
// ══ WHY THIS MODULE EXISTS ═══════════════════════════════════════════════════
// `bookSession` used to answer that question with `data.source === 'kiosk'` — a
// string off the request body, sent by an unauthenticated public caller. The
// answer then selected a SECURITY behavior, and anyone could buy it by adding
// one field to a public payload.
//
// A source string is ATTRIBUTION. It is fine for "where did this booking come
// from" on a dashboard, and it must never select who may skip a gate. The rule
// this module encodes: an authorization answer comes from something the caller
// cannot forge, and the kiosk already has one — the custom token minted by
// `unlockKiosk` after a timing-safe PIN comparison, carrying
// `{ kiosk: true, kioskTeam, kioskEpoch }` (packages/functions/src/kiosk/index.ts).
//
// ══ WHAT IT DECIDES NOW, AND WHY THAT IS STILL WORTH A TOKEN ════════════════
// The behavior it used to select was the kiosk's WAIVER DEFERRAL — the one rail
// that admitted a walk-in with a guardian requirement outstanding and emailed a
// parent afterwards. That machinery is gone; the kiosk refuses like every other
// rail, because the consent step is completable by the person at the desk.
//
// Two readers remain, and both are real:
//   • `bookSession` stamps the ledger's `source` and the booking's `source` as
//     `kiosk` ONLY on a pass — so the one value a caller might want to claim in
//     an evidence record is the one value they cannot fake into it;
//   • `waivers/limits.ts` exempts a paired tablet from the per-IP volume ceiling
//     on `resolveWaiverRequirement`, because a doorway is one address for a whole
//     evening and a studio's own tablet must not be throttled by strangers.
//
// ══ WHAT A PASS MEANS, AND WHAT IT DOES NOT ═════════════════════════════════
// It means: a device that knew this team's kiosk PIN paired with this team, and
// the pairing has not been revoked. That is a claim about the DEVICE, never
// about the person standing at it.
//
// `KioskLockConfig.enabled` defaults to FALSE. With the lock off no token is
// ever minted, so an unlocked kiosk cannot be told apart from an anonymous
// caller ON THE WIRE: its walk-in ticks are filed as `source: 'booking'`, which
// is exactly what we can stand behind about them, and it pays the ordinary
// per-IP ceiling.
import * as admin from 'firebase-admin'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { INSTALLED_PLUGINS_SUBCOLLECTION, TEAMS_COLLECTION } from '@linyup/shared'
import type { KioskConfig } from '@linyup/shared'

/** The claim bag as it arrives on a verified ID token. Every field is `unknown`
 *  on purpose: these are attacker-influenced right up until they are checked. */
export interface KioskTokenClaims {
  kiosk?: unknown
  kioskTeam?: unknown
  kioskEpoch?: unknown
  /** Present on a CONTACT session, never on a kiosk token. Read only to make the
   *  test matrix state that the two are not interchangeable. */
  contactId?: unknown
}

/**
 * PURE. Does this token claim a kiosk pairing with THIS team, and which epoch?
 *
 * Returns null for: no token at all (the anonymous caller who typed
 * `source: 'kiosk'`), a contact session, a kiosk token for another team, and a
 * token missing the `kiosk: true` marker. `epoch` is returned rather than
 * compared so the impure half owns the one read that resolves revocation.
 *
 * Firebase verifies the token's signature before `request.auth` is populated, so
 * a claim that survives to here was minted by us; the only questions left are
 * WHICH team it names and whether the pairing is still live.
 */
export function kioskClaimForTeam(
  claims: KioskTokenClaims | null | undefined,
  teamId: string
): { epoch: number } | null {
  if (!claims || !teamId) return null
  if (claims.kiosk !== true) return null
  if (typeof claims.kioskTeam !== 'string' || claims.kioskTeam !== teamId) return null
  // A pairing minted before the epoch existed reads as 0, which is also the
  // config's default — so "no epoch" is not a wildcard, it is epoch zero and it
  // is compared like any other.
  const epoch = typeof claims.kioskEpoch === 'number' ? claims.kioskEpoch : 0
  return { epoch }
}

/**
 * THE check a rail makes before it grants a kiosk-only behavior.
 *
 * Costs ONE document read, and only for a caller who actually presents a kiosk
 * claim for this team — an ordinary public booking pays nothing. The read is what
 * makes "sign out all devices" (which bumps `lock.epoch`) revoke a paired tablet
 * on its very next call rather than at the token's own leisure.
 *
 * Never throws: a caller who is not a kiosk is not an error, it is a caller who
 * takes the ordinary rail.
 */
export async function isKioskDeviceForTeam(
  request: CallableRequest<unknown>,
  teamId: string
): Promise<boolean> {
  const claim = kioskClaimForTeam(request.auth?.token as KioskTokenClaims | undefined, teamId)
  if (!claim) return false
  try {
    const snap = await admin
      .firestore()
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(INSTALLED_PLUGINS_SUBCOLLECTION)
      .doc('kiosk')
      .get()
    if (!snap.exists || snap.data()?.status !== 'active') return false
    const lock = (snap.data()?.config as KioskConfig | undefined)?.lock
    // The lock being off means no token can legitimately be live: `unlockKiosk`
    // refuses to mint one, so a claim presented against a disabled lock is a
    // stale pairing at best.
    if (!lock?.enabled) return false
    return Number(lock.epoch ?? 0) === claim.epoch
  } catch (err) {
    // Fail CLOSED. An unreadable plugin document is not a proof of pairing, and
    // the cost of the safe answer is one walk-in refused rather than one minor
    // admitted with nobody's consent.
    console.error('[kiosk] pairing check failed:', err) // eslint-disable-line no-console
    return false
  }
}
