// Linyup-owned WhatsApp templates: the create payload (provisioned into each
// studio's WhatsApp Business account at connect) and the send payload. Both
// payload builders are pure; `provisionLinyupTemplates` is the only writer.
import {
  WHATSAPP_LANGUAGES,
  WHATSAPP_LINYUP_TEMPLATES,
  whatsappTemplateStatusKey,
  type WhatsAppIntegration,
  type WhatsAppLanguage,
  type WhatsAppTemplateDefinition,
  type WhatsAppTemplateStatus,
} from '@linyup/shared'
import type { WhatsAppGraph, WhatsAppRemoteTemplate } from './graph'

function origin(appOrigin: string): string {
  return appOrigin.replace(/\/+$/, '')
}

export function buildTemplateCreatePayload(
  def: WhatsAppTemplateDefinition,
  language: WhatsAppLanguage,
  appOrigin: string,
): Record<string, unknown> {
  const components: Record<string, unknown>[] = [
    {
      type: 'BODY',
      text: def.body[language],
      example: {
        body_text_named_params: def.params.map((p) => ({ param_name: p.name, example: p.example })),
      },
    },
  ]
  if (def.urlButton) {
    components.push({
      type: 'BUTTONS',
      buttons: [
        {
          type: 'URL',
          text: def.urlButton.text[language],
          url: `${origin(appOrigin)}/{{1}}`,
          example: [`${origin(appOrigin)}/${def.urlButton.example}`],
        },
      ],
    })
  }
  return {
    name: def.name,
    language,
    category: def.category,
    parameter_format: 'NAMED',
    components,
  }
}

/** Meta refuses a parameter holding a newline, a tab or a run of spaces, and an
 *  empty one. */
export function cleanTemplateParam(value: string | null | undefined): string {
  const cleaned = (value ?? '').replace(/\s+/g, ' ').trim()
  return cleaned || '-'
}

/** A template send, for any template: its Meta name, language, the named body
 *  parameters in order, and the URL button's suffix when it has one. */
export function buildSendPayload(args: {
  toE164: string
  name: string
  language: string
  bodyParams: readonly { name: string; text: string | null | undefined }[]
  buttonSuffix?: string | null
}): Record<string, unknown> {
  const components: Record<string, unknown>[] = []
  if (args.bodyParams.length) {
    components.push({
      type: 'body',
      parameters: args.bodyParams.map((p) => ({
        type: 'text',
        parameter_name: p.name,
        text: cleanTemplateParam(p.text),
      })),
    })
  }
  if (args.buttonSuffix) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: args.buttonSuffix }],
    })
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: args.toE164.replace(/^\+/, ''),
    type: 'template',
    template: { name: args.name, language: { code: args.language }, ...(components.length ? { components } : {}) },
  }
}

/** A Linyup-owned template's send payload. */
export function buildTemplateSendPayload(args: {
  toE164: string
  def: WhatsAppTemplateDefinition
  language: WhatsAppLanguage
  params: Record<string, string>
  /** The dynamic part of the URL button — required when the template has one. */
  buttonSuffix?: string
}): Record<string, unknown> {
  const { def } = args
  if (def.urlButton && !args.buttonSuffix) throw new Error(`template ${def.name} needs a button suffix`)
  return buildSendPayload({
    toE164: args.toE164,
    name: def.name,
    language: args.language,
    bodyParams: def.params.map((p) => ({ name: p.name, text: args.params[p.name] })),
    buttonSuffix: def.urlButton ? args.buttonSuffix : null,
  })
}

/** The dynamic suffix of a URL-button link, or null when the link does not sit
 *  under the origin the template was provisioned with. */
export function buttonSuffixFor(url: string | null | undefined, appOrigin: string): string | null {
  if (!url) return null
  const prefix = `${origin(appOrigin)}/`
  return url.startsWith(prefix) && url.length > prefix.length ? url.slice(prefix.length) : null
}

const KNOWN_STATUSES: readonly WhatsAppTemplateStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED']

export function normaliseTemplateStatus(status: string | null | undefined): WhatsAppTemplateStatus {
  const upper = (status ?? '').toUpperCase() as WhatsAppTemplateStatus
  return KNOWN_STATUSES.includes(upper) ? upper : 'PENDING'
}

/** Linyup's templates only, keyed as the integration doc stores them; a
 *  template the account does not have reads MISSING. */
export function linyupTemplateStatuses(remote: readonly WhatsAppRemoteTemplate[]): WhatsAppIntegration['templates'] {
  const out: WhatsAppIntegration['templates'] = {}
  for (const def of WHATSAPP_LINYUP_TEMPLATES) {
    for (const language of WHATSAPP_LANGUAGES) {
      const found = remote.find((t) => t.name === def.name && t.language === language)
      out[whatsappTemplateStatusKey(def.name, language)] = found
        ? { status: normaliseTemplateStatus(found.status), reason: found.rejected_reason ?? null }
        : { status: 'MISSING', reason: null }
    }
  }
  return out
}

/** Creates whichever Linyup templates the account lacks; returns every status. */
export async function provisionLinyupTemplates(
  graph: WhatsAppGraph,
  token: string,
  wabaId: string,
  appOrigin: string,
): Promise<WhatsAppIntegration['templates']> {
  const remote = await graph.listTemplates(token, wabaId)
  const statuses = linyupTemplateStatuses(remote)
  for (const def of WHATSAPP_LINYUP_TEMPLATES) {
    for (const language of WHATSAPP_LANGUAGES) {
      const key = whatsappTemplateStatusKey(def.name, language)
      if (statuses[key].status !== 'MISSING') continue
      try {
        const created = await graph.createTemplate(token, wabaId, buildTemplateCreatePayload(def, language, appOrigin))
        statuses[key] = { status: normaliseTemplateStatus(created.status), reason: null }
      } catch (err) {
        statuses[key] = { status: 'MISSING', reason: (err as Error).message }
      }
    }
  }
  return statuses
}
