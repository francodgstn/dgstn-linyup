import { isTrialStage, leaderboardDisplayName, personInitials } from '@linyup/shared';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Alert,
  LayoutAnimation,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  UIManager,
  View,
  StatusBar,
} from 'react-native';
import {
  IconButton,
  Surface,
  Text,
  TouchableRipple,
  useTheme,
  Icon,
  Snackbar,
} from 'react-native-paper';
import { useAuth } from '../contexts/AuthContext';
import { useTranslations, useLocale, LOCALES } from '../i18n';
import { FirestoreService } from '../services/firestore';
import { TeamPublicProfile, Leaderboard, SessionWithStatus, ContactAlert, GamificationSettings, AppointmentWithStatus, RankingSystem } from '../types';
import { LoadingOverlay } from '../components/LoadingOverlay';
import { formatDateValue, formatAddress, formatGender, resolveAffiliationTerm, resolveSubscriptionTypeName } from '../utils/profileUtils';
import { waiverRefusal } from '../utils/waiverRefusal';

// Redesigned Components
import { ProfileHeader } from '../components/profile/ProfileHeader';
import { AffiliationCard } from '../components/profile/AffiliationCard';
import { GamificationCard } from '../components/profile/GamificationCard';
import { TrainingActivity } from '../components/TrainingActivity';
import { ProfileModals } from '../components/profile/ProfileModals';
import { ProfileUpdateModal } from '../components/profile/ProfileUpdateModal';
import { SessionAgendaCard } from '../components/profile/SessionAgendaCard';
import { AppointmentsCarousel } from '../components/profile/AppointmentsCarousel';
import { AppointmentsDashboardCard } from '../components/profile/AppointmentsDashboardCard';
import { AppointmentBookingModal } from '../components/profile/AppointmentBookingModal';
import { AlertsCard } from '../components/AlertsCard';
import { BadgesCard } from '../components/profile/BadgesCard';
import { SocialActionsCard } from '../components/profile/SocialActionsCard';
import { TeamCard } from '../components/profile/TeamCard';
import { useTenantTheme } from '../contexts/TenantThemeContext';
import { brandFromProfile } from '../utils/tenantTheme';
import { TeamQrScannerModal } from '../components/profile/TeamQrScannerModal';
import { SessionPickerModal } from '../components/profile/SessionPickerModal';
import { GoalsSection } from '../components/profile/GoalsSection';
import { PerformanceProfileSection } from '../components/profile/PerformanceProfileSection';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type TabType = 'DASH' | 'FEED' | 'TRAIN' | 'TEAM' | 'SELF';

interface CheckInFeedback {
  type: 'success' | 'error' | 'info';
  sessionName?: string;
  sessionStart?: number; // ms epoch
  message?: string;
}

const CheckInFeedbackCard: React.FC<{ feedback: CheckInFeedback; onDismiss: () => void }> = ({ feedback, onDismiss }) => {
  const theme = useTheme();
  const t = useTranslations('Profile');

  const isSuccess = feedback.type === 'success';
  const isError = feedback.type === 'error';

  const bgColor = isSuccess
    ? theme.dark ? 'rgba(34,197,94,0.15)' : '#F0FDF4'
    : isError
    ? theme.dark ? 'rgba(239,68,68,0.15)' : '#FEF2F2'
    : theme.dark ? 'rgba(100,116,139,0.15)' : '#F1F5F9';

  const accentColor = isSuccess ? '#22C55E' : isError ? '#EF4444' : '#64748B';
  const iconName = isSuccess ? 'check-circle' : isError ? 'alert-circle' : 'information';

  let title = '';
  let subtitle = '';

  if (isSuccess && feedback.sessionName) {
    title = t('checkedIn');
    const parts: string[] = [feedback.sessionName];
    if (feedback.sessionStart) {
      const d = new Date(feedback.sessionStart);
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      const today = new Date();
      const isToday = d.toDateString() === today.toDateString();
      const dateStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      parts.push(isToday ? t('todayAt', { time }) : t('dateAt', { date: dateStr, time }));
    }
    subtitle = parts.join(' · ');
  } else {
    title = isError ? t('checkInFailedTitle') : t('checkInTitle');
    subtitle = feedback.message || '';
  }

  return (
    <Surface
      style={[
        { borderRadius: 16, overflow: 'hidden', backgroundColor: bgColor },
      ]}
      elevation={0}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 }}>
        <Icon source={iconName} size={28} color={accentColor} />
        <View style={{ flex: 1 }}>
          <Text variant="titleSmall" style={{ color: accentColor, fontWeight: '800' }}>{title}</Text>
          {subtitle ? (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>{subtitle}</Text>
          ) : null}
        </View>
        <IconButton icon="close" size={18} iconColor={theme.colors.onSurfaceVariant} onPress={onDismiss} style={{ margin: 0 }} />
      </View>
    </Surface>
  );
};

