// Provider-agnostic SMS contracts — the SMS sibling of types.ts. All application
// code sends through the SMS service (smsService.ts); the only file that knows
// about Brevo SMS is brevoSmsProvider.ts.

// A message to send. `to` is a raw phone number — the service normalizes it to
// E.164 (CH default) and refuses to send when it can't.
export interface OutboundSms {
  to: string
  /**
   * The contact this message is for, so the service can honour their
   * `sms_opt_out`. Required on purpose: a new caller has to say which person it
   * is texting, or say `null` for a send that is about no contact at all.
   */
  contactId: string | null
  /** Plain text. >160 chars is sent as multiple segments (billed per segment). */
  content: string
  /** Provider-side categorisation tag (e.g. 'booking-reminder'). */
  tag?: string
  /** App-level idempotency. Duplicate sends with the same key are skipped. */
  idempotencyKey?: string
}

export interface SmsProviderSendResult {
  providerMessageId: string
}

// The seam a concrete SMS provider implements. Sender is the resolved
// alphanumeric sender name (≤11 chars); recipient is E.164 without '+'-strip —
// passed exactly as normalized by the service.
export interface SmsProvider {
  send(msg: {
    recipient: string
    content: string
    sender: string
    tag?: string
  }): Promise<SmsProviderSendResult>
}
