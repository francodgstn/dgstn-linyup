import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Chip,
  Modal,
  Portal,
  Surface,
  Text,
  TextInput,
  TouchableRipple,
  useTheme,
} from 'react-native-paper';
import Svg, { Circle, Line, Polygon, Polyline, Text as SvgText } from 'react-native-svg';
import { FirestoreService } from '../../services/firestore';
import { PerformanceIndicator, PerformanceCheckin, ProfileKey } from '../../types';
import { PERFORMANCE_PROFILE_COLORS } from '../../utils/goalContract';
import { useTranslations } from '../../i18n';

interface Props {
  contactId: string;
  teamId: string;
}

/** What the axis-copy and profile-copy builders need from
 *  `useTranslations('Performance')` — built once per render and threaded
 *  through, since this module's helpers live outside the component. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

// ─── Axis question copy ───────────────────────────────────────────────────────
//
// A FIXED set of five axis ids Linyup ships with (not tenant data — a studio's
// own coaching axes come from `PerformanceIndicator.label`, read verbatim,
// never translated here). These are only the default question prompts and
// fallback display labels for THOSE five ids.

const axisQuestions = (t: Translate): Record<string, string> => ({
  consistency: t('axisQuestionConsistency'),
  effort: t('axisQuestionEffort'),
  focus: t('axisQuestionFocus'),
  recharge: t('axisQuestionRecharge'),
  sense_of_progress: t('axisQuestionSenseOfProgress'),
});

const axisLabels = (t: Translate): Record<string, string> => ({
  consistency: t('axisLabelConsistency'),
  effort: t('axisLabelEffort'),
  focus: t('axisLabelFocus'),
  recharge: t('axisLabelRecharge'),
  sense_of_progress: t('axisLabelSenseOfProgress'),
});

// ─── Profile display metadata ─────────────────────────────────────────────────
//
// The most sensitive copy in the app — it tells a member how their training is
// going. Wording is aligned with the web Space's `SpaceCoaching` namespace
// (the member-facing equivalent) so the two surfaces agree; translate with the
// same care, not word-for-word literalism.

type ProfileDisplay = {
  label: string;
  color: string;
  message: string;
};

// The colour is the shared fact (`PERFORMANCE_PROFILE_COLORS` — the admin's
// profile badge tints the same reading the same way); the words stay here.
const profileDisplay = (t: Translate, key: ProfileKey, lever?: string, anchor?: string): ProfileDisplay => {
  const labels = axisLabels(t);
  const color = PERFORMANCE_PROFILE_COLORS[key];
  switch (key) {
    case 'burnout_risk':
      return { label: t('profileBurnoutRiskLabel'), color, message: t('profileBurnoutRiskMessage') };
    case 'overreaching':
      return { label: t('profileOverreachingLabel'), color, message: t('profileOverreachingMessage') };
    case 'stuck':
      return { label: t('profileStuckLabel'), color, message: t('profileStuckMessage') };
    case 'coasting':
      return { label: t('profileCoastingLabel'), color, message: t('profileCoastingMessage') };
    case 'inconsistent':
      return { label: t('profileInconsistentLabel'), color, message: t('profileInconsistentMessage') };
    case 'balanced':
      return { label: t('profileBalancedLabel'), color, message: t('profileBalancedMessage') };
    default:
      return {
        label: t('profileDefaultLabel'),
        color,
        message: anchor && lever
          ? t('profileDefaultMessage', { anchor: labels[anchor] ?? anchor, lever: labels[lever] ?? lever })
          : '',
      };
  }
};

// ─── Radar Chart ──────────────────────────────────────────────────────────────

interface RadarChartProps {
  indicators: PerformanceIndicator[];
  studentScores: Record<string, number>;
  coachScores?: Record<string, number>;
  size?: number;
  maxValue?: number;
}

const RadarChartSVG: React.FC<RadarChartProps> = ({
  indicators,
  studentScores,
  coachScores,
  size = 300,
  maxValue = 5,
}) => {
  const n = indicators.length;
  if (n < 3) return null;

  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.38;
  const labelRadius = radius + 10;

  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const polar = (r: number, i: number) => ({
    x: cx + r * Math.cos(angle(i)),
    y: cy + r * Math.sin(angle(i)),
  });

  const rings = [1, 2, 3, 4, 5];

  const buildPoints = (scores: Record<string, number>) =>
    indicators
      .map((ind, i) => {
        const val = Math.min(Math.max(scores[ind.key] ?? 0, 0), maxValue);
        const r = (val / maxValue) * radius;
        const p = polar(r, i);
        return `${p.x},${p.y}`;
      })
      .join(' ');

  const studentPoints = buildPoints(studentScores);
  const coachPoints = coachScores ? buildPoints(coachScores) : null;

  return (
    <Svg width={size} height={size}>
      {rings.map(ring => {
        const r = (ring / maxValue) * radius;
        const ringPoints = indicators
          .map((_, i) => {
            const p = polar(r, i);
            return `${p.x},${p.y}`;
          })
          .join(' ');
        return (
          <Polygon key={ring} points={ringPoints} fill="none" stroke="#CBD5E1" strokeWidth={0.8} />
        );
      })}

      {indicators.map((_, i) => {
        const outer = polar(radius, i);
        return (
          <Line key={i} x1={cx} y1={cy} x2={outer.x} y2={outer.y} stroke="#CBD5E1" strokeWidth={0.8} />
        );
      })}

      {coachPoints && (
        <Polygon
          points={coachPoints}
          fill="rgba(249,115,22,0.1)"
          stroke="#F97316"
          strokeWidth={1.5}
          strokeDasharray="4 2"
        />
      )}

      <Polygon points={studentPoints} fill="rgba(59,130,246,0.18)" stroke="#3B82F6" strokeWidth={2} />
      <Circle cx={cx} cy={cy} r={3} fill="#3B82F6" />

      {indicators.map((ind, i) => {
        const p = polar(labelRadius, i);
        const a = angle(i);
        let anchor: 'start' | 'middle' | 'end' = 'middle';
        if (Math.cos(a) > 0.2) anchor = 'start';
        else if (Math.cos(a) < -0.2) anchor = 'end';

        // Word-wrap: split into lines of ≤10 chars at word boundaries
        const words = ind.label.split(' ');
        const lines: string[] = [];
        let current = '';
        for (const word of words) {
          if (!current) { current = word; }
          else if ((current + ' ' + word).length <= 10) { current += ' ' + word; }
          else { lines.push(current); current = word; }
        }
        if (current) lines.push(current);

        const lineHeight = 11;
        const startY = p.y + 4 - ((lines.length - 1) * lineHeight) / 2;

        return lines.map((line, li) => (
          <SvgText
            key={`${ind.key}-${li}`}
            x={p.x}
            y={startY + li * lineHeight}
            fontSize={10}
            fill="#64748B"
            textAnchor={anchor}
          >
            {line}
          </SvgText>
        ));
      })}
    </Svg>
  );
};

// ─── Score input row ──────────────────────────────────────────────────────────

const ScoreRow: React.FC<{
  indicator: PerformanceIndicator;
  value: number;
  onChange: (v: number) => void;
}> = ({ indicator, value, onChange }) => {
  const theme = useTheme();
  const t = useTranslations('Performance');
  const question = axisQuestions(t)[indicator.key];
  return (
    <View style={{ paddingVertical: 8 }}>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600', marginBottom: question ? 2 : 8 }}>
        {indicator.label}
      </Text>
      {question && (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
          {question}
        </Text>
      )}
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {[1, 2, 3, 4, 5].map(i => (
          <TouchableRipple key={i} onPress={() => onChange(i)} borderless style={{ borderRadius: 16 }}>
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                borderWidth: 1.5,
                borderColor: i <= value ? '#3B82F6' : '#CBD5E1',
                backgroundColor: i <= value ? '#3B82F620' : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text variant="labelSmall" style={{ color: i <= value ? '#3B82F6' : '#94A3B8', fontWeight: '700', fontSize: 10 }}>
                {i}
              </Text>
            </View>
          </TouchableRipple>
        ))}
      </View>
    </View>
  );
};

// ─── Check-in history row ─────────────────────────────────────────────────────

const CheckinHistoryRow: React.FC<{
  checkin: PerformanceCheckin;
  indicators: PerformanceIndicator[];
}> = ({ checkin, indicators }) => {
  const theme = useTheme();
  const t = useTranslations('Performance');
  const date = checkin.taken_at.toDate();
  const dateStr = date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

  const abbreviated = indicators
    .map(ind => {
      const abbr = ind.label[0].toUpperCase() + ind.label[1].toLowerCase();
      const val = checkin.scores[ind.key] ?? '-';
      return `${abbr} ${val}`;
    })
    .join('  ·  ');

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.outlineVariant,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>
          {dateStr}
        </Text>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {abbreviated}
        </Text>
      </View>
      {/* `default` included — a check-in that matched no named pattern still
          has a (deliberately unexciting) label, and the portal and the coach's
          tab both show it; hiding it here was the one surface that differed. */}
      {checkin.profile_key && (() => {
        const display = profileDisplay(t, checkin.profile_key);
        return (
          <Chip
            compact
            style={{
              backgroundColor: display.color + '20',
              height: 24,
              marginRight: 6,
            }}
            textStyle={{ fontSize: 10, color: display.color, marginVertical: 0 }}
          >
            {display.label}
          </Chip>
        );
      })()}
      <Chip
        compact
        style={{
          backgroundColor: checkin.filled_by === 'coach' ? '#7C3AED20' : '#3B82F620',
          height: 24,
        }}
        textStyle={{
          fontSize: 10,
          color: checkin.filled_by === 'coach' ? '#7C3AED' : '#3B82F6',
          marginVertical: 0,
        }}
      >
        {checkin.filled_by === 'coach' ? t('filledByCoach') : t('filledBySelf')}
      </Chip>
    </View>
  );
};

