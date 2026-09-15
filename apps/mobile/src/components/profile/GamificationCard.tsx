import React from 'react';
import { StyleSheet, View, Dimensions } from 'react-native';
import { Card, Icon, Text, useTheme, IconButton, TouchableRipple } from 'react-native-paper';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslations } from '../../i18n';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface GamificationCardProps {
  score?: number;
  streak?: number;
  maxStreak?: number;
  leaderboardRank?: number;
  variant?: 'compact' | 'hero';
  onPress?: () => void;
}

export const GamificationCard: React.FC<GamificationCardProps> = ({
  score = 0,
  streak = 0,
  maxStreak = 0,
  leaderboardRank,
  variant = 'compact',
  onPress
}) => {
  const theme = useTheme();
  const t = useTranslations('Gamification');

  if (score <= 0 && streak <= 0) return null;

  const isDark = theme.dark;
  const isHero = variant === 'hero';

  // Gradient definitions
  const pointsGradient: [string, string] = isDark
    ? ['#D97706', '#B45309']  // Darker Amber/Orange
    : ['#FBBF24', '#F59E0B']; // Bright Amber

  const streakGradient: [string, string] = isDark
    ? ['#4F46E5', '#7C3AED']  // Indigo -> Violet
    : ['#6366F1', '#8B5CF6']; // Indigo -> Violet (Lighter)

  // If we want to keep the unified "Hero" gradient for consistency, we can,
  // but "separate cards" often implies distinction.
  // Let's use the requested "bold" aesthetic.
  // User liked the previous Indigo->Pink. Let's stick to that for Streak,
  // and use a complementary one for Points, or use the same for visual unity?
  // "The points and streak should be 2 separate cards".
  // Let's use specific colors for meaning: Star=Gold/Orange, Fire=Red/Orange/Pink.

  const cardGradientPoints: [string, string] = ['#F59E0B', '#EA580C']; // Amber -> Orange
  const cardGradientStreak: [string, string] = ['#6366F1', '#DB2777']; // Indigo -> Pink

  if (isHero) {
    const message = streak > 3
      ? t('onFireMessage')
      : t('keepTrainingMessage');

    return (
      <View style={styles.heroContainer}>
        <View style={styles.heroRow}>
          {/* Points Card */}
          <TouchableRipple onPress={onPress} style={styles.halfCardWrapper} borderless>
            <LinearGradient
              colors={cardGradientPoints}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.halfCard}
            >
              {leaderboardRank !== undefined && (
                <View style={[styles.bestBadge, styles.bestBadgeCorner, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
                  <Icon
                    source={leaderboardRank === 1 ? 'trophy' : leaderboardRank <= 3 ? 'medal' : 'podium'}
                    size={13}
                    color="#FFFFFF"
                  />
                  <Text style={styles.bestBadgeText}>{leaderboardRank}</Text>
                </View>
              )}
              <Text style={styles.heroStatValue}>{score}</Text>
              <View style={styles.cardBottom}>
                <View>
                  <Text style={styles.heroStatLabel}>{t('pointsLabel').toUpperCase()}</Text>
                  <Text style={styles.heroStatSublabel}>{t('thisMonthLabel').toUpperCase()}</Text>
                </View>
                <View style={[styles.iconBadge, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
                  <Icon source="star" size={26} color="#FFFFFF" />
                </View>
              </View>
            </LinearGradient>
          </TouchableRipple>

          {/* Streak Card */}
          <TouchableRipple onPress={onPress} style={styles.halfCardWrapper} borderless>
            <LinearGradient
              colors={cardGradientStreak}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.halfCard}
            >
              {maxStreak > 0 && (
                <View style={[styles.bestBadge, styles.bestBadgeCorner, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
                  <Icon source="fire" size={13} color="#FFFFFF" />
                  <Text style={styles.bestBadgeText}>{t('bestPrefix', { count: maxStreak })}</Text>
                </View>
              )}
              <Text style={styles.heroStatValue}>{streak}</Text>
              <View style={styles.cardBottom}>
                <View>
                  <Text style={styles.heroStatLabel}>{(streak === 1 ? t('weekLabel') : t('weeksLabel')).toUpperCase()}</Text>
                  <Text style={styles.heroStatSublabel}>{t('streakLabel').toUpperCase()}</Text>
                </View>
                <View style={[styles.iconBadge, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
                  <Icon source="fire" size={26} color="#FFFFFF" />
                </View>
              </View>
            </LinearGradient>
          </TouchableRipple>
        </View>

        {/* Motivational Message - Text directly on background */}
        <Text style={[styles.heroMessage, { color: theme.colors.outline }]}>
          {message}
        </Text>
      </View>
    );
  }

  // COMPACT VARIANT (Keeping existing logic but cleaning up if needed)
  return (
    <Card style={[styles.card, { backgroundColor: theme.colors.surface }]}>
      <Card.Content style={styles.content}>
        <View style={styles.statsContainer}>
          {score > 0 && (
            <View style={styles.statItem}>
              <View style={[
                styles.iconContainer,
                { backgroundColor: isDark ? 'rgba(217, 119, 6, 0.15)' : '#FEF3C7' }
              ]}>
                <Icon source="star" size={24} color="#D97706" />
              </View>
              <View>
                <Text variant="titleLarge" style={[styles.statValue, { color: theme.colors.onSurface }]}>
                  {score} <Text variant="bodyMedium" style={[styles.unitText, { color: theme.colors.onSurfaceVariant }]}>{t('ptsUnit')}</Text>
                </Text>
                <Text variant="labelSmall" style={[styles.statLabel, { color: theme.colors.onSurfaceVariant }]}>{t('thisMonthLabel').toUpperCase()}</Text>
              </View>
            </View>
          )}

          {(score > 0 && streak > 0) && <View style={[styles.verticalDivider, { backgroundColor: theme.colors.outlineVariant }]} />}

          {streak > 0 && (
            <View style={styles.statItem}>
              <View style={[
                styles.iconContainer,
                { backgroundColor: isDark ? 'rgba(37, 99, 235, 0.15)' : '#DBEAFE' }
              ]}>
                <Icon source="fire" size={24} color="#2563EB" />
              </View>
              <View>
                <Text variant="titleLarge" style={[styles.statValue, { color: theme.colors.onSurface }]}>
                  {streak} <Text variant="bodyMedium" style={[styles.unitText, { color: theme.colors.onSurfaceVariant }]}>{streak === 1 ? t('weekUnit') : t('weeksUnit')}</Text>
                </Text>
                <Text variant="labelSmall" style={[styles.statLabel, { color: theme.colors.onSurfaceVariant }]}>{t('streakLabel').toUpperCase()}</Text>
                {maxStreak > 0 && (
                  <Text variant="labelSmall" style={[styles.statSublabel, { color: theme.colors.onSurfaceVariant }]}>{t('bestWeeksShort', { count: maxStreak })}</Text>
                )}
              </View>
            </View>
          )}
        </View>
      </Card.Content>
    </Card>
  );
};

const styles = StyleSheet.create({
  // Compact Styles
  card: {
    borderRadius: 24,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    marginVertical: 4,
  },
  content: {
    padding: 20,
  },
  statsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statValue: {
    fontWeight: '900',
  },
  unitText: {
    fontWeight: '600',
    fontSize: 14,
  },
  statLabel: {
    fontWeight: '800',
    letterSpacing: 0.5,
    marginTop: -2,
  },
  statSublabel: {
    fontWeight: '600',
    fontSize: 11,
    marginTop: 2,
    opacity: 0.7,
  },
  verticalDivider: {
    width: 1,
    height: 40,
  },

  // Hero Styles
  heroContainer: {
    marginVertical: 12,
    gap: 8,
  },
  heroRow: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  halfCardWrapper: {
    flex: 1,
    borderRadius: 24,
    overflow: 'hidden',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
  },
  halfCard: {
    padding: 16,
    paddingBottom: 12,
  },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: 0,
  },
  bestBadge: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  bestBadgeCorner: {
    position: 'absolute',
    top: 12,
    right: 12,
  },
  bestBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  heroStatValue: {
    fontSize: 64,
    fontWeight: '900',
    color: '#FFFFFF',
    lineHeight: 68,
  },
  heroStatUnit: {
    fontSize: 16,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.8)',
    marginLeft: 2,
  },
  heroStatLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: 'rgba(255, 255, 255, 0.7)',
    letterSpacing: 1,
  },
  heroStatSublabel: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.5)',
    marginTop: 2,
    letterSpacing: 0.5,
  },
  heroMessage: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    opacity: 0.8,
  },
});
