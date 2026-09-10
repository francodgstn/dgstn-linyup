import React, { useMemo, useState } from 'react';
import { StyleSheet, View, Pressable, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Icon, Surface, Text, useTheme } from 'react-native-paper';
import { LinearGradient } from 'expo-linear-gradient';
import { mergeBadgeThresholds } from '@linyup/shared';
import { Contact, GamificationBadgeThresholds, GamificationCoachBadge, RankingSystem } from '../../types';
import { resolvePrimaryRank } from '../../utils/profileUtils';
import { useTranslations } from '../../i18n';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** What `getBadgeGroups` needs from `useTranslations('Badges')` — a plain
 *  function param since it is built outside the component. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

interface Badge {
  id: string;
  label: string;
  description: string;
  icon: string;
  gradient: [string, string];
  earned: boolean;
  coachAssigned?: boolean;
}

interface BadgeGroup {
  /** Stable, locale-independent — used for collapse state and list keys so a
   *  language switch never loses a group's expanded/collapsed state. */
  id: string;
  title: string;
  icon: string;
  badges: Badge[];
}

interface BadgesCardProps {
  contact: Contact;
  badgeThresholds?: GamificationBadgeThresholds | null;
  coachBadges?: GamificationCoachBadge[] | null;
  /** The tenant's effective ranking systems. Empty = no Rank badge group. */
  rankingSystems?: RankingSystem[];
}

// Coach badge icons are stored as MaterialCommunityIcons names directly
// (matching react-native-paper's Icon component)

const COACH_BADGE_GRADIENTS: Record<string, [string, string]> = {
  tournament_ready: ['#EF4444', '#991B1B'],
  forms_expert: ['#8B5CF6', '#5B21B6'],
  kick_pro: ['#F59E0B', '#B45309'],
  flying_kick: ['#06B6D4', '#0E7490'],
};

const DEFAULT_COACH_GRADIENT: [string, string] = ['#6366F1', '#4338CA'];
const DEFAULT_COACH_ICON = 'star-circle';

// No built-in coach badges: a tenant's ranks/badges are a configured feature,
// never a hardcoded sport-specific set (CLAUDE.md — never a default badge set
// or belt/kickboxing/dojo copy). Absent `coachBadges` just means this studio
// hasn't configured any yet — the "Special" group falls back to `Explorer` /
// `Iron Will` alone rather than inventing combat-sport badges for it.

/**
 * Rank badges as PROPORTIONS of whatever scale the tenant configured.
 *
 * These were absolute numbers against HMD's 15-belt ladder — `rank >= 3`,
 * `>= 7`, `>= 11`, `>= 14` — which meant two things: every badge but the first
 * became unearnable the moment the migration moved ranks out of the scalar this
 * file read, and the whole group was meaningless for a club on a five-level
 * scale.
 *
 * The fractions below reproduce HMD's own thresholds exactly on a 0-14 ladder
 * (3/14, 7/14, 11/14) while meaning something on any other. `master` is the top
 * of the scale rather than a fraction, because "the highest grade" is the claim.
 */
const RANK_BADGE_FRACTIONS = { intermediate: 0.2, advanced: 0.5, blackBelt: 0.75 } as const;

