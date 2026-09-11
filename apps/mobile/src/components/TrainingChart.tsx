import React, { useState, useEffect, useMemo } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { Text, Chip, useTheme, ActivityIndicator } from 'react-native-paper';
import { LineChart } from 'react-native-gifted-charts';
import { FirestoreService } from '../services/firestore';
import { useTranslations } from '../i18n';

interface TrainingChartProps {
  contactId: string;
  teamId?: string;
  onMonthPress?: (date: Date) => void;
}

export const TrainingChart: React.FC<TrainingChartProps> = ({ contactId, teamId, onMonthPress }) => {
  const theme = useTheme();
  const t = useTranslations('Training');
  const [chartWeeks, setChartWeeks] = useState(26);
  const [attendedSessions, setAttendedSessions] = useState<{ start: Date }[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch real attendance data for the selected range
  useEffect(() => {
    if (!contactId || !teamId) return;

    const loadData = async () => {
      setIsLoading(true);
      try {
        const now = new Date();

        // Calculate end of current week (Sunday)
        const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday...
        const daysToSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
        const endDate = new Date(now);
        endDate.setDate(now.getDate() + daysToSunday);
        endDate.setHours(23, 59, 59, 999);

        // Calculate start date (Monday of chartWeeks ago)
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - (chartWeeks * 7) + 1); // +1 because we want the start of that week
        startDate.setHours(0, 0, 0, 0);

        const sessions = await FirestoreService.getContactAttendance(
          startDate,
          endDate,
          teamId
        );
        setAttendedSessions(sessions);
      } catch (error) {
        console.error('Error loading chart data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [contactId, teamId, chartWeeks]);

  // Build weekly session counts from real attendance data
  const weeklyData = useMemo(() => {
    const weekMap = new Map<string, number>();

    // Generate all week keys for the range
    const now = new Date();
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));

    for (let i = chartWeeks - 1; i >= 0; i--) {
      const d = new Date(monday);
      d.setDate(monday.getDate() - i * 7);
      const key = getIsoWeekKey(d);
      weekMap.set(key, 0);
    }

    // Count attended sessions per week
    attendedSessions.forEach(session => {
      const key = getIsoWeekKey(session.start);
      if (weekMap.has(key)) {
        weekMap.set(key, (weekMap.get(key) || 0) + 1);
      }
    });

    return Array.from(weekMap.entries()).map(([key, count]) => ({
      iso_week: key,
      sessions_count: count,
    }));
  }, [attendedSessions, chartWeeks]);

  // For 6m and 1y views, aggregate weekly data into monthly bins
  const useMonthly = chartWeeks >= 12;
  const monthCount = chartWeeks === 52 ? 12 : 6;
  let chartEntries: { label: string; sessions_count: number; date: Date }[];

  if (useMonthly) {
    const monthMap = new Map<string, number>();
    const now = new Date();
    for (let i = monthCount - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthMap.set(key, 0);
    }
    // Sum actual sessions into months based on their date
    attendedSessions.forEach(session => {
      const d = session.start;
      // Construct key YYYY-MM
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (monthMap.has(monthKey)) {
        monthMap.set(monthKey, (monthMap.get(monthKey) || 0) + 1);
      }
    });
    const monthNames = [
      t('monthJan'), t('monthFeb'), t('monthMar'), t('monthApr'),
      t('monthMay'), t('monthJun'), t('monthJul'), t('monthAug'),
      t('monthSep'), t('monthOct'), t('monthNov'), t('monthDec'),
    ];
    chartEntries = Array.from(monthMap.entries()).map(([key, count]) => {
      const [y, m] = key.split('-').map(Number);
      return {
        label: monthNames[m - 1],
        sessions_count: count,
        date: new Date(y, m - 1, 1),
      };
    });
  } else {
    chartEntries = weeklyData.map(w => ({
      label: w.iso_week.replace(/^\d{4}-W/, t('weekPrefix')),
      sessions_count: w.sessions_count,
      date: new Date(),
    }));
  }

  const totalSessions = chartEntries.reduce((sum, r) => sum + r.sessions_count, 0);
  const chartWidth = Dimensions.get('window').width - 80;
  const showAllLabels = chartEntries.length <= 12;
  const chartData = chartEntries.map((entry, index) => ({
    value: entry.sessions_count,
    label: showAllLabels || index === 0 || index === chartEntries.length - 1
      ? entry.label
      : '',
    dataPointText: entry.sessions_count > 0 ? String(entry.sessions_count) : undefined,
    onPress: onMonthPress && useMonthly ? () => onMonthPress(entry.date) : undefined,
  }));

  const rangeOptions = [
    { label: t('range6mLabel'), value: 26, summary: t('range6mSummary') },
    { label: t('range1yLabel'), value: 52, summary: t('range1ySummary') },
  ];

  const rangeSummary = rangeOptions.find(o => o.value === chartWeeks)?.summary ?? t('weeksFallback', { count: chartWeeks });

  return (
    <View>
      <View style={styles.header}>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {totalSessions === 1
            ? t('sessionsCountOneWithRange', { range: rangeSummary })
            : t('sessionsCountOtherWithRange', { count: totalSessions, range: rangeSummary })}
        </Text>
        <View style={styles.filters}>
          {rangeOptions.map((option) => (
          <Chip
            key={option.value}
            selected={chartWeeks === option.value}
            onPress={() => setChartWeeks(option.value)}
            compact
            mode="flat"
            showSelectedCheck={false}
            style={chartWeeks === option.value
              ? { backgroundColor: theme.colors.primaryContainer }
              : { backgroundColor: theme.colors.surfaceVariant }}
            textStyle={[
              styles.chipText,
              chartWeeks === option.value && { color: theme.colors.onPrimaryContainer }
            ]}
          >
            {option.label}
          </Chip>
          ))}
        </View>
      </View>
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" />
        </View>
      ) : (
        <LineChart
          data={chartData}
          width={chartWidth}
          height={140}
          overflowTop={20}
          spacing={chartWidth / Math.max(chartData.length - 1, 1)}
          initialSpacing={0}
          endSpacing={0}
          color={theme.colors.primary}
          thickness={2}
          dataPointsColor={theme.colors.primary}
          dataPointsRadius={onMonthPress ? 6 : 4}
          textColor={theme.colors.onSurfaceVariant}
          textFontSize={10}
          textShiftY={-8}
          xAxisColor={theme.colors.outlineVariant}
          yAxisColor="transparent"
          hideYAxisText
          hideRules
          curved
          xAxisLabelTextStyle={{ color: theme.colors.onSurfaceVariant, fontSize: 10 }}
          noOfSections={4}
          maxValue={Math.max(...chartEntries.map(r => r.sessions_count), 4)}
          yAxisThickness={0}
          xAxisThickness={1}
          areaChart
          startFillColor={theme.colors.primary}
          startOpacity={0.15}
          endOpacity={0.01}
        />
      )}
    </View>
  );
};

/** Compute ISO week key (YYYY-WXX) for a given date */
function getIsoWeekKey(date: Date): string {
  // Create a copy of the date object to avoid modifying the original
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Set to nearest Thursday: current date + 4 - current day number
  // Make Sunday's day number 7
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  // Get first day of year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));

  // Calculate full weeks to nearest Thursday
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

  // Return YYYY-WXX using the ISO week-numbering year
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  filters: {
    flexDirection: 'row',
    gap: 8,
  },
  chipText: {
    fontSize: 12,
  },
  loadingContainer: {
    height: 140,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