// ─── Performance Check-in Modal ───────────────────────────────────────────────

type PerformanceContextValue = 'self' | '1to1';

interface CheckinModalProps {
  visible: boolean;
  indicators: PerformanceIndicator[];
  onDismiss: () => void;
  onSubmit: (scores: Record<string, number>, notes: string, context: PerformanceContextValue) => Promise<void>;
}

const PerformanceCheckinModal: React.FC<CheckinModalProps> = ({ visible, indicators, onDismiss, onSubmit }) => {
  const theme = useTheme();
  const t = useTranslations('Performance');
  // Unset until the member actually taps a value for every axis — defaulting
  // every axis to 3 let a check-in save with zero interaction.
  const [scores, setScores] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  const [context, setContext] = useState<PerformanceContextValue>('self');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setScores({});
      setNotes('');
      setContext('self');
    }
  }, [visible, indicators]);

  const allRated = indicators.length > 0 && indicators.every(ind => typeof scores[ind.key] === 'number');

  const handleSubmit = async () => {
    if (!allRated) return;
    setSubmitting(true);
    try {
      await onSubmit(scores, notes.trim(), context);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={{
          backgroundColor: theme.colors.surface,
          margin: 20,
          borderRadius: 16,
          padding: 20,
          maxHeight: '90%',
        }}
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text variant="titleMedium" style={{ fontWeight: '700', marginBottom: 16 }}>
            {t('rateMyPerformanceTitle')}
          </Text>

          {indicators.map(ind => (
            <ScoreRow
              key={ind.key}
              indicator={ind}
              value={scores[ind.key] ?? 0}
              onChange={v => setScores(prev => ({ ...prev, [ind.key]: v }))}
            />
          ))}

          <TextInput
            label={t('notesOptional')}
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={2}
            mode="outlined"
            style={{ backgroundColor: theme.colors.surface, marginTop: 12 }}
          />

          <View style={{ marginTop: 12 }}>
            <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
              {t('context')}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Chip selected={context === 'self'} onPress={() => setContext('self')}>
                {t('selfCheck')}
              </Chip>
              <Chip selected={context === '1to1'} onPress={() => setContext('1to1')}>
                {t('oneToOneWithCoach')}
              </Chip>
            </View>
          </View>

          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Button onPress={onDismiss} disabled={submitting}>{t('cancel')}</Button>
            <Button mode="contained" onPress={handleSubmit} loading={submitting} disabled={submitting || !allRated}>
              {t('save')}
            </Button>
          </View>
        </ScrollView>
      </Modal>
    </Portal>
  );
};

