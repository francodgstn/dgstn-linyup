import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { USERS_COLLECTION } from '@linyup/shared'

/**
 * Account/team provisioning shared by the signup wizard and the social-auth
 * flow. Sign-in (email, social, or magic link) only authenticates the user;
 * `provisionTeam` turns that account into a studio.
 *
 * The team, the owner membership and the user profile are written server-side in
 * ONE atomic batch by the `createStudioTeam` callable
 * (packages/functions/src/teams/createStudioTeam.ts) — NOT from the browser. That
 * closes the bootstrap that made the 2026-08-26 team takeover (#106) possible: a
 * `team_members` self-provision rule has to grant a write to a not-yet-member,
 * i.e. to "anyone". The callable also owns slug uniqueness (a privileged query
 * the client cannot run) and refuses contact/kiosk sessions, so a studio is only
 * ever owned by a durable personal account.
 */

/** Whether the user already has a team (i.e. has finished signup before). */
export async function userHasTeam(uid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, USERS_COLLECTION, uid))
  return snap.exists() && !!snap.data()?.currentTeam
}

export interface TeamProvisioningOptions {
  /** ISO 4217, uppercase. Every price the studio types is authored in it. */
  defaultCurrency?: string
  /**
   * The language this studio writes to its MEMBERS in — every booking
   * confirmation, reminder and waitlist offer (`Team.language`, read by ~15 call
   * sites in the functions). Not the UI language, which follows the URL.
   *
   * Optional so the social-auth path and any other caller still compile, but a
   * team created without one mails in English forever, which is why the signup
   * wizard now asks.
   */
  language?: 'en' | 'de' | 'fr' | 'it'
  /**
   * The terms version the signup form showed and the Customer ticked. Passed in
   * rather than read from the constant here so the record names the text that
   * was ACTUALLY on screen — if a deploy changes the constant while someone has
   * the form open, the honest record is the one they saw, not the new one.
   *
   * Optional so the social-auth path and any other caller still compiles, but a
   * team provisioned without it carries no contract record at all.
   */
  termsVersion?: string
}

/**
 * Create the studio (team + owner membership + user profile) for the currently
 * signed-in account and return its id. Identity — uid, email, displayName,
 * email-verified — is taken from the verified auth token on the server, never
 * from the client, so no `user` argument is needed or trusted here.
 */
export async function provisionTeam(
  teamName: string,
  sportType: string | undefined,
  options: TeamProvisioningOptions = {}
): Promise<string> {
  const call = httpsCallable<
    {
      name: string
      sportType?: string
      defaultCurrency?: string
      language?: 'en' | 'de' | 'fr' | 'it'
      termsVersion?: string
    },
    { teamId: string; slug: string }
  >(functions, 'createStudioTeam')

  const res = await call({
    name: teamName,
    sportType,
    defaultCurrency: options.defaultCurrency,
    language: options.language,
    termsVersion: options.termsVersion,
  })
  return res.data.teamId
}
