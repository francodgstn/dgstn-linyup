import type { Timestamp } from './common'

// Types for the Brevo-backed mail pipeline (packages/functions/src/mail/).
// nDSG note: we persist Brevo references/IDs and minimal status only — never
// message bodies or PII beyond the recipient address needed for suppression.

// Why a recipient was suppressed. Mirrors the Brevo events that mean "stop
// sending here": a hard bounce, an explicit block, a spam complaint, or an
// address Brevo rejected as invalid.
export type MailSuppressionReason = 'hardBounce' | 'blocked' | 'spam' | 'invalid' | 'unsubscribed'

// One suppressed recipient. Doc id = sha256(lowercased email) so we never use a
// raw address as a document key. Checked before every send; a present doc means
// the address is dead/complained and must be skipped.
export interface MailSuppression {
  email: string
  reason: MailSuppressionReason
  provider_message_id?: string
  created_at: Timestamp
  updated_at: Timestamp
}

// Idempotency + delivery ledger. Doc id = the idempotency key the caller passed
// (or a hash of the message). Guards against duplicate sends on retry and records
// the last provider event for the message.
export interface MailSendRecord {
  idempotency_key: string
  provider: 'brevo'
  provider_message_id?: string
  // 'studio' mail is sent on behalf of a team; 'system' mail is Linyup's own.
  stream: 'system' | 'studio'
  team_id?: string
  // 'suppressed' = never handed to the provider (synthetic recipient or a
  // messaging-policy drop); suppress_reason explains which layer dropped it.
  status: 'sent' | 'delivered' | 'bounced' | 'blocked' | 'spam' | 'failed' | 'suppressed'
  suppress_reason?: 'synthetic' | 'policy_silent' | 'policy_allowlist'
  created_at: Timestamp
  updated_at: Timestamp
}

// ─── per-tenant messaging policy (messaging_policies/{entityId}) ─────────────
// OPERATOR-controlled outbound-delivery policy — the answer to mixed-tenant
// environments (the sandbox hosts lead demos AND the public /try playground).
// Client reads/writes are DENIED by rules (the /try teams have shared owner
// logins); only the Admin SDK writes these (seeders, ops scripts, operator
// console). Resolved by the mail/SMS services per send, after the env kill
// switch; a tenant without a doc falls back to the MESSAGING_DEFAULT_MODE env
// param ('silent' on the sandbox, 'live' in production).
//
// entityId = teamId | orgId | the literal 'system' (Linyup's own system stream).

export type MessagingMode = 'live' | 'allowlist' | 'redirect' | 'silent'

export interface MessagingPolicy {
  entityId: string
  mode: MessagingMode
  // allowlist mode: recipients kept when they match an exact address (case-
  // insensitive) or a '@domain.tld' entry. Everything else is dropped.
  allowEmails?: string[]
  // allowlist mode: E.164 phone numbers granted SMS delivery.
  allowPhones?: string[]
  // redirect mode: every email/SMS is delivered to this target instead.
  redirectEmail?: string
  redirectPhone?: string
  /**
   * IGNORE THE ENVIRONMENT'S TEST_MODE REDIRECT FOR THIS TENANT — so the policy
   * above is what decides, exactly as it would in production.
   *
   * `TEST_MODE=true` redirects EVERY message in an environment to one inbox and
   * deliberately bypasses this document (see mailService). That is right for a
   * staging environment full of real imported addresses — and wrong for the one
   * studio you have asked a real person to test, who then never receives the
   * confirmation they are testing.
   *
   * So this is a per-tenant hole in an environment-wide guard, and it is built
   * to be hard to open by accident:
   *   • ABSENT ⇒ false ⇒ today's behaviour. Never defaulted on, never inherited.
   *   • OPERATOR-ONLY, like the rest of this document: rules deny every client
   *     write, and the console surfaces it only while TEST_MODE is actually on.
   *   • It does NOT bypass the layers that protect recipients rather than
   *     redirect them: synthetic addresses (@example.com and friends) are still
   *     dropped, suppressed addresses are still skipped, and `mode: 'silent'`
   *     still sends nothing. It removes the environment's redirect, not the
   *     tenant's own policy.
   *
   * Real mail to real people follows from setting this. That is the point, and
   * it is why the copy beside it says so.
   */
  ignoreTestMode?: boolean
  // Operator context, e.g. "founder demo — deliver to Ash only".
  note?: string
  updated_at?: Timestamp
  updated_by?: string
}

// Shape of a single Brevo transactional webhook event (the subset we consume).
// https://developers.brevo.com/docs/transactional-webhooks
export interface BrevoWebhookEvent {
  event: string            // delivered | hardBounce | softBounce | blocked | spam | invalid | …
  email: string
  'message-id'?: string
  messageId?: string
  reason?: string
  ts?: number
  tag?: string
  tags?: string[]
}