// ─── Trend chart ─────────────────────────────────────────────────────────────

const CHART_COLORS = ['#3B82F6', '#F97316', '#8B5CF6', '#22C55E', '#EAB308', '#EF4444', '#06B6D4'];

const TrendChart: React.FC<{ checkins: PerformanceCheckin[]; indicators: PerformanceIndicator[] }> = ({
  checkins,
  indicators,
}) => {
  const theme = useTheme();
  const t = useTranslations('Performance');
  const data = [...checkins].filter(c => c.filled_by === 'student').reverse();

  if (data.length < 2) {
    return (
      <View style={{ alignItems: 'center', paddingVertical: 32 }}>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
          {t('rateAtLeastTwice')}
        </Text>
      </View>
    );
  }

  const W = 300;
  const H = 160;
  const padL = 20;
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xPos = (i: number) =>
    padL + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const yPos = (score: number) =>
    padT + plotH - ((Math.min(Math.max(score, 1), 5) - 1) / 4) * plotH;

  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={W} height={H}>
        {[1, 2, 3, 4, 5].map(v => (
          <React.Fragment key={v}>
            <Line
              x1={padL} y1={yPos(v)} x2={W - padR} y2={yPos(v)}
              stroke="#E2E8F0" strokeWidth={v === 3 ? 1 : 0.5}
            />
            <SvgText x={padL - 4} y={yPos(v) + 3} fontSize={8} fill="#94A3B8" textAnchor="end">
              {v}
            </SvgText>
          </React.Fragment>
        ))}

        {indicators.map((ind, idx) => {
          const color = CHART_COLORS[idx % CHART_COLORS.length];
          const points = data.map((c, i) => `${xPos(i)},${yPos(c.scores[ind.key] ?? 3)}`).join(' ');
          return (
            <React.Fragment key={ind.key}>
              <Polyline
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {data.map((c, i) => (
                <Circle
                  key={i}
                  cx={xPos(i)}
                  cy={yPos(c.scores[ind.key] ?? 3)}
                  r={2.5}
                  fill={color}
                />
              ))}
            </React.Fragment>
          );
        })}

        {data.map((c, i) => {
          const show = data.length <= 5 || i === 0 || i === data.length - 1 || i === Math.floor((data.length - 1) / 2);
          if (!show) return null;
          const date = c.taken_at.toDate();
          const label = date.toLocaleDateString([], { day: 'numeric', month: 'short' });
          const anchor: 'start' | 'middle' | 'end' = i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle';
          return (
            <SvgText key={i} x={xPos(i)} y={H - 4} fontSize={8} fill="#94A3B8" textAnchor={anchor}>
              {label}
            </SvgText>
          );
        })}
      </Svg>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center', marginTop: 8 }}>
        {indicators.map((ind, idx) => (
          <View key={ind.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 12, height: 2.5, backgroundColor: CHART_COLORS[idx % CHART_COLORS.length], borderRadius: 2 }} />
            <Text variant="labelSmall" style={{ fontSize: 9, color: '#64748B' }}>{ind.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
};

// ─── PerformanceProfileSection ───────────────────────────────────────────────────

export const PerformanceProfileSection: React.FC<Props> = ({ contactId, teamId }) => {
  const theme = useTheme();
  const t = useTranslations('Performance');
  const { width: screenWidth } = useWindowDimensions();
  // Fill card width: screenWidth minus 20px outer scroll padding each side, then bleed through the 16px card padding
  const chartSize = screenWidth - 40;
  const [checkins, setCheckins] = useState<PerformanceCheckin[]>([]);
  const [indicators, setIndicators] = useState<PerformanceIndicator[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'profile' | 'history'>('profile');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [data, inds] = await Promise.all([
        FirestoreService.getPerformanceCheckins(contactId, 10),
        teamId ? FirestoreService.getCoachingDimensions(teamId) : Promise.resolve([]),
      ]);
      setCheckins(data);
      setIndicators(inds);
    } finally {
      setLoading(false);
    }
  }, [contactId, teamId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSubmit = async (scores: Record<string, number>, notes: string, context: PerformanceContextValue) => {
    await FirestoreService.addPerformanceCheckin(contactId, {
      filled_by: 'student',
      scores,
      notes,
      context,
    });
    setShowModal(false);
    await loadData();
  };

  const latestStudentCheckin = checkins.find(s => s.filled_by === 'student');

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const latestCoachCheckin = checkins.find(s => {
    if (s.filled_by !== 'coach') return false;
    const d = s.taken_at.toDate();
    return d >= sevenDaysAgo;
  });

  const profileKey = latestStudentCheckin?.profile_key;
  const display = profileKey
    ? profileDisplay(t, profileKey, latestStudentCheckin?.primary_lever ?? undefined, latestStudentCheckin?.anchor ?? undefined)
    : null;

  const tabStyle = (active: boolean) => ({
    paddingHorizontal: 16 as const,
    paddingVertical: 6 as const,
    borderRadius: 8 as const,
    borderWidth: 1 as const,
    borderColor: 'transparent' as const,
    ...(active ? {
      backgroundColor: theme.colors.surface,
      elevation: 2,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
    } : {}),
  });

  return (
    <View style={{ marginBottom: 16 }}>
      {/* Section heading with tab switcher */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingHorizontal: 4 }}>
        <Text variant="titleLarge" style={{ fontWeight: '800', color: theme.colors.onSurface }}>
          {t('performanceProfileTitle')}
        </Text>
        <View style={{ flexDirection: 'row', backgroundColor: theme.colors.surfaceVariant, borderRadius: 12, padding: 4 }}>
          <TouchableOpacity onPress={() => setActiveTab('profile')} style={tabStyle(activeTab === 'profile')}>
            <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: activeTab === 'profile' ? theme.colors.primary : theme.colors.onSurfaceVariant }}>
              {t('tabProfile').toUpperCase()}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setActiveTab('history')} style={tabStyle(activeTab === 'history')}>
            <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: activeTab === 'history' ? theme.colors.primary : theme.colors.onSurfaceVariant }}>
              {t('tabHistory').toUpperCase()}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <Surface style={{ borderRadius: 16, overflow: 'hidden', backgroundColor: theme.colors.surface }} elevation={1}>
        <View style={{ padding: 16 }}>
          {loading ? (
            <ActivityIndicator size="small" style={{ marginVertical: 24 }} />
          ) : activeTab === 'profile' ? (
            <>
              {latestStudentCheckin && indicators.length >= 3 ? (
                <View style={{ marginHorizontal: -8, marginTop: -4, marginBottom: 8 }}>
                  <RadarChartSVG
                    indicators={indicators}
                    studentScores={latestStudentCheckin.scores}
                    coachScores={latestCoachCheckin?.scores}
                    size={chartSize + 8}
                    maxValue={5}
                  />
                </View>
              ) : (
                <View style={{ alignItems: 'center', paddingVertical: 28, gap: 6 }}>
                  <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700', textAlign: 'center' }}>
                    {t('howIsPerformanceGoing')}
                  </Text>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                    {t('rateAcrossFiveDimensions')}
                  </Text>
                </View>
              )}

              {display && profileKey && (
                <View style={{ borderRadius: 10, padding: 12, backgroundColor: display.color + '18', marginBottom: 12 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: display.color }} />
                    <Text variant="labelMedium" style={{ color: display.color, fontWeight: '700' }}>
                      {display.label}
                    </Text>
                  </View>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    {display.message}
                  </Text>
                </View>
              )}

              <Button mode="contained-tonal" icon="plus" compact onPress={() => setShowModal(true)} style={{ alignSelf: 'flex-start', marginTop: 8 }}>
                {t('rateMyselfButton')}
              </Button>
            </>
          ) : (
            <>
              <TrendChart checkins={checkins} indicators={indicators} />
              {checkins.length > 0 && (
                <ScrollView style={{ maxHeight: 260, marginTop: 16 }} nestedScrollEnabled>
                  {checkins.map(c => (
                    <CheckinHistoryRow key={c.id} checkin={c} indicators={indicators} />
                  ))}
                </ScrollView>
              )}
            </>
          )}
        </View>
      </Surface>

      <PerformanceCheckinModal
        visible={showModal}
        indicators={indicators}
        onDismiss={() => setShowModal(false)}
        onSubmit={handleSubmit}
      />
    </View>
  );
};
