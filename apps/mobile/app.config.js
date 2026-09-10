/**
 * Expo dynamic configuration — Linyup mobile app
 *
 * Firebase environment is determined by FIREBASE_PROJECT_ID.
 * Only FIREBASE_API_KEY needs to be provided via environment.
 *
 * Usage:
 *   pnpm start                -> loads .env.staging    (linyup-staging — the default target)
 *   pnpm run start:prod       -> loads .env.production (linyup-prod)
 *   pnpm run start:emulators  -> demo-linyup + the local emulators; the emulator PORTS
 *                                come from .env.local (EXPO_PUBLIC_*_EMULATOR_PORT, written
 *                                by scripts/local-env.mjs for this checkout's port slot)
 *
 * Expo loads .env / .env.local itself before this file runs; the dotenv-cli
 * prefix in package.json only adds the per-target file on top.
 */
const { version } = require('./package.json')

// Terraform provisions the `<project>.firebasestorage.app` bucket naming
// scheme for every real project; the emulator project keeps the legacy
// `.appspot.com` form (the emulator never validates it against a real bucket).
const environments = {
  'demo-linyup': {
    authDomain: 'demo-linyup.firebaseapp.com',
    databaseURL: 'https://demo-linyup.firebaseio.com',
    projectId: 'demo-linyup',
    storageBucket: 'demo-linyup.appspot.com',
    messagingSenderId: 'demo',
    webAppUrl: 'http://localhost:3000',
  },
  'linyup-staging': {
    authDomain: 'linyup-staging.firebaseapp.com',
    databaseURL: 'https://linyup-staging.firebaseio.com',
    projectId: 'linyup-staging',
    storageBucket: 'linyup-staging.firebasestorage.app',
    messagingSenderId: '157648925506',
    webAppUrl: 'https://app-stg.linyup.com',
  },
  'linyup-sandbox': {
    authDomain: 'linyup-sandbox.firebaseapp.com',
    databaseURL: 'https://linyup-sandbox.firebaseio.com',
    projectId: 'linyup-sandbox',
    storageBucket: 'linyup-sandbox.firebasestorage.app',
    messagingSenderId: '', // TODO: set from Firebase console
    webAppUrl: 'https://demo.linyup.com',
  },
  'linyup-prod': {
    authDomain: 'linyup-prod.firebaseapp.com',
    databaseURL: 'https://linyup-prod.firebaseio.com',
    projectId: 'linyup-prod',
    storageBucket: 'linyup-prod.firebasestorage.app',
    messagingSenderId: '576514050360',
    webAppUrl: 'https://app.linyup.com',
  },
}

// ── App variants — the white-label seam, deliberately ONE entry ──────────────
// A studio's look is a RUNTIME concern (src/utils/tenantTheme.ts re-themes the
// app from the studio's public profile after sign-in). What a runtime theme
// cannot change is the store listing: name, icon, bundle id, scheme — and
// behind those, an App Store Connect record and a Play listing, i.e. developer
// accounts per organisation (docs/mobile-roadmap-2026-09.md §5). That is the
// only thing an org-branded variant would add, so it is the only thing this
// map holds. Adding one = a second entry with its own assets + its own EAS
// project/credentials; nothing in src/ changes. Until then `APP_VARIANT` is
// unset and this resolves to Linyup.
const VARIANTS = {
  linyup: {
    name: 'Linyup',
    slug: 'linyup',
    scheme: 'linyup',
    bundleId: 'com.dgstn.linyup',
    icon: './assets/icon.png',
    adaptiveIcon: './assets/adaptive-icon.png',
    // Foreground is a white swoosh on transparency — bg must be brand purple
    adaptiveIconBackground: '#6d28d9',
    splash: './assets/splash-icon.png',
    favicon: './assets/favicon.png',
  },
}

