// The ONE file that calls Meta's Graph API for WhatsApp. Everything else talks
// to the `WhatsAppGraph` interface, so tests swap in a fake and a Graph version
// bump is a change here and in META_GRAPH_VERSION only.
import { getSecret } from '../utils/secrets'
import { META_APP_ID, META_APP_SECRET, META_GRAPH_VERSION } from './config'

export class WhatsAppGraphError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: number | null,
  ) {
    super(message)
    this.name = 'WhatsAppGraphError'
  }
}

export interface WhatsAppPhoneNumber {
  display_phone_number: string | null
  verified_name: string | null
  quality_rating: string | null
  is_on_biz_app: boolean | null
  platform_type: string | null
}

export interface WhatsAppRemoteTemplate {
  name: string
  language: string
  status: string
  rejected_reason?: string | null
}

export interface WhatsAppGraph {
  /** Embedded Signup's code → the studio's business integration token. */
  exchangeCode(code: string): Promise<string>
  getPhoneNumber(token: string, phoneNumberId: string): Promise<WhatsAppPhoneNumber>
  /** The number ids on an account. Business App onboarding reports only the
   *  account id, so the number is found here. */
  listPhoneNumberIds(token: string, wabaId: string): Promise<string[]>
  subscribeApp(token: string, wabaId: string): Promise<void>
  unsubscribeApp(token: string, wabaId: string): Promise<void>
  listTemplates(token: string, wabaId: string): Promise<WhatsAppRemoteTemplate[]>
  createTemplate(token: string, wabaId: string, payload: Record<string, unknown>): Promise<{ status: string }>
  sendMessage(token: string, phoneNumberId: string, payload: Record<string, unknown>): Promise<{ messageId: string }>
}

const TIMEOUT_MS = 15_000

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  token: string | null,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION.value()}/${path}`)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const err = (json.error ?? {}) as { message?: string; code?: number }
    // Never include the request: the query of an exchange carries the app secret.
    throw new WhatsAppGraphError(err.message ?? `Graph ${method} ${path} failed`, res.status, err.code ?? null)
  }
  return json
}

export const metaGraph: WhatsAppGraph = {
  async exchangeCode(code) {
    const json = await call('GET', 'oauth/access_token', null, undefined, {
      client_id: META_APP_ID.value(),
      client_secret: await getSecret(META_APP_SECRET),
      code,
    })
    const token = json.access_token
    if (typeof token !== 'string' || !token) throw new WhatsAppGraphError('No access token in the exchange', 502, null)
    return token
  },

  async getPhoneNumber(token, phoneNumberId) {
    const json = await call('GET', encodeURIComponent(phoneNumberId), token, undefined, {
      fields: 'display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type',
    })
    return {
      display_phone_number: (json.display_phone_number as string) ?? null,
      verified_name: (json.verified_name as string) ?? null,
      quality_rating: (json.quality_rating as string) ?? null,
      is_on_biz_app: typeof json.is_on_biz_app === 'boolean' ? json.is_on_biz_app : null,
      platform_type: (json.platform_type as string) ?? null,
    }
  },

  async listPhoneNumberIds(token, wabaId) {
    const json = await call('GET', `${encodeURIComponent(wabaId)}/phone_numbers`, token, undefined, { fields: 'id' })
    return ((json.data as { id?: string }[]) ?? []).map((n) => n.id).filter((id): id is string => !!id)
  },

  async subscribeApp(token, wabaId) {
    await call('POST', `${encodeURIComponent(wabaId)}/subscribed_apps`, token)
  },

  async unsubscribeApp(token, wabaId) {
    await call('DELETE', `${encodeURIComponent(wabaId)}/subscribed_apps`, token)
  },

  async listTemplates(token, wabaId) {
    const json = await call('GET', `${encodeURIComponent(wabaId)}/message_templates`, token, undefined, {
      fields: 'name,language,status,rejected_reason',
      limit: '200',
    })
    return ((json.data as WhatsAppRemoteTemplate[]) ?? []).map((t) => ({
      name: t.name,
      language: t.language,
      status: t.status,
      rejected_reason: t.rejected_reason ?? null,
    }))
  },

  async createTemplate(token, wabaId, payload) {
    const json = await call('POST', `${encodeURIComponent(wabaId)}/message_templates`, token, payload)
    return { status: (json.status as string) ?? 'PENDING' }
  },

  async sendMessage(token, phoneNumberId, payload) {
    const json = await call('POST', `${encodeURIComponent(phoneNumberId)}/messages`, token, payload)
    const id = (json.messages as { id?: string }[] | undefined)?.[0]?.id
    if (!id) throw new WhatsAppGraphError('No message id in the send response', 502, null)
    return { messageId: id }
  },
}

let graph: WhatsAppGraph = metaGraph

export function whatsappGraph(): WhatsAppGraph {
  return graph
}

export function __setWhatsAppGraphForTests(g: WhatsAppGraph | null): void {
  graph = g ?? metaGraph
}
