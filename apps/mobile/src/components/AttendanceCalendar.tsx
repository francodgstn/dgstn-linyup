import React, { useEffect, useState, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert, Linking } from 'react-native';
import { Text, IconButton, useTheme, ActivityIndicator, Divider, Button } from 'react-native-paper';
import { FirestoreService } from '../services/firestore';
import { HydratedSession, Contact } from '../types';
import { waiverRefusal } from '../utils/waiverRefusal';
import { useTranslations } from '../i18n';

interface AttendanceCalendarProps {
  contactId: string;
  teamId?: string;
  initialMonth?: Date;
  contact?: Contact | null;
}

export const AttendanceCalendar: React.FC<AttendanceCalendarProps> = ({ contactId, teamId, initialMonth, contact }) => {
  const theme = useTheme();
  const t = useTranslations('Attendance');
  const tWaiver = useTranslations('Waiver');
  const [currentDate, setCurrentDate] = useState(initialMonth || new Date());

  // Navigate to month when initialMonth changes (e.g. from chart tap)
  useEffect(() => {
    if (initialMonth) {
      setCurrentDate(initialMonth);
      setSelectedDay(null);
    }
  }, [initialMonth]);
  const [attendedSessions, setAttendedSessions] = useState<HydratedSession[]>([]);
  const [bookedSessions, setBookedSessions] = useState<HydratedSession[]>([]);
  const [availableSessions, setAvailableSessions] = useState<HydratedSession[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  // Load data when month changes
  useEffect(() => {
    loadMonthData();
  }, [currentDate.getMonth(), currentDate.getFullYear(), contactId]);

  const loadMonthData = async () => {
    setIsLoading(true);
    try {
      // Get first and last day of current month
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth();
      const startDate = new Date(year, month, 1);
      const endDate = new Date(year, month + 1, 0, 23, 59, 59);

      const [attended, booked] = await Promise.all([
        FirestoreService.getContactAttendance(startDate, endDate, teamId),
        FirestoreService.getContactBookings(startDate, endDate, teamId)
      ]);
      setAttendedSessions(attended);
      setBookedSessions(booked);

      if (teamId) {
        const available = await FirestoreService.getTeamSessionsInRange(
            teamId,
            startDate,
            endDate
        );
        setAvailableSessions(available);
      }
    } catch (error) {
      console.error('Error loading attendance:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBook = async (session: HydratedSession) => {
    if (!contact?.id) {
      Alert.alert(t('errorTitle'), t('signInAgain'));
      return;
    }
    if (!session.teamId) {
      Alert.alert(t('errorTitle'), t('missingTeamInfo'));
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
      loadMonthData();
    } catch (error) {
      console.error(error);
      // The SECOND mobile booking rail, and it swallowed the same refusal. Both
      // call `bookSession`, both are gated server-side, so both have to name the
      // document rather than telling a member to retry something that cannot
      // succeed until somebody signs. See utils/waiverRefusal.ts.
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

  const handleCancel = async (session: HydratedSession) => {
    if (!contact?.id) return;
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
              await FirestoreService.cancelSession({
                sessionId: session.id,
                contactId: contact.id
              });
              Alert.alert(t('successTitle'), t('cancelledSuccess'));
              loadMonthData();
            } catch (error: any) {
              const message = error?.message || t('cancelFailed');
              Alert.alert(t('errorTitle'), message);
            } finally {
              setLoadingSessionId(null);
            }
          }
        }
      ]
    );
  };

  const handlePrevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    setSelectedDay(null);
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
    setSelectedDay(null);
  };

  // Calendar generation logic
  const calendarDays = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // 0 = Sunday, 1 = Monday, ... 6 = Saturday
    // Adjust to make Monday first day (0 = Monday, ..., 6 = Sunday)
    let startDayOfWeek = firstDayOfMonth.getDay() - 1;
    if (startDayOfWeek === -1) startDayOfWeek = 6;

    const days: (number | null)[] = [];

    // Add empty slots for previous month
    for (let i = 0; i < startDayOfWeek; i++) {
      days.push(null);
    }

    // Add days of current month
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(i);
    }

    return days;
  }, [currentDate]);

  const getSessionStatus = (day: number) => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    const hasAttended = attendedSessions.some(s => {
        const d = s.start;
        return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
    });

    if (hasAttended) return 'attended';

    const hasBooked = bookedSessions.some(s => {
        const d = s.start;
        return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
    });

    if (hasBooked) return 'booked';

    return null;
  };

  const hasSession = (day: number) => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    // Use availableSessions to show dots for classes available to book?
    // The original logic showed dots for available sessions.
    // We should keeping distinguishing user's sessions vs available sessions.
    return availableSessions.some(s => {
        const d = s.start;
        return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
    });
  };

  const sessionsOnSelectedDay = useMemo(() => {
    if (!selectedDay) return [];
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    return availableSessions.filter(s => {
      const d = s.start;
      return d.getFullYear() === year && d.getMonth() === month && d.getDate() === selectedDay;
    });
  }, [selectedDay, availableSessions, currentDate]);

  const weekDays = [
    t('weekDayMon'),
    t('weekDayTue'),
    t('weekDayWed'),
    t('weekDayThu'),
    t('weekDayFri'),
    t('weekDaySat'),
    t('weekDaySun'),
  ];

  return (
    <View>
      <View style={styles.header}>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {attendedSessions.length === 1
            ? t('sessionsInMonthOne', { month: currentDate.toLocaleDateString(undefined, { month: 'long' }) })
            : t('sessionsInMonthOther', { count: attendedSessions.length, month: currentDate.toLocaleDateString(undefined, { month: 'long' }) })}
        </Text>
        <View style={styles.monthSelector}>
          <IconButton icon="chevron-left" size={20} onPress={handlePrevMonth}  />
          <Text variant="labelLarge" style={{ color: theme.colors.onSurface, minWidth: 80, textAlign: 'center' }}>
            {currentDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
          </Text>
          <IconButton icon="chevron-right" size={20} onPress={handleNextMonth} />
        </View>
      </View>

      <View style={styles.calendarContainer}>
          {/* Weekday headers */}
          <View style={styles.weekRow}>
              {weekDays.map((d, i) => (
                  <Text key={i} style={[styles.weekDayText, { color: theme.colors.onSurfaceVariant }]}>{d}</Text>
              ))}
          </View>

          {/* Days grid */}
          <View style={styles.daysGrid}>
              {calendarDays.map((day, index) => {
                  if (day === null) {
                      return <View key={index} style={styles.dayCell} />;
                  }

                  const status = getSessionStatus(day);
                  const isAttended = status === 'attended';
                  const isBooked = status === 'booked';
                  const hasSess = hasSession(day);
                  const isSelected = day === selectedDay;

                  // Styles based on status
                  let bgObj: any = {};
                  let textObj: any = {};

                  if (isAttended) {
                      bgObj = { backgroundColor: theme.dark ? 'rgba(34, 197, 94, 0.2)' : '#DCFCE7' };
                      textObj = { color: theme.dark ? '#4ADE80' : '#166534', fontWeight: 'bold' };
                  } else if (isBooked) {
                      bgObj = { backgroundColor: theme.dark ? 'rgba(59, 130, 246, 0.2)' : '#DBEAFE' };
                      textObj = { color: theme.dark ? '#60A5FA' : '#1E40AF', fontWeight: 'bold' };
                  }

                  if (isSelected) {
                      bgObj = {
                          borderWidth: 2,
                          borderColor: theme.colors.primary,
                          backgroundColor: isAttended
                              ? (theme.dark ? 'rgba(34, 197, 94, 0.3)' : '#BBF7D0')
                              : isBooked
                                  ? (theme.dark ? 'rgba(59, 130, 246, 0.3)' : '#BFDBFE')
                                  : (theme.dark ? 'rgba(93, 176, 255, 0.1)' : '#EFF6FF'),
                      };
                      textObj = { color: theme.colors.primary, fontWeight: '900' };
                  }

                  return (
                      <TouchableOpacity
                          key={index}
                          style={[
                              styles.dayCell,
                              (isAttended || isBooked) && { borderRadius: 12 },
                              bgObj
                          ]}
                          onPress={() => setSelectedDay(isSelected ? null : day)}
                      >
                          <Text style={[
                              styles.dayText,
                              { color: theme.colors.onSurface },
                              textObj
                          ]}>
                              {day}
                          </Text>
                          {hasSess && (
                              <View style={[
                                  styles.dot,
                                  { backgroundColor: theme.colors.primary }
                              ]} />
                          )}
                      </TouchableOpacity>
                  );
              })}
          </View>

          {isLoading && (
              <View style={[styles.loadingOverlay, { backgroundColor: theme.colors.surface, opacity: 0.7 }]}>
                  <ActivityIndicator size="small" />
              </View>
          )}
      </View>

      {/* Selected Day Details */}
      {selectedDay ? (
          <View style={styles.detailsContainer}>
              <Divider style={{ marginVertical: 12 }} />
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
                  {new Date(currentDate.getFullYear(), currentDate.getMonth(), selectedDay).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
              </Text>

              {sessionsOnSelectedDay.length > 0 ? (
                  sessionsOnSelectedDay.map(session => {
                      const isAttended = attendedSessions.some(as => as.id === session.id);
                      const isBooked = !isAttended && bookedSessions.some(bs => bs.id === session.id);
                      const isAvailable = !isAttended && !isBooked;
                      const isFuture = session.start > new Date();
                      const isSessionLoading = loadingSessionId === session.id;

                      return (
                          <View key={session.id} style={[
                              styles.sessionItem,
                              isAttended && {
                                  backgroundColor: theme.dark ? 'rgba(34, 197, 94, 0.15)' : '#F0FDF4',
                                  borderColor: theme.dark ? 'rgba(34, 197, 94, 0.3)' : '#DCFCE7',
                                  borderWidth: 1
                              },
                              isBooked && {
                                  backgroundColor: theme.dark ? 'rgba(59, 130, 246, 0.15)' : '#EFF6FF',
                                  borderColor: theme.dark ? 'rgba(59, 130, 246, 0.3)' : '#DBEAFE',
                                  borderWidth: 1
                              }
                          ]}>
                              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <View style={{ flex: 1 }}>
                                      <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                                          {session.activityName || t('sessionFallback')}
                                      </Text>
                                      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                                          {session.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                          {session.providerName ? ` · ${session.providerName}` : ''}
                                      </Text>
                                  </View>
                                  {isSessionLoading ? (
                                      <ActivityIndicator size={16} color={theme.colors.primary} style={{ marginLeft: 8 }} />
                                  ) : isAttended ? (
                                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                          <IconButton icon="check-circle" size={18} iconColor={theme.dark ? '#4ADE80' : '#166534'} style={{ margin: 0 }} />
                                          <Text variant="labelSmall" style={{ color: theme.dark ? '#4ADE80' : '#166534', fontWeight: 'bold' }}>{t('attendedTag').toUpperCase()}</Text>
                                      </View>
                                  ) : isBooked && isFuture ? (
                                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                          <View style={[styles.statusPill, { backgroundColor: theme.dark ? 'rgba(59, 130, 246, 0.2)' : '#DBEAFE' }]}>
                                              <Text variant="labelSmall" style={{ color: theme.dark ? '#60A5FA' : '#1E40AF', fontWeight: '800', fontSize: 9 }}>{t('bookedTag').toUpperCase()}</Text>
                                          </View>
                                          <IconButton
                                              icon="trash-can-outline"
                                              size={18}
                                              iconColor={theme.colors.error}
                                              onPress={() => handleCancel(session)}
                                              style={{ margin: 0, marginLeft: 2 }}
                                          />
                                      </View>
                                  ) : isBooked ? (
                                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                          <IconButton icon="calendar-check" size={18} iconColor={theme.dark ? '#60A5FA' : '#1E40AF'} style={{ margin: 0 }} />
                                          <Text variant="labelSmall" style={{ color: theme.dark ? '#60A5FA' : '#1E40AF', fontWeight: 'bold' }}>{t('bookedTag').toUpperCase()}</Text>
                                      </View>
                                  ) : isAvailable && isFuture && session.allowBooking ? (
                                      <Button
                                          mode="contained"
                                          compact
                                          onPress={() => handleBook(session)}
                                          style={styles.bookBtn}
                                          labelStyle={styles.btnLabel}
                                      >
                                          {t('bookButton')}
                                      </Button>
                                  ) : null}
                              </View>
                          </View>
                      );
                  })
              ) : (
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, fontStyle: 'italic' }}>
                      {t('noClassesScheduled')}
                  </Text>
              )}
          </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  monthSelector: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  calendarContainer: {
    position: 'relative',
    minHeight: 200,
  },
  weekRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 8,
  },
  weekDayText: {
    width: '14.28%',
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: '14.28%', // 100% / 7
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 2,
  },
  dayText: {
    fontSize: 14,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 3,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  detailsContainer: {
    marginTop: 0,
  },
  sessionItem: {
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(150, 150, 150, 0.1)',
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    marginLeft: 8,
    alignItems: 'center',
  },
  bookBtn: {
    marginLeft: 8,
    borderRadius: 8,
  },
  btnLabel: {
    fontSize: 10,
    fontWeight: '700',
    marginVertical: 4,
    marginHorizontal: 8,
  }
});