export default ({ config }) => {
  const variantId = process.env.APP_VARIANT || 'linyup'
  const variant = VARIANTS[variantId]
  if (!variant) {
    throw new Error(`Unknown APP_VARIANT: ${variantId} (known: ${Object.keys(VARIANTS).join(', ')})`)
  }

  // Default to the local emulator project (demo-linyup) when no real API key is
  // provided — lets `pnpm start` run against the Firebase emulators with no real
  // Firebase project. EAS staging/prod builds set FIREBASE_API_KEY + FIREBASE_PROJECT_ID.
  const hasRealKey = !!process.env.FIREBASE_API_KEY
  const projectId = process.env.FIREBASE_PROJECT_ID || (hasRealKey ? 'linyup-staging' : 'demo-linyup')
  const envConfig = environments[projectId]

  if (!envConfig) {
    throw new Error(`Unknown FIREBASE_PROJECT_ID: ${projectId}`)
  }

  const useEmulators =
    projectId === 'demo-linyup' || process.env.EXPO_PUBLIC_USE_EMULATORS === 'true'

  // A real project with no key would run against it with the placeholder below
  // and fail later, as auth/invalid-api-key, with nothing to say which env file
  // was wrong. Refuse here, where the fix can be named. (CI's config check and
  // the EAS environments both set a key; the emulator needs none.)
  if (!hasRealKey && !useEmulators) {
    throw new Error(
      `FIREBASE_API_KEY is empty for ${projectId}. Set it in apps/mobile/.env.${
        projectId === 'linyup-prod' ? 'production' : 'staging'
      } (template: apps/mobile/.env.example; EAS builds: the environment's variables), ` +
        'or run `pnpm dev:mobile:emulators` for the local stack.'
    )
  }

  // Where the emulators listen, from the app's point of view. Slot 0 is the
  // documented default; a worktree on slot N gets N×10000 added (local-env).
  const emulatorPort = (name, fallback) => {
    const raw = process.env[`EXPO_PUBLIC_${name}_EMULATOR_PORT`]
    const n = Number(raw)
    return raw && Number.isInteger(n) && n > 0 ? n : fallback
  }
  const emulatorPorts = {
    firestore: emulatorPort('FIRESTORE', 8080),
    auth: emulatorPort('AUTH', 9099),
    functions: emulatorPort('FUNCTIONS', 5001),
  }

  const { webAppUrl, ...envFirebaseConfig } = envConfig

  const firebaseConfig = {
    ...envFirebaseConfig,
    // The Auth/Firestore emulators don't validate the key; a non-empty placeholder
    // avoids the SDK throwing auth/invalid-api-key in local dev.
    apiKey: process.env.FIREBASE_API_KEY || 'demo-api-key',
  }

  // `eas init` created @francodagostino/linyup and printed this id. The config is
  // dynamic, so EAS cannot write it itself — it lives here. The env override stays:
  // CI, or a second account, can still redirect a build at another project — `||`
  // rather than `??` because the env templates ship an EMPTY `EAS_PROJECT_ID=`,
  // and an empty string is not nullish: `??` would silently disable OTA.
  const easProjectId = process.env.EAS_PROJECT_ID || 'f941b285-002a-4bdb-8c42-8c3e5edfab66'

  return {
    ...config,
    name: variant.name,
    slug: variant.slug,
    version,
    orientation: 'portrait',
    icon: variant.icon,
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    scheme: variant.scheme,
    runtimeVersion: {
      policy: 'fingerprint',
    },
    updates: easProjectId
      ? {
          url: `https://u.expo.dev/${easProjectId}`,
        }
      : undefined,
    plugins: [
      'expo-updates',
      '@react-native-community/datetimepicker',
      [
        'expo-camera',
        {
          cameraPermission: "Linyup uses the camera only to scan your studio's check-in QR code.",
          microphonePermission: false,
          recordAudioAndroid: false,
        },
      ],
      // Notifications are present but ASLEEP. Nothing prompts and nothing sends
      // (see src/push/registerPushToken.ts) — this entry exists so the native
      // capability ships once, in a store build, and every decision afterwards
      // (when to ask, what is worth interrupting somebody for, what a tap opens)
      // is JS and reaches every install over the air. Adding it later instead
      // would put a store build and its review queue in front of the first
      // notification we ever want to send.
      'expo-notifications',
    ],
    splash: {
      image: variant.splash,
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
    },
    ios: {
      // FALSE deliberately. Declaring iPad support obliges Apple's listing to
      // carry a full iPad screenshot set, forever, on every listing update —
      // and the member app is a phone app: a QR check-in scanner, a booking
      // list, a profile. Nothing here wants a tablet canvas. Turning this on
      // later is a one-line change plus that screenshot set.
      supportsTablet: false,
      bundleIdentifier: variant.bundleId,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: variant.adaptiveIcon,
        backgroundColor: variant.adaptiveIconBackground,
      },
      package: variant.bundleId,
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      softwareKeyboardLayoutMode: 'resize',
    },
    web: {
      favicon: variant.favicon,
    },
    extra: {
      variant: variantId,
      firebase: firebaseConfig,
      useEmulators,
      emulatorPorts,
      webAppUrl,
      eas: {
        projectId: easProjectId,
      },
    },
  }
}
