/**
 * Shared automations + gamification + alerts seeding.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * These three blocks were written once and copied into three seeders, and the
 * copies had already started to diverge — not in STRUCTURE, which was identical
 * line for line, but in VOCABULARY: "Belt grading reminder" against "Assessment
 * reminder", "Win back inactive students" against "…inactive members". That is
 * the same shape as the documents block whose divergence broke the waiver ledger
 * (docs/seed-truth-2026-08.md → "Duplication register"), caught this time before
 * it drifted into anything load-bearing.
 *
 * So the vocabulary is the ONE parameter. A seeder picks a preset; nothing else
 * about the automations differs between them, and the moment something does it
 * has to be added here deliberately rather than by editing one copy.
 *
 * ── READS CONTACTS BACK ──────────────────────────────────────────────────────
 * `seedMonthlyScores` and `seedContactAlerts` query the team's contacts rather
 * than taking ids. The four seeders build their pools in four different shapes
 * and each had its own id convention baked into these loops, which is most of
 * why they could not be shared before. Same approach the waiver and money
 * fixtures take.
 *
 * Path constants mirror @linyup/shared (same convention as lib/storefront.ts).
 */

import admin from 'firebase-admin'
import { ledgerExpiry } from '../ledgerExpiry'

const TEAMS_COLLECTION = 'teams'
const CONTACTS_COLLECTION = 'contacts'
const MONTHLY_SCORES_SUBCOLLECTION = 'monthly_scores'
const CONTACT_ALERTS_SUBCOLLECTION = 'contact_alerts'
const OUTREACH_TEMPLATES_SUBCOLLECTION = 'outreach_templates'
const ALERT_PRESETS_SUBCOLLECTION = 'alert_presets'
const AUTOMATION_RULES_SUBCOLLECTION = 'automation_rules'
const AUTOMATION_LOGS_SUBCOLLECTION = 'automation_logs'

