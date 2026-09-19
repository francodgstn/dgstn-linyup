import {
  httpsCallable,
  httpsCallableFromURL,
  type HttpsCallable,
  type HttpsCallableOptions,
  type HttpsCallableResult,
} from 'firebase/functions'
import { Platform } from 'react-native'
import Constants from 'expo-constants'
import {
  callableRouteUrl,
  functionsBaseUrl,
  routerForCallable,
  withRouterFallback,
} from '@linyup/shared'
import { getFunctions } from '../config/firebase'

// ─── callFunction ─────────────────────────────────────────────────────────────
//
// The way to reach a callable by NAME, wherever it happens to be served from.
// Callables are being folded into a few domain ROUTER functions — an `onRequest`
// that hands the request to the existing `onCall` value, so auth, App Check and
// error codes stay the SDK's own (`docs/functions-consolidation-plan.md`).
// `CALLABLE_ROUTES` in @linyup/shared says which router serves a name.
//
// A name that is NOT in that table behaves exactly as it did before this file
// existed: `httpsCallable(getFunctions(), name, options)`. Deleting a name from
// the table is therefore the rollback — no edit here, and none at the call site.
// In THIS app the rollback only travels as fast as a bundle does: the table is
// compiled in, so an install keeps the routes it was built with until an OTA or
// a store update reaches it, and a router has to keep serving a name for as long
// as such a build is live.
//
// Region and project come off the instance `config/firebase.ts` made. The
// emulator cannot be inherited — `httpsCallableFromURL` ignores
// `connectFunctionsEmulator` — so the origin is rebuilt from the same inputs
// that file reads: `extra.useEmulators`, `extra.emulatorPorts` (this checkout's
// port slot, resolved in app.config.js) and the Metro host, because on a device
// `localhost` is the phone. `config/firebase.ts` keeps its `resolveEmulatorHost`
// private; the copy below must say what that one says, and the day it is
// exported this file should import it instead.

function emulatorOrigin(): { host: string; port: number } | null {
  const extra = Constants.expoConfig?.extra
  if (extra?.useEmulators !== true) return null
  const port = Number(extra?.emulatorPorts?.functions ?? 5001)
  if (Platform.OS === 'web') return { host: 'localhost', port }
  const hostUri =
    Constants.expoConfig?.hostUri ||
    (Constants as { expoGoConfig?: { debuggerHost?: string } }).expoGoConfig?.debuggerHost ||
    ''
  return { host: hostUri.split(':')[0] || 'localhost', port }
}

function functionsBase(): string {
  const functions = getFunctions()
  const projectId = functions.app.options.projectId
  if (!projectId) {
    throw new Error(
      'callFunction: the Firebase app has no projectId (FIREBASE_PROJECT_ID) — refusing to build a router URL without one.'
    )
  }
  return functionsBaseUrl({ projectId, region: functions.region, emulator: emulatorOrigin() })
}

export function callFunction<Req = unknown, Res = unknown>(
  name: string,
  options?: HttpsCallableOptions
): HttpsCallable<Req, Res> {
  const router = routerForCallable(name)
  if (!router) return httpsCallable<Req, Res>(getFunctions(), name, options)

  // LAZY: neither callable is built until a call is made. Call sites may build
  // theirs at module load, and a module can load where there is no window, no
  // project id, or no Firebase app yet.
  let routed: HttpsCallable<Req, Res> | undefined
  let direct: HttpsCallable<Req, Res> | undefined
  const getRouted = () =>
    (routed ??= httpsCallableFromURL<Req, Res>(
      getFunctions(),
      callableRouteUrl({ base: functionsBase(), router, name }),
      options
    ))
  const getDirect = () => (direct ??= httpsCallable<Req, Res>(getFunctions(), name, options))

  // A project that does not have the router YET (a client and its backend do not
  // deploy together) is answered under the callable's own name, which stays
  // deployed. @linyup/shared → withRouterFallback says when that is safe: only
  // when no member ran.
  const call = withRouterFallback<Req, HttpsCallableResult<Res>>({
    router,
    routed: (data) => getRouted()(data),
    direct: (data) => getDirect()(data),
    onFallback: (r) =>
      console.warn(
        `[callFunction] ${r} is not deployed here — calling its members by their own names`
      ),
  })
  const callable = call as HttpsCallable<Req, Res>
  callable.stream = (data, streamOptions) => getRouted().stream(data, streamOptions)
  return callable
}
