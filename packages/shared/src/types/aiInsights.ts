// ─── AI insights ──────────────────────────────────────────────────────────────
//
// The `ai` plugin CONTAINER and what its modules store. The container is an
// ordinary bundle (`PLUGIN_BUNDLES.ai`, see plugin-bundles.ts): a studio installs
// ONE card and switches the modules below on and off independently, exactly as
// HMD's bundle works.
//
// ── WHY A PLUGIN AND NOT AN EXPERIMENT ANY MORE ──────────────────────────────
// The contact summary started as an experiment (`contact-summary`, 2026-09-11)
// because its output was what was being tuned. Once there were three AI surfaces
// that a studio would want to choose between — a briefing for the coach, a
// recap sent to the member, a team-wide reading — one on/off switch per surface
// in Settings → Experimental stopped describing the decision. A container with
// modules does, and it carries `status: 'beta'` so the "may change" caveat stays
// on the card (Franco, 2026-09-16).
//
// ── COST IS BOUNDED PER SURFACE, NEVER BY A SCHEDULE ─────────────────────────
// Every model call here is a button somebody pressed. There is deliberately no
// scheduled generation for all contacts: it would spend model calls on people
// nobody is about to look at. Team sentiment reads EVERY summary at once, so it
// also has a per-team daily cap (`TEAM_SENTIMENT_DAILY_LIMIT`).

import type { Timestamp } from './common'

/** The container a studio installs. */
export const AI_PLUGIN_ID = 'ai' as const

/**
 * The modules, as plugin ids — each an ordinary bundle member with its own
 * manifest and install document. Stored in Firestore, so a rename is a migration.
 */
export const AI_MODULES = {
  /** The coach's briefing on the contact page (status · outlook · next session). */
  contactSummary: 'ai-contact-summary',
  /** Email the member-facing recap from the briefing. Lives inside the briefing. */
  memberRecap: 'ai-member-recap',
  /** A team-wide reading of the contact summaries, on the dashboard. */
  teamSentiment: 'ai-team-sentiment',
} as const

export type AiModuleId = (typeof AI_MODULES)[keyof typeof AI_MODULES]

// ─── Team sentiment ───────────────────────────────────────────────────────────

/**
 * Runs per team per calendar day (Europe/Zurich). One run reads up to
 * `TEAM_SENTIMENT_MAX_SUMMARIES` summaries in a single prompt, so it is by far
 * the largest call in the container — the cap is what keeps an idle refresh
 * button from becoming the bill.
 */
export const TEAM_SENTIMENT_DAILY_LIMIT = 5
/** The most contact summaries one run reads — the newest ones. */
export const TEAM_SENTIMENT_MAX_SUMMARIES = 150
/** Fewer summaries than this and there is no team to read a sentiment from. */
export const TEAM_SENTIMENT_MIN_SUMMARIES = 3
/** A summary older than this describes somebody who may have changed since. */
export const TEAM_SENTIMENT_MAX_AGE_DAYS = 180

/** The overall reading, as a word the card can colour — never a score. */
export type TeamSentimentMood = 'positive' | 'steady' | 'mixed' | 'concerning'
export const TEAM_SENTIMENT_MOODS: readonly TeamSentimentMood[] = [
  'positive',
  'steady',
  'mixed',
  'concerning',
]

/** The parts of a team reading, in reading order. Labels are the app's. */
export interface TeamSentimentSections {
  /** The overall picture in a sentence or two. */
  overview: string
  /** What is working — patterns shared by the people who come steadily. */
  strengths: string
  /** What to watch — groups drifting, plans ending, thin history. */
  concerns: string
  /** One or two team-level things to do in the coming weeks. */
  focus: string
}

export const TEAM_SENTIMENT_SECTION_KEYS = ['overview', 'strengths', 'concerns', 'focus'] as const

export interface TeamSentimentReport {
  mood: TeamSentimentMood | null
  sections: TeamSentimentSections
  generated_at: Timestamp
  generated_by: string
  model: string
  language: string
  /** How many contact summaries the reading was made from. */
  summaries_used: number
  /** The oldest of them — how far back "now" reaches in this reading. */
  summaries_oldest_at: Timestamp | null
}

/** Runs used on one calendar day. Written absolutely, in a transaction. */
export interface AiReportUsage {
  /** `YYYY-MM-DD` in Europe/Zurich. */
  day: string
  count: number
}

/**
 * `teams/{teamId}/ai_reports/team_sentiment` — the latest reading and today's
 * usage, in one document so the card reads both with one listener. Written only
 * by `generateTeamSentiment`; the rules deny every client write and admit only
 * all-scoped members to read (a coach scoped to their own book does not get a
 * reading of everybody else's).
 */
export interface TeamSentimentDoc {
  report?: TeamSentimentReport
  usage?: AiReportUsage
}

/** The document id of the team sentiment reading under `ai_reports`. */
export const TEAM_SENTIMENT_REPORT_ID = 'team_sentiment'

/**
 * The calendar day a run counts against, in the studio's clock. A day, not a
 * rolling 24 hours: "five a day" is what the card says, and a studio reading
 * "2 left today" at 23:00 should get five again in the morning.
 */
export function aiUsageDayKey(now: Date, timeZone = 'Europe/Zurich'): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** Runs already used today, from a stored usage record of any age. */
export function aiUsageCountToday(usage: AiReportUsage | null | undefined, now: Date): number {
  if (!usage || usage.day !== aiUsageDayKey(now)) return 0
  return Math.max(0, Number(usage.count) || 0)
}

/** Runs left today — never negative. */
export function teamSentimentRunsLeft(usage: AiReportUsage | null | undefined, now: Date): number {
  return Math.max(0, TEAM_SENTIMENT_DAILY_LIMIT - aiUsageCountToday(usage, now))
}
