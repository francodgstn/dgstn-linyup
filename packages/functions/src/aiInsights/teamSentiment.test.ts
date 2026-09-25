import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SUMMARY_REUSE_MAX_AGE_DAYS,
  TEAM_SENTIMENT_DAILY_LIMIT,
  TEAM_SENTIMENT_REFRESH_BATCH,
  TEAM_SENTIMENT_RUN_STALE_MINUTES,
  aiUsageCountToday,
  aiUsageDayKey,
  summaryNeedsRefresh,
  teamSentimentRoundCount,
  teamSentimentRoundSlice,
  teamSentimentRunInProgress,
  teamSentimentRunsLeft,
  type TeamSentimentRun,
} from '@linyup/shared'
import { selectActiveMembers } from './teamSentimentRun'
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

  it('a mood outside the vocabulary is null, not a word the card cannot color', () => {
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

  // The callable STARTS a run and the run spends the calls, so the guarantees
  // are split across two files: the button reserves before anything is spent,
  // and the run writes what it spends absolutely and the reading whole.
  const strip = (file: string) =>
    readFileSync(join(__dirname, file), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')

  describe('the callable, from source', () => {
    const body = strip('teamSentiment.ts')

    it('gates on both modules and on an all-scoped caller', () => {
      assert.match(body, /pluginIsActive\(teamId, AI_MODULES\.teamSentiment\)/)
      assert.match(body, /pluginIsActive\(teamId, AI_MODULES\.contactSummary\)/)
      assert.match(body, /callerIsAllScoped\(uid, teamId\)/)
    })

    it('reserves the run in a transaction BEFORE the run is queued, absolutely', () => {
      const reserve = body.indexOf('runTransaction(')
      const queue = body.indexOf('enqueueTeamSentimentRound(')
      assert.ok(reserve > 0 && queue > reserve, 'the run must be reserved before any member is refreshed')
      assert.match(body, /usage: \{ day, count: count \+ 1 \}/)
      assert.ok(!/FieldValue\.increment/.test(body), 'the run count is written absolutely, never incremented')
    })

    it('makes no model call itself', () => {
      assert.ok(!body.includes('generateContent('), 'the button only starts a run')
    })

    it('refuses what costs nothing before spending a run', () => {
      const reserve = body.indexOf('runTransaction(')
      assert.ok(body.indexOf('not_enough_members') < reserve, 'too few active members')
      assert.ok(body.indexOf('teamSentimentRunInProgress(') < reserve, 'a run already going')
    })

    it('replaces usage and the run whole, keeping the last reading on the card', () => {
      assert.match(body, /mergeFields: \['usage', 'run'\]/)
    })
  })

  describe('the run, from source', () => {
    const body = strip('teamSentimentRun.ts')

    it('writes its progress absolutely, from the transaction that guards the round', () => {
      assert.ok(!/FieldValue\.increment/.test(body), 'counts are absolute, never incremented')
      assert.match(body, /'run\.refreshed': current\.refreshed \+ tally\.refreshed/)
      assert.match(body, /current\.rounds_done !== round/)
    })

    it('replaces the stored reading whole', () => {
      assert.match(body, /tx\.update\(ref, \{\s*report: \{/)
    })

    it('stamps the briefings it writes', () => {
      assert.match(body, /generatedBy: TEAM_SENTIMENT_GENERATED_BY/)
    })
  })
})

describe('team sentiment — the run', () => {
  const NOW = Date.UTC(2026, 8, 16, 12)
  const DAY = 86_400_000
  const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms })
  const contact = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    data: { archived_at: null, deleted_at: null, last_session_at: ts(NOW - 2 * DAY), created_at: ts(NOW - 400 * DAY), ...over },
  })

  describe('who counts as active', () => {
    it('keeps roster members inside the active threshold, leads included', () => {
      const ids = selectActiveMembers(
        [
          contact('recent'),
          contact('lead', { provisional: true }),
          contact('external', { external: true }),
          contact('archived', { archived_at: ts(NOW - DAY) }),
          contact('low', { last_session_at: ts(NOW - 20 * DAY) }),
        ],
        undefined,
        NOW
      )
      assert.deepEqual([...ids].sort(), ['lead', 'recent'])
    })

    it('measures like the contact page: last session, else when they joined', () => {
      const ids = selectActiveMembers(
        [
          contact('new', { last_session_at: undefined, created_at: ts(NOW - 3 * DAY) }),
          contact('old-never-came', { last_session_at: undefined, created_at: ts(NOW - 90 * DAY) }),
        ],
        undefined,
        NOW
      )
      assert.deepEqual(ids, ['new'])
    })

    it("follows the studio's own active threshold", () => {
      const twenty = [contact('twenty', { last_session_at: ts(NOW - 20 * DAY) })]
      assert.deepEqual(selectActiveMembers(twenty, undefined, NOW), [])
      assert.deepEqual(
        selectActiveMembers(twenty, { active_within_days: 30, low_within_days: 45, at_risk_within_days: 90 }, NOW),
        ['twenty']
      )
    })

    it('puts the most recently seen first, and caps', () => {
      const ids = selectActiveMembers(
        [
          contact('a', { last_session_at: ts(NOW - 5 * DAY) }),
          contact('b', { last_session_at: ts(NOW - 1 * DAY) }),
          contact('c', { last_session_at: ts(NOW - 3 * DAY) }),
        ],
        undefined,
        NOW,
        2
      )
      assert.deepEqual(ids, ['b', 'c'])
    })
  })

  describe('when a briefing is reused', () => {
    const generatedAtMs = NOW - 2 * DAY
    const quiet = { generatedAtMs, lastSessionMs: NOW - 3 * DAY, newestBookingMs: NOW - 4 * DAY, newestNoteMs: null }

    it('regenerates when there is none', () => {
      assert.equal(summaryNeedsRefresh({ ...quiet, generatedAtMs: null }, NOW), true)
    })

    it('reuses a recent one when nothing happened since', () => {
      assert.equal(summaryNeedsRefresh(quiet, NOW), false)
    })

    it('regenerates after a session, a booking or a note', () => {
      assert.equal(summaryNeedsRefresh({ ...quiet, lastSessionMs: NOW - DAY }, NOW), true)
      assert.equal(summaryNeedsRefresh({ ...quiet, newestBookingMs: NOW - DAY }, NOW), true)
      assert.equal(summaryNeedsRefresh({ ...quiet, newestNoteMs: NOW - DAY }, NOW), true)
    })

    it(`regenerates one older than ${SUMMARY_REUSE_MAX_AGE_DAYS} days even when nothing happened`, () => {
      const old = NOW - (SUMMARY_REUSE_MAX_AGE_DAYS + 1) * DAY
      assert.equal(summaryNeedsRefresh({ ...quiet, generatedAtMs: old, lastSessionMs: old - DAY, newestBookingMs: null }, NOW), true)
    })
  })

  describe('a run in flight', () => {
    const run = (over: Partial<TeamSentimentRun>): TeamSentimentRun => ({
      id: 'r',
      status: 'refreshing',
      started_at: ts(NOW - 60_000) as unknown as TeamSentimentRun['started_at'],
      started_by: 'u',
      finished_at: null,
      active_within_days: 14,
      member_ids: [],
      rounds_done: 0,
      refreshed: 0,
      reused: 0,
      failed: 0,
      error: null,
      ...over,
    })

    it('is in progress while refreshing or reading', () => {
      assert.equal(teamSentimentRunInProgress(run({}), NOW), true)
      assert.equal(teamSentimentRunInProgress(run({ status: 'reading' }), NOW), true)
      assert.equal(teamSentimentRunInProgress(run({ status: 'done' }), NOW), false)
      assert.equal(teamSentimentRunInProgress(run({ status: 'failed' }), NOW), false)
      assert.equal(teamSentimentRunInProgress(undefined, NOW), false)
    })

    it('is abandoned, not in progress, once it is stale — so the button works again', () => {
      const stale = ts(NOW - (TEAM_SENTIMENT_RUN_STALE_MINUTES + 1) * 60_000) as unknown as TeamSentimentRun['started_at']
      assert.equal(teamSentimentRunInProgress(run({ started_at: stale }), NOW), false)
    })

    it('walks the members in rounds, covering each exactly once', () => {
      const ids = Array.from({ length: TEAM_SENTIMENT_REFRESH_BATCH * 2 + 3 }, (_, i) => `m${i}`)
      const rounds = teamSentimentRoundCount(ids.length)
      assert.equal(rounds, 3)
      const walked = Array.from({ length: rounds }, (_, r) => teamSentimentRoundSlice(ids, r)).flat()
      assert.deepEqual(walked, ids)
      assert.deepEqual(teamSentimentRoundSlice(ids, rounds), [])
    })
  })
})
