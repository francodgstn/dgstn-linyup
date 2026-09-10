'use client'

// The Space's Gamification tab — score, streak, leaderboard, badges. A
// deliberately SIMPLE web view: the primary gamification surface is still the
// mobile app (`apps/mobile/src/components/profile/GamificationCard.tsx` +
// `BadgesCard.tsx`), which is not shipped to members yet. This tab exists so
// the capability is demonstrable and usable TODAY, on the surface members
// actually have — not to reproduce the mobile app's richer hero cards, sort
// toggles, rank badges or coach-assigned badges. See `badges.ts` for exactly
// what is intentionally left out and why.
//
// GATING, two independent questions:
//  1. Is the tab OFFERED at all? `TeamPublicProfile.gamificationEnabled`
//     (mirrors the `gamification` plugin install — see syncTeamPublicProfile.ts).
//     `SpacePortalNav` already hides the nav item when this is false; this page
//     also checks it directly so a stale/bookmarked URL doesn't render a page
//     for a feature the studio never turned on.
//  2. Is a visitor SIGNED IN? Same wall every other Space module shows.
//
// DATA SOURCES, both already permitted for a contact session by
// firestore.rules with NO changes needed:
//  - Score/streak/badge stats: the contact's OWN `contacts/{contactId}` doc
//    (`usePublicContactRecord`, the `isSelfContact` rule arm).
//  - Leaderboard: `teams/{teamId}/leaderboard/current`, a denormalized
//    document with its own `sessionExpires` rule arm — see
//    `useSpaceLeaderboard.ts` for the exact rule text and why it is safe.

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Trophy, Star, Flame, Award, Lock } from 'lucide-react'
import { isTrialStage, leaderboardDisplayName, mergeBadgeThresholds } from '@linyup/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryErrorState } from '@/components/ui/query-error'
import { loadFailureDetail } from '@/lib/publicQueryError'
import SpaceSignInWall from '../SpaceSignInWall'
import { useSpaceAuth } from '../SpaceAuthProvider'
import { usePublicContactRecord } from '../../usePublicContactRecord'
import { usePublicTeam } from '../../PublicTeamProvider'
import { useSpaceTheme } from '../useSpaceTheme'
import { useSpaceLeaderboard } from './useSpaceLeaderboard'
import { badgeDefinitions, isBadgeEarned, earnedBadgeCount, type BadgeGroupKey, type BadgeStats } from './badges'
import { usePublicFormat } from '../../usePublicFormat'


const LEADERBOARD_DISPLAY_LIMIT = 10

const GROUP_ICON: Record<BadgeGroupKey, React.ElementType> = {
  attendance: Trophy,
  streak: Flame,
  score: Star,
}

