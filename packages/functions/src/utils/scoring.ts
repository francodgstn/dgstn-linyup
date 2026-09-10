import { DEFAULT_GAMIFICATION_SCORING, type GamificationScoringSettings } from '@linyup/shared'

/** The scorer's resolved view of `settings.gamification`: the shared scoring
 *  shape plus the plugin's on/off flag. */
export interface GamificationSettings extends GamificationScoringSettings {
  enabled: boolean
}

export function getDefaultGamificationSettings(): GamificationSettings {
  return { enabled: false, ...DEFAULT_GAMIFICATION_SCORING, time_multipliers: [] }
}

export function resolveGamificationSettings(teamSettings: Partial<GamificationSettings> | undefined): GamificationSettings {
  const defaults = getDefaultGamificationSettings()
  if (!teamSettings) return defaults
  return {
    ...defaults,
    ...teamSettings,
    time_multipliers: teamSettings.time_multipliers ?? defaults.time_multipliers,
  }
}

export function calculateAttendancePoints(baseScore: number, timeMultiplier: number): number {
  return Math.round(baseScore * timeMultiplier)
}

export function getTimeMultiplier(
  sessionStartDate: Date,
  timeMultipliers: GamificationSettings['time_multipliers'],
): number {
  if (!timeMultipliers || timeMultipliers.length === 0) return 1.0
  const dayOfWeek = sessionStartDate.getDay()
  const hour = sessionStartDate.getHours()
  let highest: number | null = null
  for (const range of timeMultipliers) {
    if (range.day !== dayOfWeek) continue
    if (hour >= range.start_hour && hour < range.end_hour) {
      if (highest === null || range.multiplier > highest) highest = range.multiplier
    }
  }
  return highest !== null ? highest : 1.0
}

export function calculateMonthlyScore(totalPoints: number, cap: number): number {
  return Math.min(totalPoints, cap)
}

function parseIsoWeek(isoWeek: string): { year: number; week: number } {
  const [yearStr, weekStr] = isoWeek.split('-W')
  return { year: parseInt(yearStr, 10), week: parseInt(weekStr, 10) }
}

function areConsecutiveWeeks(weekA: string, weekB: string): boolean {
  const a = parseIsoWeek(weekA)
  const b = parseIsoWeek(weekB)
  if (a.year === b.year) return b.week === a.week + 1
  if (b.year === a.year + 1 && b.week === 1) return a.week >= 52
  return false
}

export function qualifiesForWeekStreak(
  sessionsAttended: number,
  minSessions: number,
  totalSessionsAvailable?: number,
): boolean {
  if (sessionsAttended >= minSessions) return true
  if (
    totalSessionsAvailable != null &&
    totalSessionsAvailable > 0 &&
    totalSessionsAvailable < minSessions &&
    sessionsAttended >= totalSessionsAvailable
  ) return true
  return false
}

interface ClassifiedWeek { week: string; empty: boolean; qualifies: boolean }

function areConsecutiveOrBridgedByEmpty(weekA: string, weekB: string, classified: ClassifiedWeek[]): boolean {
  if (areConsecutiveWeeks(weekA, weekB)) return true
  let foundA = false
  for (const entry of classified) {
    if (entry.week === weekA) { foundA = true; continue }
    if (!foundA) continue
    if (entry.week === weekB) return true
    if (!entry.empty) return false
  }
  return false
}

export function calculateMaxStreak(
  weeklySessionCounts: Record<string, number>,
  minSessions: number,
  weeklyTotalSessionCounts?: Record<string, number>,
  currentIsoWeek?: string,
): number {
  const allWeekKeys = new Set([
    ...Object.keys(weeklySessionCounts),
    ...(weeklyTotalSessionCounts ? Object.keys(weeklyTotalSessionCounts) : []),
  ])
  const weeks = [...allWeekKeys].filter((w) => !currentIsoWeek || w < currentIsoWeek).sort()
  if (weeks.length === 0) return 0

  const classified: ClassifiedWeek[] = weeks.map((week) => {
    const totalAvailable = weeklyTotalSessionCounts?.[week] ?? undefined
    const attended = weeklySessionCounts[week] ?? 0
    const empty = totalAvailable === 0
    const qualifies = !empty && qualifiesForWeekStreak(attended, minSessions, totalAvailable)
    return { week, empty, qualifies }
  })

  let maxStreak = 0
  let currentRun = 0
  let lastQualifyingWeek: string | null = null

  for (const entry of classified) {
    if (entry.empty) continue
    if (!entry.qualifies) { currentRun = 0; lastQualifyingWeek = null; continue }
    if (currentRun === 0 || !lastQualifyingWeek) {
      currentRun = 1
    } else if (areConsecutiveOrBridgedByEmpty(lastQualifyingWeek, entry.week, classified)) {
      currentRun++
    } else {
      currentRun = 1
    }
    lastQualifyingWeek = entry.week
    if (currentRun > maxStreak) maxStreak = currentRun
  }
  return maxStreak
}

export function calculateStreak(
  weeklySessionCounts: Record<string, number>,
  minSessions: number,
  currentIsoWeek: string,
  weeklyTotalSessionCounts?: Record<string, number>,
): { current_streak: number; streak_last_qualified_week: string | null; max_streak: number } {
  const allWeekKeys = new Set([
    ...Object.keys(weeklySessionCounts),
    ...(weeklyTotalSessionCounts ? Object.keys(weeklyTotalSessionCounts) : []),
  ])
  const weeks = [...allWeekKeys].sort().reverse()

  let streak = 0
  let lastQualifiedWeek: string | null = null

  for (const week of weeks) {
    if (week >= currentIsoWeek) continue
    const totalAvailable = weeklyTotalSessionCounts?.[week] ?? undefined
    if (totalAvailable === 0) continue
    const attended = weeklySessionCounts[week] ?? 0
    if (qualifiesForWeekStreak(attended, minSessions, totalAvailable)) {
      streak++
      if (!lastQualifiedWeek) lastQualifiedWeek = week
    } else {
      break
    }
  }

  const maxStreak = calculateMaxStreak(weeklySessionCounts, minSessions, weeklyTotalSessionCounts, currentIsoWeek)

  return { current_streak: streak, streak_last_qualified_week: lastQualifiedWeek, max_streak: maxStreak }
}
