import * as assert from 'node:assert'
import { publicBaseUrl } from './index'

// The OpenAPI `servers` URL, per place the function answers. The request path
// is useless for this — the runtime strips the function prefix — so the host
// and the environment decide.

function req(host: string, headers: Record<string, string> = {}, protocol = 'http') {
  const all: Record<string, string> = { host, ...headers }
  return { protocol, get: (name: string) => all[name.toLowerCase()] } as Parameters<typeof publicBaseUrl>[0]
}

describe('public API base URL', () => {
  it('uses API_BASE_URL when the environment sets it', () => {
    assert.strictEqual(publicBaseUrl(req('anything'), { API_BASE_URL: 'https://api.linyup.com/' }), 'https://api.linyup.com')
  })

  it('adds the emulator’s project/region/function prefix', () => {
    assert.strictEqual(
      publicBaseUrl(req('127.0.0.1:25001'), { FUNCTIONS_EMULATOR: 'true', GCLOUD_PROJECT: 'demo-linyup' }),
      'http://127.0.0.1:25001/demo-linyup/europe-west6/api'
    )
  })

  it('adds the function name on a cloudfunctions.net host, and nothing behind the api domain', () => {
    assert.strictEqual(
      publicBaseUrl(req('europe-west6-linyup-staging.cloudfunctions.net', { 'x-forwarded-proto': 'https' }), {}),
      'https://europe-west6-linyup-staging.cloudfunctions.net/api'
    )
    assert.strictEqual(publicBaseUrl(req('api.linyup.com', { 'x-forwarded-proto': 'https,http' }), {}), 'https://api.linyup.com')
  })
})
