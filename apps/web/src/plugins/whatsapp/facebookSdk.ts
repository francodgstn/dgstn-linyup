// Loads the Facebook JS SDK ONCE (module-level flag, same guard shape the
// Firebase emulator connection uses on a `globalThis` flag — see
// src/lib/firebase.ts — to survive HMR re-mounts of ConfigPanel without a
// double `<script>` tag or a double `FB.init`).
//
// Scoped to this settings page only: nothing else in the app loads
// connect.facebook.net, and nothing here runs on any public/portal route.

export interface FacebookSdkWindow extends Window {
  FB?: {
    init: (params: {
      appId: string
      autoLogAppEvents: boolean
      xfbml: boolean
      version: string
    }) => void
    login: (
      callback: (response: { status?: string; authResponse?: { code?: string } }) => void,
      options: {
        config_id: string
        response_type: string
        override_default_response_type: boolean
        extras: {
          setup: Record<string, unknown>
          featureType: string
          sessionInfoVersion: string
        }
      }
    ) => void
  }
  fbAsyncInit?: () => void
}

declare const globalThis: { __linyupFbSdkPromise?: Promise<void> } & typeof window

const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js'

/** Resolves once `window.FB` is initialized for `appId`/`graphVersion`. Safe to
 *  call more than once (returns the same in-flight/cached promise). */
export function loadFacebookSdk(appId: string, graphVersion: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no_window'))
  const w = window as FacebookSdkWindow
  if (globalThis.__linyupFbSdkPromise) return globalThis.__linyupFbSdkPromise

  globalThis.__linyupFbSdkPromise = new Promise<void>((resolve, reject) => {
    w.fbAsyncInit = () => {
      try {
        w.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion })
        resolve()
      } catch (err) {
        reject(err instanceof Error ? err : new Error('fb_init_failed'))
      }
    }
    if (w.FB) {
      // Already loaded by an earlier mount — fbAsyncInit already fired, so
      // init directly.
      w.fbAsyncInit()
      return
    }
    const existing = document.getElementById('facebook-jssdk')
    if (existing) return // fbAsyncInit above will fire once it finishes loading
    const script = document.createElement('script')
    script.id = 'facebook-jssdk'
    script.src = SDK_SRC
    script.async = true
    script.defer = true
    script.crossOrigin = 'anonymous'
    script.onerror = () => reject(new Error('sdk_load_failed'))
    document.body.appendChild(script)
  })

  return globalThis.__linyupFbSdkPromise
}
