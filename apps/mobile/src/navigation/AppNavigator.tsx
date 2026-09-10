import React, { useEffect, useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoginScreen } from '../screens/LoginScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { useAuth } from '../contexts/AuthContext';
import { useTenantTheme } from '../contexts/TenantThemeContext';
import { useTheme } from 'react-native-paper';
import { ActivityIndicator, AppState, View, StyleSheet } from 'react-native';
import { FirestoreService } from '../services/firestore';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useAppUpdates } from '../hooks/useAppUpdates';
import { useMinVersionGate } from '../hooks/useMinVersionGate';
import { UpdateRequiredScreen } from '../screens/UpdateRequiredScreen';
import { buildMobileAppTelemetry } from '../utils/mobileAppTelemetry';

export type RootStackParamList = {
  Login: undefined;
  Profile: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export const AppNavigator: React.FC = () => {
  const { isAuthenticated, isInitializing, contact } = useAuth();
  const theme = useTheme();
  const { setBrand } = useTenantTheme();
  const appState = useRef(AppState.currentState);

  // The studio look belongs to a SESSION: once there is none, the app is
  // Linyup's again (the login screen never knows a studio). Not cleared while
  // initialising — a restored session keeps the persisted look from the first
  // frame instead of flashing purple.
  useEffect(() => {
    if (!isInitializing && !isAuthenticated) setBrand(null);
  }, [isInitializing, isAuthenticated, setBrand]);
  const { checkForUpdates } = useAppUpdates();
  // Older than app_settings/mobile.min_supported_version → the update screen
  // instead of the app. Fails open; re-read on every foreground, beside the
  // OTA check, so a raised minimum lands without a restart.
  const minVersion = useMinVersionGate();
  const mobileAppTelemetry = buildMobileAppTelemetry(Constants.expoConfig?.version, {
    runtimeVersion: Updates.runtimeVersion ?? null,
    channel: Updates.channel ?? null,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
    updateId: Updates.updateId ?? null,
  });

  // Update last_seen_at + mobile_app telemetry whenever the app comes to the foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (
        appState.current.match(/inactive|background/) &&
        nextState === 'active'
      ) {
        checkForUpdates();
        minVersion.recheck();
        if (contact?.id) {
          FirestoreService.updateLastSeen(contact.id, mobileAppTelemetry).catch(() => undefined);
        }
      }
      appState.current = nextState;
    });

    // Also record on first mount (app open from cold start)
    checkForUpdates();
    if (contact?.id) {
      FirestoreService.updateLastSeen(contact.id, mobileAppTelemetry).catch(() => undefined);
    }

    return () => subscription.remove();
  }, [contact?.id]);

  if (minVersion.gate) {
    return <UpdateRequiredScreen gate={minVersion.gate} />;
  }

  if (isInitializing) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {/* The top inset needs its own background. It sits OUTSIDE the
          navigator's painted area, so with none it shows the RN root view's
          default WHITE — a white band above a dark app on every notched
          iPhone, in every screenshot. Android never showed it: there the OS
          paints the status bar itself. */}
      <SafeAreaView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        edges={['top']}
      >
        {isAuthenticated ? (
          <Stack.Navigator
            key="authenticated"
            screenOptions={{ headerShown: false }}
          >
            <Stack.Screen name="Profile" component={ProfileScreen} />
          </Stack.Navigator>
        ) : (
          <Stack.Navigator
            key="unauthenticated"
            screenOptions={{ headerShown: false }}
          >
            <Stack.Screen name="Login" component={LoginScreen} />
          </Stack.Navigator>
        )}
      </SafeAreaView>
    </NavigationContainer>
  );
};

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
