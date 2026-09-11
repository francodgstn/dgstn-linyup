/**
 * WHAT A STAFF USER IS CALLED — one rule, and the fallback is the CALLER'S.
 *
 * `users/{uid}` carries three name-ish fields and they are not interchangeable:
 * `firstname` + `lastname` are what every signup and every import fills in, and
 * `displayName` is what Firebase Auth happens to have set — which for an
 * account created by an import is usually NOTHING. Four server surfaces asked
 * this question and two of them read `displayName` ALONE:
 *
 *   • `listTeamMembers` → the Coaches page showed every migrated coach by their
 *     EMAIL ADDRESS, because that was the next fallback in line.
 *   • `syncTeamCoachesPublicProfile` → the world-readable coach roster showed a
 *     raw UID, because that one (rightly) refuses to fall back to an email in
 *     public. A studio's public site listing "8vT2c…" as a coach.
 *
 * HMD's 45 users: 45 with a firstname, 42 with a lastname, ONE with a
 * displayName. The name was there the whole time, in the field nobody read.
 *
 * ── THE FALLBACK IS DELIBERATELY NOT HERE ───────────────────────────────────
 *
 * This returns `null` for a user with no name, and each caller supplies its own
 * last resort, because that is the one thing they legitimately disagree about:
 * an internal surface falls back to the email (useful, and the viewer is staff
 * of the same team), a PUBLIC surface must never — it falls back to the uid,
 * which is opaque. Folding a single fallback in here would either leak a staff
 * email to the open internet or print a uid to the studio's own admin.
 */

export interface UserNameFields {
  firstname?: string | null
  lastname?: string | null
  displayName?: string | null
}

/** `firstname lastname`, else `displayName`, else null. Never an email, never a uid. */
export function userFullName(u: UserNameFields | null | undefined): string | null {
  if (!u) return null
  const full = `${u.firstname ?? ''} ${u.lastname ?? ''}`.trim()
  if (full) return full
  const display = u.displayName?.trim()
  return display ? display : null
}
