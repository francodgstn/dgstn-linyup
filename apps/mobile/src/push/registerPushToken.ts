// Push, present but ASLEEP.
//
// WHY THIS EXISTS BEFORE ANYTHING SENDS. `expo-notifications` is a NATIVE
// module, and app.config.js sets `runtimeVersion.policy: 'fingerprint'` — so
// adding it changes the fingerprint and forces a store build, which takes days
// and cannot be un-shipped. Everything ABOVE the native layer is JS and reaches
// every install over the air. Landing the capability now, inert, means the
// first notification we ever decide to send is an OTA update rather than a
// release train.
//
// THAT IS TRUE OF iOS ONLY, TODAY. The APNs key lives on Expo's servers, so
// switching iOS on really is a JS change. ANDROID IS NOT: FCM reads
// `google-services.json` at BUILD time, the repo has none, and `app.config.js`
// sets no `android.googleServicesFile` — so `getExpoPushTokenAsync` fails on
// Android and no OTA can fix it. Enabling notifications today would reach
// iPhones and silently skip every Android device.
//
// PARKED until after the store review (2026-09-04), deliberately: wiring it
// needs a Firebase Android app per PROJECT — the file is baked into the binary
// and is project-specific, unlike the JS firebaseConfig this app switches by
// env — plus an FCM V1 key on EAS, and it must be in the build BEFORE the store
// build that ships. Whoever flips the switch: check this first, or the flip is
// half a feature.
//
// SO THIS NEVER ASKS. `registerPushTokenIfAllowed` reads the permission and
// stops if it is anything but already-granted — it does not call
// `requestPermissionsAsync`, so a member sees no system dialog they have no
// context for, and we do not burn the ONE undetermined→denied decision iOS
// gives us before the studio has ever explained why. Flipping that on later is
// a JS change. On a fresh install the permission is undetermined, so in
// practice this is a no-op today; it is written this way so that it is
// CORRECT rather than merely idle, and so the path is exercised by anyone who
// grants notifications from Settings.
//
// It also never throws. A member's session, their bookings and their check-in
// must not depend on a notification service being reachable.

import { Platform } from 'react-native'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import Constants from 'expo-constants'
import { doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { db } from '../config/firebase'
import { CONTACTS_COLLECTION, CONTACT_PUSH_TOKENS_SUBCOLLECTION } from '@linyup/shared'


/** Android needs a channel to exist before anything can be delivered to it.
 *  Creating it is free, silent, and does NOT prompt — so it happens now rather
 *  than on the day the first notification is sent. */
async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Linyup',
    importance: Notifications.AndroidImportance.DEFAULT,
  })
}

/**
 * Register this device's push token — but ONLY if the member has already
 * granted permission. Returns the token when one was stored, else null.
 *
 * The doc id IS the token (see PushToken in @linyup/shared): a device
 * re-registers on foreground and on every permission change, so this is a
 * self-correcting `set()` rather than a growing pile of duplicates for one
 * phone.
 */
export async function registerPushTokenIfAllowed(
  contactId: string,
  teamId: string
): Promise<string | null> {
  try {
    // A simulator cannot receive a push and cannot mint a token; asking anyway
    // throws, which would make every emulator run log a scary error for a
    // feature that is deliberately doing nothing yet.
    if (!Device.isDevice) return null

    const { status } = await Notifications.getPermissionsAsync()
    if (status !== 'granted') return null

    await ensureAndroidChannel()

    // The EAS project id is what mints an Expo push token; without it (a bare
    // dev client, or a checkout with no EAS link) there is nothing to register.
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
    if (!projectId) return null

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId })
    if (!token) return null

    await setDoc(
      doc(db, CONTACTS_COLLECTION, contactId, CONTACT_PUSH_TOKENS_SUBCOLLECTION, token),
      {
        token,
        teamId,
        kind: 'expo',
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        app_version: Constants.expoConfig?.version ?? null,
        runtime_version:
          typeof Constants.expoConfig?.runtimeVersion === 'string'
            ? Constants.expoConfig.runtimeVersion
            : null,
        created_at: serverTimestamp(),
        last_seen_at: serverTimestamp(),
      },
      // MERGE, so a re-registration refreshes `last_seen_at` without resetting
      // `created_at` — how long a device has been reachable is worth keeping.
      { merge: true }
    )
    return token
  } catch {
    // Deliberately silent. Nothing in the app is waiting on this, and a member
    // has no action to take about it.
    return null
  }
}
