// ─── Client ID Metadata Documents ────────────────────────────────────────────
//
// An MCP client identifies itself with an HTTPS URL (`client_id`) whose JSON
// document names it and lists its redirect URIs. The authorization server
// fetches and validates that document before showing a consent page
// (MCP spec 2026-07-28, client-registration).
//
// Fetching a URL a stranger supplied is a server-side request forgery surface,
// so the fetch refuses: anything but HTTPS (loopback HTTP on the emulator only),
// IP-literal hosts, hosts that resolve to private or link-local addresses,
// redirects, bodies over 5 KB and anything slower than 3 s. The DNS check runs
// before the fetch, so a record that changes in between is not caught — the
// remaining exposure is one GET with no credentials and a tiny body limit.

import * as crypto from 'crypto'
import * as dns from 'dns/promises'
import * as net from 'net'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import {
  OAUTH_CLIENTS_COLLECTION,
  OAUTH_CLIENT_METADATA_TTL_MS,
  OAUTH_RECOGNISED_CLIENT_HOSTS,
  type OAuthClientRecord,
} from '@linyup/shared'

const FETCH_TIMEOUT_MS = 3000
const MAX_DOCUMENT_BYTES = 5 * 1024
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface ClientMetadata {
  client_id: string
  client_name: string
  client_uri: string | null
  logo_uri: string | null
  redirect_uris: string[]
}

export class ClientMetadataError extends Error {
  constructor(
    readonly reason:
      | 'invalid_client_id'
      | 'unsafe_host'
      | 'fetch_failed'
      | 'too_large'
      | 'invalid_document',
    message: string
  ) {
    super(message)
  }
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

/** Only the emulator accepts a loopback HTTP client_id, so a local client can be tested. */
export function allowLoopbackClients(env: Record<string, string | undefined> = process.env): boolean {
  return env.FUNCTIONS_EMULATOR === 'true'
}

/** Parse a client_id and refuse anything that is not a fetchable client identifier. */
export function parseClientIdUrl(raw: string, options: { allowLoopbackHttp: boolean }): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ClientMetadataError('invalid_client_id', 'client_id is not a URL')
  }
  if (url.username || url.password) throw new ClientMetadataError('invalid_client_id', 'client_id must not carry credentials')
  if (url.hash) throw new ClientMetadataError('invalid_client_id', 'client_id must not carry a fragment')
  if (url.pathname === '/' || url.pathname === '') throw new ClientMetadataError('invalid_client_id', 'client_id must have a path')
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && options.allowLoopbackHttp && isLoopbackHost(url.hostname)) return url
  throw new ClientMetadataError('invalid_client_id', 'client_id must be an https URL')
}

/** Private, loopback, link-local, CGNAT, multicast or reserved — never fetched in production. */
export function isNonPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return isNonPublicAddress(mapped[1])
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff')
  }
  return true
}

async function assertPublicHost(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(bare)) throw new ClientMetadataError('unsafe_host', 'client_id must use a host name, not an IP address')
  const lower = bare.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new ClientMetadataError('unsafe_host', 'client_id host is not public')
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await dns.lookup(bare, { all: true })
  } catch {
    throw new ClientMetadataError('fetch_failed', 'client_id host does not resolve')
  }
  if (addresses.length === 0 || addresses.some((a) => isNonPublicAddress(a.address))) {
    throw new ClientMetadataError('unsafe_host', 'client_id host resolves to a non-public address')
  }
}

function isAllowedRedirectUri(raw: unknown, allowLoopbackHttp: boolean): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const url = new URL(raw)
    if (url.hash) return false
    // Redirects to a loopback address over plain HTTP are how native and CLI
    // clients receive codes (RFC 8252 §7.3), in every environment.
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname)) || (allowLoopbackHttp && url.protocol === 'http:')
  } catch {
    return false
  }
}

