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
// nobody is about to look at. Team sentiment is the one press that fans out: it
// first refreshes the briefings of the team's ACTIVE members (one call each,
// skipping anyone with nothing new — `summaryNeedsRefresh`) and then reads them
// all in one prompt. That is why it has a per-team daily cap
// (`TEAM_SENTIMENT_DAILY_LIMIT`), reserved before the first member is touched.

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
  /**
   * "Draft with AI" on Offerings: activities and plans proposed from a
   * description, reviewed, then created. The `offer-drafting` experiment until
   * 2026-09-17.
   */
  offerDrafting: 'ai-offer-drafting',
} as const

export type AiModuleId = (typeof AI_MODULES)[keyof typeof AI_MODULES]

// ─── Team sentiment ───────────────────────────────────────────────────────────

/**
 * Runs per team per calendar day (Europe/Zurich). One run refreshes the briefing
 * of every active member that has something new — a model call each — and then
 * reads up to `TEAM_SENTIMENT_MAX_SUMMARIES` of them in a single prompt, so it is
 * by far the largest thing the container does. The cap is what keeps an idle
 * refresh button from becoming the bill.
 */
export const TEAM_SENTIMENT_DAILY_LIMIT = 5
/** The most active members one run refreshes and reads — the most recently seen. */
export const TEAM_SENTIMENT_MAX_SUMMARIES = 150
/** Members refreshed per Cloud Task round (each a model call, a few at a time). */
export const TEAM_SENTIMENT_REFRESH_BATCH = 10
/**
 * A member's briefing is REUSED unless something happened since it was written —
 * a session, a booking, a note — or it is older than this many days.
 */
export const SUMMARY_REUSE_MAX_AGE_DAYS = 7
/**
 * A run still refreshing or reading after this long is treated as abandoned — a
 * chain that crashed past its retries — so the button works again. The run it
 * spent is not given back.
 */
export const TEAM_SENTIMENT_RUN_STALE_MINUTES = 30
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
  /**
   * The engagement threshold the reading was scoped to: it covers only members
   * seen within this many days (the studio's `active_within_days`). Absent on a
   * reading made before runs refreshed the active members.
   */
  active_within_days?: number
}

export type TeamSentimentRunStatus = 'refreshing' | 'reading' | 'done' | 'failed'

/**
 * The run in flight, or the last one — beside the report so the dashboard's one
 * listener shows progress too. Written only by the functions; replaced WHOLE
 * when a run starts, and moved forward with absolute counts from a transaction's
 * own read (never `FieldValue.increment`).
 */
export interface TeamSentimentRun {
  id: string
  status: TeamSentimentRunStatus
  started_at: Timestamp
  started_by: string
  finished_at: Timestamp | null
  /** The active threshold the members were picked with — acknowledged on the card. */
  active_within_days: number
  /** The active members, most recently seen first, capped at TEAM_SENTIMENT_MAX_SUMMARIES. */
  member_ids: string[]
  /** Task rounds completed — the guard that makes a redelivered round a no-op. */
  rounds_done: number
  refreshed: number
  reused: number
  failed: number
  /** Why a `failed` run failed, as a stable code the card can word. */
  error: string | null
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
  run?: TeamSentimentRun
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

function tsMillis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  const t = value as { toMillis?: () => number } | null | undefined
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null
}

/**
 * Is a run still going? Refreshing or reading, and started within
 * TEAM_SENTIMENT_RUN_STALE_MINUTES — past that it is abandoned, not in progress.
 */
export function teamSentimentRunInProgress(run: TeamSentimentRun | null | undefined, nowMs: number): boolean {
  if (!run || (run.status !== 'refreshing' && run.status !== 'reading')) return false
  const started = tsMillis(run.started_at)
  return started === null || nowMs - started < TEAM_SENTIMENT_RUN_STALE_MINUTES * 60_000
}

/** What `summaryNeedsRefresh` decides on — epoch ms, `null` when unknown or absent. */
export interface SummaryFreshnessFacts {
  /** When the stored briefing was written; `null` = there is none. */
  generatedAtMs: number | null
  lastSessionMs: number | null
  newestBookingMs: number | null
  newestNoteMs: number | null
}

/**
 * THE freshness rule for a member's briefing inside a team run: regenerate when
 * there is none, when it is older than SUMMARY_REUSE_MAX_AGE_DAYS, or when the
 * member attended, booked or got a note after it was written. Otherwise reuse —
 * nothing it was written from has changed, so a new call would repeat it.
 */
export function summaryNeedsRefresh(facts: SummaryFreshnessFacts, nowMs: number): boolean {
  const { generatedAtMs } = facts
  if (generatedAtMs === null) return true
  if (nowMs - generatedAtMs > SUMMARY_REUSE_MAX_AGE_DAYS * 86_400_000) return true
  return [facts.lastSessionMs, facts.newestBookingMs, facts.newestNoteMs].some(
    (ms) => ms !== null && ms > generatedAtMs
  )
}

/** Which round a member index falls in, and the slice a round covers. */
export function teamSentimentRoundSlice(memberIds: readonly string[], round: number): string[] {
  return memberIds.slice(round * TEAM_SENTIMENT_REFRESH_BATCH, (round + 1) * TEAM_SENTIMENT_REFRESH_BATCH)
}

/** Rounds a run of this many members takes. */
export function teamSentimentRoundCount(members: number): number {
  return Math.ceil(members / TEAM_SENTIMENT_REFRESH_BATCH)
}
