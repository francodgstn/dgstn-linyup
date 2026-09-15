import React, { useState } from 'react';
import { StyleSheet, View, TouchableOpacity } from 'react-native';
import { Card, Text, useTheme, Icon } from 'react-native-paper';
import { AttendanceCalendar } from './AttendanceCalendar';
import { TrainingChart } from './TrainingChart';
import { useTranslations } from '../i18n';

interface TrainingActivityProps {
  contactId: string;
  teamId?: string;
  contact?: import('../types').Contact | null;
  /** See AttendanceCalendar's `onBookingsChanged`. */
  onBookingsChanged?: () => void;
}

export const TrainingActivity: React.FC<TrainingActivityProps> = ({
  contactId,
  teamId,
  contact,
  onBookingsChanged,
}) => {
  const theme = useTheme();
  const t = useTranslations('Training');
  const [activeTab, setActiveTab] = useState<'CALENDAR' | 'STATS'>('CALENDAR');

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text variant="titleLarge" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>{t('trainingActivity')}</Text>
        <View style={[styles.tabContainer, { backgroundColor: theme.colors.surfaceVariant }]}>
          <TouchableOpacity
            onPress={() => setActiveTab('CALENDAR')}
            style={[
              styles.tabButton,
              activeTab === 'CALENDAR' && styles.activeTabButton,
              {
                borderColor: activeTab === 'CALENDAR' ? theme.colors.primary : 'transparent',
                backgroundColor: activeTab === 'CALENDAR' ? theme.colors.surface : 'transparent'
              }
            ]}
          >
            <Text style={[
              styles.tabText,
              { color: activeTab === 'CALENDAR' ? theme.colors.primary : theme.colors.onSurfaceVariant }
            ]}>{t('tabCalendar').toUpperCase()}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setActiveTab('STATS')}
            style={[
              styles.tabButton,
              activeTab === 'STATS' && styles.activeTabButton,
              {
                borderColor: activeTab === 'STATS' ? theme.colors.primary : 'transparent',
                backgroundColor: activeTab === 'STATS' ? theme.colors.surface : 'transparent'
              }
            ]}
          >
            <Text style={[
              styles.tabText,
              { color: activeTab === 'STATS' ? theme.colors.primary : theme.colors.onSurfaceVariant }
            ]}>{t('tabStats').toUpperCase()}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Card style={[styles.card, { backgroundColor: theme.colors.surface }]}>
        <Card.Content style={styles.cardContent}>
          {activeTab === 'CALENDAR' ? (
            <AttendanceCalendar contactId={contactId} teamId={teamId} contact={contact} onBookingsChanged={onBookingsChanged} />
          ) : (
            <TrainingChart contactId={contactId} teamId={teamId} />
          )}
        </Card.Content>
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
    alignItems: 'center',
    marginBottom: 16,
  },
  headerTitle: {
    fontWeight: '800',
    color: '#0F172A',
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    padding: 4,
  },
  tabButton: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  activeTabButton: {
    backgroundColor: '#FFFFFF',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  tabText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  card: {
    borderRadius: 24,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  cardContent: {
    padding: 24,
  },
});
