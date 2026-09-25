/**
 * TWO BILLING RAILS, ONE PER AUTHORIZATION MODEL (UX-75).
 *
 * `saas_subscriptions/{entityId}` is billed to a team OR an organization, and
 * the two are authorized through different documents:
 *
 *   team → teams/{teamId}/team_members/{uid}          (hasTeamRole 'owner')
 *   org  → organizations/{orgId}/org_members/{uid}    (assertOrgAdmin)
 *
 * `firestore.rules` has always said exactly that (`match /saas_subscriptions/
 * {entityId}` allows a team owner or an org admin to read). The CALLABLES did
 * not: all four guarded with the team check while taking a parameter named
 * `teamId` that the org page filled with an org id, so an org admin was refused
 * `permission-denied` on cancel, reactivate, portal and invoices alike — and
 * kept being charged.
 *
 * These assertions read the SOURCE, like `../connect/commitSites.test.ts`, and
 * for the same reason: the claim is about which guard sits in front of which
 * callable and which callable the client actually calls, which is a property of
 * the text, and the last one crosses the functions/web boundary — where a
 * correction stops traveling.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')
const ROOT = join(SRC, '..', '..', '..')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}
function readRoot(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** CODE only — same idiom as `../connect/commitSites.test.ts`. Both files under
 *  test EXPLAIN the bug in prose, and the prose necessarily names the thing that
 *  must not appear in the code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** The org rail, named — a member added here must be added everywhere below. */
const ORG_CALLABLES = [
  'cancelOrgSubscription',
  'reactivateOrgSubscription',
  'getOrgBillingPortalUrl',
  'getOrgInvoices',
] as const

/** Its team counterpart, in the same order. */
const TEAM_CALLABLES = [
  'cancelSaasSubscription',
  'reactivateSaasSubscription',
  'getBillingPortalUrl',
  'getSaasInvoices',
] as const

describe('org billing rail', () => {
  const orgBilling = read('orgs/billing.ts')

  it('every org billing callable exists and is guarded by the org-admin check', () => {
    for (const name of ORG_CALLABLES) {
      const body = orgBilling.split(`export const ${name} = onCall(`)[1]
      assert.ok(body, `${name} is not declared in orgs/billing.ts`)
      const decl = body.split('\n})')[0]
      assert.ok(
        decl.includes('requireOrgAdmin('),
        `${name} does not go through requireOrgAdmin — an unguarded billing callable`,
      )
    }
    assert.ok(orgBilling.includes('await assertOrgAdmin(auth.uid, orgId)'))
  })

  it('takes orgId on the wire, and never a parameter named teamId', () => {
    assert.ok(!/\bteamId\b/.test(code(orgBilling)), 'orgs/billing.ts must not name anything teamId')
    for (const name of ORG_CALLABLES) {
      assert.ok(orgBilling.includes(name))
    }
    assert.ok(orgBilling.includes("orgId?: string"))
  })

  it('is exported from the functions entrypoint, or it does not exist at runtime', () => {
    const entry = read('index.ts')
    for (const name of ORG_CALLABLES) {
      assert.ok(entry.includes(name), `${name} is not exported from src/index.ts`)
    }
  })
})

describe('team billing rail', () => {
  const teamBilling = read('saas-billing/index.ts')

  it('the team owner check is never applied to something called an org id', () => {
    assert.ok(!/assertOwner\([^)]*orgId/.test(teamBilling))
  })

  it('the four team callables still guard with assertOwner on data.teamId', () => {
    for (const name of TEAM_CALLABLES) {
      const body = teamBilling.split(`export const ${name} = onCall(`)[1]
      assert.ok(body, `${name} is not declared in saas-billing/index.ts`)
      const decl = body.split('\n})')[0]
      assert.ok(
        decl.includes('await assertOwner(request.auth.uid, data.teamId)'),
        `${name} lost its team-owner guard`,
      )
    }
  })

  it('both rails run the SAME Stripe work, so "cancel" cannot mean two things', () => {
    const actions = read('saas-billing/actions.ts')
    const orgBilling = read('orgs/billing.ts')
    for (const fn of [
      'cancelSubscriptionFor',
      'reactivateSubscriptionFor',
      'billingPortalUrlFor',
      'invoicesFor',
    ]) {
      assert.ok(actions.includes(`export async function ${fn}`), `${fn} is not in actions.ts`)
      assert.ok(teamBilling.includes(`${fn}(`), `the team rail no longer calls ${fn}`)
      assert.ok(orgBilling.includes(`${fn}(`), `the org rail no longer calls ${fn}`)
    }
  })
})

describe('the web client calls the rail it is on', () => {
  it('the shared hook dispatches to the org callables under scope org', () => {
    const hook = readRoot('apps/web/src/hooks/useSaasBilling.ts')
    for (const name of ['cancelOrgSubscription', 'reactivateOrgSubscription', 'getOrgBillingPortalUrl']) {
      assert.ok(hook.includes(name), `useSaasBilling.ts never names ${name}`)
    }
  })

  it('the org billing page asks for the ORG invoices', () => {
    const page = code(readRoot('apps/web/src/app/[locale]/(auth)/org/[orgId]/billing/page.tsx'))
    assert.ok(page.includes('getOrgInvoices'))
    assert.ok(
      !page.includes('getSaasInvoices'),
      'the org page is back on the team-guarded invoices callable, which renders a refusal as "no invoices"',
    )
  })
})
