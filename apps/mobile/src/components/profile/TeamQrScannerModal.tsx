import React, { useEffect } from 'react';
import { Linking, Modal, StyleSheet, View } from 'react-native';
import { Button, IconButton, Text, useTheme, ActivityIndicator } from 'react-native-paper';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useTranslations } from '../../i18n';

interface TeamQrScannerModalProps {
  visible: boolean;
  onClose: () => void;
  onScan: (teamSlug: string) => void;
}

export const TeamQrScannerModal: React.FC<TeamQrScannerModalProps> = ({
  visible,
  onClose,
  onScan,
}) => {
  const theme = useTheme();
  const t = useTranslations('QrScanner');
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = React.useRef(false);

  // Reset scanned flag when modal opens
  useEffect(() => {
    if (visible) {
      scannedRef.current = false;
    }
  }, [visible]);

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (scannedRef.current) return;
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed?.team === 'string' && parsed.team.length > 0) {
        scannedRef.current = true;
        onScan(parsed.team);
      }
    } catch {
      // Not a valid team QR — ignore and keep scanning
    }
  };

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.header}>
          <Text variant="titleLarge" style={{ color: theme.colors.onSurface }}>
            {t('scanStudioQr')}
          </Text>
          <IconButton icon="close" size={24} onPress={onClose} />
        </View>

        {!permission ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : !permission.granted ? (
          // App Review 5.1.1(iv): the pre-prompt explains and moves on with a
          // neutral "Continue" — never "Grant"/"Allow", which reads as steering
          // the user's answer. Once iOS stops asking (canAskAgain false),
          // requestPermission is a no-op, so offer Settings instead.
          <View style={styles.center}>
            <Text
              variant="bodyMedium"
              style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginBottom: 20 }}
            >
              {permission.canAskAgain ? t('cameraPermissionBody') : t('cameraDeniedBody')}
            </Text>
            {permission.canAskAgain ? (
              <Button mode="contained" onPress={requestPermission}>
                {t('continue')}
              </Button>
            ) : (
              <Button mode="outlined" onPress={() => { Linking.openSettings().catch(() => undefined); }}>
                {t('openSettings')}
              </Button>
            )}
          </View>
        ) : (
          <View style={styles.cameraContainer}>
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleBarCodeScanned}
            />
            <View style={styles.overlay}>
              <View style={[styles.scanFrame, { borderColor: theme.colors.primary }]} />
            </View>
            <Text
              variant="bodyMedium"
              style={[styles.hint, { color: '#ffffff' }]}
            >
              {t('pointCamera')}
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 12,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  cameraContainer: {
    flex: 1,
    position: 'relative',
  },
  camera: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanFrame: {
    width: 220,
    height: 220,
    borderWidth: 3,
    borderRadius: 16,
    backgroundColor: 'transparent',
  },
  hint: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingVertical: 8,
  },
});
