// The contact login chain — sendContactVerificationCode → loginContactWithCode →
// switchActiveContact — tested at the seams that decide it. Each callable reads
// `admin.firestore()` at call time with no injected db (see the header of
// loginContactWithCode.test.ts for why they cannot be invoked here), so the
// decisions were lifted into pure modules and the wiring is pinned by reading
// the SOURCE, the same technique that file uses.
//
// The one behavior every case here circles: `login_emails`. A parent whose
// address is on two children's allow-lists must be matched (both), must be
// able to pick one, and must be able to SWITCH to the other afterwards — the
// last of which was refused until `switchActiveContact` adopted the shared
// predicate.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAllowedTeamIds, selectLoginCandidates } from './loginCandidates'
import {
  distinctTeamIds,
  summarizeCodeRequest,
  toMatchedContactSummary,
} from './codeRequestSummary'
import { contactAcceptsLoginEmail } from '../utils/contactSession'

const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')

describe('contactAcceptsLoginEmail — the ONE "may this email sign in as this contact" rule', () => {
  const child = {
    email: 'kid@example.com',
    login_emails: ['Parent@Example.com', ' other@example.com '],
  }

  it('accepts the primary email, case- and whitespace-insensitively', () => {
    assert.equal(contactAcceptsLoginEmail(child, 'kid@example.com'), true)
    assert.equal(contactAcceptsLoginEmail(child, '  KID@example.com '), true)
    assert.equal(contactAcceptsLoginEmail({ email: 'A@B.C' }, 'a@b.c'), true)
  })

  it('accepts a login_emails entry (the parent), normalized on both sides', () => {
    assert.equal(contactAcceptsLoginEmail(child, 'parent@example.com'), true)
    assert.equal(contactAcceptsLoginEmail(child, 'OTHER@example.com'), true)
  })

  it('refuses everything else, and never throws on a malformed document', () => {
    assert.equal(contactAcceptsLoginEmail(child, 'stranger@example.com'), false)
    assert.equal(contactAcceptsLoginEmail(child, ''), false)
    assert.equal(contactAcceptsLoginEmail(child, null), false)
    assert.equal(contactAcceptsLoginEmail({}, 'kid@example.com'), false)
    assert.equal(
      contactAcceptsLoginEmail(
        { email: 42, login_emails: 'parent@example.com' },
        'parent@example.com'
      ),
      false
    )
    assert.equal(
      contactAcceptsLoginEmail(
        { login_emails: [null, 7, 'parent@example.com'] },
        'parent@example.com'
      ),
      true
    )
  })

  it('is what BOTH session-minting doors read — no inline primary-only check survives', () => {
    const session = src('../utils/contactSession.ts')
    const switching = src('../contacts/switchActiveContact.ts')
    assert.match(session, /contactAcceptsLoginEmail\(\{ email: contactEmail/)
    assert.match(switching, /contactAcceptsLoginEmail\(contactDoc\.data\(\)/)
    assert.doesNotMatch(switching, /contactEmail !== claimEmail/)
  })
})

describe('selectLoginCandidates — which contacts a verified email may sign in as', () => {
  const c = (id: string, teamId: string | null, extra: Record<string, unknown> = {}) => ({
    id,
    teamId,
    ...extra,
  })
  const open = { teamId: null, allowedTeamIds: null }

  it('keeps a primary-email match', () => {
    assert.deepEqual(
      selectLoginCandidates([c('me', 't1')], [], open).map((x) => x.id),
      ['me']
    )
  })

  it('keeps login_emails-only matches — a parent sees BOTH children', () => {
    const kids = [c('kid-a', 't1'), c('kid-b', 't1')]
    assert.deepEqual(
      selectLoginCandidates([], kids, open).map((x) => x.id),
      ['kid-a', 'kid-b']
    )
  })

  it('dedupes a contact matched by both sources, primary order first', () => {
    const primary = [c('me', 't1')]
    const allow = [c('me', 't1'), c('kid', 't1')]
    assert.deepEqual(
      selectLoginCandidates(primary, allow, open).map((x) => x.id),
      ['me', 'kid']
    )
  })

  it('drops archived and deleted contacts from either source', () => {
    const primary = [c('gone', 't1', { archived_at: new Date() }), c('me', 't1')]
    const allow = [c('kid', 't1', { deleted_at: new Date() })]
    assert.deepEqual(
      selectLoginCandidates(primary, allow, open).map((x) => x.id),
      ['me']
    )
  })

  it('a team-scoped code admits only that team', () => {
    const primary = [c('me-t1', 't1'), c('me-t2', 't2')]
    const allow = [c('kid-t2', 't2')]
    assert.deepEqual(
      selectLoginCandidates(primary, allow, { teamId: 't2', allowedTeamIds: null }).map(
        (x) => x.id
      ),
      ['me-t2', 'kid-t2']
    )
  })

  it('a cross-team code narrows to the teams recorded on it', () => {
    const primary = [c('me-t1', 't1'), c('me-t2', 't2'), c('me-t3', 't3')]
    assert.deepEqual(
      selectLoginCandidates(primary, [], { teamId: null, allowedTeamIds: ['t1', 't3'] }).map(
        (x) => x.id
      ),
      ['me-t1', 'me-t3']
    )
    // A contact with no team cannot satisfy a narrowing list.
    assert.deepEqual(
      selectLoginCandidates([c('orphan', null)], [], { teamId: null, allowedTeamIds: ['t1'] }),
      []
    )
  })

  it('resolveAllowedTeamIds: a scoped code never narrows; an empty or junk list means no narrowing', () => {
    assert.equal(resolveAllowedTeamIds('t1', ['t1', 't2']), null)
    assert.equal(resolveAllowedTeamIds(null, []), null)
    assert.equal(resolveAllowedTeamIds(null, undefined), null)
    assert.equal(resolveAllowedTeamIds(null, [7, '']), null)
    assert.deepEqual(resolveAllowedTeamIds(null, ['t1', 7, 't2']), ['t1', 't2'])
  })

  it('is what loginContactWithCode runs, and the post-verification picker names the team', () => {
    const login = src('./loginContactWithCode.ts')
    assert.match(login, /selectLoginCandidates\(/)
    assert.match(login, /resolveAllowedTeamIds\(teamId, codeData\.teamIds\)/)
    // The contact-selection response carries teamId so the app can group a
    // family address by studio without a client-side read of every team.
    assert.match(login, /matchedContacts: activeContacts\.map\(\(doc\) => \(\{[\s\S]*?teamId:/)
  })
})

describe('sendContactVerificationCode — what an anonymous caller is told', () => {
  it('toMatchedContactSummary exposes ONLY id, firstname, lastname, teamId', () => {
    const summary = toMatchedContactSummary('c1', {
      firstname: 'Ada',
      lastname: 'Lovelace',
      teamId: 't1',
      email: 'ada@example.com',
      phone: '+41791234567',
      birthdate: new Date('1815-12-10'),
      gender: 'f',
      address: { city: 'London' },
      custom_fields: { belt: 'black' },
    })
    assert.deepEqual(Object.keys(summary).sort(), ['firstname', 'id', 'lastname', 'teamId'])
    assert.deepEqual(summary, { id: 'c1', firstname: 'Ada', lastname: 'Lovelace', teamId: 't1' })
  })

  it('tolerates a document with nothing usable on it', () => {
    assert.deepEqual(toMatchedContactSummary('c2', { firstname: 7, teamId: '' }), {
      id: 'c2',
      firstname: '',
      lastname: '',
      teamId: null,
    })
  })

  it('distinctTeamIds: matched teams first-seen, plus the requested team once', () => {
    const r = distinctTeamIds(
      [{ teamId: 't2' }, { teamId: 't1' }, { teamId: 't2' }, { teamId: null }],
      't1'
    )
    assert.deepEqual(r, { matchedTeamIds: ['t2', 't1'], allTeamIds: ['t2', 't1'] })
    assert.deepEqual(distinctTeamIds([], 't9').allTeamIds, ['t9'])
  })

  it('brands the OTP for the requested team, else the single matched team, else the platform', () => {
    const names = { t1: 'Iron Circle', t2: 'Samurai' }
    const one = [toMatchedContactSummary('a', { teamId: 't1' })]
    const two = [...one, toMatchedContactSummary('b', { teamId: 't2' })]
    assert.equal(
      summarizeCodeRequest({ matched: two, requestedTeamId: 't2', teamNames: names }).teamName,
      'Samurai'
    )
    assert.equal(
      summarizeCodeRequest({ matched: one, requestedTeamId: null, teamNames: names }).teamName,
      'Iron Circle'
    )
    assert.equal(
      summarizeCodeRequest({ matched: two, requestedTeamId: null, teamNames: names }).teamName,
      'Linyup'
    )
    assert.equal(
      summarizeCodeRequest({ matched: [], requestedTeamId: null, teamNames: {} }).teamName,
      'Linyup'
    )
  })

  it('team summaries list only teams that still exist; none at all reads as null', () => {
    const r = summarizeCodeRequest({
      matched: [
        toMatchedContactSummary('a', { teamId: 't1' }),
        toMatchedContactSummary('b', { teamId: 'gone' }),
      ],
      requestedTeamId: null,
      teamNames: { t1: 'Iron Circle' },
    })
    assert.deepEqual(r.teamSummaries, [{ id: 't1', name: 'Iron Circle' }])
    assert.deepEqual(
      r.contactsWithTeamName.map((c) => c.teamName),
      ['Iron Circle', null]
    )
    assert.equal(
      summarizeCodeRequest({ matched: [], requestedTeamId: null, teamNames: {} }).teamSummaries,
      null
    )
  })

  it('is the projection the callable uses — no inline field list survives', () => {
    const send = src('./sendContactVerificationCode.ts')
    assert.match(send, /toMatchedContactSummary\(doc\.id, doc\.data\(\)\)/)
    assert.match(send, /summarizeCodeRequest\(/)
    assert.doesNotMatch(send, /phone: doc\.get/)
  })
})
