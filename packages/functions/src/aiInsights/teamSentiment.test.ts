import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TEAM_SENTIMENT_DAILY_LIMIT,
  aiUsageCountToday,
  aiUsageDayKey,
  teamSentimentRunsLeft,
} from '@linyup/shared'
import {
  MEMBER_TOKEN,
  SENTIMENT_SECTION_MAX_CHARS,
  buildTeamDossier,
  readTeamSentimentReply,
  scrubFirstName,
  type SentimentEntry,
} from './teamSentimentPrompt'

// TEAM SENTIMENT (2026-09-16) — the `ai-team-sentiment` module. What reaches the
// prompt, what is kept from the reply, and the daily cap. The callable itself
// cannot run without Vertex, so its load-bearing lines are pinned from source.

const entry = (over: Partial<SentimentEntry> = {}): SentimentEntry => ({
  firstname: 'Zoltana',
  band: 'active',
  ageDays: 3,
  status: 'Zoltana trains twice a week, mostly Tuesday evenings.',
  outlook: "Zoltana's plan renews next month; she is likely to keep coming.",
  ...over,
})

describe('team sentiment — nobody is named', () => {
  it('replaces the first name in the person’s own text, as a whole word and in any case', () => {
    assert.equal(scrubFirstName('Anna and ANNA, but not Annabel.', 'Anna'), `${MEMBER_TOKEN} and ${MEMBER_TOKEN}, but not Annabel.`)
    assert.equal(scrubFirstName("Zoë's rhythm", 'Zoë'), `${MEMBER_TOKEN}'s rhythm`)
  })

  it('leaves a one-letter name alone rather than eating every "A"', () => {
    assert.equal(scrubFirstName('A steady rhythm.', 'A'), 'A steady rhythm.')
  })

  it('the dossier carries no first name, and numbers the entries instead', () => {
    const dossier = buildTeamDossier([entry(), entry({ firstname: 'Bartholomew', status: 'Bartholomew is slipping.', outlook: 'Bartholomew may stop.' })])
    assert.ok(!dossier.includes('Zoltana'), 'a first name reached the prompt')
    assert.ok(!dossier.includes('Bartholomew'), 'a first name reached the prompt')
    assert.match(dossier, /^1\. engagement active/m)
    assert.match(dossier, /^2\. engagement active/m)
  })

  it('states the tallies so the model does not count', () => {
    const dossier = buildTeamDossier([entry(), entry({ band: 'at_risk' }), entry({ band: 'at_risk', ageDays: 70 })])
    assert.match(dossier, /Contact summaries read: 3/)
    assert.match(dossier, /at risk 2, active 1/)
    assert.match(dossier, /oldest 2 months old/)
  })

  it('an older summary without parts is sent as its paragraph, cut', () => {
    const dossier = buildTeamDossier([entry({ status: null, outlook: null, text: `Zoltana ${'x'.repeat(900)}` })])
    const line = dossier.split('\n').find((l) => l.includes('summary: '))!
    assert.ok(line.length < 500)
    assert.ok(!line.includes('Zoltana'))
  })
})

describe('team sentiment — the reply', () => {
  const parts = {
    mood: 'mixed',
    overview: 'Most regulars are steady; newer members are thin on history.',
    strengths: 'Evening classes hold a loyal core.',
    concerns: 'A group whose plans end this month has slowed down.',
    focus: 'Reach out to members whose plans end soon.',
  }

  it('reads a mood and four parts', () => {
    const r = readTeamSentimentReply(JSON.stringify(parts))
    assert.equal(r?.mood, 'mixed')
    assert.equal(r?.sections.focus, 'Reach out to members whose plans end soon.')
  })

  it('a mood outside the vocabulary is null, not a word the card cannot colour', () => {
    assert.equal(readTeamSentimentReply(JSON.stringify({ ...parts, mood: 'ecstatic' }))?.mood, null)
    assert.equal(readTeamSentimentReply(JSON.stringify({ ...parts, mood: ' Positive ' }))?.mood, 'positive')
  })

  it('no overview means no reading — the callable refuses rather than storing a hollow one', () => {
    assert.equal(readTeamSentimentReply(JSON.stringify({ ...parts, overview: '' })), null)
    assert.equal(readTeamSentimentReply('The team is doing fine.'), null)
  })

  it('a reply stopped mid-JSON keeps the parts that closed', () => {
    const cut = '{"mood": "steady", "overview": "Steady overall.", "strengths": "Evenings are full.", "concerns": "A gro'
    const r = readTeamSentimentReply(cut)
    assert.equal(r?.sections.strengths, 'Evenings are full.')
    assert.equal(r?.sections.concerns, '')
  })

  it('caps each part', () => {
    const r = readTeamSentimentReply(JSON.stringify({ ...parts, overview: 'Long. '.repeat(200) }))
    assert.ok((r?.sections.overview.length ?? 0) <= SENTIMENT_SECTION_MAX_CHARS)
  })
})

describe('team sentiment — five a day', () => {
  // 2026-09-16 23:30 UTC is already 2026-09-17 in Zurich (UTC+2).
  const lateUtc = new Date('2026-09-16T23:30:00Z')

  it('counts calendar days in the studio clock, not UTC', () => {
    assert.equal(aiUsageDayKey(lateUtc), '2026-09-17')
    assert.equal(aiUsageDayKey(new Date('2026-09-16T12:00:00Z')), '2026-09-16')
  })

  it('a stored count from another day is zero today', () => {
    assert.equal(aiUsageCountToday({ day: '2026-09-16', count: 5 }, lateUtc), 0)
    assert.equal(aiUsageCountToday({ day: '2026-09-17', count: 2 }, lateUtc), 2)
    assert.equal(aiUsageCountToday(undefined, lateUtc), 0)
  })

  it('runs left never goes negative', () => {
    assert.equal(teamSentimentRunsLeft({ day: '2026-09-17', count: 2 }, lateUtc), TEAM_SENTIMENT_DAILY_LIMIT - 2)
    assert.equal(teamSentimentRunsLeft({ day: '2026-09-17', count: 99 }, lateUtc), 0)
  })

  describe('the callable, from source', () => {
    const source = readFileSync(join(__dirname, 'teamSentiment.ts'), 'utf8').replace(/\r\n/g, '\n')
    const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

    it('gates on its module and on an all-scoped caller', () => {
      assert.match(body, /pluginIsActive\(teamId, AI_MODULES\.teamSentiment\)/)
      assert.match(body, /callerIsAllScoped\(uid, teamId\)/)
    })

    it('reserves the run in a transaction BEFORE the model call, absolutely', () => {
      const reserve = body.indexOf('runTransaction(')
      const call = body.indexOf('generateContent(')
      assert.ok(reserve > 0 && call > reserve, 'the run must be reserved before the model is asked')
      assert.match(body, /usage: \{ day, count: count \+ 1 \}/)
      assert.ok(!/FieldValue\.increment/.test(body), 'the run count is written absolutely, never incremented')
    })

    it('refuses too few summaries before spending a run', () => {
      assert.ok(body.indexOf('not_enough_summaries') < body.indexOf('runTransaction('))
    })

    it('replaces the stored reading whole', () => {
      assert.match(body, /ref\.update\(\{\s*report: \{/)
    })
  })
})