const getBadgeGroups = (
  t: Translate,
  contact: Contact,
  thresholds: GamificationBadgeThresholds,
  coachBadgeList: GamificationCoachBadge[],
  rankingSystems: RankingSystem[],
): BadgeGroup[] => {
  const resolved = resolvePrimaryRank(contact, rankingSystems);
  const levels = [...(resolved?.system?.levels ?? [])].sort((a, b) => a.value - b.value);
  const position = resolved ? levels.findIndex((l) => l.value === resolved.value) : -1;
  const top = levels.length - 1;
  const fraction = position >= 0 && top > 0 ? position / top : 0;
  /** The label a tenant's own scale gives the level at `f` — so the badge says
   *  "Reach Blue" for HMD and "Reach Purple" for a BJJ club, instead of naming
   *  one organisation's belts to everybody. */
  const labelAt = (f: number) => levels[Math.ceil(f * top)]?.label ?? '';
  const sessions = contact.total_sessions ?? 0;
  const maxStreak = contact.max_streak ?? 0;
  const monthScore = contact.current_month_score ?? 0;
  const distinctActivities = contact.distinct_activities?.length ?? 0;

  const weight = contact.weight ?? 0;
  const timesLeader = contact.times_leader ?? 0;
  const timesTop5 = contact.times_top5 ?? 0;

  const a = thresholds.attendance;
  const s = thresholds.streak;
  const sc = thresholds.score;
  const lb = thresholds.leaderboard;
  const ex = thresholds.explorer;

  const groups: BadgeGroup[] = []

  // Only when the tenant actually uses ranks. A club with no ranking system was
  // shown five permanently-locked belt badges that meant nothing to it.
  if (resolved && levels.length > 1) {
    groups.push({
      id: 'rank',
      title: t('groupRank'),
      icon: 'shield-outline',
      badges: [
        { id: 'beginner', label: t('beginner'), description: t('startJourney'), icon: 'white-balance-sunny', gradient: ['#E0E0E0', '#BDBDBD'], earned: true },
        { id: 'intermediate', label: t('intermediate'), description: t('reachLevel', { level: labelAt(RANK_BADGE_FRACTIONS.intermediate) }), icon: 'shield-half-full', gradient: ['#FF9A3C', '#FF6B1B'], earned: fraction >= RANK_BADGE_FRACTIONS.intermediate },
        { id: 'advanced', label: t('advanced'), description: t('reachLevel', { level: labelAt(RANK_BADGE_FRACTIONS.advanced) }), icon: 'shield-star', gradient: ['#42A5F5', '#1565C0'], earned: fraction >= RANK_BADGE_FRACTIONS.advanced },
        { id: 'expert', label: t('expert'), description: t('reachLevel', { level: labelAt(RANK_BADGE_FRACTIONS.blackBelt) }), icon: 'shield-star', gradient: ['#555555', '#1A1A1A'], earned: fraction >= RANK_BADGE_FRACTIONS.blackBelt },
        { id: 'master', label: t('master'), description: t('reachLevel', { level: levels[top]?.label ?? t('highestGrade') }), icon: 'crown', gradient: ['#FFD700', '#F59E0B'], earned: position === top },
      ],
    })
  }

  const attendanceBadges: Badge[] = [];
  if (a.enabled !== false) {
    attendanceBadges.push(
      { id: 'first-class', label: t('firstClass'), description: a.first_class === 1 ? t('attendFirstSession') : t('attendSessions', { count: a.first_class }), icon: 'shoe-sneaker', gradient: ['#34D399', '#059669'], earned: sessions >= a.first_class },
      { id: 'dedicated', label: t('dedicated'), description: t('attendSessions', { count: a.dedicated }), icon: 'dumbbell', gradient: ['#60A5FA', '#2563EB'], earned: sessions >= a.dedicated },
      { id: 'committed', label: t('committed'), description: t('attendSessions', { count: a.committed }), icon: 'arm-flex', gradient: ['#A78BFA', '#7C3AED'], earned: sessions >= a.committed },
      { id: 'centurion', label: t('centurion'), description: t('attendSessions', { count: a.centurion }), icon: 'medal', gradient: ['#FBBF24', '#D97706'], earned: sessions >= a.centurion },
      { id: 'veteran', label: t('veteran'), description: t('attendSessions', { count: a.veteran }), icon: 'trophy-award', gradient: ['#F97316', '#C2410C'], earned: sessions >= a.veteran },
    );
  }
  if (s.enabled !== false) {
    attendanceBadges.push(
      { id: 'on-fire', label: t('onFire'), description: t('reachStreak', { weeks: s.on_fire }), icon: 'fire', gradient: ['#F87171', '#DC2626'], earned: maxStreak >= s.on_fire },
      { id: 'unstoppable', label: t('unstoppable'), description: t('reachStreak', { weeks: s.unstoppable }), icon: 'lightning-bolt', gradient: ['#818CF8', '#4F46E5'], earned: maxStreak >= s.unstoppable },
      { id: 'legendary', label: t('legendary'), description: t('reachStreak', { weeks: s.legendary }), icon: 'star-shooting', gradient: ['#F472B6', '#BE185D'], earned: maxStreak >= s.legendary },
    );
  }
  if (attendanceBadges.length > 0) {
    groups.push({
      id: 'attendance',
      title: t('groupAttendanceStreak'),
      icon: 'calendar-check-outline',
      badges: attendanceBadges,
    });
  }

  const scoreBadges: Badge[] = [];
  if (sc.enabled !== false) {
    scoreBadges.push(
      { id: 'rising-star', label: t('risingStar'), description: t('scorePoints', { points: sc.rising_star }), icon: 'star-outline', gradient: ['#60A5FA', '#2563EB'], earned: monthScore >= sc.rising_star },
      { id: 'monthly-star', label: t('monthlyStar'), description: t('scorePoints', { points: sc.monthly_star }), icon: 'star-circle', gradient: ['#FBBF24', '#EA580C'], earned: monthScore >= sc.monthly_star },
      { id: 'superstar', label: t('superstar'), description: t('scorePoints', { points: sc.superstar }), icon: 'star-shooting', gradient: ['#F472B6', '#9333EA'], earned: monthScore >= sc.superstar },
    );
  }
  if (lb.enabled !== false) {
    scoreBadges.push(
      { id: 'top-5', label: t('top5'), description: lb.top5 === 1 ? t('finishTop5Once') : t('finishTop5Times', { count: lb.top5 }), icon: 'numeric-5-circle-outline', gradient: ['#60A5FA', '#2563EB'], earned: timesTop5 >= lb.top5 },
      { id: 'leader', label: t('leader'), description: lb.leader === 1 ? t('finishFirstOnce') : t('finishFirstTimes', { count: lb.leader }), icon: 'trophy', gradient: ['#FBBF24', '#D97706'], earned: timesLeader >= lb.leader },
      { id: 'hall-of-fame', label: t('hallOfFame'), description: t('finishTop5PlusTimes', { count: lb.hall_of_fame }), icon: 'star-face', gradient: ['#F472B6', '#9333EA'], earned: timesTop5 >= lb.hall_of_fame },
    );
  }
  if (scoreBadges.length > 0) {
    groups.push({
      id: 'score',
      title: t('groupScoreLeaderboard'),
      icon: 'podium',
      badges: scoreBadges,
    });
  }

  const customBadges = contact.custom_badges ?? [];

  const specialBadges: Badge[] = [];
  if (ex.enabled !== false) {
    specialBadges.push(
      { id: 'explorer', label: t('explorer'), description: t('trainActivities', { count: ex.explorer }), icon: 'compass-outline', gradient: ['#2DD4BF', '#0D9488'], earned: distinctActivities >= ex.explorer },
    );
  }
  specialBadges.push(
    { id: 'iron-will', label: t('ironWill'), description: t('updateWeight'), icon: 'kettlebell', gradient: ['#78716C', '#44403C'], earned: weight > 10 },
    // cb.label / cb.description are the studio's own copy (Firestore), never translated here.
    ...coachBadgeList.map((cb) => {
      const rnIcon = cb.icon || DEFAULT_COACH_ICON;
      const gradient = COACH_BADGE_GRADIENTS[cb.key] || DEFAULT_COACH_GRADIENT;
      return {
        id: `coach-${cb.key}`,
        label: cb.label,
        description: cb.description || t('coachAssignedDefault'),
        icon: rnIcon,
        gradient,
        earned: customBadges.includes(cb.key),
        coachAssigned: true,
      };
    }),
  );
  if (specialBadges.length > 0) {
    groups.push({
      id: 'special',
      title: t('groupSpecial'),
      icon: 'creation',
      badges: specialBadges,
    });
  }

  return groups;
};

