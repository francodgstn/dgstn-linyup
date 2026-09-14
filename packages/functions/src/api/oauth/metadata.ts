// ─── Discovery documents ─────────────────────────────────────────────────────
//
// RFC 9728 protected resource metadata (the MCP endpoint) and RFC 8414
// authorization server metadata (Linyup). One origin serves both, so the issuer
// and the resource share a host.

import { API_MCP_PATH, API_SCOPES } from '@linyup/shared'

export function mcpResource(base: string): string {
  return `${base}${API_MCP_PATH}`
}

/** Where a 401 on the MCP endpoint points the client (RFC 9728 path-inserted form). */
export function resourceMetadataUrl(base: string): string {
  return `${base}/.well-known/oauth-protected-resource${API_MCP_PATH}`
}

export function protectedResourceMetadata(base: string) {
  return {
    resource: mcpResource(base),
    authorization_servers: [base],
    scopes_supported: [...API_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Linyup',
    resource_documentation: `${base}/v1/openapi.json`,
  }
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...API_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}
