import React, { useState, useRef } from 'react';
import {
  Dimensions,
  ScrollView,
  StyleSheet,
  View,
  NativeSyntheticEvent,
  NativeScrollEvent,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import {
  Icon,
  Text,
  TouchableRipple,
  useTheme,
} from 'react-native-paper';
import { ContactAlert } from '../types';
import { withAlpha } from '@linyup/shared';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface AlertsCardProps {
  alerts: ContactAlert[];
}

export const AlertsCard: React.FC<AlertsCardProps> = ({ alerts }) => {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const scrollViewRef = useRef<ScrollView>(null);

  // Early return after all hooks
  if (!alerts || alerts.length === 0) {
    return null;
  }

  const handlePress = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(!expanded);
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    const cardWidth = SCREEN_WIDTH - 32; // Account for container padding
    const newIndex = Math.round(offsetX / cardWidth);
    if (newIndex !== currentIndex && newIndex >= 0 && newIndex < alerts.length) {
      setCurrentIndex(newIndex);
      // Collapse when swiping to a new alert
      if (expanded) {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setExpanded(false);
      }
    }
  };

  // Get alert icon based on type
  const getAlertIcon = (alertType?: string) => {
    switch (alertType) {
      case 'booking':
        return 'calendar-check';
      case 'contact_request':
        return 'account-edit';
      default:
        return 'bell';
    }
  };

  // Check if message needs expansion (roughly 2 lines worth of text)
  const needsExpansion = (message: string) => message.length > 80;

  // Accent color for the alert card (clean alerts)
  const isDark = theme.dark;

  // The studio's own messages, in the studio's colour (the tenant accent) —
  // a "messaging" tint rather than a warning one.
  const alertColor = theme.colors.primary;
  const accentBg = withAlpha(alertColor, isDark ? 0.12 : 0.06);
  const accentBorder = withAlpha(alertColor, isDark ? 0.3 : 0.18);

  const styles = createStyles(theme);

  const renderAlertCard = (alert: ContactAlert, index: number) => {
    const canExpand = needsExpansion(alert.message);
    const isExpanded = expanded && index === currentIndex && canExpand;

    return (
      <View key={alert.id} style={styles.slideContainer}>
        <TouchableRipple
          onPress={canExpand ? handlePress : undefined}
          style={[
            styles.alertCard,
            {
              backgroundColor: accentBg,
              borderColor: accentBorder,
            },
          ]}
          borderless
        >
          <View style={styles.cardContent}>
            <View
              style={[
                styles.iconContainer,
                { backgroundColor: withAlpha(alertColor, isDark ? 0.2 : 0.1) },
              ]}
            >
              <Icon
                source={getAlertIcon(alert.alert_type)}
                size={18}
                color={alertColor}
              />
            </View>
            <View style={styles.messageContainer}>
              <Text
                variant="bodyMedium"
                numberOfLines={isExpanded ? undefined : 2}
                style={[styles.messageText, { color: isDark ? theme.colors.onSurface : theme.colors.onPrimaryContainer, fontWeight: '500' }]}
              >
                {alert.message}
              </Text>
            </View>
            {canExpand && (
              <Icon
                source={isExpanded ? 'chevron-up' : 'chevron-down'}
                size={20}
                color={isDark ? withAlpha(alertColor, 0.6) : alertColor}
              />
            )}
          </View>
        </TouchableRipple>
      </View>
    );
  };

  // Single alert - no scrolling needed
  if (alerts.length === 1) {
    return (
      <View style={styles.container}>
        {renderAlertCard(alerts[0], 0)}
      </View>
    );
  }

  // Multiple alerts - horizontal scroll
  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollViewRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        decelerationRate="fast"
        contentContainerStyle={styles.scrollContent}
      >
        {alerts.map((alert, index) => renderAlertCard(alert, index))}
      </ScrollView>

      {/* Page indicator dots */}
      <View style={styles.pageIndicator}>
        {alerts.map((_, index) => (
          <View
            key={index}
            style={[
              styles.dot,
              {
                backgroundColor:
                  index === currentIndex
                    ? alertColor
                    : isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
                width: index === currentIndex ? 12 : 6,
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
};

const createStyles = (theme: any) =>
  StyleSheet.create({
    container: {
      marginTop: 4,
      marginBottom: 12,
    },
    scrollContent: {
      // No extra padding - cards are full width
    },
    slideContainer: {
      width: SCREEN_WIDTH - 32, // Match parent padding
      paddingHorizontal: 0,
    },
    alertCard: {
      borderRadius: 16,
      borderWidth: 1,
      overflow: 'hidden',
      ...Platform.select({
        ios: {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.1,
          shadowRadius: 4,
        },
        android: {
          elevation: 2,
        },
      }),
    },
    cardContent: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      gap: 12,
    },
    iconContainer: {
      width: 36,
      height: 36,
      borderRadius: 18,
      justifyContent: 'center',
      alignItems: 'center',
    },
    messageContainer: {
      flex: 1,
      justifyContent: 'center',
    },
    messageText: {
      lineHeight: 18,
      fontSize: 14,
    },
    pageIndicator: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      paddingTop: 10,
      gap: 4,
    },
    dot: {
      height: 6,
      borderRadius: 3,
    },
  });

export default AlertsCard;