export const BadgesCard: React.FC<BadgesCardProps> = ({ contact, badgeThresholds, coachBadges, rankingSystems }) => {
  const theme = useTheme();
  const t = useTranslations('Badges');
  const [selectedBadge, setSelectedBadge] = useState<Badge | null>(null);
  // The studio's thresholds over the product defaults — the same resolution the
  // admin editor and the web Space make (`mergeBadgeThresholds`, @linyup/shared).
  const mergedThresholds = useMemo<GamificationBadgeThresholds>(() => mergeBadgeThresholds(badgeThresholds), [badgeThresholds]);

  const resolvedCoachBadges = coachBadges || [];
  const groups = useMemo(() => getBadgeGroups(t, contact, mergedThresholds, resolvedCoachBadges, rankingSystems ?? []), [t, contact, mergedThresholds, resolvedCoachBadges, rankingSystems]);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    new Set(getBadgeGroups(t, contact, mergeBadgeThresholds(badgeThresholds), coachBadges || [], rankingSystems ?? []).map(g => g.id))
  );
  const allBadges = groups.flatMap(g => g.badges);
  const earnedCount = allBadges.filter(b => b.earned).length;

  const toggleGroup = (id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        if (selectedBadge && groups.find(g => g.id === id)?.badges.some(b => b.id === selectedBadge.id)) {
          setSelectedBadge(null);
        }
      }
      return next;
    });
  };

  const handleBadgeTap = (badge: Badge) => {
    setSelectedBadge(prev => prev?.id === badge.id ? null : badge);
  };

  const renderBadge = (badge: Badge) => (
    <Pressable key={badge.id} onPress={() => handleBadgeTap(badge)} style={styles.badgeItem}>
      <View>
        {badge.earned ? (
          <LinearGradient
            colors={badge.gradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[
              styles.badgeCircle,
              selectedBadge?.id === badge.id && { borderWidth: 2.5, borderColor: theme.colors.primary },
            ]}
          >
            <Icon source={badge.icon} size={32} color="#FFFFFF" />
          </LinearGradient>
        ) : (
          <View
            style={[
              styles.badgeCircle,
              {
                backgroundColor: theme.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                borderWidth: selectedBadge?.id === badge.id ? 2.5 : 1,
                borderColor: selectedBadge?.id === badge.id
                  ? theme.colors.primary
                  : theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
              },
            ]}
          >
            <Icon
              source={badge.icon}
              size={32}
              color={theme.dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)'}
            />
            <View style={[styles.lockOverlay, { backgroundColor: theme.dark ? '#2A2A2A' : '#E5E5E5' }]}>
              <Icon source="lock" size={11} color={theme.dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.35)'} />
            </View>
          </View>
        )}
        {badge.coachAssigned && (
          <View style={[styles.coachOverlay, { backgroundColor: theme.dark ? '#44381A' : '#FEF3C7' }]}>
            <Icon source="medal" size={12} color={theme.dark ? '#FBBF24' : '#B45309'} />
          </View>
        )}
      </View>
      <Text
        numberOfLines={1}
        style={[
          styles.badgeLabel,
          {
            color: badge.earned ? theme.colors.onSurface : theme.colors.onSurfaceVariant,
            opacity: badge.earned ? 1 : 0.4,
          },
        ]}
      >
        {badge.label}
      </Text>
    </Pressable>
  );

  const renderTooltip = () => {
    if (!selectedBadge) return null;
    return (
      <View style={[styles.tooltip, { backgroundColor: theme.dark ? '#2A2A2A' : '#F1F5F9' }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon
            source={selectedBadge.earned ? 'check-circle' : 'lock-outline'}
            size={14}
            color={selectedBadge.earned ? '#10B981' : theme.colors.onSurfaceVariant}
          />
          <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '700', flex: 1 }}>
            {selectedBadge.label}
          </Text>
        </View>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 1, marginLeft: 20 }}>
          {selectedBadge.description}
        </Text>
      </View>
    );
  };

  const selectedGroupId = selectedBadge
    ? groups.find(g => g.badges.some(b => b.id === selectedBadge.id))?.id ?? null
    : null;

  return (
    <View style={{ marginBottom: 4 }}>
      {/* Section heading — outside card */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingHorizontal: 4 }}>
        <Text variant="titleLarge" style={{ fontWeight: '800', color: theme.colors.onSurface }}>
          {t('achievements')}
        </Text>
        <Surface style={[styles.countBadge, { backgroundColor: theme.colors.secondaryContainer }]} elevation={0}>
          <Text style={{ color: theme.colors.onSecondaryContainer, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 }}>
            {earnedCount}/{allBadges.length}
          </Text>
        </Surface>
      </View>

    <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
      <View style={styles.content}>

        {groups.map((group, index) => {
          const isCollapsed = collapsedGroups.has(group.id);
          const groupEarned = group.badges.filter(b => b.earned).length;

          return (
            <View key={group.id} style={index > 0 ? { marginTop: 14 } : undefined}>
              <Pressable onPress={() => toggleGroup(group.id)} style={styles.groupHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                  <Icon source={group.icon} size={14} color={theme.colors.onSurfaceVariant} />
                  <Text style={[styles.groupTitle, { color: theme.colors.onSurfaceVariant }]}>
                    {group.title}
                  </Text>
                  <Text style={[styles.groupCount, { color: theme.colors.onSurfaceVariant }]}>
                    {groupEarned}/{group.badges.length}
                  </Text>
                </View>
                <Icon
                  source={isCollapsed ? 'chevron-down' : 'chevron-up'}
                  size={18}
                  color={theme.colors.onSurfaceVariant}
                />
              </Pressable>
              {!isCollapsed && (
                <>
                  <View style={styles.grid}>
                    {group.badges.map(renderBadge)}
                  </View>
                  {selectedGroupId === group.id && renderTooltip()}
                </>
              )}
            </View>
          );
        })}
      </View>
    </Surface>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    overflow: 'hidden',
  },
  content: {
    padding: 16,
  },
  countBadge: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 12,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  groupTitle: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  groupCount: {
    fontSize: 12,
    fontWeight: '600',
    opacity: 0.5,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'flex-start',
  },
  badgeItem: {
    alignItems: 'center',
    width: 76,
  },
  badgeCircle: {
    width: 66,
    height: 66,
    borderRadius: 33,
    justifyContent: 'center',
    alignItems: 'center',
  },
  lockOverlay: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  coachOverlay: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 6,
    textAlign: 'center',
  },
  tooltip: {
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
  },
});