export const ProfileScreen: React.FC = () => {
  const theme = useTheme();
  const t = useTranslations('Profile');
  const tWaiver = useTranslations('Waiver');
  const { locale, setLocale } = useLocale();
  const insets = useSafeAreaInsets();
  const { contact, logout, refreshContact, email, showContactSelection, selectContact, matchedContacts } = useAuth();
  const scrollRef = useRef<any>(null);

  const [teamProfile, setTeamProfile] = useState<TeamPublicProfile | null>(null);
  const { setBrand } = useTenantTheme();
  const [affiliationTerm, setAffiliationTerm] = useState<string>('Affiliation');
  const [rankingSystems, setRankingSystems] = useState<RankingSystem[]>([]);
  const [subscriptionTypeName, setSubscriptionTypeName] = useState<string | null>(null);
  const [affiliationCollapsed, setAffiliationCollapsed] = useState(true);
  const [teamCardCollapsed, setTeamCardCollapsed] = useState(true);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [lbSort, setLbSort] = useState<'points' | 'streak' | 'best_streak'>('points');
  const [agendaSessions, setAgendaSessions] = useState<SessionWithStatus[]>([]);
  const [appointments, setAppointments] = useState<AppointmentWithStatus[]>([]);
  const [appointmentsCollapsed, setAppointmentsCollapsed] = useState(false);
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [alerts, setAlerts] = useState<ContactAlert[]>([]);
  const [gamificationSettings, setGamificationSettings] = useState<GamificationSettings | null>(null);
  const [rewardedCount, setRewardedCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [currentTab, setCurrentTab] = useState<TabType>('DASH');
  // Modals state
  const [showQRModal, setShowQRModal] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showGenderInfo, setShowGenderInfo] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showUpdateSuccess, setShowUpdateSuccess] = useState(false);
  const [isSwitchingContact, setIsSwitchingContact] = useState(false);
  const [qrData, setQrData] = useState<string | null>(null);
  const [isLoadingQR, setIsLoadingQR] = useState(false);

  // Self check-in state
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [scanSessions, setScanSessions] = useState<{ id: string; activityName: string; start: any; end: any }[]>([]);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [checkInLoading, setCheckInLoading] = useState(false);
  const [pendingTeamSlug, setPendingTeamSlug] = useState<string | null>(null);
  const [checkInFeedback, setCheckInFeedback] = useState<CheckInFeedback | null>(null);

  // Weight edit state
  const [isEditingWeight, setIsEditingWeight] = useState(false);
  const [weightInput, setWeightInput] = useState('');
  const [isSavingWeight, setIsSavingWeight] = useState(false);

  useEffect(() => {
    loadData();
  }, [contact?.id]);

  const loadData = async () => {
    if (!contact) return;
    setIsLoading(true);
    try {
      let loadedProfile = null;
      if (contact.teamId) {
        // ONE read of the public_profile mirror carries everything below —
        // ranking systems and affiliation term are already the team's
        // EFFECTIVE values (org-aware, resolved server-side by
        // syncTeamPublicProfile), so no separate org lookup is needed or
        // possible (a contact session cannot read organizations/{id}).
        loadedProfile = await FirestoreService.getTeamPublicProfile(contact.teamId);
        setTeamProfile(loadedProfile);
        // The studio's look (preset + accent + logo) → the whole app's theme,
        // persisted for the next cold start. utils/tenantTheme.ts.
        if (loadedProfile) setBrand(brandFromProfile(loadedProfile));
        setAffiliationTerm(resolveAffiliationTerm(loadedProfile?.affiliation_term));
        setRankingSystems(loadedProfile?.ranking_systems ?? []);
      }
      // The plan name lives on the contact's own denormalised subscription
      // snapshot — never `teams/{id}/subscription_types/*`, which a contact
      // session cannot read.
      setSubscriptionTypeName(resolveSubscriptionTypeName(contact));
      if (contact.teamId) {
        const lb = await FirestoreService.getTeamLeaderboard(contact.teamId);
        setLeaderboard(lb);

        // Fetch agenda sessions (±7 days)
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 7);
        const agenda = await FirestoreService.getSessionsWithParticipation(
          contact.teamId,
          startDate,
          endDate
        );
        setAgendaSessions(agenda);
      }

      const contactAlerts = await FirestoreService.getContactAlerts(contact.id, contact.total_sessions);
      setAlerts(contactAlerts);

      setGamificationSettings(loadedProfile?.gamification_settings ?? null);

      if (loadedProfile?.referralEnabled) {
        const stats = await FirestoreService.getMyReferralStats();
        setRewardedCount(stats.rewarded_count);
      }

      if (contact.teamId) {
        // The contact's OWN booked appointments. Browsing/booking NEW times is a
        // separate flow (AppointmentBookingModal, built on listAvailability) —
        // availability-only means there are no pre-existing "open slots" here.
        //
        // DELIBERATELY NOT gated on `teamProfile.appointmentsEnabled`: that flag
        // composes the studio toggle with the server's content half, which goes
        // false when the availability windows lapse, when the window↔activity
        // pairing breaks, or when Connect stops being chargeable — none of which
        // is a fact about an appointment somebody has already booked. Gating the
        // FETCH on it meant a member with a confirmed booking could not even see
        // it, let alone cancel it. The query costs nothing where there is nothing
        // to find: a studio with no appointment sessions matches no documents.
        const slots = await FirestoreService.getUpcomingAppointments(contact.teamId);
        setAppointments(slots);
      } else {
        setAppointments([]);
      }
    } catch (error) {
      console.error('Error loading profile data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refreshContact();
    await loadData();
    setIsRefreshing(false);
  };

  const initials = useMemo(() => (contact ? personInitials(contact) : ''), [contact]);

  const myLeaderboardRank = useMemo(() => {
    if (!leaderboard || !contact?.id) return undefined;
    const sorted = [...leaderboard.entries].sort((a, b) => b.score - a.score || a.lastname.localeCompare(b.lastname));
    let rank = 1;
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i].score < sorted[i - 1].score) rank++;
      if (sorted[i].contact_id === contact.id) return rank;
    }
    return undefined;
  }, [leaderboard, contact?.id]);

  const sortedLeaderboardEntries = useMemo(() => {
    if (!leaderboard) return [];
    return [...leaderboard.entries].sort((a, b) => {
      if (lbSort === 'streak') return (b.streak || 0) - (a.streak || 0) || a.lastname.localeCompare(b.lastname);
      if (lbSort === 'best_streak') return (b.max_streak || 0) - (a.max_streak || 0) || a.lastname.localeCompare(b.lastname);
      return b.score - a.score || a.lastname.localeCompare(b.lastname);
    });
  }, [leaderboard, lbSort]);

  const handleUpdateWeight = async () => {
    if (!contact?.id) return;
    const parsed = parseFloat(weightInput.replace(',', '.'));
    if (isNaN(parsed) || parsed < 0) {
      Alert.alert(t('invalidWeightTitle'), t('invalidWeightMessage'));
      return;
    }
    setIsSavingWeight(true);
    try {
      await FirestoreService.updateContactWeight(contact.id, parsed);
      await refreshContact();
      setIsEditingWeight(false);
    } catch {
      Alert.alert(t('errorTitle'), t('updateWeightFailed'));
    } finally {
      setIsSavingWeight(false);
    }
  };

  const showFeedback = (fb: CheckInFeedback) => {
    setCheckInFeedback(fb);
    setTimeout(() => setCheckInFeedback(null), 5000);
  };

  // A waiver refusal is not a failure of the scan and must not read like one.
  // `selfCheckIn` is gated (a member scanning alone is the one attendance path
  // with nobody supervising it), so an unsigned member gets a named document and
  // — when the server sent a link — a way to go and sign it on the phone they are
  // already holding. Everything else keeps the existing generic message.
  const handleCheckInError = (err: unknown) => {
    const waiver = waiverRefusal(tWaiver, err);
    if (!waiver) {
      showFeedback({
        type: 'error',
        message: (err as { message?: string })?.message || t('checkInFailedGeneric'),
      });
      return;
    }
    if (waiver.signUrl) {
      const url = waiver.signUrl;
      Alert.alert(t('signatureNeededTitle'), waiver.message, [
        { text: t('notNow'), style: 'cancel' },
        { text: t('open'), onPress: () => { Linking.openURL(url).catch(() => undefined); } },
      ]);
      return;
    }
    showFeedback({ type: 'error', message: waiver.message });
  };

  const refreshAgenda = useCallback(async () => {
    if (!contact?.teamId || !contact?.id) return;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 7);
    const agenda = await FirestoreService.getSessionsWithParticipation(contact.teamId, startDate, endDate);
    setAgendaSessions(agenda);
  }, [contact?.id, contact?.teamId]);

  const handleTeamQrScanned = useCallback(async (slug: string) => {
    setShowScannerModal(false);
    setCheckInLoading(true);
    setPendingTeamSlug(slug);
    try {
      const result = await FirestoreService.selfCheckIn({ teamSlug: slug });
      if (result.status === 'no_sessions') {
        showFeedback({ type: 'info', message: t('noActiveSessions') });
      } else if (result.status === 'session_required') {
        setScanSessions(result.sessions);
        setShowSessionPicker(true);
      } else if (result.status === 'checked_in') {
        showFeedback({ type: 'success', sessionName: result.sessionName, sessionStart: result.sessionStart });
        refreshAgenda();
      }
    } catch (err: unknown) {
      handleCheckInError(err);
    } finally {
      setCheckInLoading(false);
    }
  }, [refreshAgenda, t]);

  const handleSessionPicked = useCallback(async (sessionId: string) => {
    if (!pendingTeamSlug) return;
    setShowSessionPicker(false);
    setCheckInLoading(true);
    try {
      const result = await FirestoreService.selfCheckIn({ teamSlug: pendingTeamSlug, sessionId });
      if (result.status === 'checked_in') {
        showFeedback({ type: 'success', sessionName: result.sessionName, sessionStart: result.sessionStart });
        refreshAgenda();
      } else {
        showFeedback({ type: 'error', message: t('checkInFailedGeneric') });
      }
    } catch (err: unknown) {
      handleCheckInError(err);
    } finally {
      setCheckInLoading(false);
      setPendingTeamSlug(null);
    }
  }, [pendingTeamSlug, refreshAgenda, t]);

  const handleShowQR = useCallback(async () => {
    setIsLoadingQR(true);
    setShowQRModal(true);
    try {
      const result = await FirestoreService.getContactQR();
      if (result?.success && result.qrData) {
        setQrData(result.qrData);
      } else {
        Alert.alert(t('errorTitle'), t('qrGenerateFailed'));
        setShowQRModal(false);
      }
    } catch {
      setShowQRModal(false);
    } finally {
      setIsLoadingQR(false);
    }
  }, [t]);

  const handleLogout = () => {
    Alert.alert(t('logoutTitle'), t('logoutConfirm'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('signOut'),
        style: 'destructive',
        onPress: () => {
          logout().catch((err) => {
            console.error('Logout error:', err);
          });
        },
      },
    ]);
  };

  /**
   * CLOSING THE ACCOUNT.
   *
   * Required by Apple 5.1.1(v) where accounts exist, and the right of anyone
   * whose data a studio holds. Nothing is destroyed on tap: the server schedules
   * it and the account keeps working for the whole window, which is why the
   * confirmation names the date and the way back rather than shouting.
   *
   * It ANONYMISES rather than erases when the window closes — the studio's
   * finance records and its signed waivers have to survive somebody leaving.
   * The copy says so plainly; discovering it afterwards would feel like a trick.
   */
  // Read straight off the contact, so a cancel on another device shows up on the
  // next refresh rather than needing its own state to be kept in step.
  const deletionSeconds = (contact as { deletion_scheduled_for?: { seconds?: number } | null } | null)
    ?.deletion_scheduled_for?.seconds
  const deletionPending = typeof deletionSeconds === 'number'
  const deletionDate = deletionPending
    ? new Date(deletionSeconds * 1000).toLocaleDateString()
    : ''

  const handleDeleteAccount = () => {
    Alert.alert(
      t('deleteAccountTitle'),
      // No day count here on purpose: this app does not depend on @linyup/shared,
      // so a number typed in would be a second copy of
      // CONTACT_DELETION_GRACE_DAYS that nothing keeps in step. The server
      // returns the real date and the next alert states it.
      t('deleteAccountBody'),
      [
        { text: t('keepAccount'), style: 'cancel' },
        {
          text: t('delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              const res = await FirestoreService.requestAccountDeletion();
              await refreshContact();
              Alert.alert(
                t('deletionScheduledTitle'),
                t('deletionScheduledBody', { date: new Date(res.scheduledForMs).toLocaleDateString() })
              );
            } catch (err) {
              Alert.alert(t('errorTitle'), err instanceof Error ? err.message : t('scheduleFailed'));
            }
          },
        },
      ]
    );
  };

  const handleCancelDeletion = async () => {
    try {
      await FirestoreService.cancelAccountDeletion();
      await refreshContact();
      Alert.alert(t('deletionCancelledTitle'), t('deletionCancelledBody'));
    } catch (err) {
      Alert.alert(t('errorTitle'), err instanceof Error ? err.message : t('cancelFailed'));
    }
  };

  if (!contact) return <LoadingOverlay visible message={t('loadingProfile')} />;


  const handleShowContactSelection = async () => {
    await showContactSelection();
    setShowContactModal(true);
  };

  const handleSelectContact = async (contactId: string) => {
    setIsSwitchingContact(true);
    try {
      const result = await selectContact(contactId);
      if (result.success) {
        setShowContactModal(false);
      } else {
        Alert.alert(t('errorTitle'), result.error || t('switchContactFailed'));
      }
    } catch (error) {
      console.error('Error switching contact:', error);
      Alert.alert(t('errorTitle'), t('switchContactUnexpected'));
    } finally {
      setIsSwitchingContact(false);
    }
  };

  const renderDashboard = () => {
    return (
      <View style={{ gap: 20 }}>
        {checkInFeedback && <CheckInFeedbackCard feedback={checkInFeedback} onDismiss={() => setCheckInFeedback(null)} />}

        <View>
          <AffiliationCard
            contact={contact}
            rankingSystems={rankingSystems}
            teamProfile={teamProfile}
            initials={initials}
            collapsed={affiliationCollapsed}
            onToggleCollapse={() => setAffiliationCollapsed(c => !c)}
            onShowStatusModal={() => setShowStatusModal(true)}
            onShowGenderInfo={() => setShowGenderInfo(true)}
            isEditingWeight={isEditingWeight}
            weightInput={weightInput}
            onWeightInputChange={setWeightInput}
            onEditWeight={() => {
              setWeightInput(contact.weight?.toString() || '');
              setIsEditingWeight(true);
            }}
            onSaveWeight={handleUpdateWeight}
            onCancelWeightEdit={() => setIsEditingWeight(false)}
            isSavingWeight={isSavingWeight}
            affiliationTerm={affiliationTerm}
          />
          {teamProfile && (
            <TeamCard
              teamName={teamProfile.name}
              logoUrl={teamProfile.profileImage ?? null}
              subscriptionName={subscriptionTypeName}
              subscriptionRecurrence={contact.subscription_recurrence}
              lastSeenAt={contact.last_seen_at}
            />
          )}
        </View>

        {alerts.length > 0 && <AlertsCard alerts={alerts} />}

        <GamificationCard
          score={contact.current_month_score}
          streak={contact.current_streak}
          maxStreak={contact.max_streak}
          leaderboardRank={myLeaderboardRank}
          variant="hero"
          onPress={() => setCurrentTab('TEAM')}
        />


        <SessionAgendaCard
          sessions={agendaSessions.filter(s => s.start >= new Date())}
          contact={contact}
          onRefresh={loadData}
          onViewAll={() => {
            scrollRef.current?.scrollTo({ y: 0, animated: false });
            setCurrentTab('TRAIN');
          }}
        />

        {/* Not the raw studio toggle: FirestoreService.getTeamPublicProfile
            composes it with the server's content flag, so this card is never
            shown over a coach who has published no availability. */}
        {teamProfile?.appointmentsEnabled && (
          <AppointmentsDashboardCard
            contact={contact}
            onOpenBooking={() => setShowBookingModal(true)}
          />
        )}

        {teamProfile && (teamProfile.referralEnabled || teamProfile.socialLinks?.some(l => l.platform === 'instagram' || l.platform === 'review')) && (
          <View>
            <Text variant="titleLarge" style={[styles.sectionLabel, { color: theme.colors.onSurface }]}>{t('supportTheTeam')}</Text>
            <SocialActionsCard teamProfile={teamProfile} rewardedCount={rewardedCount} />
          </View>
        )}
      </View>
    );
  };

  const renderSelfTab = () => (
    <View style={styles.selfTabContainer}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Pressable
          onPress={handleShowContactSelection}
          style={({ pressed }) => [
            styles.actionButton,
            { backgroundColor: theme.colors.surface, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Icon source="account-switch" size={24} color={theme.colors.primary} />
          <Text variant="labelLarge" style={{ color: theme.colors.primary, fontWeight: '700', textAlign: 'center' }}>{t('switchAccount').toUpperCase()}</Text>
        </Pressable>

        <Pressable
          onPress={handleLogout}
          style={({ pressed }) => [
            styles.actionButton,
            { backgroundColor: theme.colors.surface, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Icon source="logout" size={24} color="#EF4444" />
          <Text variant="labelLarge" style={{ color: '#EF4444', fontWeight: '700', textAlign: 'center' }}>{t('signOut').toUpperCase()}</Text>
        </Pressable>
      </View>

      {/* Language — a personal preference, same product decision as the web
          Space's header switcher: compact locale codes, tap to switch
          immediately, no confirmation. Persisted (I18nProvider), so it
          survives the next cold start; the sign-in screen reads it too. */}
      <Surface style={[styles.infoCard, { marginTop: 16 }]} elevation={1}>
        <View style={styles.infoSection}>
          <Text variant="titleMedium" style={styles.infoSectionTitle}>{t('language').toUpperCase()}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {LOCALES.map((l) => {
              const active = l === locale;
              return (
                <TouchableRipple
                  key={l}
                  onPress={() => setLocale(l)}
                  borderless
                  style={{ borderRadius: 12, flex: 1 }}
                >
                  <View
                    style={{
                      paddingVertical: 10,
                      borderRadius: 12,
                      alignItems: 'center',
                      backgroundColor: active ? theme.colors.primaryContainer : theme.colors.surfaceVariant,
                    }}
                  >
                    <Text
                      variant="labelLarge"
                      style={{
                        color: active ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant,
                        fontWeight: active ? '800' : '600',
                      }}
                    >
                      {l.toUpperCase()}
                    </Text>
                  </View>
                </TouchableRipple>
              );
            })}
          </View>
        </View>
      </Surface>

      {/* Account closure. Set apart from the action row above: it is not one of
          the things you do here, it is the way out. A pending deletion takes
          over the space entirely, because until it is resolved it is the most
          important thing on this screen. */}
      <View style={{ marginTop: 24, paddingHorizontal: 16 }}>
        {deletionPending ? (
          <Surface style={{ padding: 16, borderRadius: 12, gap: 8 }} elevation={1}>
            <Text variant="titleSmall" style={{ color: '#B45309', fontWeight: '700' }}>
              {t('deletionScheduledCard')}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {t('deletionScheduledCardBody', { date: deletionDate })}
            </Text>
            <Pressable
              onPress={handleCancelDeletion}
              style={({ pressed }) => ({
                marginTop: 4,
                paddingVertical: 10,
                borderRadius: 8,
                backgroundColor: theme.colors.primary,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text variant="labelLarge" style={{ color: '#fff', fontWeight: '700', textAlign: 'center' }}>
                {t('cancelDeletion').toUpperCase()}
              </Text>
            </Pressable>
          </Surface>
        ) : (
          <Pressable onPress={handleDeleteAccount} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', textDecorationLine: 'underline' }}
            >
              {t('deleteMyAccount')}
            </Text>
          </Pressable>
        )}
      </View>

      <Surface style={styles.infoCard} elevation={1}>
        <View style={styles.infoSection}>
          <Text variant="titleMedium" style={styles.infoSectionTitle}>{t('contactInformation').toUpperCase()}</Text>

          <View style={styles.infoRow}>
            <View style={[styles.infoIconContainer, { backgroundColor: theme.dark ? 'rgba(14, 165, 233, 0.15)' : '#E0F2FE' }]}>
              <Icon source="email-outline" size={20} color={theme.dark ? '#5DB0FF' : '#0EA5E9'} />
            </View>
            <View style={styles.infoTextContainer}>
              <Text variant="labelSmall" style={[styles.infoLabel, { color: theme.colors.onSurfaceVariant }]}>{t('emailAddress').toUpperCase()}</Text>
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>{contact.email || email || t('notAvailable')}</Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={[styles.infoIconContainer, { backgroundColor: theme.dark ? 'rgba(34, 197, 94, 0.15)' : '#F0FDF4' }]}>
              <Icon source="phone-outline" size={20} color={theme.dark ? '#4ADE80' : '#22C55E'} />
            </View>
            <View style={styles.infoTextContainer}>
              <Text variant="labelSmall" style={[styles.infoLabel, { color: theme.colors.onSurfaceVariant }]}>{t('phoneNumber').toUpperCase()}</Text>
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>{contact.phone || t('notAvailable')}</Text>
            </View>
          </View>

          {contact.address && (
            <View style={styles.infoRow}>
              <View style={[styles.infoIconContainer, { backgroundColor: theme.dark ? 'rgba(249, 115, 22, 0.15)' : '#FFF7ED' }]}>
                <Icon source="map-marker-outline" size={20} color={theme.dark ? '#FB923C' : '#F97316'} />
              </View>
              <View style={styles.infoTextContainer}>
                <Text variant="labelSmall" style={[styles.infoLabel, { color: theme.colors.onSurfaceVariant }]}>{t('address').toUpperCase()}</Text>
                <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>
                  {formatAddress(contact.address)}
                </Text>
              </View>
            </View>
          )}
        </View>

        <View style={[styles.separator, { backgroundColor: theme.colors.outlineVariant, marginHorizontal: 20 }]} />

        <View style={styles.infoSection}>
          <Text variant="titleMedium" style={styles.infoSectionTitle}>{t('personalDetails').toUpperCase()}</Text>

          <View style={styles.infoRow}>
            <View style={[styles.infoIconContainer, { backgroundColor: theme.colors.primaryContainer }]}>
              <Icon source="cake-variant-outline" size={20} color={theme.colors.primary} />
            </View>
            <View style={styles.infoTextContainer}>
              <Text variant="labelSmall" style={[styles.infoLabel, { color: theme.colors.onSurfaceVariant }]}>{t('birthdateBirthplace').toUpperCase()}</Text>
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>
                {formatDateValue(contact.birthdate) || t('notAvailable')}{contact.birthplace ? t('inPlace', { place: contact.birthplace }) : ''}
              </Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={[styles.infoIconContainer, { backgroundColor: theme.colors.primaryContainer }]}>
              <Icon source="gender-male-female" size={20} color={theme.colors.primary} />
            </View>
            <View style={styles.infoTextContainer}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text variant="labelSmall" style={[styles.infoLabel, { color: theme.colors.onSurfaceVariant }]}>{t('gender').toUpperCase()}</Text>
                <TouchableRipple onPress={() => setShowGenderInfo(true)}>
                  <Icon source="information-outline" size={14} color={theme.colors.onSurfaceVariant} />
                </TouchableRipple>
              </View>
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>{formatGender(t, contact.gender) || t('notAvailable')}</Text>
            </View>
          </View>
        </View>

        <View style={[styles.separator, { backgroundColor: theme.colors.outlineVariant, marginHorizontal: 20 }]} />

        <View style={styles.infoSection}>
          <Text variant="titleMedium" style={[styles.infoSectionTitle, { color: theme.colors.onSurfaceVariant }]}>{t('emergencyContact').toUpperCase()}</Text>
          {contact.emergency_contacts?.[0] ? (
            <View style={styles.infoRow}>
              <View style={[styles.infoIconContainer, { backgroundColor: theme.dark ? 'rgba(239, 68, 68, 0.15)' : '#FEF2F2' }]}>
                <Icon source="account-alert-outline" size={20} color={theme.dark ? '#F87171' : '#EF4444'} />
              </View>
              <View style={styles.infoTextContainer}>
                <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>{contact.emergency_contacts[0].name}</Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>{contact.emergency_contacts[0].phone}</Text>
              </View>
            </View>
          ) : (
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, paddingLeft: 52 }}>{t('noEmergencyContact')}</Text>
          )}
        </View>

        <TouchableRipple
          onPress={() => setShowUpdateModal(true)}
          style={[styles.requestUpdateButton, { borderTopColor: theme.colors.outlineVariant }]}
        >
          <View style={styles.requestUpdateContent}>
            <Text style={[styles.requestUpdateText, { color: theme.colors.primary }]}>{t('requestInfoUpdate')}</Text>
            <Icon source="chevron-right" size={20} color={theme.colors.primary} />
          </View>
        </TouchableRipple>
      </Surface>

    </View>
    );

  const renderFeedTab = () => (
    <View style={styles.placeholderTab}>
      <Icon source="newspaper-variant-outline" size={48} color={theme.dark ? '#94A3B8' : '#64748B'} />
      <Text variant="titleMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}>
        {t('feedComingSoon')}
      </Text>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
        {t('feedComingSoonBody')}
      </Text>
    </View>
  );

  const getRankColor = (rank: number) => {
    if (rank === 1) return '#EAB308';
    if (rank === 2) return theme.dark ? '#D1D5DB' : '#9CA3AF';
    if (rank === 3) return '#CD7F32';
    return theme.colors.onSurfaceVariant;
  };

  const renderLeaderboard = () => {
    if (!leaderboard || leaderboard.entries.length === 0) {
      return (
        <View style={styles.placeholderTab}>
          <Icon source="trophy-outline" size={48} color={theme.dark ? '#EAB308' : '#F59E0B'} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}>
            {t('noScoresYet')}
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
            {t('attendToEarnPoints')}
          </Text>
        </View>
      );
    }

    let currentRank = 1;
    const getSortValue = (e: typeof leaderboard.entries[0]) => {
      if (lbSort === 'streak') return e.streak || 0;
      if (lbSort === 'best_streak') return e.max_streak || 0;
      return e.score;
    };
    const processedEntries: (typeof leaderboard.entries[0] & { displayRank: number })[] = [];
    for (let i = 0; i < sortedLeaderboardEntries.length; i++) {
      if (i > 0 && getSortValue(sortedLeaderboardEntries[i]) < getSortValue(sortedLeaderboardEntries[i - 1])) currentRank++;
      if (currentRank > 5) break;
      processedEntries.push({ ...sortedLeaderboardEntries[i], displayRank: currentRank });
    }

    return (
      <View>
        <Text variant="titleLarge" style={[styles.sectionLabel, { color: theme.colors.onSurface }]}>{t('monthlyLeaderboard')}</Text>
        <Surface style={[styles.infoCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
        <View style={{ padding: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>{leaderboard.month}</Text>
            <Surface style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, backgroundColor: theme.colors.secondaryContainer }} elevation={0}>
              <Text variant="labelSmall" style={{ color: theme.colors.onSecondaryContainer, fontWeight: '700' }}>{t('top5Chip').toUpperCase()}</Text>
            </Surface>
          </View>
          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
            {(['points', 'streak', 'best_streak'] as const).map((opt) => {
              const active = lbSort === opt;
              const label = opt === 'points' ? t('sortPoints') : opt === 'streak' ? t('sortStreak') : t('sortBestStreak');
              return (
                <TouchableRipple key={opt} onPress={() => setLbSort(opt)} borderless style={{ borderRadius: 12 }}>
                  <View style={active ? {
                    backgroundColor: theme.colors.primaryContainer,
                    borderRadius: 12,
                    paddingHorizontal: 10,
                    paddingVertical: 3,
                  } : { paddingHorizontal: 2, paddingVertical: 3 }}>
                    <Text
                      variant="labelMedium"
                      style={{
                        color: active ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant,
                        fontWeight: active ? '700' : '400',
                      }}
                    >
                      {label}
                    </Text>
                  </View>
                </TouchableRipple>
              );
            })}
          </View>
          {processedEntries.map((entry) => {
            const isCurrentUser = entry.contact_id === contact?.id;
            // Anonymise not-yet-joined (trial) members — the ONE rule, shared
            // with the Space's leaderboard (leaderboardName in @linyup/shared).
            // This copy compared stage strings untyped and fell back to
            // 'Unknown' where the Space used '?'.
            const isTrial = isTrialStage(entry.acquisition_stage);
            const fullName = leaderboardDisplayName(entry);
            const rank = entry.displayRank;
            const primaryValue = getSortValue(entry);
            const primaryUnit = lbSort === 'points' ? 'pts' : 'w';
            const primaryIcon = lbSort === 'points' ? undefined : lbSort === 'streak' ? 'fire' : 'trophy';
            const primaryColor = lbSort === 'points' ? theme.colors.onSurface : lbSort === 'streak' ? '#2563EB' : '#D97706';
            return (
              <View
                key={entry.contact_id}
                style={[
                  styles.leaderboardRow,
                  { borderBottomColor: theme.colors.outlineVariant },
                  isCurrentUser && { backgroundColor: theme.dark ? 'rgba(93,176,255,0.1)' : '#EFF6FF', borderRadius: 8 },
                ]}
              >
                <View style={[styles.rankBadge, { backgroundColor: rank <= 3 ? getRankColor(rank) + '20' : theme.colors.surfaceVariant, flexDirection: 'row', gap: 2, minWidth: rank <= 3 ? 48 : 32, paddingHorizontal: 4 }]}>
                  {rank <= 3 && <Icon source="trophy" size={14} color={getRankColor(rank)} />}
                  <Text style={[styles.rankText, { color: getRankColor(rank) }]}>{rank}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text variant="bodyMedium" style={{ fontWeight: isCurrentUser ? '700' : '400', color: theme.colors.onSurface }} numberOfLines={1}>
                    {fullName}{isTrial && <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}> - {t('trialSuffix')}</Text>}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {primaryIcon && <Icon source={primaryIcon} size={14} color={primaryColor} />}
                  <Text variant="bodyMedium" style={{ fontWeight: '900', color: primaryColor }}>{primaryValue}</Text>
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>{primaryUnit}</Text>
                </View>
              </View>
            );
          })}
        </View>
      </Surface>
      </View>
    );
  };

  const renderTeamTab = () => {
    // Only custom links here; "page links" (booking/signup/shop/space) are system
    // surfaces, surfaced by the app's own navigation rather than as plain links.
    const generalLinks = (teamProfile?.links || []).filter((l) => !l.target);
    const websiteLink = teamProfile?.socialLinks?.find((s) => s.platform === 'website');
    const coaches = teamProfile?.coaches || [];

    const toggleTeamCard = () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setTeamCardCollapsed(c => !c);
    };


    const hasSupportUs = !!(teamProfile?.referralEnabled || teamProfile?.socialLinks?.some(l => l.platform === 'instagram'));

    return (
      <View style={{ gap: 16 }}>
        {/* Team info card */}
        {teamProfile && (
          <Surface style={[styles.infoCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
            {/* Always-visible header */}
            <View style={styles.infoSection}>
              <Text variant="headlineSmall" style={{ fontWeight: '800', color: theme.colors.onSurface, marginBottom: 4 }}>
                {teamProfile.name}
              </Text>
              {teamProfile.description ? (
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 20 }}>
                  {teamProfile.description}
                </Text>
              ) : null}
            </View>

            {/* LINKS toggle row — always visible */}
            <TouchableRipple onPress={toggleTeamCard} style={styles.infoSection}>
              <View style={styles.teamCardHandleInner}>
                <Text variant="titleMedium" style={[styles.infoSectionTitle, { color: theme.colors.onSurfaceVariant, marginBottom: 0 }]}>{t('links').toUpperCase()}</Text>
                <Icon source={teamCardCollapsed ? 'chevron-down' : 'chevron-up'} size={18} color={theme.colors.onSurfaceVariant} />
              </View>
            </TouchableRipple>

            {!teamCardCollapsed && (
              <>
                {/* Coaches */}
                {coaches.length > 0 && (
                  <>
                    <View style={[styles.separator, { backgroundColor: theme.colors.outlineVariant, marginHorizontal: 20 }]} />
                    <View style={styles.infoSection}>
                      <Text variant="titleMedium" style={[styles.infoSectionTitle, { color: theme.colors.onSurfaceVariant }]}>{t('coaches').toUpperCase()}</Text>
                      {coaches.map((coach, idx) => (
                        <View key={idx} style={[styles.infoRow, { paddingVertical: 4 }]}>
                          <View style={[styles.infoIconContainer, { backgroundColor: theme.dark ? 'rgba(34,197,94,0.12)' : '#F0FDF4' }]}>
                            <Icon source="account-tie" size={20} color={theme.dark ? '#4ADE80' : '#16A34A'} />
                          </View>
                          <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>{coach.name}</Text>
                        </View>
                      ))}
                    </View>
                  </>
                )}

                {/* General links + website */}
                {(generalLinks.length > 0 || websiteLink) && (
                  <>
                    <View style={[styles.separator, { backgroundColor: theme.colors.outlineVariant, marginHorizontal: 20 }]} />
                    <View style={styles.infoSection}>
                      {/* links content only, heading is the toggle above */}
                      {websiteLink && (
                        <TouchableRipple onPress={() => Linking.openURL(websiteLink.url).catch(() => undefined)}>
                          <View style={[styles.infoRow, { paddingVertical: 4 }]}>
                            <View style={[styles.infoIconContainer, { backgroundColor: theme.colors.primaryContainer }]}>
                              <Icon source="web" size={20} color={theme.colors.primary} />
                            </View>
                            <View style={styles.infoTextContainer}>
                              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>{t('website')}</Text>
                            </View>
                            <Icon source="chevron-right" size={18} color={theme.colors.onSurfaceVariant} />
                          </View>
                        </TouchableRipple>
                      )}
                      {generalLinks.map((link, idx) => (
                        <TouchableRipple key={idx} onPress={() => { if (link.url) Linking.openURL(link.url).catch(() => undefined) }}>
                          <View style={[styles.infoRow, { paddingVertical: 4 }]}>
                            <View style={[styles.infoIconContainer, { backgroundColor: theme.colors.primaryContainer }]}>
                              <Icon source="link-variant" size={20} color={theme.colors.primary} />
                            </View>
                            <View style={styles.infoTextContainer}>
                              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>{link.label}</Text>
                              {link.description ? (
                                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>{link.description}</Text>
                              ) : null}
                            </View>
                            <Icon source="chevron-right" size={18} color={theme.colors.onSurfaceVariant} />
                          </View>
                        </TouchableRipple>
                      ))}
                    </View>
                  </>
                )}

              </>
            )}

          </Surface>
        )}

        {/* Support us — standalone card */}
        {teamProfile && hasSupportUs && (
          <View>
            <Text variant="titleLarge" style={[styles.sectionLabel, { color: theme.colors.onSurface }]}>{t('supportUs')}</Text>
            <SocialActionsCard teamProfile={teamProfile} rewardedCount={rewardedCount} />
          </View>
        )}

        {renderLeaderboard()}
      </View>
    );
  };

  const renderProgressTab = () => {
    return (
      <View style={{ gap: 16 }}>
        <GamificationCard
          score={contact.current_month_score}
          streak={contact.current_streak}
          maxStreak={contact.max_streak}
        />

        <TrainingActivity
          contactId={contact.id}
          teamId={contact.teamId}
          contact={contact}
        />

        <PerformanceProfileSection contactId={contact.id} teamId={contact.teamId || ''} />

        {/* Two questions, and only one of them is the promo flag. A booking the
            member already holds is a RECORD — it shows because it exists, so the
            cancel/reschedule affordances stay reachable even after the studio's
            availability lapses. The composed flag only adds the section when
            there is nothing booked yet, i.e. when it is an invitation. */}
        {(appointments.length > 0 || teamProfile?.appointmentsEnabled) && (
          <View>
            <TouchableRipple
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setAppointmentsCollapsed(c => !c);
              }}
              borderless
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 }}>
                <Text variant="titleLarge" style={[styles.sectionLabel, { color: theme.colors.onSurface, marginBottom: 0 }]}>{t('appointments')}</Text>
                <Icon source={appointmentsCollapsed ? 'chevron-down' : 'chevron-up'} size={20} color={theme.colors.onSurfaceVariant} />
              </View>
            </TouchableRipple>
            {!appointmentsCollapsed && (
              <AppointmentsCarousel
                slots={appointments}
                onRefresh={loadData}
                onBookNew={() => setShowBookingModal(true)}
              />
            )}
          </View>
        )}

        <GoalsSection contactId={contact.id} teamId={contact.teamId || ''} />

        <BadgesCard
          contact={contact}
          rankingSystems={rankingSystems}
          badgeThresholds={gamificationSettings?.badge_thresholds}
          coachBadges={gamificationSettings?.coach_badges}
        />
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StatusBar barStyle={theme.dark ? 'light-content' : 'dark-content'} />
      <LoadingOverlay visible={isLoading && !isRefreshing} message={t('updating')} />

      <ScrollView
        testID="profile-screen"
        ref={scrollRef}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        <ProfileHeader
          contact={contact}
          initials={initials}
          onShowQR={handleShowQR}
          onScanTeamQR={() => setShowScannerModal(true)}
          onEditProfile={() => setCurrentTab(currentTab === 'SELF' ? 'DASH' : 'SELF')}
        />

        {currentTab === 'DASH' && renderDashboard()}
        {currentTab === 'FEED' && renderFeedTab()}
        {currentTab === 'TRAIN' && renderProgressTab()}
        {currentTab === 'TEAM' && renderTeamTab()}
        {currentTab === 'SELF' && renderSelfTab()}

        <View style={{ height: 100 + insets.bottom }} />
      </ScrollView>

      {/* Bottom Navigation */}
      <Surface style={[styles.bottomNav, { backgroundColor: theme.colors.surface, paddingBottom: insets.bottom, height: 85 + insets.bottom }]} elevation={4}>
        {(['DASH', 'FEED', 'TRAIN', 'TEAM'] as TabType[]).map((tab) => {
          const icon = tab === 'DASH' ? 'view-dashboard'
            : tab === 'FEED' ? 'newspaper'
            : tab === 'TRAIN' ? 'chart-timeline-variant'
            : 'account-group';
          // TabType values ('DASH'/'FEED'/…) are internal state, never
          // rendered raw — the label shown is always the translated one.
          const label = tab === 'DASH' ? t('tabDashboard')
            : tab === 'FEED' ? t('tabFeed')
            : tab === 'TRAIN' ? t('tabTrain')
            : t('tabTeam');
          const active = currentTab === tab;
          return (
            <TouchableRipple key={tab} onPress={() => setCurrentTab(tab)} style={styles.navItem}>
              <View style={styles.navItemContent}>
                <IconButton
                  icon={icon}
                  size={24}
                  iconColor={active ? theme.colors.primary : theme.colors.onSurfaceVariant}
                  style={styles.navIcon}
                />
                <Text
                  variant="labelSmall"
                  style={{ color: active ? theme.colors.primary : theme.colors.onSurfaceVariant, fontWeight: active ? '700' : '500' }}
                >
                  {label.toUpperCase()}
                </Text>
              </View>
            </TouchableRipple>
          );
        })}
      </Surface>

      <ProfileModals
        contact={contact}
        teamProfile={teamProfile}
        showQRModal={showQRModal}
        onCloseQR={() => setShowQRModal(false)}
        isLoadingQR={isLoadingQR}
        qrData={qrData}
        showStatusModal={showStatusModal}
        onCloseStatus={() => setShowStatusModal(false)}
        showGenderInfo={showGenderInfo}
        onCloseGenderInfo={() => setShowGenderInfo(false)}
        showContactModal={showContactModal}
        onCloseContactModal={() => setShowContactModal(false)}
        matchedContacts={matchedContacts}
        onSelectContact={handleSelectContact}
        isSwitchingContact={isSwitchingContact}
        affiliationTerm={affiliationTerm}
      />

      <ProfileUpdateModal
        visible={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        contact={contact}
        onSuccess={() => setShowUpdateSuccess(true)}
      />

      <TeamQrScannerModal
        visible={showScannerModal}
        onScan={handleTeamQrScanned}
        onClose={() => setShowScannerModal(false)}
      />

      <SessionPickerModal
        visible={showSessionPicker}
        sessions={scanSessions}
        loading={checkInLoading}
        onSelect={handleSessionPicked}
        onClose={() => { setShowSessionPicker(false); setPendingTeamSlug(null); }}
      />

      <AppointmentBookingModal
        visible={showBookingModal}
        teamId={contact.teamId}
        contact={contact}
        onClose={() => setShowBookingModal(false)}
        onBooked={() => {
          setShowBookingModal(false);
          loadData();
        }}
      />

      <Snackbar
        visible={showUpdateSuccess}
        onDismiss={() => setShowUpdateSuccess(false)}
        duration={4000}
        style={{ marginBottom: 20 }}
      >
        {t('updateRequestSubmitted')}
      </Snackbar>

    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 20,
  },
  selfTabContainer: {
    gap: 16,
  },
  infoCard: {
    borderRadius: 20,
    overflow: 'hidden',
  },
  infoSection: {
    padding: 20,
    gap: 16,
  },
  infoSectionTitle: {
    color: '#64748B',
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 1,
    marginBottom: 4,
  },
  sectionLabel: {
    fontWeight: '800',
    marginBottom: 8,
    marginTop: 8,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  infoIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  infoTextContainer: {
    flex: 1,
  },
  infoLabel: {
    color: '#94A3B8',
    fontWeight: '700',
    fontSize: 10,
    marginBottom: 2,
  },
  separator: {
    height: 1,
  },
  requestUpdateButton: {
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    padding: 16,
  },
  requestUpdateContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  requestUpdateText: {
    fontWeight: '700',
    fontSize: 14,
  },
  teamCardHandleInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logoutAction: {
    width: '100%',
    padding: 10,
    alignItems: 'center',
  },
  actionButton: {
    flex: 1,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 20,
    elevation: 1,
  },
  placeholderTab: {
    padding: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leaderboardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    gap: 12,
  },
  rankBadge: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rankText: {
    fontSize: 13,
    fontWeight: '700',
  },
  bottomNav: {
    height: 85,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 10,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: '#FFFFFF', // Fallback
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navItemContent: {
    alignItems: 'center',
  },
  navIcon: {
    margin: 0,
    padding: 0,
  },
});
