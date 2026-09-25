import React, { useState } from 'react';
import { StyleSheet, View, Alert, Linking } from 'react-native';
import { Card, Icon, Text, useTheme, Button, ActivityIndicator, IconButton } from 'react-native-paper';
import { SessionWithStatus, Contact } from '../../types';
import { FirestoreService } from '../../services/firestore';
import { waiverRefusal } from '../../utils/waiverRefusal';
import { callableErrorCode } from '../../utils/callableError';
import { cancelRefusalIsFinal, cancelRefusalKey } from '../../utils/cancelRefusal';
import { useTranslations } from '../../i18n';

interface SessionAgendaCardProps {
  sessions: SessionWithStatus[];
  contact?: Contact | null;
  onRefresh?: () => void;
  onViewAll?: () => void;
}

export const SessionAgendaCard: React.FC<SessionAgendaCardProps> = ({ sessions, contact, onRefresh, onViewAll }) => {
  const theme = useTheme();
  const t = useTranslations('Agenda');
  const tWaiver = useTranslations('Waiver');
  const tCancel = useTranslations('BookingCancellation');
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);

  const handleBook = async (session: SessionWithStatus) => {
    if (!contact?.id) {
      Alert.alert(t('errorTitle'), t('signInAgain'));
      return;
    }

    setLoadingSessionId(session.id);
    try {
      // Name/email come from our contact doc server-side, via the session claims.
      await FirestoreService.bookSession({
        teamId: session.teamId,
        sessionId: session.id,
      });
      Alert.alert(t('successTitle'), t('bookedSuccess'));
      if (onRefresh) onRefresh();
    } catch (error) {
      console.error(error);
      // A WAIVER REFUSAL IS NOT A FAILED BOOKING, and "please try again" is the
      // one instruction that can never work for it: the member would retry
      // forever over a document they were never shown. The app has no waiver
      // step by design (§3.9 — it mirrors shared shapes locally, so a step here
      // is a port), but it does have the refusal mapper written for exactly
      // this, and the same rail is gated server-side. So: name the document,
      // say who has to sign, and open the signing page when the server sent one.
      // Already booked — from the Train tab, another device, or the desk. The
      // ROW was stale, not the booking: say so and reload rather than "failed"
      // (PrimeTestLab report 7107, M-03).
      if (callableErrorCode(error) === 'already-exists') {
        Alert.alert(t('alreadyBookedTitle'), t('alreadyBooked'));
        if (onRefresh) onRefresh();
        return;
      }
      const waiver = waiverRefusal(tWaiver, error, 'booking');
      if (!waiver) {
        Alert.alert(t('errorTitle'), t('bookFailed'));
        return;
      }
      if (waiver.signUrl) {
        const url = waiver.signUrl;
        Alert.alert(t('signatureNeeded'), waiver.message, [
          { text: t('notNow'), style: 'cancel' },
          { text: t('open'), onPress: () => { Linking.openURL(url).catch(() => undefined); } },
        ]);
        return;
      }
      Alert.alert(t('signatureNeeded'), waiver.message);
    } finally {
      setLoadingSessionId(null);
    }
  };

  const handleCancel = async (session: SessionWithStatus) => {
    // The bin only renders when the server said this booking is cancelable
    // and handed back its token (BookedSession), so no token means the row is
    // stale — reload instead of pressing on.
    const token = session.cancelToken;
    if (!contact?.id || !token) {
      if (onRefresh) onRefresh();
      return;
    }

    Alert.alert(
      t('cancelBookingTitle'),
      t('cancelBookingConfirm'),
      [
        { text: t('no'), style: 'cancel' },
        {
          text: t('yesCancel'),
          style: 'destructive',
          onPress: async () => {
            setLoadingSessionId(session.id);
            try {
              await FirestoreService.cancelBookingByToken(token);
              Alert.alert(t('successTitle'), t('cancelledSuccess'));
              if (onRefresh) onRefresh();
            } catch (error: unknown) {
              console.error('Cancel booking error:', error);
              // A tagged refusal is final and means the row was stale: say
              // why, and reload rather than inviting a retry that cannot work.
              Alert.alert(t('errorTitle'), tCancel(cancelRefusalKey(error)));
              if (cancelRefusalIsFinal(error) && onRefresh) onRefresh();
            } finally {
              setLoadingSessionId(null);
            }
          }
        }
      ]
    );
  };

  if (sessions.length === 0) {
    return (
      <Card style={styles.card} elevation={2}>
        <Card.Content style={styles.emptyState}>
          <Icon source="calendar-blank-outline" size={48} color={theme.colors.outline} />
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}>
            {t('noUpcomingSessions')}
          </Text>
        </Card.Content>
      </Card>
    );
  }

  const getStatusConfig = (status: SessionWithStatus['status']) => {
    const isDark = theme.dark;
    switch (status) {
      case 'attended':
        return {
          bg: isDark ? 'rgba(34, 197, 94, 0.15)' : '#F0FDF4',
          text: '#22C55E',
        };
      case 'booked':
        return {
          bg: isDark ? 'rgba(34, 197, 94, 0.15)' : '#F0FDF4', // Greenish background
          text: '#22C55E', // Green text
        };
      case 'ongoing' as any:
        return {
          bg: isDark ? 'rgba(239, 68, 68, 0.15)' : '#FEF2F2',
          text: theme.colors.error,
        };
      case 'not attended':
        return {
          bg: isDark ? 'rgba(148, 163, 184, 0.15)' : '#F8FAFC',
          text: '#94A3B8',
        };
      default:
        return {
          bg: isDark ? 'rgba(100, 116, 139, 0.1)' : '#F1F5F9',
          text: theme.colors.onSurface,
        };
    }
  };

  const renderSessionItem = (session: SessionWithStatus, isLast: boolean) => {
    const start = new Date(session.start);
    const end = new Date(session.end);
    const startTime = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const endTime = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const month = start.toLocaleString('default', { month: 'short' }).toUpperCase();
    const day = start.getDate();

    const now = new Date();
    let currentStatus = session.status;

    // Dynamic 'ongoing' override if currently happening
    if (now >= start && now <= end) currentStatus = 'ongoing' as any;

    const statusLabels: Record<string, string> = {
      'attended': t('statusAttended').toUpperCase(),
      'not attended': t('statusMissed').toUpperCase(),
      'booked': t('statusBooked').toUpperCase(),
      'book': t('statusAvailable').toUpperCase(),
      'ongoing': t('statusOngoing').toUpperCase()
    };

    const config = getStatusConfig(currentStatus);
    const isLoading = loadingSessionId === session.id;

    // Determine action button
    let actionElement = null;
    if (isLoading) {
      actionElement = (
        <View style={styles.actionContainer}>
           <ActivityIndicator size={16} color={theme.colors.primary} />
        </View>
      );
    } else if (currentStatus === 'book' && session.allowBooking && new Date(session.start) > new Date()) {
      actionElement = (
        <Button
          mode="contained"
          compact
          onPress={() => handleBook(session)}
          style={styles.bookBtn}
          labelStyle={styles.btnLabel}
        >
          {t('bookButton')}
        </Button>
      );
    } else if (currentStatus === 'booked' && new Date(session.start) > new Date()) {
       // Booked status, plus the bin ONLY when the server said `cancelBooking`
       // will accept it — a bin that exists is a promise (report 7107, S-04).
       const canCancel = !!session.cancellable && !!session.cancelToken;
       actionElement = (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={[styles.statusPill, { backgroundColor: config.bg, marginRight: canCancel ? 4 : 0 }]}>
            <Text variant="labelSmall" style={[styles.statusText, { color: config.text }]}>{statusLabels[currentStatus]}</Text>
          </View>
          {canCancel && (
            <IconButton
              icon="trash-can-outline"
              size={20}
              iconColor={theme.colors.error}
              onPress={() => handleCancel(session)}
              style={{ margin: 0 }}
            />
          )}
        </View>
      );
    } else {
       // Default status pill
       actionElement = (
        <View style={[styles.statusPill, { backgroundColor: config.bg }]}>
          <Text variant="labelSmall" style={[styles.statusText, { color: config.text }]}>{statusLabels[currentStatus] || t('statusAvailable').toUpperCase()}</Text>
        </View>
       );
    }

    return (
      <View key={session.id} style={[styles.sessionItem, !isLast && [styles.sessionSeparator, { borderBottomColor: theme.colors.outlineVariant }]]}>
        <View style={[styles.dateBox, { backgroundColor: theme.colors.surfaceVariant }]}>
          <Text variant="labelSmall" style={[styles.monthText, { color: theme.colors.onSurfaceVariant }]}>{month}</Text>
          <Text variant="headlineSmall" style={[styles.dayText, { color: theme.colors.onSurface }]}>{day}</Text>
        </View>

        <View style={styles.detailsSection}>
          <Text variant="titleMedium" style={[styles.className, { color: theme.colors.onSurface }]} numberOfLines={1}>
            {session.activityName || t('sessionFallback')}
          </Text>
          <View style={styles.infoRow}>
            <Icon source="clock-outline" size={14} color={theme.colors.onSurfaceVariant} />
            <Text variant="bodySmall" style={[styles.infoText, { color: theme.colors.onSurfaceVariant }]}>
              {startTime} - {endTime}
            </Text>
          </View>
          <View style={styles.infoRow}>
             <Icon source="map-marker-outline" size={14} color={theme.colors.onSurfaceVariant} />
             <Text variant="bodySmall" style={[styles.infoText, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
               {session.location || t('studioFallback')}
             </Text>
          </View>
        </View>

        {actionElement}
      </View>
    );
  };

  // Only show first 3
  const displaySessions = sessions.slice(0, 3);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text variant="titleLarge" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>{t('upcomingClasses')}</Text>
        <Text variant="bodySmall" style={{ color: theme.colors.outline }}>{t('nextThreeSessions')}</Text>
      </View>

      <Card style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
        <Card.Content style={styles.cardContent}>
          {displaySessions.map((session, index) =>
            renderSessionItem(session, index === displaySessions.length - 1)
          )}
        </Card.Content>
        {onViewAll && (
          <Card.Actions style={styles.cardFooter}>
            <Button
              mode="text"
              compact
              onPress={onViewAll}
              icon="calendar-month-outline"
              labelStyle={styles.viewAllLabel}
            >
              {t('viewAllClasses')}
            </Button>
          </Card.Actions>
        )}
      </Card>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginVertical: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 12,
  },
  headerTitle: {
    fontWeight: '800',
  },
  card: {
    borderRadius: 24,
    overflow: 'hidden',
  },
  cardContent: {
    padding: 16,
  },
  dateGroup: {
    marginBottom: 8,
  },
  sessionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  sessionSeparator: {
    borderBottomWidth: 1,
  },
  dateBox: {
    width: 50,
    height: 50,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  monthText: {
    fontWeight: '700',
    fontSize: 9,
    opacity: 0.6,
  },
  dayText: {
    fontWeight: '800',
    fontSize: 18,
    marginTop: -2,
  },
  detailsSection: {
    flex: 1,
    gap: 1,
  },
  className: {
    fontWeight: '700',
    fontSize: 15,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  infoText: {
    marginLeft: 6,
    fontSize: 11,
  },
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    marginLeft: 8,
    minWidth: 70, // Slightly reduced to fit buttons if needed
    alignItems: 'center',
  },
  statusText: {
    fontWeight: '800',
    fontSize: 9,
  },
  emptyState: {
    padding: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bookBtn: {
     marginLeft: 8,
     borderRadius: 8,
  },
  cancelBtn: {
    marginLeft: 8,
    borderRadius: 8,
    borderColor: 'rgba(239, 68, 68, 0.5)',
  },
  btnLabel: {
    fontSize: 10,
    fontWeight: '700',
    marginVertical: 4,
    marginHorizontal: 8,
  },
  actionContainer: {
    width: 60,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  cardFooter: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(150,150,150,0.15)',
    justifyContent: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  viewAllLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
});
