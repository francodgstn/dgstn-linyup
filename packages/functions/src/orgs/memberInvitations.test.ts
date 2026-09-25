/**
 * ORG MEMBER INVITATIONS — the properties that only the SOURCE can settle, plus
 * the two pure derivations (the doc id and the emailed link).
 *
 * Same idiom, and for the same reason, as ./orgTierRails.test.ts: most of what
 * makes this rail safe is a property of the TEXT — which guard sits in front of
 * which callable, which collection a module is allowed to touch, whether a
 * link went through the locale-pinned builder — and no runtime assertion in a
 * mocked Firestore would notice any of it.
 *
 * The claim it exists to protect above all others: THIS RAIL AND THE
 * TEAM-INTO-ORG RAIL ARE DIFFERENT RELATIONSHIPS. `org_invitations` enrolls a
 * whole studio and moves its billing; `org_member_invitations` grants one
 * person a row in `org_members`. Conflating them in code or in copy is the
 * failure mode this whole file is watching for.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  localizedAppUrl,
  orgMemberInvitationId,
  orgMemberInvitePath,
} from '@linyup/shared'
import { sha256Hex } from '../utils/crypto'

const SRC = join(__dirname, '..')
const ROOT = join(SRC, '..', '..', '..')
const WEB = join(ROOT, 'apps', 'web', 'src')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}
function readRoot(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}
function readWeb(rel: string): string {
  return readFileSync(join(WEB, rel), 'utf8').replace(/\r\n/g, '\n')
}
/** CODE only — this module explains its own hazards in prose, and the prose
 *  necessarily names the things that must not appear in the code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}
/** One callable's body, sliced out by its declaration. */
function callable(source: string, name: string): string {
  const parts = source.split(`export const ${name} = onCall(`)
  assert.ok(parts[1], `${name} is not declared where it was expected`)
  return parts[1].split('\n})')[0]
}

const INVITES = read('orgs/memberInvitations.ts')
const MEMBERS = read('orgs/members.ts')
const SWEEP = read('dailyTasks/expireOrgMemberInvitations.ts')

// ─────────────────────────────────────────────────────────────────────────────
// The doc id — "the same address is invited twice"
// ─────────────────────────────────────────────────────────────────────────────

