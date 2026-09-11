import React, { useEffect, useRef } from 'react';
import { Animated, LayoutAnimation, Platform, StyleSheet, TextInput, UIManager, View } from 'react-native';
import { Card, Icon, IconButton, Text, TouchableRipple, useTheme } from 'react-native-paper';
import { LinearGradient } from 'expo-linear-gradient';
import { Contact, RankingSystem, TeamPublicProfile } from '../../types';
import {
  getAffiliationLabel,
  getAffiliationColors,
  calculateAge,
  formatGender,
} from '../../utils/profileUtils';
import { primaryRank, rankLevelBadge } from '@linyup/shared';
import { BeltBadge } from './BeltBadge';
import { useTranslations } from '../../i18n';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface AffiliationCardProps {
  contact: Contact;
  teamProfile: TeamPublicProfile | null;
  initials: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onShowStatusModal: () => void;
  onShowGenderInfo: () => void;
  isEditingWeight: boolean;
  weightInput: string;
  onWeightInputChange: (value: string) => void;
  onEditWeight: () => void;
  onSaveWeight: () => void;
  onCancelWeightEdit: () => void;
  isSavingWeight: boolean;
  affiliationTerm?: string;
  /** The tenant's effective ranking systems. Absent/empty = this tenant does not
   *  use ranks, and the belt simply reads "NO BELT". */
  rankingSystems?: RankingSystem[];
}

const PillHandle: React.FC<{
  onPress: () => void;
  rotation: Animated.AnimatedInterpolation<string>;
}> = ({ onPress, rotation }) => (
  <TouchableRipple onPress={onPress} style={styles.handleArea} borderless>
    <Animated.View style={{ transform: [{ rotate: rotation }] }}>
      <Icon source="chevron-up" size={20} color="#475569" />
    </Animated.View>
  </TouchableRipple>
);

export const AffiliationCard: React.FC<AffiliationCardProps> = ({
  contact,
  teamProfile,
  collapsed,
  onToggleCollapse,
  onShowStatusModal,
  onShowGenderInfo,
  isEditingWeight,
  weightInput,
  onWeightInputChange,
  onEditWeight,
  onSaveWeight,
  onCancelWeightEdit,
  affiliationTerm,
  rankingSystems,
}) => {
  const theme = useTheme();
  const t = useTranslations('Affiliation');
  const resolvedAffiliationTerm = affiliationTerm ?? t('affiliationFallback');
  const chevronAnim = useRef(new Animated.Value(collapsed ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(chevronAnim, {
      toValue: collapsed ? 1 : 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [collapsed]);

  const chevronRotation = chevronAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });

  // THE shared rule (`primaryRank`) — the same belt the coach's screen shows.
  // This once read `contact.rank`, a scalar the HMD migration deletes, so every
  // migrated member saw "NO BELT"; null now means genuinely nothing to show.
  const rankInfo = primaryRank(contact, rankingSystems);
  const rankBadge = rankInfo ? rankLevelBadge(rankInfo.level) : null;

  const age = calculateAge(contact.birthdate);
  const genderLabel = formatGender(t, contact.gender);

  const rankTitle = rankInfo?.level.label ?? t('noRank');
  const studentName = [contact.firstname, contact.lastname].filter(Boolean).join(' ').toUpperCase();
  const rankSub = t('memberPrefix', { name: studentName });
  const affiliationSummary = contact.affiliation_summary;
  const statusColors = getAffiliationColors(affiliationSummary, theme.colors);
  const affiliationLabel = getAffiliationLabel(t, affiliationSummary);

  const handleToggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    onToggleCollapse();
  };

  // ── collapsed strip ──────────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <Card style={styles.affiliationCard}>
        <LinearGradient
          colors={['#0F172A', '#1E293B', '#0F172A']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.collapsedGradient}
        >
          <View style={styles.collapsedTopRow}>
            <BeltBadge badge={rankBadge} size={26} />
            <Text style={styles.collapsedRank}>{rankTitle.toUpperCase()}</Text>
            <TouchableRipple onPress={onShowStatusModal} style={styles.statusBadgeContainer}>
              <View style={[styles.statusBadge, { backgroundColor: statusColors.bg }]}>
                <Text style={[styles.statusBadgeText, { color: statusColors.text }]}>
                  {affiliationLabel}
                </Text>
              </View>
            </TouchableRipple>
          </View>
          <PillHandle onPress={handleToggle} rotation={chevronRotation} />
        </LinearGradient>
      </Card>
    );
  }

  // ── expanded card ────────────────────────────────────────────────────────────
  return (
    <Card style={styles.affiliationCard}>
      <LinearGradient
        colors={['#0F172A', '#1E293B', '#0F172A']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.gradient}
      >
        <Card.Content style={styles.affiliationContent}>
          {/* Header Row */}
          <View style={styles.headerRow}>
            <View>
              <Text variant="labelSmall" style={styles.orgLabel} numberOfLines={1}>
                {(teamProfile?.name ?? 'LINYUP').toUpperCase()}
              </Text>
              <Text variant="labelSmall" style={styles.orgSubLabel}>
                {t('cardLabel', { term: resolvedAffiliationTerm }).toUpperCase()}
              </Text>
            </View>
            <TouchableRipple onPress={onShowStatusModal} style={styles.statusBadgeContainer}>
              <View style={[styles.statusBadge, { backgroundColor: statusColors.bg }]}>
                <Text style={[styles.statusBadgeText, { color: statusColors.text }]}>
                  {affiliationLabel}
                </Text>
              </View>
            </TouchableRipple>
          </View>

          {/* Rank Section */}
          <View style={styles.rankSection}>
            <View style={styles.rankStatusRow}>
              <View style={[styles.rankAccent, { backgroundColor: '#3B82F6' }]} />
              <Text variant="labelMedium" style={styles.rankSubText}>
                {rankSub}
              </Text>
            </View>
            <View style={styles.rankTitleRow}>
              <BeltBadge badge={rankBadge} size={32} />
              <Text variant="headlineMedium" style={styles.rankTitle}>
                {rankTitle.toUpperCase()}
              </Text>
            </View>
          </View>

          {/* Separator */}
          <View style={styles.separator} />

          {/* Stats Row */}
          <View style={styles.footerRow}>
            <View style={styles.footerItem}>
              <View style={styles.statValueRow}>
                <TouchableRipple onPress={onShowGenderInfo} style={styles.statChip}>
                  <View style={styles.inlineStats}>
                    <Text variant="titleSmall" style={styles.footerValue}>{genderLabel || t('genderFallback')}</Text>
                    <Icon source="information-outline" size={14} color="#94A3B8" />
                  </View>
                </TouchableRipple>

                <Text variant="titleSmall" style={styles.statSeparator}>•</Text>
                <Text variant="titleSmall" style={styles.footerValue}>{t('ageYears', { age: age || t('ageFallback') })}</Text>
                <Text variant="titleSmall" style={styles.statSeparator}>•</Text>

                {isEditingWeight ? (
                  <View style={styles.editingContainer}>
                    <TextInput
                      value={weightInput}
                      onChangeText={onWeightInputChange}
                      keyboardType="numeric"
                      style={styles.weightInput}
                      autoFocus
                      placeholderTextColor="#64748B"
                    />
                    <IconButton icon="check" size={16} iconColor="#4CAF50" onPress={onSaveWeight} style={styles.editActionIcon} />
                    <IconButton icon="close" size={16} iconColor="#FF5252" onPress={onCancelWeightEdit} style={styles.editActionIcon} />
                  </View>
                ) : (
                  <TouchableRipple onPress={onEditWeight}>
                    <View style={styles.weightValueRow}>
                      <Text variant="titleSmall" style={styles.footerValue}>
                        {t('weightKg', { weight: contact.weight || t('weightFallback') })}
                      </Text>
                      <Icon source="pencil-outline" size={12} color="#94A3B8" />
                    </View>
                  </TouchableRipple>
                )}
              </View>
            </View>
          </View>
        </Card.Content>

        <PillHandle onPress={handleToggle} rotation={chevronRotation} />
      </LinearGradient>
    </Card>
  );
};

