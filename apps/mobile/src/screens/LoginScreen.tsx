import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Alert, Linking, View, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, TextInput as RNTextInput } from 'react-native';
import {
  Button,
  Card,
  Checkbox,
  HelperText,
  Text,
  TextInput,
  TouchableRipple,
  useTheme
} from 'react-native-paper';
import { useNavigation } from '@react-navigation/native';
import { looksLikeEmail } from '../utils/email';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../contexts/AuthContext';
import { useTranslations } from '../i18n';
import { RootStackParamList } from '../navigation/AppNavigator';
import { LoadingOverlay } from '../components/LoadingOverlay';
import { GradientBackground } from '../components/GradientBackground';
import { webAppUrl } from '../config/firebase';

type LoginScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Login'>;
type LoginStep = 'email' | 'code' | 'team-selection' | 'contact-selection';

export const LoginScreen: React.FC = () => {
  const theme = useTheme();
  const t = useTranslations('Login');
  const [step, setStep] = useState<LoginStep>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stayLoggedIn, setStayLoggedIn] = useState(true);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const {
    sendCode,
    verifyCode,
    isLoading,
    matchedContacts,
    teamSummaries,
    selectContact,
    isAuthenticated,
    appNotIncludedTeams,
    clearAppNotIncluded,
  } = useAuth();
  const navigation = useNavigation<LoginScreenNavigationProp>();

  // Navigate to Profile screen when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      navigation.reset({
        index: 0,
        routes: [{ name: 'Profile' }],
      });
    }
  }, [isAuthenticated, navigation]);

  useEffect(() => {
    // If we have matched contacts but no authenticated contact, jump to selection
    if (matchedContacts && matchedContacts.length > 0 && !isAuthenticated) {
      if (multipleTeamsAvailable) {
        setStep('team-selection');
      } else {
        if (matchedContacts[0].teamId) {
          setSelectedTeamId(matchedContacts[0].teamId);
        }
        setStep('contact-selection');
      }
    }
  }, []);

  useEffect(() => {
    if (step !== 'code') {
      return;
    }

    if (!matchedContacts || matchedContacts.length === 0) {
      return;
    }

    const uniqueTeamIds = Array.from(
      new Set(
        matchedContacts
          .map((contact) => contact.teamId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      )
    );

    if (uniqueTeamIds.length > 1) {
      setSelectedTeamId('');
      setStep('team-selection');
      return;
    }

    if (uniqueTeamIds.length === 1) {
      setSelectedTeamId(uniqueTeamIds[0]);
    }
    setStep('contact-selection');
  }, [matchedContacts, step]);

  // Studio names come from `sendContactVerificationCode`'s teamSummaries —
  // the teams THIS email belongs to, named by the server. (The app used to read
  // every public_profile mirror on the platform for this, on every mount.)
  const teamNameMap = useMemo(() => {
    const map = new Map<string, string>();
    teamSummaries?.forEach((summary) => {
      if (summary.id) {
        map.set(summary.id, summary.name);
      }
    });
    return map;
  }, [teamSummaries]);

  const resolveTeamName = (teamId?: string | null) => {
    if (!teamId) {
      return t('defaultTeamName');
    }
    return teamNameMap.get(teamId) || t('defaultTeamName');
  };

  const teamOptions = useMemo(() => {
    const counts = new Map<string, number>();

    matchedContacts?.forEach((contact) => {
      const id = contact.teamId || '';
      if (!id) {
        return;
      }
      counts.set(id, (counts.get(id) || 0) + 1);
    });

    teamSummaries?.forEach((summary) => {
      if (summary.id && !counts.has(summary.id)) {
        counts.set(summary.id, 0);
      }
    });

    return Array.from(counts.entries()).map(([id, count]) => ({
      id,
      name: teamNameMap.get(id) || t('defaultTeamName'),
      contactCount: count
    }));
  }, [matchedContacts, teamSummaries, teamNameMap, t]);

  const filteredContacts = useMemo(() => {
    if (!matchedContacts) {
      return [];
    }

    if (selectedTeamId) {
      return matchedContacts.filter((contact) => contact.teamId === selectedTeamId);
    }

    return matchedContacts;
  }, [matchedContacts, selectedTeamId]);

  const multipleTeamsAvailable = useMemo(() => {
    if (!matchedContacts) {
      return false;
    }
    const uniqueTeamIds = new Set(
      matchedContacts
        .map((contact) => contact.teamId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    );
    return uniqueTeamIds.size > 1;
  }, [matchedContacts]);

  const codeInputRef = useRef<RNTextInput>(null);
  const autoSubmittedRef = useRef(false);

  const handleVerifyCode = useCallback(async () => {
    if (!code.trim() || code.length !== 6) {
      Alert.alert(t('errorTitle'), t('invalidCodeMessage'));
      return;
    }

    const result = await verifyCode(code.trim(), stayLoggedIn);
    if (result.success) {
      // AuthContext will automatically set contact and isAuthenticated
    } else {
      Alert.alert(t('errorTitle'), result.error || t('invalidCode'));
      setCode('');
      codeInputRef.current?.focus();
    }
  }, [code, verifyCode, stayLoggedIn, t]);

  // Auto-submit when all 6 digits are entered
  useEffect(() => {
    if (code.length === 6 && !autoSubmittedRef.current && !isLoading) {
      autoSubmittedRef.current = true;
      handleVerifyCode();
    }
    if (code.length < 6) {
      autoSubmittedRef.current = false;
    }
  }, [code, isLoading, handleVerifyCode]);

  // Once a studio has been chosen, a re-sent code is requested FOR that studio:
  // the server then scopes the match, the rate limit and the email's branding
  // to it, instead of the cross-team lookup the first request has to make.
  const handleSendCode = async (teamId?: string) => {
    if (!email.trim()) {
      Alert.alert(t('errorTitle'), t('enterEmail'));
      return;
    }
    // A malformed address must not reach the server: the callable answers a
    // code request without saying whether the address exists (by design), so
    // "name@" would land on the code screen waiting for mail that cannot come.
    if (!looksLikeEmail(email)) {
      Alert.alert(t('errorTitle'), t('invalidEmail'));
      return;
    }

    const result = await sendCode(email.trim(), teamId || undefined);
    if (result.success) {
      setStep('code');
      setCode('');
      setSelectedTeamId(teamId ?? '');
    } else {
      Alert.alert(t('errorTitle'), result.error || t('sendCodeFailed'));
    }
  };

  const handleSelectContact = async (contactId: string) => {
    const result = await selectContact(contactId, stayLoggedIn);
    if (!result.success) {
      Alert.alert(t('errorTitle'), result.error || t('selectContactFailed'));
    }
  };

  const handleTeamSelection = (teamId: string) => {
    setSelectedTeamId(teamId);
    setStep('contact-selection');
  };

  const handleBackToTeams = () => {
    setSelectedTeamId('');
    setStep('team-selection');
  };

  const renderHeader = (title: string, subtitle: string) => (
    <View style={styles.header}>
      <Text variant="headlineMedium" style={styles.headerTitle}>{title}</Text>
      <Text variant="bodyMedium" style={[styles.headerSubtitle, { color: theme.colors.onSurfaceVariant }]}>{subtitle}</Text>
    </View>
  );

  const renderStayLoggedIn = () => (
    <TouchableRipple
      onPress={() => setStayLoggedIn(!stayLoggedIn)}
      style={styles.checkboxContainer}
      disabled={isLoading}
    >
      <View style={styles.checkboxRow}>
        <Checkbox.Android
          status={stayLoggedIn ? 'checked' : 'unchecked'}
          onPress={() => setStayLoggedIn(!stayLoggedIn)}
          disabled={isLoading}
          color={theme.colors.primary}
        />
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
          {t('stayLoggedIn')}
        </Text>
      </View>
    </TouchableRipple>
  );

  const handleBackFromAppNotIncluded = () => {
    clearAppNotIncluded();
    setStep('email');
    setEmail('');
    setCode('');
  };

  const handleOpenSpace = (slug: string | null) => {
    if (!slug) return;
    Linking.openURL(`${webAppUrl}/public/${slug}/space`).catch(() => undefined);
  };

  // Every matched contact existed, but none of their teams' plans include the
  // member app — shown instead of falling through to the generic invalid-code
  // path, which would be a confusing "no account" message for a real account
  // behind a plan wall. Named per team so a member on several teams sees
  // exactly which studio(s) are not included yet.
  if (appNotIncludedTeams) {
    return (
      <GradientBackground>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.container}
        >
          <ScrollView contentContainerStyle={styles.centeredContent}>
            {renderHeader(
              t('notIncludedTitle'),
              appNotIncludedTeams.length === 1
                ? t('notIncludedSingle', { team: appNotIncludedTeams[0].teamName ?? t('yourStudioFallback') })
                : t('notIncludedMultiple')
            )}

            {appNotIncludedTeams.map((team) => (
              <Card key={team.teamId} style={styles.contactCard} mode="contained">
                <Card.Content>
                  <Text variant="titleMedium">{team.teamName ?? t('studioFallback')}</Text>
                  <Text
                    variant="bodySmall"
                    style={[styles.teamMeta, { color: theme.colors.onSurfaceVariant }]}
                  >
                    {t('askUpgrade')}
                  </Text>
                  {team.slug ? (
                    <Button
                      mode="text"
                      compact
                      onPress={() => handleOpenSpace(team.slug)}
                      style={styles.inlineButton}
                    >
                      {t('openWebSpace')}
                    </Button>
                  ) : null}
                </Card.Content>
              </Card>
            ))}

            <Button mode="text" onPress={handleBackFromAppNotIncluded}>
              {t('backToSignIn')}
            </Button>
          </ScrollView>
        </KeyboardAvoidingView>
      </GradientBackground>
    );
  }

  if (step === 'email') {
    return (
      <GradientBackground>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        <ScrollView contentContainerStyle={styles.centeredContent} keyboardShouldPersistTaps="handled">
          {/* No studio is known yet at this step (email entry precedes any
              team lookup), so this always reads "Linyup" — never HMD's old
              hardcoded "Linyup Member". "Linyup" is the brand name, never
              translated. */}
          {renderHeader('Linyup', t('emailSubtitle'))}

          <TextInput
            mode="outlined"
            label={t('emailLabel')}
            placeholder={t('emailPlaceholder')}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            disabled={isLoading}
            style={styles.paperInput}
            testID="login-email"
          />

          <Button
            mode="contained"
            onPress={() => handleSendCode()}
            disabled={isLoading}
            style={styles.primaryButton}
            loading={isLoading}
            testID="login-send"
          >
            {t('sendCode')}
          </Button>

          <Text variant="bodySmall" style={[styles.infoText, { color: theme.colors.onSurfaceVariant }]}>
            {t('emailHelp')}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
      </GradientBackground>
    );
  }

  if (step === 'code') {
    const digits = code.split('');
    return (
      <GradientBackground>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        <ScrollView contentContainerStyle={styles.centeredContent} keyboardShouldPersistTaps="handled">
          {renderHeader(t('verifyCodeTitle'), t('verifyCodeSubtitle', { email }))}

          <View
            style={styles.pinContainer}
            onTouchEnd={() => codeInputRef.current?.focus()}
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <View
                key={i}
                style={[
                  styles.pinCell,
                  {
                    borderColor: i === digits.length
                      ? theme.colors.primary
                      : digits[i]
                        ? theme.colors.outline
                        : theme.colors.outlineVariant,
                    backgroundColor: theme.colors.surface
                  }
                ]}
              >
                <Text variant="headlineMedium" style={styles.pinDigit}>
                  {digits[i] || ''}
                </Text>
              </View>
            ))}
            <RNTextInput
              ref={codeInputRef}
              value={code}
              onChangeText={(text) => setCode(text.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
              editable={!isLoading}
              style={styles.hiddenInput}
              caretHidden
              testID="login-code"
            />
          </View>

          {renderStayLoggedIn()}

          {isLoading ? (
            <Button
              mode="contained"
              disabled
              style={styles.primaryButton}
              loading
            >
              {t('verifying')}
            </Button>
          ) : (
            <Button
              mode="contained"
              onPress={handleVerifyCode}
              disabled={code.length !== 6}
              style={styles.primaryButton}
            >
              {t('verifyCodeButton')}
            </Button>
          )}

          <Button
            mode="text"
            onPress={() => handleSendCode(selectedTeamId)}
            disabled={isLoading}
            testID="login-resend"
          >
            {t('sendNewCode')}
          </Button>

          <Button
            mode="text"
            onPress={() => { setStep('email'); setCode(''); }}
            disabled={isLoading}
          >
            {t('backToEmail')}
          </Button>

          <Text variant="bodySmall" style={[styles.infoText, { color: theme.colors.onSurfaceVariant }]}>
            {t('codeExpires')}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
      </GradientBackground>
    );
  }

  if (step === 'team-selection') {
    return (
      <GradientBackground>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        <ScrollView contentContainerStyle={styles.content}>
          {renderHeader(
            t('chooseTeamTitle'),
            t('chooseTeamSubtitle')
          )}

          {teamOptions.length > 0 ? (
            teamOptions.map((team) => (
              <Card
                key={team.id}
                style={styles.contactCard}
                onPress={() => handleTeamSelection(team.id)}
                mode="contained"
              >
                <Card.Content>
                  <Text variant="titleLarge">{team.name}</Text>
                  <Text variant="bodyMedium" style={[styles.teamMeta, { color: theme.colors.onSurfaceVariant }]}>
                    {team.contactCount > 0
                      ? team.contactCount === 1
                        ? t('contactAvailableOne')
                        : t('contactsAvailable', { count: team.contactCount })
                      : t('noSavedContacts')}
                  </Text>
                </Card.Content>
              </Card>
            ))
          ) : (
            <HelperText type="info" visible>
              {t('noLinkedTeams')}
            </HelperText>
          )}

          <Button
            mode="text"
            onPress={() => setStep('code')}
            disabled={isLoading}
          >
            {t('backToCode')}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
      </GradientBackground>
    );
  }

  if (step === 'contact-selection' && matchedContacts) {
    return (
      <GradientBackground>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.container}
        >
          <ScrollView contentContainerStyle={styles.content}>
            {renderHeader(
              t('selectContactTitle'),
              multipleTeamsAvailable && selectedTeamId
                ? t('contactsForTeam', { team: resolveTeamName(selectedTeamId) })
                : t('multipleContactsFound')
            )}

            {multipleTeamsAvailable && (
              <Button
                mode="text"
                onPress={handleBackToTeams}
                style={styles.inlineButton}
                disabled={isLoading}
              >
                {t('changeTeam')}
              </Button>
            )}

            {filteredContacts.length > 0 ? (
              filteredContacts.map((contact) => {
                const phoneDisplay = contact.phone?.trim();

                return (
                  <Card
                    key={contact.id}
                    style={[styles.contactCard, isLoading && { opacity: 0.6 }]}
                    onPress={() => handleSelectContact(contact.id)}
                    mode="contained"
                    disabled={isLoading}
                  >
                    <Card.Content>
                      <Text variant="titleLarge">
                        {`${contact.firstname || ''} ${contact.lastname || ''}`.trim()}
                      </Text>
                      {phoneDisplay ? (
                        <Text variant="bodyMedium" style={[styles.contactPhone, { color: theme.colors.onSurfaceVariant }]}>{phoneDisplay}</Text>
                      ) : null}
                      <Text variant="bodySmall" style={[styles.teamMeta, { color: theme.colors.onSurfaceVariant }]}>
                        {resolveTeamName(contact.teamId)}
                      </Text>
                    </Card.Content>
                  </Card>
                );
              })
            ) : (
              <HelperText type="info" visible>
                {t('noContactsForTeam')}
              </HelperText>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
        <LoadingOverlay visible={isLoading} message={t('signingIn')} />
      </GradientBackground>
    );
  }

  return null;
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 60,
    paddingBottom: 32,
  },
  centeredContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingBottom: 80,
  },
  header: {
    marginBottom: 24,
    alignItems: 'center',
  },
  headerTitle: {
    fontWeight: 'bold',
  },
  headerSubtitle: {
    textAlign: 'center',
    marginTop: 8,
  },
  paperInput: {
    marginBottom: 16,
  },
  primaryButton: {
    marginTop: 8,
  },
  card: {
    marginBottom: 16,
  },
  contactCard: {
    marginBottom: 12,
  },
  contactPhone: {
    marginTop: 4,
  },
  teamMeta: {
    marginTop: 6,
  },
  inlineButton: {
    alignSelf: 'flex-start',
    marginBottom: 12,
    paddingHorizontal: 0,
  },
  infoText: {
    marginTop: 16,
    textAlign: 'center',
    lineHeight: 18,
  },
  pinContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginVertical: 16,
    position: 'relative',
  },
  pinCell: {
    width: 44,
    height: 56,
    borderWidth: 2,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinDigit: {
    fontWeight: '600',
  },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    width: '100%',
    height: '100%',
    zIndex: 1,
  },
  checkboxContainer: {
    marginVertical: 12,
    borderRadius: 8,
    alignSelf: 'center',
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 16,
    paddingLeft: 4,
  },
});