/** Validate a fetched document against the client_id it was fetched for. */
export function validateClientMetadataDocument(doc: unknown, clientId: string, allowLoopbackHttp = false): ClientMetadata {
  const d = (doc ?? {}) as Record<string, unknown>
  const fail = (message: string) => new ClientMetadataError('invalid_document', message)
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw fail('the metadata document is not a JSON object')
  if (d.client_id !== clientId) throw fail('client_id in the document does not match the URL it was fetched from')
  if (typeof d.client_name !== 'string' || !d.client_name.trim() || d.client_name.length > 200) throw fail('client_name is required')
  if (!Array.isArray(d.redirect_uris) || d.redirect_uris.length === 0 || d.redirect_uris.length > 20) {
    throw fail('redirect_uris must list between 1 and 20 URIs')
  }
  if (!d.redirect_uris.every((u) => isAllowedRedirectUri(u, allowLoopbackHttp))) throw fail('a redirect_uri is not an allowed URI')
  if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== 'none') {
    throw fail('only public clients (token_endpoint_auth_method "none") are supported')
  }
  if (d.grant_types !== undefined && !(Array.isArray(d.grant_types) && d.grant_types.includes('authorization_code'))) {
    throw fail('grant_types must include authorization_code')
  }
  if (d.response_types !== undefined && !(Array.isArray(d.response_types) && d.response_types.includes('code'))) {
    throw fail('response_types must include code')
  }
  const httpsOrNull = (v: unknown) => {
    if (typeof v !== 'string') return null
    try {
      return new URL(v).protocol === 'https:' ? v : null
    } catch {
      return null
    }
  }
  return {
    client_id: clientId,
    client_name: d.client_name.trim(),
    client_uri: httpsOrNull(d.client_uri),
    logo_uri: httpsOrNull(d.logo_uri),
    redirect_uris: d.redirect_uris as string[],
  }
}

/**
 * Does the requested redirect_uri match a registered one? Exactly — except that
 * a loopback redirect may use any port (RFC 8252 §7.3), because a native client
 * picks a free port at run time.
 */
export function redirectUriAllowed(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true
  let req: URL
  try {
    req = new URL(requested)
  } catch {
    return false
  }
  if (req.protocol !== 'http:' || !isLoopbackHost(req.hostname)) return false
  return registered.some((r) => {
    try {
      const reg = new URL(r)
      return (
        reg.protocol === req.protocol &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      )
    } catch {
      return false
    }
  })
}

/** Is this a client the consent page may name as recognized? Display only. */
export function isRecognisedClient(clientId: string): boolean {
  try {
    const host = new URL(clientId).hostname.toLowerCase()
    return OAUTH_RECOGNISED_CLIENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

async function readLimited(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new ClientMetadataError('too_large', 'the metadata document is too large')
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new ClientMetadataError('too_large', 'the metadata document is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

/** Fetch and validate a client's metadata document. No caching here. */
export async function fetchClientMetadata(
  clientId: string,
  options: { allowLoopbackHttp: boolean; fetchImpl?: typeof fetch; skipDnsCheck?: boolean }
): Promise<ClientMetadata> {
  const url = parseClientIdUrl(clientId, options)
  const loopback = isLoopbackHost(url.hostname)
  if (!loopback && !options.skipDnsCheck) await assertPublicHost(url.hostname)
  let res: Response
  try {
    res = await (options.fetchImpl ?? fetch)(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
  } catch {
    throw new ClientMetadataError('fetch_failed', 'the metadata document could not be fetched')
  }
  if (res.status !== 200) throw new ClientMetadataError('fetch_failed', `the metadata document answered ${res.status}`)
  const text = await readLimited(res, MAX_DOCUMENT_BYTES)
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new ClientMetadataError('invalid_document', 'the metadata document is not JSON')
  }
  return validateClientMetadataDocument(doc, clientId, options.allowLoopbackHttp)
}

/** The client's metadata, from the 24-hour cache or freshly fetched. */
export async function loadClientMetadata(clientId: string, nowMs: number = Date.now()): Promise<ClientMetadata> {
  const allowLoopbackHttp = allowLoopbackClients()
  const ref = admin
    .firestore()
    .collection(OAUTH_CLIENTS_COLLECTION)
    .doc(crypto.createHash('sha256').update(clientId, 'utf8').digest('hex'))
  const cached = await ref.get()
  const data = cached.data() as OAuthClientRecord | undefined
  if (data && data.client_id === clientId && data.expires_at.toMillis() > nowMs) {
    return {
      client_id: data.client_id,
      client_name: data.client_name,
      client_uri: data.client_uri,
      logo_uri: data.logo_uri,
      redirect_uris: data.redirect_uris,
    }
  }
  const meta = await fetchClientMetadata(clientId, { allowLoopbackHttp })
  const record: OAuthClientRecord = {
    ...meta,
    fetched_at: Timestamp.fromMillis(nowMs),
    expires_at: Timestamp.fromMillis(nowMs + OAUTH_CLIENT_METADATA_TTL_MS),
  }
  await ref.set(record)
  return meta
}
