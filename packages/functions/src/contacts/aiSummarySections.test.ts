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
