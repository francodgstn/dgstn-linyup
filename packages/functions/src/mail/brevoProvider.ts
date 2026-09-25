import { getBrevoClient } from './brevoClient'
import type { MailProvider, OutboundMessage, ProviderSendResult, ResolvedSender } from './types'

function toRecipients(to: string | string[]): { email: string }[] {
  return (Array.isArray(to) ? to : [to]).map((email) => ({ email }))
}

function toBase64(content: Buffer | string): string {
  return Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content, 'utf8').toString('base64')
}

// Brevo implementation of the MailProvider seam. Maps our provider-agnostic
// OutboundMessage onto Brevo's sendTransacEmail request. The only place in the
// codebase that imports the Brevo SDK for sending.
export const brevoProvider: MailProvider = {
  async send(msg: OutboundMessage, sender: ResolvedSender): Promise<ProviderSendResult> {
    const client = await getBrevoClient()

    const replyToEmail = msg.replyTo || sender.replyTo
    const headers: Record<string, unknown> = {}
    // Brevo honors an Idempotency-Key header on transactional sends.
    if (msg.idempotencyKey) headers['Idempotency-Key'] = msg.idempotencyKey
    // RFC 2369. Set only by bulk senders (outreach); transactional mail omits it.
    if (msg.listUnsubscribe) headers['List-Unsubscribe'] = msg.listUnsubscribe

    const res = await client.transactionalEmails.sendTransacEmail({
      sender: { name: sender.name, email: sender.email },
      to: toRecipients(msg.to),
      ...(replyToEmail ? { replyTo: { email: replyToEmail } } : {}),
      subject: msg.subject,
      ...(msg.html ? { htmlContent: msg.html } : {}),
      ...(msg.text ? { textContent: msg.text } : {}),
      ...(msg.tags && msg.tags.length ? { tags: msg.tags } : {}),
      ...(msg.attachments && msg.attachments.length
        ? { attachment: msg.attachments.map((a) => ({ name: a.filename, content: toBase64(a.content) })) }
        : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    })

    return { providerMessageId: res.messageId ?? '' }
  },
}