export default function GamificationHome() {
  const t = useTranslations('SpaceGamification')
  const tSpace = useTranslations('Space')
  const { isAuthenticated, contact } = useSpaceAuth()
  const { team } = usePublicTeam()
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const fmt = usePublicFormat()
  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }

  const {
    data: contactRecord,
    isPending: contactPending,
    isError: contactErrored,
    error: contactError,
    refetch: refetchContact,
  } = usePublicContactRecord()

  const {
    data: leaderboard,
    isLoading: leaderboardLoading,
    isError: leaderboardErrored,
    error: leaderboardError,
    refetch: refetchLeaderboard,
  } = useSpaceLeaderboard()

  const stats: BadgeStats = useMemo(
    () => ({
      totalSessions: contactRecord?.total_sessions ?? 0,
      maxStreak: contactRecord?.max_streak ?? 0,
      monthScore: contactRecord?.current_month_score ?? 0,
    }),
    [contactRecord]
  )
  // The studio's own thresholds (public mirror), over the product defaults —
  // the same resolution the admin editor and the member app make.
  const badges = useMemo(
    () => badgeDefinitions(mergeBadgeThresholds(team.gamification_settings?.badge_thresholds)),
    [team.gamification_settings?.badge_thresholds]
  )
  const earned = earnedBadgeCount(badges, stats)

  const monthLabel = useMemo(() => {
    const month = leaderboard?.month
    if (!month) return ''
    // Mid-month, noon UTC: an instant that is inside `month` in EVERY zone, so
    // the studio-zone formatter cannot land on the neighbouring month.
    const parsed = new Date(`${month}-15T12:00:00Z`)
    if (Number.isNaN(parsed.getTime())) return month
    return fmt.monthYear(parsed)
  }, [leaderboard?.month, fmt])

  const { topEntries, myEntry, myEntryInTop } = useMemo(() => {
    const entries = leaderboard?.entries ?? []
    const top = entries.slice(0, LEADERBOARD_DISPLAY_LIMIT)
    const mine = contact?.id ? (entries.find((e) => e.contact_id === contact.id) ?? null) : null
    return { topEntries: top, myEntry: mine, myEntryInTop: mine ? top.some((e) => e.contact_id === mine.contact_id) : false }
  }, [leaderboard?.entries, contact?.id])

  if (!isAuthenticated) {
    return <SpaceSignInWall prompt={tSpace('gamificationSignInPrompt')} />
  }

  // Direct-URL / stale-bookmark guard — the nav already hides this tab when the
  // studio never installed the plugin.
  if (!team.gamificationEnabled) {
    return (
      <div className="mt-10 rounded-2xl p-8 text-center" style={cardStyle}>
        <Trophy className="mx-auto h-7 w-7" style={{ color: textMuted }} />
        <p className="mt-3 text-sm font-medium" style={{ color: textMain }}>{t('notEnabledTitle')}</p>
        <p className="mt-1 text-sm" style={{ color: textMuted }}>{t('notEnabledBody')}</p>
      </div>
    )
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center gap-2">
        <Trophy className="h-4 w-4" style={{ color: accent }} />
        <h1 className="text-lg font-bold" style={{ color: textMain }}>{t('pageTitle')}</h1>
      </div>

      {/* Score + streak */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl p-4" style={cardStyle}>
          <div className="flex items-center gap-1.5 mb-2">
            <Star className="h-3.5 w-3.5" style={{ color: '#d97706' }} />
            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: textMuted }}>{t('scoreTitle')}</p>
          </div>
          {contactPending ? (
            <Skeleton className="h-8 w-16" />
          ) : contactErrored ? (
            <QueryErrorState
              onRetry={() => void refetchContact()}
              detail={loadFailureDetail(contactError)}
              theme={{ textMain, textMuted, accent, border: cardBorder }}
            />
          ) : (
            <>
              <p className="text-3xl font-extrabold" style={{ color: textMain }}>
                {stats.monthScore}
                <span className="ml-1 text-sm font-medium" style={{ color: textMuted }}>{t('scoreUnit')}</span>
              </p>
              <p className="mt-0.5 text-xs" style={{ color: textMuted }}>{t('scoreSubtitle')}</p>
            </>
          )}
        </div>

        <div className="rounded-2xl p-4" style={cardStyle}>
          <div className="flex items-center gap-1.5 mb-2">
            <Flame className="h-3.5 w-3.5" style={{ color: '#2563eb' }} />
            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: textMuted }}>{t('streakTitle')}</p>
          </div>
          {contactPending ? (
            <Skeleton className="h-8 w-16" />
          ) : contactErrored ? (
            <QueryErrorState
              onRetry={() => void refetchContact()}
              detail={loadFailureDetail(contactError)}
              theme={{ textMain, textMuted, accent, border: cardBorder }}
            />
          ) : (
            <>
              <p className="text-3xl font-extrabold" style={{ color: textMain }}>
                {contactRecord?.current_streak ?? 0}
                <span className="ml-1 text-sm font-medium" style={{ color: textMuted }}>{t('streakUnit')}</span>
              </p>
              <p className="mt-0.5 text-xs" style={{ color: textMuted }}>
                {stats.maxStreak > 0 ? t('streakBest', { count: stats.maxStreak }) : t('streakZeroHint')}
              </p>
            </>
          )}
        </div>
      </div>

      {/* Leaderboard */}
      <section className="rounded-2xl p-4" style={cardStyle}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Trophy className="h-4 w-4" style={{ color: accent }} />
            <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
              {t('leaderboardTitle')}
            </h2>
          </div>
          {monthLabel && <span className="text-xs" style={{ color: textMuted }}>{monthLabel}</span>}
        </div>

        {leaderboardLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-10 w-full rounded-xl" />
          </div>
        ) : leaderboardErrored ? (
          <QueryErrorState
            onRetry={() => void refetchLeaderboard()}
            title={t('leaderboardLoadFailed')}
            detail={loadFailureDetail(leaderboardError)}
            theme={{ textMain, textMuted, accent, border: cardBorder }}
          />
        ) : topEntries.length === 0 ? (
          <p className="py-4 text-sm" style={{ color: textMuted }}>{t('leaderboardEmpty')}</p>
        ) : (
          <div className="space-y-1">
            {topEntries.map((entry) => {
              const isMe = entry.contact_id === contact?.id
              const isTrial = isTrialStage(entry.acquisition_stage)
              return (
                <div
                  key={entry.contact_id}
                  className="flex items-center gap-3 rounded-xl px-2 py-2"
                  style={isMe ? { background: `${accent}14` } : undefined}
                >
                  <span
                    className="flex h-6 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                    style={{
                      background: entry.rank <= 3 ? `${accent}22` : cardBorder,
                      color: entry.rank <= 3 ? accent : textMuted,
                    }}
                  >
                    {entry.rank}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    style={{ color: textMain, fontWeight: isMe ? 700 : 400 }}
                  >
                    {leaderboardDisplayName(entry)}
                    {isTrial && <span className="ml-1 text-xs" style={{ color: textMuted }}>{t('leaderboardTrialLabel')}</span>}
                  </span>
                  <span className="shrink-0 text-sm font-bold" style={{ color: textMain }}>
                    {entry.score} <span className="text-xs font-medium" style={{ color: textMuted }}>{t('scoreUnit')}</span>
                  </span>
                </div>
              )
            })}

            {myEntry && !myEntryInTop && (
              <div className="mt-2 flex items-center gap-3 rounded-xl px-2 py-2" style={{ background: `${accent}14` }}>
                <span
                  className="flex h-6 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                  style={{ background: cardBorder, color: textMuted }}
                >
                  {myEntry.rank}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-bold" style={{ color: textMain }}>
                  {t('leaderboardYou')}
                </span>
                <span className="shrink-0 text-sm font-bold" style={{ color: textMain }}>
                  {myEntry.score} <span className="text-xs font-medium" style={{ color: textMuted }}>{t('scoreUnit')}</span>
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Badges */}
      <section className="rounded-2xl p-4" style={cardStyle}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Award className="h-4 w-4" style={{ color: accent }} />
            <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
              {t('badgesTitle')}
            </h2>
          </div>
          {!contactPending && !contactErrored && (
            <span className="text-xs font-semibold" style={{ color: textMuted }}>
              {t('badgesEarnedCount', { earned, total: badges.length })}
            </span>
          )}
        </div>

        {contactPending ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : contactErrored ? (
          <QueryErrorState
            onRetry={() => void refetchContact()}
            detail={loadFailureDetail(contactError)}
            theme={{ textMain, textMuted, accent, border: cardBorder }}
          />
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {badges.map((def) => {
              const isEarned = isBadgeEarned(def, stats)
              const GroupIcon = GROUP_ICON[def.group]
              return (
                <div key={def.key} className="flex flex-col items-center gap-1.5 text-center">
                  <div
                    className="relative flex h-12 w-12 items-center justify-center rounded-full"
                    style={
                      isEarned
                        ? { background: `${accent}22`, color: accent }
                        : { background: cardBorder, color: textMuted, opacity: 0.6 }
                    }
                    title={t(`badges.${def.key}.description`)}
                  >
                    <GroupIcon className="h-5 w-5" />
                    {!isEarned && (
                      <span
                        className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full"
                        style={{ background: cardBg, border: `1px solid ${cardBorder}` }}
                      >
                        <Lock className="h-2.5 w-2.5" style={{ color: textMuted }} />
                      </span>
                    )}
                  </div>
                  <span
                    className="line-clamp-2 text-[11px] font-medium leading-tight"
                    style={{ color: isEarned ? textMain : textMuted, opacity: isEarned ? 1 : 0.6 }}
                  >
                    {t(`badges.${def.key}.label`)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