const tsOf = (d: Date) => admin.firestore.Timestamp.fromDate(d)
function daysFrom(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}
function monthsAgo(n: number): Date {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  return d
}
/** Doc id + `month` field of a monthly_scores row — 'YYYY-MM'. */
function monthLabel(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Deterministic pseudo-random in [0,1) from a string key.
 *
 * Seeds must be REPRODUCIBLE: a re-run that shifts every score makes a demo
 * tenant's charts move for no reason and makes "did my change do that?"
 * unanswerable.
 */
function seededRand(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

// ── Vocabulary ────────────────────────────────────────────────────────────────

/**
 * The ONLY thing that differs between the seeders' automation sets.
 *
 * `martial_arts` for tenants that grade belts (the emulator and staging demo
 * teams); `generic` for the multi-sector sandbox playground, where "belt
 * grading" would be wrong in four of its six tenants.
 */
export type AutomationVocabulary = 'martial_arts' | 'generic'

interface VocabularyCopy {
  milestoneKey: string
  milestonePresetName: string
  milestonePresetDescription: string
  milestonePresetMessage: string
  winbackRuleName: string
}

const VOCABULARIES: Record<AutomationVocabulary, VocabularyCopy> = {
  martial_arts: {
    milestoneKey: 'grading',
    milestonePresetName: 'Belt grading reminder',
    milestonePresetDescription: 'Fires 10 sessions before next grading window.',
    milestonePresetMessage: 'Belt grading is coming up — review the curriculum.',
    winbackRuleName: 'Win back inactive students',
  },
  generic: {
    milestoneKey: 'assessment',
    milestonePresetName: 'Assessment reminder',
    milestonePresetDescription: 'Fires 10 sessions before the next assessment.',
    milestonePresetMessage: 'Assessment is coming up — review goals together.',
    winbackRuleName: 'Win back inactive members',
  },
}

// ── Gamification: monthly scores ──────────────────────────────────────────────

/**
 * Per-contact monthly score rows, shaped as `recalculateMonthlyScores` writes
 * them (functions/src/utils/scoreComputation.ts): `final_score` is
 * `total_points` clamped by the team's own `monthly_cap`, so the cap is visibly
 * doing something rather than being a number nobody can see working.
 *
 * The CALLER decides whether gamification is on. Scores under a disabled
 * scoreboard are data no screen ever explains — and `/gamification` is
 * install-gated besides, so the caller also owns installing the plugin.
 */
export async function seedMonthlyScores(opts: {
  teamId: string
  monthlyCap: number
  /** How many months back. Default 4. */
  months?: number
  contactLimit?: number
}): Promise<number> {
  const db = admin.firestore()
  const { teamId, monthlyCap } = opts
  const months = opts.months ?? 4
  const contacts = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .limit(opts.contactLimit ?? 30)
    .get()

  let written = 0
  for (const c of contacts.docs) {
    // Somebody who has never trained has nothing to score, and a zero row reads
    // as a bug rather than as an absence.
    if (!((c.data().total_sessions as number | undefined) ?? 0)) continue
    for (let m = 0; m < months; m++) {
      const md = monthsAgo(m)
      const label = monthLabel(md)
      const sessions = Math.floor(seededRand(`${c.id}mscount${m}`) * 12)
      const totalPoints = sessions * (10 + Math.floor(seededRand(`${c.id}mp${m}`) * 6))
      await c.ref
        .collection(MONTHLY_SCORES_SUBCOLLECTION)
        .doc(`${c.id}-${label}`)
        .set({
          month: label,
          team_id: teamId,
          total_points: totalPoints,
          final_score: Math.min(totalPoints, monthlyCap),
          sessions_count: sessions,
          updated_at: tsOf(md),
        })
      written += 1
    }
  }
  return written
}

// ── Contact alerts ────────────────────────────────────────────────────────────

/**
 * A few per-contact alerts.
 *
 * Written FLAT (`schedule_type` / `schedule_value`) — the shape the admin page
 * round-trips. The server writers use a nested `schedule`, which that page
 * normalizes on read; a seed writing the nested form would round-trip into the
 * flat one on the first save and look like the studio had edited it.
 */
export async function seedContactAlerts(opts: {
  teamId: string
  vocabulary?: AutomationVocabulary
  /** How many contacts get one. Default 4. */
  count?: number
}): Promise<number> {
  const db = admin.firestore()
  const { teamId } = opts
  const v = VOCABULARIES[opts.vocabulary ?? 'generic']
  const alertDefs = [
    {
      schedule_type: 'sessions_countdown' as const,
      schedule_value: 10,
      message: v.milestonePresetMessage,
      show_in_app: true,
    },
    {
      // A `datetime` alert carries an actual instant. The three copies this
      // fixture replaces had already diverged here — one wrote `null`, which is
      // a dated reminder with no date. The PRESET keeps null (a preset is a
      // template; the date is chosen when it is applied), a contact's own alert
      // does not.
      schedule_type: 'datetime' as const,
      schedule_value: tsOf(daysFrom(7)),
      message: 'Membership renewal is due — confirm payment details.',
      show_in_app: true,
    },
    {
      // show_in_app false = a private coach note, invisible in the member app.
      schedule_type: 'sessions_countdown' as const,
      schedule_value: 50,
      message: '50-session milestone — celebrate in class!',
      show_in_app: false,
    },
  ]

  const contacts = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .limit(opts.count ?? 4)
    .get()

  let written = 0
  for (let i = 0; i < contacts.docs.length; i++) {
    const c = contacts.docs[i]
    const def = alertDefs[i % alertDefs.length]
    await c.ref
      .collection(CONTACT_ALERTS_SUBCOLLECTION)
      .doc(`${c.id}-alert-0`)
      .set({
        teamId,
        schedule_type: def.schedule_type,
        schedule_value: def.schedule_value,
        message: def.message,
        show_in_app: def.show_in_app,
        archived_at: null,
        created_at: tsOf(daysFrom(-3)),
      })
    written += 1
  }
  return written
}

// ── Automations ───────────────────────────────────────────────────────────────

/**
 * The `/automations` set: outreach templates, alert presets, rules, and run
 * logs.
 *
 * `lib_trial_cleanup` is written at a FIXED doc id equal to its system_key,
 * which is what makes it converge with `onTeamCreated` — that trigger writes the
 * same rule at the same id, so whichever runs first wins and the other is a
 * harmless no-op, never a duplicate. Its own comment says so; do not give this
 * a team-prefixed id.
 */
export async function seedAutomations(opts: {
  teamId: string
  /** Message language, used in the templates' `system_key`. Default 'en'. */
  language?: string
  vocabulary?: AutomationVocabulary
}): Promise<void> {
  const db = admin.firestore()
  const { teamId } = opts
  const language = opts.language ?? 'en'
  const v = VOCABULARIES[opts.vocabulary ?? 'generic']
  const teamRef = db.collection(TEAMS_COLLECTION).doc(teamId)
  const created = tsOf(daysFrom(-60))

  const templates = [
    {
      id: `${teamId}-tmpl-welcome`,
      system_key: `lib_trial_welcome:${language}`,
      name: 'Welcome to your first session',
      subject: 'Welcome to {{teamName}}, {{firstname}}!',
      body: 'Hi {{firstname}},\n\nWe are delighted to welcome you to **{{teamName}}** for your first session!\n\nArrive a few minutes early so we can welcome you and answer any questions — no experience needed, we will guide you through everything.\n\nWe look forward to meeting you!\n\nThe {{teamName}} team',
    },
    {
      id: `${teamId}-tmpl-winback`,
      system_key: `lib_winback:${language}`,
      name: 'We miss you',
      subject: '{{firstname}}, we miss you at {{teamName}}',
      body: 'Hi {{firstname}},\n\nIt has been a while since your last session. Whenever you are ready to come back, we will be here.\n\nReply to this email and we will help you find a time that fits your schedule.\n\nThe {{teamName}} team',
    },
  ]
  for (const t of templates) {
    await teamRef
      .collection(OUTREACH_TEMPLATES_SUBCOLLECTION)
      .doc(t.id)
      .set({
        name: t.name,
        subject: t.subject,
        body: t.body,
        body_mode: 'markdown',
        language,
        active: true,
        system_key: t.system_key,
        created_at: created,
      })
  }

  const milestonePresetId = `${teamId}-preset-${v.milestoneKey}`
  const presets = [
    {
      id: milestonePresetId,
      name: v.milestonePresetName,
      description: v.milestonePresetDescription,
      schedule_type: 'sessions_countdown',
      schedule_value: 10,
      message: v.milestonePresetMessage,
      show_in_app: true,
    },
    {
      id: `${teamId}-preset-renewal`,
      name: 'Membership renewal',
      description: 'One-off reminder on a chosen date.',
      schedule_type: 'datetime',
      schedule_value: null,
      message: 'Membership renewal is due — confirm payment details.',
      show_in_app: true,
    },
  ]
  for (const p of presets) {
    await teamRef
      .collection(ALERT_PRESETS_SUBCOLLECTION)
      .doc(p.id)
      .set({
        name: p.name,
        description: p.description,
        schedule_type: p.schedule_type,
        schedule_value: p.schedule_value,
        message: p.message,
        show_in_app: p.show_in_app,
        created_at: created,
      })
  }

  const rules = [
    {
      id: `${teamId}-rule-welcome`,
      name: 'Welcome new trial',
      active: true,
      system_key: 'lib_trial_welcome',
      trigger: { type: 'contact_created' },
      // Trial-funnel contacts only — off-funnel entries (shop/form, no stage)
      // must NOT get the "first session" welcome. The engine fails closed on an
      // unknown condition type, which is the safe direction but not an excuse
      // to write a rule that relies on it.
      conditions: [{ type: 'acquisition_stage', value: 'trial_booked' }],
      actions: [{ type: 'send_email', templateId: `${teamId}-tmpl-welcome` }],
    },
    {
      id: `${teamId}-rule-winback`,
      name: v.winbackRuleName,
      active: true,
      system_key: 'lib_winback',
      trigger: { type: 'schedule_daily' },
      conditions: [
        { type: 'acquisition_stage', value: 'joined' },
        { type: 'inactivity_days', value: 30 },
      ],
      actions: [
        { type: 'send_email', templateId: `${teamId}-tmpl-winback` },
        { type: 'assign_tag', tag: 'win-back' },
      ],
    },
    {
      id: `${teamId}-rule-milestone`,
      name: 'Celebrate 50-session milestone',
      active: false,
      system_key: 'lib_milestone_50',
      trigger: { type: 'session_ended' },
      conditions: [{ type: 'sessions_attended_exactly', value: 50 }],
      actions: [
        { type: 'create_alert', presetId: milestonePresetId },
        { type: 'log_activity', message: '{{firstname}} reached 50 sessions 🎉' },
      ],
    },
    {
      // Default lead-hygiene rule — mirrors the onTeamCreated trigger
      // (@linyup/shared TRIAL_CLEANUP_RULE). Fixed doc id converges, no duplicate.
      id: 'lib_trial_cleanup',
      name: 'Archive stale trial bookings',
      active: true,
      system_key: 'lib_trial_cleanup',
      trigger: { type: 'schedule_daily' },
      conditions: [
        { type: 'acquisition_stage', value: 'trial_booked' },
        { type: 'sessions_attended_exactly', value: 0 },
        { type: 'days_since_created', value: 30 },
      ],
      actions: [{ type: 'archive_contact' }],
    },
  ]
  for (const r of rules) {
    await teamRef
      .collection(AUTOMATION_RULES_SUBCOLLECTION)
      .doc(r.id)
      .set({
        name: r.name,
        active: r.active,
        trigger: r.trigger,
        conditions: r.conditions,
        actions: r.actions,
        system_key: r.system_key,
        created_at: created,
        updated_at: tsOf(daysFrom(-5)),
      })
  }

  // Run history. The MILESTONE rule gets none — it is seeded inactive, and an
  // inactive rule with runs behind it reads as "it stopped working".
  const logs = [
    {
      id: `${teamId}-alog-0`,
      rule_id: `${teamId}-rule-welcome`,
      rule_name: 'Welcome new trial',
      trigger_type: 'contact_created',
      trigger_tier: 'event',
      contacts_matched: 1,
      actions_executed: 1,
      days: 1,
    },
    {
      id: `${teamId}-alog-1`,
      rule_id: `${teamId}-rule-winback`,
      rule_name: v.winbackRuleName,
      trigger_type: 'schedule_daily',
      trigger_tier: 'scheduled',
      contacts_matched: 3,
      actions_executed: 6,
      days: 2,
    },
  ]
  for (const l of logs) {
    // The run's OWN date, so the TTL stamp ages this row exactly as a real one
    // of the same age would age — see scripts/lib/ledgerExpiry.ts.
    const triggeredAt = daysFrom(-l.days)
    await teamRef
      .collection(AUTOMATION_LOGS_SUBCOLLECTION)
      .doc(l.id)
      .set({
        rule_id: l.rule_id,
        rule_name: l.rule_name,
        triggered_at: tsOf(triggeredAt),
        trigger_type: l.trigger_type,
        trigger_tier: l.trigger_tier,
        contacts_matched: l.contacts_matched,
        actions_executed: l.actions_executed,
        actions_failed: 0,
        expires_at: ledgerExpiry('automation_logs', triggeredAt),
      })
  }
}
