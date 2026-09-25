// ─── The PURE half of team sentiment ─────────────────────────────────────────
//
// What the model is told about the team (`buildTeamDossier`) and what is done
// with its reply (`readTeamSentimentReply`). No Firebase, no network — the
// callable in `teamSentiment.ts` only fetches and forwards, and
// `teamSentiment.test.ts` pins what reaches the prompt.
//
// ── IT READS SUMMARIES, NOT CONTACTS ─────────────────────────────────────────
// The input is the per-contact AI summaries the studio has already generated
// (`Contact.ai_summary`), not the contacts' records. That is the design Franco
// asked for (2026-09-16), and it has two consequences worth stating: the reading
// covers only the people somebody summarized, so the card always says how many
// it read; and no new fact about any person reaches the model — every line here
// was already written by the model about that person.
//
// ── NOBODY IS NAMED ──────────────────────────────────────────────────────────
// A team reading is about patterns, and a name in it is a person discussed in a
// document every manager opens. Entries are numbered, and each contact's first
// name — the only name a summary uses — is replaced in their own text by
// `[member]` before it is sent. The prompt also forbids identifying anyone.

import type { TeamSentimentMood, TeamSentimentSections } from '@linyup/shared'
import { TEAM_SENTIMENT_MOODS, TEAM_SENTIMENT_SECTION_KEYS } from '@linyup/shared'
import { normaliseSummary } from '../contacts/aiSummaryDossier'

/** One part of the reading: at most this many sentences and characters. */
export const SENTIMENT_SECTION_MAX_SENTENCES = 3
export const SENTIMENT_SECTION_MAX_CHARS = 420
/** A summary written before the sections existed is one paragraph; this much of it. */
export const LEGACY_SUMMARY_MAX_CHARS = 450
/** What a first name is replaced with in a person's own summary. */
export const MEMBER_TOKEN = '[member]'