describe('orgMemberInvitationId', () => {
  it('is deterministic, so a re-invite REWRITES one row instead of minting a second live token', () => {
    assert.equal(
      orgMemberInvitationId('sam@example.com', sha256Hex),
      orgMemberInvitationId('sam@example.com', sha256Hex)
    )
  })

  it('normalises case and surrounding space — "Sam@" and "sam@" are one person', () => {
    const canonical = orgMemberInvitationId('sam@example.com', sha256Hex)
    assert.equal(orgMemberInvitationId('  Sam@Example.com ', sha256Hex), canonical)
  })

  it('separates different addresses', () => {
    assert.notEqual(
      orgMemberInvitationId('sam@example.com', sha256Hex),
      orgMemberInvitationId('sam+admin@example.com', sha256Hex)
    )
  })

  it('is safe as a Firestore doc id — hex only, no slash, not a reserved name', () => {
    // A raw address is legal doc-id input only by luck: '/' is valid in an RFC
    // 5322 local part and would silently re-target the document path.
    const id = orgMemberInvitationId('a/b@example.com', sha256Hex)
    assert.match(id, /^[0-9a-f]{40}$/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The emailed link
// ─────────────────────────────────────────────────────────────────────────────

describe('the invitation link', () => {
  const ORIGIN = 'https://app.linyup.com'

  it('is locale-pinned, and the default locale stays unprefixed', () => {
    const path = orgMemberInvitePath('org1', 'tok_abc')
    assert.equal(localizedAppUrl(ORIGIN, 'de', path), `${ORIGIN}/de/org-member-invite/org1/tok_abc`)
    assert.equal(localizedAppUrl(ORIGIN, 'en', path), `${ORIGIN}/org-member-invite/org1/tok_abc`)
    // An unknown locale degrades to the default language, never to a 404 path.
    assert.equal(localizedAppUrl(ORIGIN, 'xx', path), `${ORIGIN}/org-member-invite/org1/tok_abc`)
    assert.equal(localizedAppUrl(ORIGIN, null, path), `${ORIGIN}/org-member-invite/org1/tok_abc`)
  })

  it('is NOT the team-into-org accept route', () => {
    // /org-invite/{orgId}/{invId} asks a studio owner to enroll their studio and
    // move its billing. A person invited personally must never land there.
    assert.ok(!orgMemberInvitePath('org1', 'tok').startsWith('/org-invite/'))
  })

  it('is built through the shared builder, never string-concatenated at the call site', () => {
    const invite = code(callable(INVITES, 'inviteOrgMember'))
    assert.ok(
      invite.includes('localizedAppUrl(') && invite.includes('orgMemberInvitePath('),
      'the accept URL must go through the shared locale-pinned builder',
    )
    assert.ok(
      !/\$\{getHostingUrl\(\)\}\/org-member-invite/.test(invite),
      'an unprefixed `${getHostingUrl()}/…` link opens in the READER’s browser language, ' +
        'not the one the mail was written in',
    )
  })

  it('the route the link points at actually exists in the web app', () => {
    // A link nobody can land on is the failure the emailed-link builders were
    // introduced to stop. This one is checked against the file tree.
    const page = readWeb('app/[locale]/org-member-invite/[orgId]/[token]/page.tsx')
    assert.ok(page.includes("useTranslations('OrgMemberInvite')"))
    assert.ok(page.includes("'getOrgMemberInvitation'"))
    assert.ok(page.includes("'acceptOrgMemberInvitation'"))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The two invitations must not be conflated
// ─────────────────────────────────────────────────────────────────────────────

describe('org MEMBER invitations are not org TEAM invitations', () => {
  it('the collections are different, and this module touches only its own', () => {
    assert.ok(INVITES.includes('ORG_MEMBER_INVITATIONS_SUBCOLLECTION'))
    assert.ok(
      !code(INVITES).includes('ORG_INVITATIONS_SUBCOLLECTION') &&
        !code(INVITES).includes("'org_invitations'"),
      'the member-invitation rail must never read or write the team-invitation collection',
    )
  })

  it('accepting one grants a MEMBERSHIP and moves no billing and no studio', () => {
    const src = code(INVITES)
    for (const forbidden of [
      'ORG_TEAMS_SUBCOLLECTION',
      'org_teams',
      'saas_subscriptions',
      'trial_ends_at',
      'plan_status',
      "collection('teams')",
    ]) {
      assert.ok(
        !src.includes(forbidden),
        `memberInvitations.ts mentions "${forbidden}" — that belongs to the team-into-org rail, ` +
          'which enrolls a studio and changes its billing. This one grants a person a row in org_members.',
      )
    }
  })

  it('the invitation email says so in words — no studio, no billing', () => {
    const invite = callable(INVITES, 'inviteOrgMember')
    const body = invite.split('buildEmailTemplate(')[1] ?? ''
    assert.ok(body, 'inviteOrgMember composes no email at all')
    assert.ok(
      /does not change anything about[\s\S]*studio/.test(body) && /billing/.test(body),
      'the copy must state what this invitation is NOT — a reader who has just been told ' +
        '"you have been invited" by the OTHER rail has every reason to assume their studio is being enrolled',
    )
  })

  it('the accept page never asks which team you own', () => {
    const page = code(readWeb('app/[locale]/org-member-invite/[orgId]/[token]/page.tsx'))
    assert.ok(
      !/selectTeam|teamId|acceptOrgInvitation/.test(page),
      'the team-selection step belongs to /org-invite; this page grants a person a role',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The token proves a mailbox, not an identity
// ─────────────────────────────────────────────────────────────────────────────

describe('accepting requires the invited ADDRESS, not merely the token', () => {
  const accept = callable(INVITES, 'acceptOrgMemberInvitation')

  it('compares the signed-in account address with the invited one and refuses on a mismatch', () => {
    assert.ok(
      accept.includes('request.auth.token.email'),
      "the caller's address must come from Firebase Auth's record, never from the request payload",
    )
    assert.ok(accept.includes("callerEmail !== inv.email"))
    assert.ok(accept.includes("reason: 'email_mismatch'"))
  })

  it('refuses BEFORE anything is granted', () => {
    const guardAt = accept.indexOf("reason: 'email_mismatch'")
    const grantAt = accept.indexOf('grantOrgMembership(')
    assert.ok(guardAt > -1 && grantAt > -1)
    assert.ok(guardAt < grantAt, 'the address check must precede the grant, not follow it')
  })

  it('never re-points the invitation at whoever turned up', () => {
    // Silently attaching the wrong identity is the failure this rail exists to
    // avoid; "helpfully" rewriting `email` to the caller's address would turn a
    // forwarded link into a transferable grant.
    const src = code(INVITES)
    assert.ok(
      !/email:\s*callerEmail/.test(src),
      'nothing may write the caller’s address into the invitation',
    )
  })

  it('declining is bound to the same address', () => {
    const decline = callable(INVITES, 'declineOrgMemberInvitation')
    assert.ok(
      decline.includes("reason: 'email_mismatch'"),
      'anyone holding a forwarded link could otherwise close somebody else’s invitation',
    )
  })

  it('re-reads the invitation inside the transaction and re-checks the token', () => {
    // A re-invite ROTATES the token. Without this, an older mail's link could
    // accept the newer invitation.
    assert.ok(accept.includes('await tx.get(invRef)'))
    assert.ok(accept.includes("current.token !== data.token"))
  })

  it('answers the double-submit BEFORE comparing the token, or that arm is dead code', () => {
    // Every terminal transition deletes the token, so a token comparison placed
    // first would answer "not found" to the one person entitled to "you are
    // already in". The document was located BY the token in the read above.
    const accept = callable(INVITES, 'acceptOrgMemberInvitation')
    const idempotent = accept.indexOf("current.status === 'accepted' && current.acceptedBy === uid")
    const tokenCheck = accept.indexOf('current.token !== data.token')
    assert.ok(idempotent > -1 && tokenCheck > -1)
    assert.ok(idempotent < tokenCheck)
  })

  it('spends the token — an accepted, declined or revoked invitation keeps no credential', () => {
    for (const name of [
      'acceptOrgMemberInvitation',
      'declineOrgMemberInvitation',
      'revokeOrgMemberInvitation',
    ] as const) {
      assert.ok(
        callable(INVITES, name).includes('token: FieldValue.delete()'),
        `${name} leaves a spent token in a document an org admin can read`,
      )
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Authorization + the last-admin guard
// ─────────────────────────────────────────────────────────────────────────────

describe('authorization follows UX-75s shape', () => {
  it('the two admin-only callables go through assertOrgAdmin', () => {
    for (const name of ['inviteOrgMember', 'revokeOrgMemberInvitation'] as const) {
      assert.ok(
        callable(INVITES, name).includes('await assertOrgAdmin('),
        `${name} is an unguarded org callable`,
      )
    }
  })

  it('never reaches for a team_members check', () => {
    assert.ok(!/hasTeamRole|assertOwner|assertManager/.test(code(INVITES)))
  })

  it('the invitee-facing read is deliberately unauthenticated', () => {
    // The invitee may have no account at all, so no rule and no signed-in read
    // could ever match them. The token is the credential.
    const details = callable(INVITES, 'getOrgMemberInvitation')
    assert.ok(
      !details.includes("throw new HttpsError('unauthenticated'"),
      'gating the details read on a signed-in user would shut out exactly the people this rail is for',
    )
  })

  it('an invitation does NOT interact with the last-admin guard', () => {
    // An invitation grants nothing until accepted, so it must neither satisfy
    // the guard (an unopened mailbox is not an administrator, and counting one
    // would let the last admin leave against a link nobody may ever click) nor
    // be blocked by it (sending one takes no admin away).
    const guard = MEMBERS.split('async function assertNotLastAdmin(')[1].split('\n}')[0]
    assert.ok(
      guard.includes('membersRef(orgId)'),
      'the guard must count MEMBERSHIPS',
    )
    assert.ok(
      !/invitation/i.test(code(guard)),
      'the last-admin guard must not consult invitations',
    )
    assert.ok(
      !code(INVITES).includes('assertNotLastAdmin'),
      'sending or revoking an invitation takes no admin away — there is nothing for the guard to protect',
    )
  })

  it('the membership write goes through the ONE shared writer', () => {
    assert.ok(MEMBERS.includes('export async function grantOrgMembership('))
    assert.ok(callable(INVITES, 'acceptOrgMemberInvitation').includes('grantOrgMembership('))
    assert.ok(
      !code(INVITES).includes('ORG_MEMBERS_SUBCOLLECTION'),
      'the invitation rail must not write org_members itself — a second writer is how a person ends up ' +
        'in an org their sidebar cannot find (users/{uid}.orgIds is the other half of the same fact)',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Expiry
// ─────────────────────────────────────────────────────────────────────────────

describe('expiry', () => {
  it('is enforced at ACCEPT, so the sweep never authorizes anything', () => {
    for (const name of ['getOrgMemberInvitation', 'acceptOrgMemberInvitation'] as const) {
      assert.ok(
        callable(INVITES, name).includes('expired('),
        `${name} does not compare the deadline itself — if the sweep is what refuses an expired ` +
          'invitation, a failed sweep is an open door',
      )
    }
    assert.ok(INVITES.includes('expires_at.toMillis() <= Date.now()'))
  })

  it('the sweep is idempotent by construction: it selects what it then stops matching', () => {
    assert.ok(SWEEP.includes("where('status', '==', 'pending')"))
    assert.ok(SWEEP.includes("where('expires_at', '<=', now)"))
    assert.ok(SWEEP.includes("status: 'expired'"))
  })

  it('the sweep notifies nobody — there is nothing that could double-fire', () => {
    assert.ok(
      !/sendEmail|sendSystemMail|sendStudioMail|notify/i.test(code(SWEEP)),
      'an expiry notice would be the one part of this that could be sent twice',
    )
  })

  it('is registered in the established daily home', () => {
    const daily = read('dailyTasks/index.ts')
    assert.ok(daily.includes("import { expireOrgMemberInvitations }"))
    assert.ok(daily.includes("{ name: 'expireOrgMemberInvitations', handler: expireOrgMemberInvitations }"))
  })

  it('has the collection-group index its query needs', () => {
    // The emulator answers a collectionGroup query with no index; a real project
    // does not, and the failure only shows up in production.
    const indexes = JSON.parse(readRoot('firestore.index.json')) as {
      indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string }[] }[]
    }
    const idx = indexes.indexes.find((i) => i.collectionGroup === 'org_member_invitations')
    assert.ok(idx, 'no index for org_member_invitations')
    assert.equal(idx!.queryScope, 'COLLECTION_GROUP')
    assert.deepEqual(
      idx!.fields.map((f) => f.fieldPath),
      ['status', 'expires_at'],
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Rules, wiring, and the account the invitee may not have
// ─────────────────────────────────────────────────────────────────────────────

describe('wiring', () => {
  it('the new collection is CLOSED in firestore.rules', () => {
    const rules = readRoot('firestore.rules')
    const block = rules.split('match /org_member_invitations/{invitationId} {')[1]
    assert.ok(block, 'org_member_invitations has no rule at all — a new collection needs one')
    const body = block.split('}')[0]
    assert.ok(
      body.includes('allow write: if false'),
      'every write must go through a callable — a client write could mint a membership grant for any address',
    )
    assert.ok(
      body.includes("allow read: if hasOrgRole(orgId, 'org_admin')"),
      'a pending row carries a bearer token and rules cannot withhold one field, so an org_viewer must not read it',
    )
  })

  it('every callable is exported from the functions entrypoint, or it does not exist at runtime', () => {
    const entry = read('index.ts')
    for (const name of [
      'inviteOrgMember',
      'getOrgMemberInvitation',
      'acceptOrgMemberInvitation',
      'declineOrgMemberInvitation',
      'revokeOrgMemberInvitation',
    ]) {
      assert.ok(entry.includes(name), `${name} is not exported from src/index.ts`)
    }
  })

  it('the invitee is allowed to create the account the invitation is waiting for', () => {
    // beforeSignup fails CLOSED while public signup is closed — which is today's
    // posture — and the one address this invitation is for is exactly the one it
    // would refuse. Without this the whole rail is dead on arrival.
    const invite = callable(INVITES, 'inviteOrgMember')
    assert.ok(invite.includes('SIGNUP_ALLOWLIST_COLLECTION'))
    assert.ok(
      invite.includes("source: 'org_member_invitation'"),
      'an entry a customer caused must be distinguishable from one an operator added',
    )
  })

  it('the Members tab sends an invitation rather than the grant that could not reach a stranger', () => {
    const page = readWeb('app/[locale]/(auth)/org/[orgId]/members/page.tsx')
    // Either spelling of a call — `httpsCallable(functions, 'x')` or `callFunction('x')`:
    // the page changed from one to the other when the org callables moved behind a router.
    const calls = (name: string) =>
      new RegExp(
        `(?:httpsCallable\\(functions,\\s*|callFunction(?:<[^()]*>)?\\(\\s*)'${name}'`
      ).test(page)
    assert.ok(calls('inviteOrgMember'))
    assert.ok(
      !calls('addOrgMember'),
      'addOrgMember refuses an address with no Linyup account — a dead end, which is what decision 12 fixed',
    )
  })
})
