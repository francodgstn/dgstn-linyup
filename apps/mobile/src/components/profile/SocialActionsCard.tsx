import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ActivityIndicator, Linking, Share, StyleSheet, View } from 'react-native';
import { Icon, Surface, Text, TouchableRipple } from 'react-native-paper';
import { useAppTheme } from '../../theme';
import { LinearGradient } from 'expo-linear-gradient';
import { FirestoreService } from '../../services/firestore';
import { ReferralInfo, TeamPublicProfile } from '../../types';
import { useTranslations } from '../../i18n';

// ─── helpers ──────────────────────────────────────────────────────────────────

function parseHandle(value: string): string {
  try {
    const url = new URL(value);
    const parts = url.pathname.replace(/\/$/, '').split('/');
    const handle = parts[parts.length - 1];
    return handle ? `@${handle}` : value;
  } catch {
    return `@${value.replace(/^@/, '')}`;
  }
}

async function openInstagram(rawUrl: string) {
  let username = rawUrl;
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.replace(/\/$/, '').split('/');
    username = parts[parts.length - 1] || rawUrl;
  } catch {
    username = rawUrl.replace(/^@/, '');
  }
  const appUrl = `instagram://user?username=${username}`;
  const webUrl = rawUrl.startsWith('http')
    ? rawUrl
    : `https://www.instagram.com/${username}`;
  // canOpenURL is unreliable on iOS for unwhitelisted schemes — try app first, fall back to web
  try {
    await Linking.openURL(appUrl);
  } catch {
    await Linking.openURL(webUrl);
  }
}

// ─── component ────────────────────────────────────────────────────────────────

interface SocialActionsCardProps {
  teamProfile: TeamPublicProfile;
  rewardedCount: number;
}

export const SocialActionsCard: React.FC<SocialActionsCardProps> = ({
  teamProfile,
  rewardedCount,
}) => {
  const theme = useAppTheme();
  const t = useTranslations('Social');
  // Accent colors (small touches only — the card stays neutral): the referral
  // action in the studio's own color, the third-party marks in theirs.
  const REFERRAL_COLOR = theme.colors.primary;
  const IG_COLOR = theme.semantic.instagram;
  const REVIEW_COLOR = theme.semantic.warning;
  const [referralInfo, setReferralInfo] = useState<ReferralInfo | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const shimmer = useRef(new Animated.Value(0)).current;

  // One-shot shimmer sweep on every mount (i.e. every time the dash is opened)
  useEffect(() => {
    shimmer.setValue(0);
    const timer = setTimeout(() => {
      Animated.timing(shimmer, {
        toValue: 1,
        duration: 900,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    }, 350);
    return () => clearTimeout(timer);
  }, [shimmer]);

  const shimmerTranslate = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [-120, 500],
  });

  const igLink = teamProfile.socialLinks?.find(l => l.platform === 'instagram');
  const reviewLink = teamProfile.socialLinks?.find(l => l.platform === 'review');
  const showReferral = !!teamProfile.referralEnabled;
  const showInstagram = !!igLink;
  const showReview = !!reviewLink;

  if (!showReferral && !showInstagram && !showReview) return null;

  const handle = igLink ? parseHandle(igLink.url) : '';

  async function handleShare() {
    setShareLoading(true);
    try {
      let info = referralInfo;
      if (!info) {
        info = await FirestoreService.getMyReferralCode();
        if (info) setReferralInfo(info);
      }
      if (!info) return;
      await Share.share({ message: info.referralUrl, url: info.referralUrl });
    } catch {
      // dismissed or error — ignore
    } finally {
      setShareLoading(false);
    }
  }

  return (
    <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
      {showReferral && (
        <TouchableRipple onPress={handleShare} disabled={shareLoading} style={styles.row}>
          <View style={styles.rowInner}>
            <View style={[styles.iconBadge, { backgroundColor: theme.dark ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.08)' }]}>
              <Icon source="gift-outline" size={20} color={REFERRAL_COLOR} />
            </View>
            <View style={styles.textBlock}>
              <Text variant="titleSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
                {t('inviteFriend')}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {rewardedCount > 0
                  ? (rewardedCount === 1 ? t('rewardsEarnedOne') : t('rewardsEarnedOther', { count: rewardedCount }))
                  : t('shareToEarn')}
              </Text>
            </View>
            {shareLoading ? (
              <ActivityIndicator size={16} color={REFERRAL_COLOR} />
            ) : (
              <View style={[styles.chip, { borderColor: REFERRAL_COLOR }]}>
                <Text variant="labelSmall" style={[styles.chipLabel, { color: REFERRAL_COLOR }]}>{t('share')}</Text>
              </View>
            )}
          </View>
        </TouchableRipple>
      )}

      {showReferral && showInstagram && (
        <View style={[styles.divider, { backgroundColor: theme.colors.outlineVariant }]} />
      )}

      {showInstagram && (
        <TouchableRipple onPress={() => openInstagram(igLink!.url)} style={styles.row}>
          <View style={styles.rowInner}>
            <View style={[styles.iconBadge, { backgroundColor: theme.dark ? 'rgba(225,48,108,0.15)' : 'rgba(225,48,108,0.08)' }]}>
              <Icon source="instagram" size={20} color={IG_COLOR} />
            </View>
            <View style={styles.textBlock}>
              <Text variant="titleSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
                {t('followInstagram')}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {handle}
              </Text>
            </View>
            <View style={[styles.chip, { borderColor: IG_COLOR }]}>
              <Text variant="labelSmall" style={[styles.chipLabel, { color: IG_COLOR }]}>{t('follow')}</Text>
            </View>
          </View>
        </TouchableRipple>
      )}

      {showReview && (showInstagram || showReferral) && (
        <View style={[styles.divider, { backgroundColor: theme.colors.outlineVariant }]} />
      )}

      {showReview && (
        <TouchableRipple onPress={() => Linking.openURL(reviewLink!.url).catch(() => undefined)} style={styles.row}>
          <View style={styles.rowInner}>
            <View style={[styles.iconBadge, { backgroundColor: theme.dark ? 'rgba(245,158,11,0.15)' : 'rgba(245,158,11,0.08)' }]}>
              <Icon source="star-outline" size={20} color={REVIEW_COLOR} />
            </View>
            <View style={styles.textBlock}>
              <Text variant="titleSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
                {t('leaveReview')}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {t('shareExperience')}
              </Text>
            </View>
            <View style={[styles.chip, { borderColor: REVIEW_COLOR }]}>
              <Text variant="labelSmall" style={[styles.chipLabel, { color: REVIEW_COLOR }]}>{t('review')}</Text>
            </View>
          </View>
        </TouchableRipple>
      )}

      {/* Shimmer reflection — sweeps once on mount, clipped by card overflow:hidden */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { transform: [{ translateX: shimmerTranslate }] }]}
      >
        <LinearGradient
          colors={['transparent', 'rgba(255,255,255,0.13)', 'rgba(255,255,255,0.06)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.shimmer}
        />
      </Animated.View>
    </Surface>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  row: {},
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  iconBadge: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textBlock: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontWeight: '700',
  },
  divider: {
    height: 1,
    marginHorizontal: 16,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1.5,
  },
  chipLabel: {
    fontWeight: '700',
  },
  shimmer: {
    width: 120,
    height: '100%',
  },
});