export interface SentimentEntry {
  /** The contact's first name — used ONLY to scrub it from their own text. */
  firstname?: string | null
  /** The studio's engagement band for them today. */
  band: string
  /** Whole days since their summary was written. */
  ageDays: number
  /** Sectioned summaries (since 2026-09-14). */
  status?: string | null
  outlook?: string | null
  /** An older summary with no sections: the paragraph. */
  text?: string | null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `firstname` out of `text`, as a whole word and in any case — "Anna",
 * "ANNA", "Anna's". A name shorter than two letters is left alone: replacing
 * every "A" in a paragraph would do more harm than the name does.
 */
export function scrubFirstName(text: string, firstname: string | null | undefined): string {
  const name = (firstname ?? '').trim()
  if (name.length < 2) return text
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'), MEMBER_TOKEN)
}

/** "today", "3 days old", "5 weeks old" — coarse on purpose. */
function ageLabel(days: number): string {
  if (days < 1) return 'written today'
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`
  if (days < 60) return `${Math.floor(days / 7)} weeks old`
  return `${Math.floor(days / 30)} months old`
}

/**
 * The prompt's facts: the tallies first (so the model does not have to count),
 * then one anonymous entry per summary, newest first.
 */
export function buildTeamDossier(entries: readonly SentimentEntry[]): string {
  const bands = new Map<string, number>()
  for (const e of entries) bands.set(e.band, (bands.get(e.band) ?? 0) + 1)
  const ages = entries.map((e) => e.ageDays)
  const lines: string[] = []
  lines.push(`Contact summaries read: ${entries.length}`)
  if (ages.length) {
    lines.push(
      `Summary ages: newest ${ageLabel(Math.min(...ages))}, oldest ${ageLabel(Math.max(...ages))}`
    )
  }
  lines.push(
    `Engagement bands among them (by the studio's own thresholds): ${[...bands.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([band, n]) => `${band.replace(/_/g, ' ')} ${n}`)
      .join(', ')}`
  )
  lines.push('')
  lines.push('Summaries, newest first. Each is about one person, who is not named:')
  entries.forEach((e, i) => {
    lines.push(`${i + 1}. engagement ${e.band.replace(/_/g, ' ')} · summary ${ageLabel(e.ageDays)}`)
    const status = scrubFirstName((e.status ?? '').trim(), e.firstname)
    const outlook = scrubFirstName((e.outlook ?? '').trim(), e.firstname)
    if (status || outlook) {
      if (status) lines.push(`   status: ${status}`)
      if (outlook) lines.push(`   outlook: ${outlook}`)
    } else {
      const text = scrubFirstName((e.text ?? '').trim(), e.firstname)
      const cut =
        text.length > LEGACY_SUMMARY_MAX_CHARS
          ? `${text.slice(0, LEGACY_SUMMARY_MAX_CHARS - 1).trimEnd()}…`
          : text
      if (cut) lines.push(`   summary: ${cut}`)
    }
  })
  return lines.join('\n')
}

/** Strip a ```fence if the model wrapped its answer in one. */
function unfence(text: string): string {
  const m = text.trim().match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i)
  return (m ? m[1] : text).trim()
}

/**
 * The reply → a mood and four parts. The same discipline as the contact summary:
 * each part through `normaliseSummary` with its own caps; a reply stopped
 * mid-JSON keeps the parts whose string closed; a mood outside the vocabulary is
 * null rather than a word the card cannot color. Null when nothing usable came
 * back — the caller refuses rather than storing an empty reading.
 */
export function readTeamSentimentReply(
  raw: string
): { mood: TeamSentimentMood | null; sections: TeamSentimentSections } | null {
  const body = unfence(raw ?? '')
  if (!body.startsWith('{')) return null
  const keys = ['mood', ...TEAM_SENTIMENT_SECTION_KEYS] as const
  const parts: Partial<Record<(typeof keys)[number], string>> = {}
  try {
    const json = JSON.parse(body) as Record<string, unknown>
    for (const key of keys) if (typeof json[key] === 'string') parts[key] = json[key] as string
  } catch {
    for (const key of keys) {
      const m = body.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
      if (!m) continue
      try {
        parts[key] = JSON.parse(`"${m[1]}"`) as string
      } catch {
        parts[key] = m[1]
      }
    }
  }
  const sections: TeamSentimentSections = { overview: '', strengths: '', concerns: '', focus: '' }
  for (const key of TEAM_SENTIMENT_SECTION_KEYS) {
    sections[key] = normaliseSummary(parts[key] ?? '', {
      maxSentences: SENTIMENT_SECTION_MAX_SENTENCES,
      maxChars: SENTIMENT_SECTION_MAX_CHARS,
    })
  }
  if (!sections.overview) return null
  const moodRaw = (parts.mood ?? '').trim().toLowerCase()
  const mood = (TEAM_SENTIMENT_MOODS as readonly string[]).includes(moodRaw)
    ? (moodRaw as TeamSentimentMood)
    : null
  return { mood, sections }
}

/** Quality, not safety — the boundary is what `buildTeamDossier` does and does not contain. */
export function teamSentimentSystemPrompt(languageName: string): string {
  return `You read the AI summaries a sports, fitness or wellness studio keeps about its clients and write a short reading of the team as a whole, for the studio's owner and managers.

Each summary describes one person's engagement ("status") and what to expect next ("outlook"). Look across them for what they have in common. Answer with a mood and four parts, each one to three sentences of plain prose, at most 220 words in total: no heading, no label, no bullet points, no markdown.
- mood: exactly one of positive, steady, mixed, concerning — the overall reading.
- overview: the overall picture — how the roster is doing and in which direction.
- strengths: what is working, as patterns shared by the people who come steadily (rhythms, activities, times).
- concerns: what to watch, as groups rather than individuals — people drifting, plans or credits running out, thin history.
- focus: one or two concrete things the studio could do as a team in the coming weeks.

Never name, number or otherwise identify an individual; people appear as [member] and must stay anonymous. Use only what the summaries say; the counts given are exact, so use them rather than estimating. When the summaries are few or old, say that the reading is tentative.

Write in ${languageName}.`
}
