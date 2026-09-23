import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Icon, IconButton, Text, TouchableRipple, useTheme } from 'react-native-paper';
import { ListAvailabilityActivity, ListAvailabilityCoach, Contact } from '../../types';
import { FirestoreService } from '../../services/firestore';
import { activityHasMemberBenefit, durationIsBenefitOnly } from '../../utils/appointmentAccess';
import { useTranslations } from '../../i18n';

interface Props {
  visible: boolean;
  teamId?: string | null;
  contact?: Contact | null;
  onClose: () => void;
  /** Called once a booking succeeds — the parent should refresh the member's
   *  own upcoming appointments and close the modal. */
  onBooked: () => void;
}

type Step = 'coach' | 'activity' | 'time';

interface PendingSlot {
  startMs: number;
  durationMinutes: number;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

function fmtDuration(t: Translate, mins: number): string {
  if (mins < 60) return t('durationMinutes', { mins });
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? t('durationHoursMinutes', { h, m }) : t('durationHoursOnly', { h });
}

const fmtDayShort = (ms: number) =>
  new Date(ms).toLocaleDateString('default', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtFullDate = (ms: number) =>
  new Date(ms).toLocaleDateString('default', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString('default', { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * The member's browse/book funnel for appointments — built entirely on
 * `listAvailability` (nothing is pre-generated; a Session is created lazily,
 * overlap-safe, at booking time via `bookAppointment`). Matches the web
 * picker's order (`/public/{slug}/appointments`) so both products behave the
 * same: coach → activity → duration (only when >1) → day → time.
 *
 * The member is already signed in via the contact session (custom-token
 * claims) — `bookAppointment` trusts `request.auth.token.contactId`, so no
 * guest form or emailed code is shown here.
 */
export const AppointmentBookingModal: React.FC<Props> = ({ visible, teamId, contact, onClose, onBooked }) => {
  const theme = useTheme();
  const t = useTranslations('Appointments');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coaches, setCoaches] = useState<ListAvailabilityCoach[]>([]);

  const [step, setStep] = useState<Step>('coach');
  const [selectedCoach, setSelectedCoach] = useState<ListAvailabilityCoach | null>(null);
  const [selectedActivity, setSelectedActivity] = useState<ListAvailabilityActivity | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<number | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const [pendingSlot, setPendingSlot] = useState<PendingSlot | null>(null);
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);

  // Fresh funnel + fresh fetch every time the modal opens.
  useEffect(() => {
    if (!visible) return;
    setStep('coach');
    setSelectedCoach(null);
    setSelectedActivity(null);
    setSelectedDuration(null);
    setSelectedDay(null);
    setPendingSlot(null);
    setBookError(null);

    if (!teamId) {
      setError(t('missingTeam'));
      setCoaches([]);
      return;
    }

    let alive = true;
    setLoading(true);
    setError(null);
    FirestoreService.listAppointmentAvailability(teamId)
      .then((result) => {
        if (!alive) return;
        setCoaches(result);
      })
      .catch(() => {
        if (!alive) return;
        setError(t('loadAvailabilityFailed'));
        setCoaches([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [visible, teamId, t]);

  const selectCoach = (coach: ListAvailabilityCoach) => {
    setSelectedCoach(coach);
    setSelectedActivity(null);
    setStep('activity');
  };

  const selectActivity = (activity: ListAvailabilityActivity) => {
    setSelectedActivity(activity);
    setSelectedDuration(activity.durations[0]?.minutes ?? 60);
    setSelectedDay(activity.days[0]?.dayMs ?? null);
    setStep('time');
  };

  const backToCoaches = () => {
    setStep('coach');
    setSelectedCoach(null);
    setSelectedActivity(null);
  };

  const backToActivities = () => {
    setStep('activity');
    setSelectedActivity(null);
  };

  const closeConfirm = () => {
    if (booking) return;
    setPendingSlot(null);
    setBookError(null);
  };

  const confirmBook = async () => {
    if (!pendingSlot || !selectedCoach || !selectedActivity || !teamId) return;
    setBooking(true);
    setBookError(null);
    try {
      await FirestoreService.bookAppointment({
        teamId,
        providerId: selectedCoach.providerId,
        activityId: selectedActivity.activityId,
        startMs: pendingSlot.startMs,
        durationMinutes: pendingSlot.durationMinutes,
      });
      setPendingSlot(null);
      Alert.alert(t('confirmedTitle'), t('confirmedBody'));
      onBooked();
    } catch (e: any) {
      // Surface the server's message (e.g. a members/subscription access-rule
      // refusal, or "this time was just taken") rather than crashing.
      setBookError(e?.message || t('bookFailed'));
    } finally {
      setBooking(false);
    }
  };

  const day = useMemo(
    () => selectedActivity?.days.find((d) => d.dayMs === selectedDay) ?? selectedActivity?.days[0] ?? null,
    [selectedActivity, selectedDay]
  );
  const times = day && selectedDuration != null ? day.slotsByDuration[String(selectedDuration)] ?? [] : [];

  const title =
    step === 'coach'
      ? t('bookTitle')
      : step === 'activity'
        ? selectedCoach?.providerName || t('chooseActivityTitle')
        : selectedActivity?.activityName || t('chooseTimeTitle');

  return (
    <Modal visible={visible} transparent={false} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.header}>
          <View style={styles.backSlot}>
            {step !== 'coach' && (
              <TouchableRipple
                onPress={step === 'activity' ? backToCoaches : backToActivities}
                borderless
                style={styles.backBtn}
              >
                <View style={styles.backBtnInner}>
                  <Icon source="chevron-left" size={20} color={theme.colors.primary} />
                  <Text style={{ color: theme.colors.primary, fontWeight: '600' }}>{t('back')}</Text>
                </View>
              </TouchableRipple>
            )}
          </View>
          <Text
            variant="titleMedium"
            style={{ color: theme.colors.onSurface, fontWeight: '800', flex: 1, textAlign: 'center' }}
            numberOfLines={1}
          >
            {title}
          </Text>
          <IconButton icon="close" size={22} onPress={onClose} />
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {loading && (
            <View style={styles.centerBox}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
            </View>
          )}

          {!loading && error && (
            <View style={styles.centerBox}>
              <Icon source="alert-circle-outline" size={40} color={theme.colors.error} />
              <Text
                variant="bodyMedium"
                style={{ color: theme.colors.onSurfaceVariant, marginTop: 10, textAlign: 'center' }}
              >
                {error}
              </Text>
            </View>
          )}

          {!loading && !error && coaches.length === 0 && (
            <View style={styles.centerBox}>
              <Icon source="calendar-remove-outline" size={40} color={theme.colors.onSurfaceVariant} />
              <Text
                variant="bodyMedium"
                style={{ color: theme.colors.onSurfaceVariant, marginTop: 10, textAlign: 'center' }}
              >
                {t('noAvailability')}
              </Text>
            </View>
          )}

          {!loading &&
            !error &&
            step === 'coach' &&
            coaches.map((coach) => (
              <TouchableRipple key={coach.providerId} onPress={() => selectCoach(coach)} borderless style={styles.cardWrap}>
                <View style={[styles.card, { borderColor: theme.colors.outlineVariant }]}>
                  <View style={[styles.avatarCircle, { backgroundColor: theme.colors.primaryContainer }]}>
                    <Icon source="account" size={20} color={theme.colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                      {coach.providerName || t('coachFallback')}
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }} numberOfLines={1}>
                      {coach.activities.map((a) => a.activityName).join(' · ')}
                    </Text>
                  </View>
                  <Icon source="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />
                </View>
              </TouchableRipple>
            ))}

          {!loading && !error && step === 'activity' && selectedCoach && (
            selectedCoach.activities.length === 0 ? (
              <View style={styles.centerBox}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  {t('noActivitiesForCoach')}
                </Text>
              </View>
            ) : (
              selectedCoach.activities.map((activity) => {
                // Appointments have NO access gate — money (durations +
                // memberBenefit) is the only gate. This badge is informational
                // only: it flags that SOME durations carry a member benefit,
                // never that booking is restricted (see utils/appointmentAccess.ts).
                const hasMemberBenefit = activityHasMemberBenefit(activity);
                const durations = activity.durations.map((d) => d.minutes);
                const durationLabel =
                  durations.length > 1
                    ? `${fmtDuration(t, Math.min(...durations))} – ${fmtDuration(t, Math.max(...durations))}`
                    : fmtDuration(t, durations[0] ?? 60);
                return (
                  <TouchableRipple
                    key={activity.activityId}
                    onPress={() => selectActivity(activity)}
                    borderless
                    style={styles.cardWrap}
                  >
                    <View style={[styles.card, { borderColor: theme.colors.outlineVariant }]}>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                            {activity.activityName}
                          </Text>
                          {hasMemberBenefit && (
                            <View
                              style={[
                                styles.lockBadge,
                                { backgroundColor: theme.dark ? 'rgba(217,119,6,0.2)' : '#FEF3C7' },
                              ]}
                            >
                              <Icon source="star-outline" size={10} color={theme.dark ? '#FBBF24' : '#B45309'} />
                              <Text style={{ color: theme.dark ? '#FBBF24' : '#B45309', fontSize: 10, fontWeight: '700' }}>
                                {t('membersBenefitBadge')}
                              </Text>
                            </View>
                          )}
                        </View>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
                          <View style={styles.metaItem}>
                            <Icon source="clock-outline" size={12} color={theme.colors.onSurfaceVariant} />
                            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                              {durationLabel}
                            </Text>
                          </View>
                          {/* The PLACE is the where, and it is what tells two
                              cards for the same offer apart — `listAvailability`
                              returns one entry per (provider, activity, place).
                              `location` is the studio's free-text note on top of
                              it, and is all a schedule naming no tracked place
                              has. */}
                          {activity.placeName || activity.location ? (
                            <View style={styles.metaItem}>
                              <Icon source="map-marker-outline" size={12} color={theme.colors.onSurfaceVariant} />
                              <Text
                                variant="bodySmall"
                                style={{ color: theme.colors.onSurfaceVariant }}
                                numberOfLines={1}
                              >
                                {[activity.placeName, activity.location].filter(Boolean).join(' · ')}
                              </Text>
                            </View>
                          ) : null}
                          {activity.onlineUrl ? (
                            <View style={styles.metaItem}>
                              <Icon source="video-outline" size={12} color={theme.colors.onSurfaceVariant} />
                              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                                {t('onlineLabel')}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      </View>
                      <Icon source="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />
                    </View>
                  </TouchableRipple>
                );
              })
            )
          )}

          {!loading && !error && step === 'time' && selectedCoach && selectedActivity && (
            <View style={{ gap: 16 }}>
              {selectedActivity.durations.length > 1 && (
                <View style={{ gap: 8 }}>
                  <Text variant="labelMedium" style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
                    {t('groupDuration').toUpperCase()}
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {selectedActivity.durations.map((duration) => {
                      const d = duration.minutes;
                      const active = d === selectedDuration;
                      // NOT SOLD INDIVIDUALLY (UX-70) — bookable only through
                      // the member benefit. Informational label only; the
                      // price is still the gate, this is not a second one.
                      const benefitOnly = durationIsBenefitOnly(duration);
                      return (
                        <TouchableRipple key={d} onPress={() => setSelectedDuration(d)} borderless style={styles.chipWrap}>
                          <View
                            style={[
                              styles.chip,
                              active
                                ? { backgroundColor: theme.colors.primaryContainer, borderColor: theme.colors.primary }
                                : { borderColor: theme.colors.outlineVariant },
                            ]}
                          >
                            <Text
                              style={{
                                color: active ? theme.colors.primary : theme.colors.onSurfaceVariant,
                                fontWeight: '600',
                                fontSize: 12,
                              }}
                            >
                              {fmtDuration(t, d)}{benefitOnly ? t('memberOnlySuffix') : ''}
                            </Text>
                          </View>
                        </TouchableRipple>
                      );
                    })}
                  </View>
                </View>
              )}

              <View style={{ gap: 8 }}>
                <Text variant="labelMedium" style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
                  {t('groupDay').toUpperCase()}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {selectedActivity.days.map((d) => {
                      const active = d.dayMs === selectedDay;
                      return (
                        <TouchableRipple key={d.dayMs} onPress={() => setSelectedDay(d.dayMs)} borderless style={styles.chipWrap}>
                          <View
                            style={[
                              styles.chip,
                              active
                                ? { backgroundColor: theme.colors.primaryContainer, borderColor: theme.colors.primary }
                                : { borderColor: theme.colors.outlineVariant },
                            ]}
                          >
                            <Text
                              style={{
                                color: active ? theme.colors.primary : theme.colors.onSurfaceVariant,
                                fontWeight: '600',
                                fontSize: 12,
                              }}
                            >
                              {fmtDayShort(d.dayMs)}
                            </Text>
                          </View>
                        </TouchableRipple>
                      );
                    })}
                  </View>
                </ScrollView>
              </View>

              <View style={{ gap: 8 }}>
                <Text variant="labelMedium" style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
                  {t('groupTime').toUpperCase()}
                </Text>
                {times.length === 0 ? (
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    {t('noTimesThisDay')}
                  </Text>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {times.map((startMs) => (
                      <TouchableRipple
                        key={startMs}
                        onPress={() => selectedDuration != null && setPendingSlot({ startMs, durationMinutes: selectedDuration })}
                        borderless
                        style={styles.chipWrap}
                      >
                        <View style={[styles.chip, styles.timeChip, { borderColor: theme.colors.outlineVariant }]}>
                          <Text style={{ color: theme.colors.onSurface, fontWeight: '700', fontSize: 13 }}>
                            {fmtTime(startMs)}
                          </Text>
                        </View>
                      </TouchableRipple>
                    ))}
                  </View>
                )}
              </View>
            </View>
          )}
        </ScrollView>

        {/* Confirm & book — an overlay inside this same Modal, not a nested one. */}
        {pendingSlot && (
          <View style={StyleSheet.absoluteFillObject}>
            <Pressable style={styles.backdrop} onPress={closeConfirm}>
              <Pressable style={[styles.sheet, { backgroundColor: theme.colors.surface }]} onPress={() => undefined}>
                <View style={[styles.dateBadge, { backgroundColor: theme.colors.primaryContainer }]}>
                  <Text style={[styles.badgeDay, { color: theme.colors.primary }]}>
                    {new Date(pendingSlot.startMs).getDate()}
                  </Text>
                  <Text style={[styles.badgeMonth, { color: theme.colors.primary }]}>
                    {new Date(pendingSlot.startMs).toLocaleString('default', { month: 'short' }).toUpperCase()}
                  </Text>
                </View>

                <Text variant="headlineSmall" style={[styles.modalTitle, { color: theme.colors.onSurface }]}>
                  {selectedActivity?.activityName}
                </Text>
                {selectedCoach?.providerName ? (
                  <View style={styles.coachRow}>
                    <Icon source="account-circle" size={16} color={theme.colors.onSurfaceVariant} />
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 6 }}>
                      {t('withLabel')}{' '}
                      <Text style={{ fontWeight: '700', color: theme.colors.onSurface }}>
                        {selectedCoach.providerName}
                      </Text>
                    </Text>
                  </View>
                ) : null}

                <View
                  style={[
                    styles.detailBox,
                    { backgroundColor: theme.dark ? 'rgba(255,255,255,0.05)' : theme.colors.surfaceVariant },
                  ]}
                >
                  <View style={styles.detailRow}>
                    <Icon source="calendar-outline" size={16} color={theme.colors.primary} />
                    <Text variant="bodySmall" style={[styles.detailText, { color: theme.colors.onSurface }]}>
                      {fmtFullDate(pendingSlot.startMs)}
                    </Text>
                  </View>
                  <View
                    style={[styles.detailRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.outlineVariant }]}
                  >
                    <Icon source="clock-outline" size={16} color={theme.colors.primary} />
                    <Text variant="bodySmall" style={[styles.detailText, { color: theme.colors.onSurface }]}>
                      {`${fmtTime(pendingSlot.startMs)} – ${fmtTime(pendingSlot.startMs + pendingSlot.durationMinutes * 60_000)} · ${fmtDuration(t, pendingSlot.durationMinutes)}`}
                    </Text>
                  </View>
                  {selectedActivity?.placeName || selectedActivity?.location ? (
                    <View
                      style={[styles.detailRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.outlineVariant }]}
                    >
                      <Icon source="map-marker-outline" size={16} color={theme.colors.primary} />
                      <Text variant="bodySmall" style={[styles.detailText, { color: theme.colors.onSurface }]}>
                        {[selectedActivity.placeName, selectedActivity.location].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                  ) : null}
                  {selectedActivity?.onlineUrl ? (
                    <View
                      style={[styles.detailRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.outlineVariant }]}
                    >
                      <Icon source="video-outline" size={16} color={theme.colors.primary} />
                      <Text variant="bodySmall" style={[styles.detailText, { color: theme.colors.onSurface }]}>
                        {t('onlineSession')}
                      </Text>
                    </View>
                  ) : null}
                </View>

                {bookError ? (
                  <Text variant="bodySmall" style={{ color: theme.colors.error, textAlign: 'center' }}>
                    {bookError}
                  </Text>
                ) : null}

                <View style={styles.actions}>
                  <Button mode="text" onPress={closeConfirm} style={{ flex: 1 }} disabled={booking}>
                    {t('notNow')}
                  </Button>
                  <Button mode="contained" style={{ flex: 1 }} onPress={confirmBook} loading={booking} disabled={booking}>
                    {t('bookIt')}
                  </Button>
                </View>
              </Pressable>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 48,
    paddingBottom: 12,
  },
  backSlot: { minWidth: 48, alignItems: 'flex-start' },
  backBtn: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6 },
  backBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  content: { padding: 16, paddingBottom: 60, gap: 10 },
  centerBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  groupLabel: { fontWeight: '700', letterSpacing: 0.5 },
  cardWrap: { borderRadius: 16 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
  },
  avatarCircle: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  lockBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chipWrap: { borderRadius: 10 },
  chip: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  timeChip: { minWidth: 76, alignItems: 'center' },
  // Confirm sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  sheet: { width: '100%', borderRadius: 24, padding: 24, alignItems: 'center', gap: 16 },
  dateBadge: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  badgeDay: { fontSize: 28, fontWeight: '900', lineHeight: 32 },
  badgeMonth: { fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  modalTitle: { fontWeight: '800', textAlign: 'center' },
  coachRow: { flexDirection: 'row', alignItems: 'center', marginTop: -8 },
  detailBox: { width: '100%', overflow: 'hidden', borderRadius: 12 },
  detailRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  detailText: { flex: 1, fontWeight: '500' },
  actions: { flexDirection: 'row', gap: 10, width: '100%' },
});
