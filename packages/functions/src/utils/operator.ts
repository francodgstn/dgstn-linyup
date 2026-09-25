/**
 * Operator authorization for callables.
 *
 * The mirror of `apps/admin/src/lib/operators.ts`, which had no counterpart in
 * the functions runtime because nothing here needed one until now: every
 * privileged operator action lived in the console's own server actions, running
 * with the Admin SDK behind `require-operator.ts`.
 *
 * The rule is deliberately IDENTICAL to the console's, because they authorize
 * the same person:
 *   1. the `saas_operator` custom claim (the durable mechanism), or
 *   2. a VERIFIED email on the `OPERATOR_EMAILS` allowlist (bootstrap).
 *
 * The one difference is `email_verified`. The console verifies a session cookie
 * it minted itself and re-checks the allowlist per request; a callable is handed
 * whatever token the caller has, so an unverified email must not pass — nothing
 * else stops somebody signing up as the operator's address and never confirming
 * it.
 *
 * No operator identity is hardcoded: it would sit in git history forever.
 */
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { defineString } from 'firebase-functions/params'

/**
 * MUST ALSO BE SPELLED OUT IN EVERY `.env.<alias>`, even empty.
 *
 * `default:` is not enough for a non-interactive deploy — firebase-tools asks
 * for the value and CI has nobody to ask, so the whole deploy fails with
 * "In non-interactive mode but have no value for the following environment
 * variables". That is exactly what broke the staging deploy on 2026-08-21, and
 * it is why `TEST_EMAIL=` is written out in those files rather than left to its
 * own empty default.
 *
 * The value MIRRORS `apps/admin`'s `OPERATOR_EMAILS`: the console and these
 * callables authorize the same person, so a value here that disagrees with the
 * console's is a button that renders and then refuses.
 */
const operatorEmails = defineString('OPERATOR_EMAILS', {
  default: '',
  description: 'Comma-separated operator emails. Mirrors the admin console env of the same name.',
})

function allowlist(): Set<string> {
  return new Set(
    operatorEmails
      .value()
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  )
}

/** The caller's operator identity, or null. Never throws — for logging. */
export function operatorIdentity(request: CallableRequest<unknown>): string | null {
  const token = request.auth?.token as
    | { saas_operator?: unknown; email?: string; email_verified?: boolean }
    | undefined
  if (!token) return null
  const email = (token.email ?? '').toLowerCase()
  if (token.saas_operator === true) return email || request.auth?.uid || 'operator'
  if (!token.email_verified) return null
  return email && allowlist().has(email) ? email : null
}

/** Refuse anyone who is not an operator. Returns the identity for the audit
 *  trail — every caller should record WHO, not just that it happened. */
export function requireOperator(request: CallableRequest<unknown>): string {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required')
  const identity = operatorIdentity(request)
  if (!identity) throw new HttpsError('permission-denied', 'Operator access required')
  return identity
}
