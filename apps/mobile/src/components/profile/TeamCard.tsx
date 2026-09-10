import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Avatar, Icon, Surface, Text } from 'react-native-paper';
import { useAppTheme } from '../../theme';
import { withAlpha } from '@linyup/shared';
import { useTranslations } from '../../i18n';

interface TeamCardProps {
  teamName: string;
  /** The studio's logo from its public profile; the shield icon otherwise. */
  logoUrl?: string | null;
  subscriptionName: string | null;
  subscriptionRecurrence?: string | null;
  lastSeenAt?: any;
}

function formatLastSeen(value: unknown, dash: string): string {
  if (!value) return dash;
  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    date = new Date(value);
  } else if (typeof value === 'string') {
    date = new Date(value);
  } else if (typeof value === 'object' && value !== null) {
    const ref = value as any;
    if (typeof ref.toDate === 'function') date = ref.toDate();
    else if (typeof ref.seconds === 'number') date = new Date(ref.seconds * 1000);
  }
  if (!date || isNaN(date.getTime())) return dash;
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

export const TeamCard: React.FC<TeamCardProps> = ({ teamName, logoUrl, subscriptionName, subscriptionRecurrence, lastSeenAt }) => {
  const theme = useAppTheme();
  const t = useTranslations('TeamCard');
  // The studio row carries the STUDIO's colour (the tenant accent); the other
  // rows keep their semantic tints so they never collide with it.
  const badge = (color: string) => ({ backgroundColor: withAlpha(color, theme.dark ? 0.16 : 0.09) });

  return (
    <Surface
      style={[styles.card, { backgroundColor: theme.colors.surface }]}
      elevation={2}
    >
      <View style={styles.row}>
        {logoUrl ? (
          <Avatar.Image size={28} source={{ uri: logoUrl }} style={styles.logo} />
        ) : (
          <View style={[styles.iconBadge, badge(theme.colors.primary)]}>
            <Icon source="shield-outline" size={16} color={theme.colors.primary} />
          </View>
        )}
        <Text variant="labelSmall" style={[styles.label, { color: theme.colors.onSurfaceVariant }]}>{t('teamLabel').toUpperCase()}</Text>
        <Text variant="labelMedium" style={[styles.value, { color: theme.colors.onSurface }]} numberOfLines={1}>
          {teamName}
        </Text>
      </View>

      <View style={[styles.divider, { backgroundColor: theme.colors.outlineVariant }]} />

      <View style={styles.row}>
        <View style={[styles.iconBadge, badge(theme.semantic.info)]}>
          <Icon source="tag-outline" size={16} color={theme.semantic.info} />
        </View>
        <Text variant="labelSmall" style={[styles.label, { color: theme.colors.onSurfaceVariant }]}>{t('subscriptionLabel').toUpperCase()}</Text>
        <Text variant="labelMedium" style={[styles.value, { color: theme.colors.onSurface }]} numberOfLines={1}>
          {subscriptionName
            ? subscriptionRecurrence
              ? `${subscriptionName} · ${subscriptionRecurrence}`
              : subscriptionName
            : t('dash')}
        </Text>
      </View>

      <View style={[styles.divider, { backgroundColor: theme.colors.outlineVariant }]} />

      <View style={styles.row}>
        <View style={[styles.iconBadge, badge(theme.semantic.teal)]}>
          <Icon source="calendar-check-outline" size={16} color={theme.semantic.teal} />
        </View>
        <Text variant="labelSmall" style={[styles.label, { color: theme.colors.onSurfaceVariant }]}>{t('lastSessionLabel').toUpperCase()}</Text>
        <Text variant="labelMedium" style={[styles.value, { color: theme.colors.onSurface }]} numberOfLines={1}>
          {formatLastSeen(lastSeenAt, t('dash'))}
        </Text>
      </View>
    </Surface>
  );
};

const styles = StyleSheet.create({
  card: {
    marginTop: -12,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    paddingTop: 20,
    paddingBottom: 12,
    paddingHorizontal: 16,
    zIndex: -1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  iconBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    borderRadius: 8,
  },
  label: {
    fontWeight: '700',
    letterSpacing: 0.8,
    fontSize: 10,
    width: 88,
  },
  value: {
    flex: 1,
    fontWeight: '600',
  },
  divider: {
    height: 1,
    marginVertical: 2,
    marginLeft: 38,
  },
});
