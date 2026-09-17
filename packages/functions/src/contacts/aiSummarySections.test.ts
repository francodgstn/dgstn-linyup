import assert from 'node:assert/strict'
import {
  SUMMARY_SECTION_MAX_CHARS,
  SUMMARY_SECTION_MAX_SENTENCES,
  normaliseSummary,
  readSummaryReply,
} from './aiSummaryDossier'

// THE SECTIONED SUMMARY (2026-09-14): three parts — status, outlook, at the next
// session — that the card labels. The labels are the APP'S; the model writes
// only the parts. See `readSummaryReply` and docs/contact-summary.md.

const reply = (parts: Record<string, unknown>) => JSON.stringify(parts)

describe('contact summary — the three parts', () => {
  it('reads the parts and joins them into the paragraph every older reader expects', () => {
    const r = readSummaryReply(
      reply({
        status: 'Anna trains twice a week, mostly Tuesday evenings.',
        outlook: 'She is likely to keep coming; her plan renews next month.',
        nextSession: 'Ask how the new competition class suits her.',
      })
    )
    assert.deepEqual(r.sections, {
      status: 'Anna trains twice a week, mostly Tuesday evenings.',
      outlook: 'She is likely to keep coming; her plan renews next month.',
      nextSession: 'Ask how the new competition class suits her.',
    })
    assert.equal(
      r.text,
      'Anna trains twice a week, mostly Tuesday evenings. She is likely to keep coming; her plan renews next month. Ask how the new competition class suits her.'
    )
  })

  it('strips a label the model wrote anyway — in any of the four languages, bold or not', () => {
    const r = readSummaryReply(
      reply({
        status: '**Status:** Anna trains twice a week.',
        outlook: 'Ausblick: Sie bleibt wahrscheinlich dabei.',
        nextSession: 'À la prochaine séance : demander le tournoi.',
      })
    )
    assert.equal(r.sections?.status, 'Anna trains twice a week.')
    assert.equal(r.sections?.outlook, 'Sie bleibt wahrscheinlich dabei.')
    assert.equal(r.sections?.nextSession, 'demander le tournoi.')
  })

  it('never eats a sentence that merely contains a colon', () => {
    const r = readSummaryReply(reply({ status: 'Anna comes steadily: twice a week.', outlook: 'x.', nextSession: 'y.' }))
    assert.equal(r.sections?.status, 'Anna comes steadily: twice a week.')
  })

  it('caps each part at its own sentence and character limits', () => {
    const long = 'One. Two. Three. Four.'
    const r = readSummaryReply(reply({ status: long, outlook: 'B'.repeat(900), nextSession: 'Fine.' }))
    assert.equal(SUMMARY_SECTION_MAX_SENTENCES, 2)
    assert.equal(r.sections?.status, 'One. Two.')
    assert.ok((r.sections?.outlook.length ?? 0) <= SUMMARY_SECTION_MAX_CHARS)
  })

  it('an empty part is left empty, not invented; all empty is an empty summary', () => {
    const one = readSummaryReply(reply({ status: 'Anna trains weekly.', outlook: '', nextSession: '   ' }))
    assert.equal(one.sections?.outlook, '')
    assert.equal(one.text, 'Anna trains weekly.')
    assert.deepEqual(readSummaryReply(reply({ status: '', outlook: '', nextSession: '' })), { text: '' })
  })

  it('a reply stopped mid-JSON keeps the parts that closed', () => {
    const cut = '{"status": "Anna trains twice a week.", "outlook": "She is likely to keep coming.", "nextSession": "Ask about the tour'
    const r = readSummaryReply(cut, { cut: true })
    assert.equal(r.sections?.status, 'Anna trains twice a week.')
    assert.equal(r.sections?.outlook, 'She is likely to keep coming.')
    assert.equal(r.sections?.nextSession, '')
    assert.equal(r.text, 'Anna trains twice a week. She is likely to keep coming.')
  })

  it('a stopped reply with no closed part is empty — the callable refuses it', () => {
    assert.deepEqual(readSummaryReply('{"status": "Anna tra', { cut: true }), { text: '' })
  })

  it('a fenced JSON reply still reads as parts', () => {
    const r = readSummaryReply('```json\n' + reply({ status: 'A.', outlook: 'B.', nextSession: 'C.' }) + '\n```')
    assert.equal(r.text, 'A. B. C.')
  })

  it('a reply that ignored the schema reads as the old paragraph, with no parts', () => {
    const prose = 'Anna trains twice a week. She holds Unlimited.'
    assert.deepEqual(readSummaryReply(prose), { text: normaliseSummary(prose) })
  })
})

// THE MEMBER RECAP (2026-09-16): two more parts in the same reply, written TO
// the person, for the `ai-member-recap` module to email. See ContactAiMemberRecap.
describe('contact summary — the member recap', () => {
  const full = {
    status: 'Anna trains twice a week.',
    outlook: 'She is at risk of drifting once her plan ends.',
    nextSession: 'Ask about the tournament.',
    memberStatus: 'You have kept a steady twice-a-week rhythm.',
    memberNextSession: 'Try the Thursday sparring class.',
  }

  it('reads both member parts beside the studio parts', () => {
    const r = readSummaryReply(reply(full))
    assert.deepEqual(r.member, {
      status: 'You have kept a steady twice-a-week rhythm.',
      nextSession: 'Try the Thursday sparring class.',
    })
    // The studio paragraph is unchanged by the recap's presence.
    assert.equal(
      r.text,
      'Anna trains twice a week. She is at risk of drifting once her plan ends. Ask about the tournament.'
    )
  })

  it('never carries an outlook — there is no member part to put one in', () => {
    const r = readSummaryReply(reply({ ...full, memberOutlook: 'You might drop off.' }))
    assert.deepEqual(Object.keys(r.member ?? {}).sort(), ['nextSession', 'status'])
  })

  it('strips a greeting and a label the model wrote although the email adds its own', () => {
    const r = readSummaryReply(
      reply({
        ...full,
        memberStatus: 'Hi Anna, you have kept a steady rhythm.',
        memberNextSession: 'For your next session: try sparring.',
      })
    )
    assert.equal(r.member?.status, 'you have kept a steady rhythm.')
    assert.equal(r.member?.nextSession, 'try sparring.')
  })

  it('leaves a sentence that merely starts with a greeting word alone', () => {
    const r = readSummaryReply(reply({ ...full, memberStatus: 'Hey there is a lot to be proud of this month.' }))
    assert.equal(r.member?.status, 'Hey there is a lot to be proud of this month.')
  })

  it('is absent unless BOTH parts survived — half a recap is not the message', () => {
    assert.equal(readSummaryReply(reply({ ...full, memberNextSession: '' })).member, undefined)
    const cut = JSON.stringify(full).replace(/"memberNextSession":"[^"]*"\}$/, '"memberNextSession":"Try the Thur')
    const r = readSummaryReply(cut, { cut: true })
    assert.equal(r.member, undefined)
    assert.equal(r.sections?.status, 'Anna trains twice a week.')
  })

  it('caps each member part like a studio part', () => {
    const r = readSummaryReply(reply({ ...full, memberStatus: 'One. Two. Three.' }))
    assert.equal(r.member?.status, 'One. Two.')
  })
})