const styles = StyleSheet.create({
  affiliationCard: {
    borderRadius: 24,
    overflow: 'hidden',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
  },
  collapsedGradient: {
    paddingTop: 14,
    paddingHorizontal: 16,
  },
  collapsedTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  collapsedRank: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 13,
    letterSpacing: 0.5,
    flex: 1,
  },
  gradient: {
    padding: 4,
    paddingBottom: 0,
  },
  affiliationContent: {
    padding: 16,
    paddingBottom: 14,
  },
  handleArea: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  orgLabel: {
    color: '#3B82F6',
    fontWeight: '900',
    letterSpacing: 1.5,
    fontSize: 12,
  },
  orgSubLabel: {
    color: '#94A3B8',
    letterSpacing: 1,
    fontSize: 9,
    marginTop: 2,
  },
  statusBadgeContainer: {
    borderRadius: 8,
    overflow: 'hidden',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  rankSection: {
    marginBottom: 12,
  },
  rankStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  rankAccent: {
    width: 3,
    height: 14,
    borderRadius: 2,
    marginRight: 8,
  },
  rankSubText: {
    color: '#94A3B8',
    letterSpacing: 1,
    fontWeight: '600',
    fontSize: 11,
  },
  rankTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rankTitle: {
    color: '#FFFFFF',
    fontWeight: '900',
    letterSpacing: 1,
    fontSize: 28,
  },
  separator: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    marginVertical: 12,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  footerItem: {
    gap: 4,
    flex: 1,
  },
  footerValue: {
    color: '#F8FAFC',
    fontWeight: '700',
  },
  statChip: {
    borderRadius: 4,
  },
  statValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 0,
  },
  inlineStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statSeparator: {
    color: '#64748B',
    marginHorizontal: 8,
    fontWeight: '700',
  },
  weightValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  editingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 6,
    paddingLeft: 4,
  },
  weightInput: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    width: 45,
    padding: 0,
    textAlign: 'center',
  },
  editActionIcon: {
    margin: 0,
    padding: 0,
  },
});
