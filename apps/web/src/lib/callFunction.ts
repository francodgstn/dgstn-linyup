import {
  httpsCallable,
  httpsCallableFromURL,
  type HttpsCallable,
  type HttpsCallableOptions,
  type HttpsCallableResult,
} from 'firebase/functions'
import {
  callableRouteUrl,
  functionsBaseUrl,
  routerForCallable,
  withRouterFallback,
} from '@linyup/shared'
import { functions, EMULATOR_PORTS, emulatorHost, emulatorProxy } from './firebase'

// ─── callFunction ─────────────────────────────────────────────────────────────
//
// The way to reach a callable by NAME, wherever it happens to be served from.
// Callables are being folded into a few domain ROUTER functions — an `onRequest`
// that hands the request to the existing `onCall` value, so auth, App Check and
// error codes stay the SDK's own (`docs/functions-consolidation-plan.md`).
// `CALLABLE_ROUTES` in @linyup/shared says which router serves a name.
//
// A name that is NOT in that table behaves exactly as it did before this file
// existed: `httpsCallable(functions, name, options)` on the same region-scoped
// instance. Deleting a name from the table is therefore the rollback — no edit
// here, and none at the call site.
//
// Everything about WHERE is read off what `firebase.ts` already decided: the
// region and project from the Functions instance, the emulator host and port
// from its exports. The one thing that cannot be inherited is the emulator
// itself — `httpsCallableFromURL` ignores `connectFunctionsEmulator`, so the
// origin is spelled out. Under the Codespace proxy `firebase.ts` connects no
// functions emulator at all, and a routed call follows it rather than inventing
// a reachability the unrouted ones do not have.
//
// Server + client safe, like `firebase.ts`: nothing here touches auth, and the
// host is resolved per call because `emulatorHost()` follows the page.

// Same flag, same spelling as `firebase.ts`, which keeps its copy private.
const useEmulators = process.env.NEXT_PUBLIC_USE_EMULATORS === 'true'

function functionsBase(): string {
  const projectId = functions.app.options.projectId
  if (!projectId) {
    throw new Error(
      'callFunction: the Firebase app has no projectId (NEXT_PUBLIC_FIREBASE_PROJECT_ID) — refusing to build a router URL without one.'
    )
  }
  return functionsBaseUrl({
    projectId,
    region: functions.region,
    emulator:
      useEmulators && !emulatorProxy
        ? { host: emulatorHost(), port: EMULATOR_PORTS.functions }
        : null,
  })
}

export function callFunction<Req = unknown, Res = unknown>(
  name: string,
  options?: HttpsCallableOptions
): HttpsCallable<Req, Res> {
  const router = routerForCallable(name)
  if (!router) return httpsCallable<Req, Res>(functions, name, options)

  // LAZY: neither callable is built until a call is made. Call sites may build
  // theirs at module load, and a module can load where there is no window, no
  // project id, or no Firebase app yet.
  let routed: HttpsCallable<Req, Res> | undefined
  let direct: HttpsCallable<Req, Res> | undefined
  const getRouted = () =>
    (routed ??= httpsCallableFromURL<Req, Res>(
      functions,
      callableRouteUrl({ base: functionsBase(), router, name }),
      options
    ))
  const getDirect = () => (direct ??= httpsCallable<Req, Res>(functions, name, options))

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
