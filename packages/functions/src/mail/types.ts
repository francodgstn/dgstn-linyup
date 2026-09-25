// Provider-agnostic mail contracts. All application code sends through the mail
// service (mailService.ts); the only file that knows about Brevo is
// brevoProvider.ts. Swapping providers is a single adapter change.

export interface MailAttachment {
  filename: string
  content: Buffer | string
  contentType?: string
}

// The resolved sender identity for a message — the output of sender resolution.
export interface ResolvedSender {
  name: string
  email: string
  replyTo?: string
}

// A message to send, independent of who it is sent as.
export interface OutboundMessage {
  to: string | string[]
  subject: string
  html?: string
  text?: string
  // Overrides the sender's default Reply-To when set (rare).
  replyTo?: string
  attachments?: MailAttachment[]
  // Provider-side categorization (Brevo tags) — also used to namespace events.
  tags?: string[]
  // App-level idempotency. When set, a duplicate send with the same key is
  // skipped (see mailService) and the key is forwarded to the provider.
  idempotencyKey?: string
  // Machine-readable opt-out for BULK mail (RFC 2369). Mail clients render this
  // as their own "Unsubscribe" affordance, and the major inbox providers expect
  // it on bulk sends — without it a studio's outreach lands in spam far sooner.
  // A mailto: target only; true one-click (RFC 8058 List-Unsubscribe-Post)
  // additionally needs a public HTTP endpoint, which does not exist yet.
  // Transactional mail must NOT set this.
  listUnsubscribe?: string
}

export interface ProviderSendResult {
  providerMessageId: string
}

// The seam a concrete ESP implements. Given a fully-resolved sender + message,
// hand it to the provider. No business logic here — resolution, suppression,
// idempotency and test-mode all live in the service above this.
export interface MailProvider {
  send(msg: OutboundMessage, sender: ResolvedSender): Promise<ProviderSendResult>
}
