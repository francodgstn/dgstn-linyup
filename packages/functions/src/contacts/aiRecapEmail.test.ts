import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MEMBER_RECAP_PART_MAX_CHARS,
  cleanMemberRecapPart,
  composeMemberRecap,
  renderMemberRecapHtml,
  resolveMemberRecapLanguage,
} from '@linyup/shared'

// THE MEMBER RECAP EMAIL (2026-09-16) — the `ai-member-recap` module. The copy
// and the rendering are shared with the web dialog's preview, so they are tested
// once here; the callable's rules are pinned from its source, since it cannot
// send mail in a unit test.

describe('member recap — the message', () => {
  const base = { firstname: 'Anna', teamName: 'Iron Circle', status: 'You kept a steady rhythm.', nextSession: 'Try sparring.' }

  it('wraps the two parts in fixed copy, in the summary language', () => {
    const de = composeMemberRecap({ ...base, language: 'de' })
    assert.equal(de.greeting, 'Hallo Anna,')
    assert.equal(de.statusLabel, 'Wo du stehst')
    assert.equal(de.subject, 'Dein Trainings-Update von Iron Circle')
    assert.ok(!/ß/.test(JSON.stringify(de)), 'Swiss spelling: never ß')
  })

  it('an unknown language reads as English, and a regional code as its language', () => {
    assert.equal(resolveMemberRecapLanguage('pt'), 'en')
    assert.equal(resolveMemberRecapLanguage(undefined), 'en')
    assert.equal(resolveMemberRecapLanguage('fr-CH'), 'fr')
  })

  it('greets without a gap when there is no first name', () => {
    assert.equal(composeMemberRecap({ ...base, firstname: '  ', language: 'it' }).greeting, 'Ciao,')
  })

  it('cleans what the studio typed: trimmed, blank lines dropped, capped', () => {
    assert.equal(cleanMemberRecapPart('  one  \n\n\n  two '), 'one\ntwo')
    assert.equal(cleanMemberRecapPart(42), '')
    assert.ok(cleanMemberRecapPart('x'.repeat(2000)).length <= MEMBER_RECAP_PART_MAX_CHARS)
  })

  it('escapes every value in the HTML — the parts are typed text, the name is a contact’s', () => {
    const html = renderMemberRecapHtml(
      composeMemberRecap({
        ...base,
        firstname: '<b>Anna</b>',
        status: 'Great <script>alert(1)</script> week',
        nextSession: 'line one\nline "two"',
        language: 'en',
      })
    )
    assert.ok(!html.includes('<script>'))
    assert.ok(!html.includes('<b>Anna</b>'))
    assert.ok(html.includes('line one<br>line &quot;two&quot;'))
  })
})

describe('member recap — the callable, from source', () => {
  const source = readFileSync(join(__dirname, 'aiRecapEmail.ts'), 'utf8').replace(/\r\n/g, '\n')
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  it('gates on its module, on contacts.manage and on the coach own-scope', () => {
    assert.match(body, /pluginIsActive\(teamId, AI_MODULES\.memberRecap\)/)
    assert.match(body, /requireCapability\(uid, teamId, 'contacts\.manage'\)/)
    assert.match(body, /coachOwnsContact\(contact, uid\)/)
  })

  it('honours the studio opt-out through the outreach recipient rules', () => {
    assert.match(body, /partitionRecipients\(/)
  })

  it('dedupes a retry of the same send', () => {
    assert.match(body, /idempotencyKey\('ai-recap', teamId, sendId, contactId\)/)
  })

  it('stamps only the two sent fields, never rewriting the model’s summary', () => {
    assert.match(body, /'ai_summary\.member_sent_at': FieldValue\.serverTimestamp\(\)/)
    assert.ok(!/ai_summary:\s*\{/.test(body), 'the send must not write the ai_summary map whole')
  })

  it('makes no model call', () => {
    assert.ok(!/generateContent\(/.test(body))
  })
})

describe('contact summary — gated on the plugin module, not the retired experiment', () => {
  const source = readFileSync(join(__dirname, 'aiSummary.ts'), 'utf8').replace(/\r\n/g, '\n')

  it('asks pluginIsActive for ai-contact-summary', () => {
    assert.match(source, /pluginIsActive\(teamId, AI_MODULES\.contactSummary\)/)
    assert.ok(!/isExperimentalFeatureEnabled/.test(source))
  })

  it('stores the member recap with the summary, written whole', () => {
    assert.match(source, /\.\.\.\(member \? \{ member \} : \{\}\)/)
  })
})
