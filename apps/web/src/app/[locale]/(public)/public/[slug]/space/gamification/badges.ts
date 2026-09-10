// Pure badge computation — deliberately SIMPLE, on purpose.
//
// This is a smaller badge set than the mobile app's `BadgesCard.tsx`: no
// coach-assigned custom badges and no rank/leaderboard/explorer/"special"
// groups. The web Space is explicitly the SIMPLE view of gamification
// (score/streak/leaderboard/badges) while the mobile app is not yet the
// primary surface — see the module header of `GamificationHome.tsx`.
//
// The NUMBERS are not this file's, though. The three groups below read the
// studio's own thresholds — `TeamPublicProfile.gamification_settings`, the
// public mirror of `teams/{id}.settings.gamification.badge_thresholds`, laid
// over `DEFAULT_BADGE_THRESHOLDS` by the shared `mergeBadgeThresholds` — so a
// studio that raised "Dedicated" to 20 in the admin sees 20 here, in the app,
// and in the editor. A group the studio switched off is dropped, as the app
// drops it. (The nine numbers used to be typed out here; one edit in the
// admin editor away from the portal and the app disagreeing.)
//
// Every input is a field already on `Contact` that a contact session may read
// off its OWN document (`isSelfContact` in firestore.rules) — no new mirror
// needed for badges.

import { DEFAULT_BADGE_THRESHOLDS, type GamificationBadgeThresholds } from '@linyup/shared'

export type BadgeGroupKey = 'attendance' | 'streak' | 'score'

export const BADGE_GROUP_KEYS: readonly BadgeGroupKey[] = ['attendance', 'streak', 'score']

export interface BadgeDefinition {
  /** Stable id — also the i18n key suffix (`SpaceGamification.badges.{key}.*`). */
  key: string
  group: BadgeGroupKey
  threshold: number
}

/** The badges this surface shows, at the studio's resolved thresholds. */
export function badgeDefinitions(
  thresholds: GamificationBadgeThresholds = DEFAULT_BADGE_THRESHOLDS,
): BadgeDefinition[] {
  const { attendance, streak, score } = thresholds
  const defs: BadgeDefinition[] = []
  if (attendance.enabled !== false) {
    defs.push(
      { key: 'first_class', group: 'attendance', threshold: attendance.first_class },
      { key: 'dedicated', group: 'attendance', threshold: attendance.dedicated },
      { key: 'committed', group: 'attendance', threshold: attendance.committed },
    )
  }
  if (streak.enabled !== false) {
    defs.push(
      { key: 'on_fire', group: 'streak', threshold: streak.on_fire },
      { key: 'unstoppable', group: 'streak', threshold: streak.unstoppable },
      { key: 'legendary', group: 'streak', threshold: streak.legendary },
    )
  }
  if (score.enabled !== false) {
    defs.push(
      { key: 'rising_star', group: 'score', threshold: score.rising_star },
      { key: 'monthly_star', group: 'score', threshold: score.monthly_star },
      { key: 'superstar', group: 'score', threshold: score.superstar },
    )
  }
  return defs
}

export interface BadgeStats {
  /** Total sessions attended (`Contact.total_sessions`). */
  totalSessions: number
  /** Best-ever weekly streak (`Contact.max_streak`) — NOT the current streak,
   *  same as mobile: a badge earned once stays earned even after a streak breaks. */
  maxStreak: number
  /** THIS calendar month's score (`Contact.current_month_score`). Carries the
   *  same "resets with the month" quirk as mobile's own score badges — a
   *  superstar badge can be lost when the month turns over. Not a bug this
   *  surface introduces; matching existing product behaviour on purpose. */
  monthScore: number
}

function statValue(group: BadgeGroupKey, stats: BadgeStats): number {
  if (group === 'attendance') return stats.totalSessions
  if (group === 'streak') return stats.maxStreak
  return stats.monthScore
}

export function isBadgeEarned(def: BadgeDefinition, stats: BadgeStats): boolean {
  return statValue(def.group, stats) >= def.threshold
}

export function earnedBadgeCount(defs: readonly BadgeDefinition[], stats: BadgeStats): number {
  return defs.reduce((count, def) => count + (isBadgeEarned(def, stats) ? 1 : 0), 0)
}
