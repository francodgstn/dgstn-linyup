// The member app's translations — a deliberately small shim, not a library.
//
// WHY THIS EXISTS AT ALL. The app shipped English-only while the rest of the
// product spoke four languages, in a country with four national languages. That
// was not a style gap: a member whose studio runs in French read her own
// training portal in English.
//
// WHY IT MIRRORS next-intl RATHER THAN USING i18n-js. The call site is
// identical to the web's — `const t = useTranslations('Ns')`, then `t('key')` —
// so a screen reads the same on both platforms and a person moving between
// them is never translating idioms in their head. It also means the repo's
// EXISTING `usedKeys` checker detects these calls with no change at all: its
// BIND regex looks for exactly that shape, so `pnpm i18n:check` now guards the
// app's keys the same way it guards the web's.
//
// WHY NO expo-localization. Reading the device locale through `Intl` is pure
// JS, and the app ships over the air through expo-updates. A native module
// would tie every future copy fix to a store build and its review queue — the
// slowest possible release path for the fastest-moving kind of change. `Intl`
// is present in Hermes on both platforms; if it ever is not, the catch below
// lands on English, which is exactly today's behavior and so cannot regress.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { messages, type Locale } from './messages'

export const LOCALES: Locale[] = ['en', 'de', 'fr', 'it']
const DEFAULT_LOCALE: Locale = 'en'
const STORAGE_KEY = 'linyup.locale'

/** The device's language, narrowed to one we actually ship. `de-CH` → `de`. */
export function deviceLocale(): Locale {
  try {
    const tag = new Intl.DateTimeFormat().resolvedOptions().locale ?? ''
    const base = tag.split('-')[0]?.toLowerCase()
    return (LOCALES as string[]).includes(base) ? (base as Locale) : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

interface I18nValue {
  locale: Locale
  setLocale: (l: Locale) => void
  /** False until the stored override has been read, so nothing renders copy in
   *  one language and then swaps it a frame later. */
  ready: boolean
}

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  ready: true,
})

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(deviceLocale)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return
        if (stored && (LOCALES as string[]).includes(stored)) setLocaleState(stored as Locale)
      })
      // A storage read that fails is not worth blocking the app for — the
      // device locale is already a sensible answer.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    AsyncStorage.setItem(STORAGE_KEY, l).catch(() => {})
  }, [])

  const value = useMemo(() => ({ locale, setLocale, ready }), [locale, setLocale, ready])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useLocale(): I18nValue {
  return useContext(I18nContext)
}

type Values = Record<string, string | number>

/** `{name}` → the value. Left verbatim when a caller forgets one, which is
 *  visible in review rather than silently blank. */
function interpolate(template: string, values?: Values): string {
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole
  )
}

function lookup(locale: Locale, namespace: string, key: string): string | undefined {
  const ns = (messages[locale] as Record<string, unknown> | undefined)?.[namespace]
  if (!ns || typeof ns !== 'object') return undefined
  const value = (ns as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Same shape as next-intl's: bind a namespace, then call keys within it.
 *
 * MISSING KEYS FALL BACK TO ENGLISH, then to the key id. A half-translated
 * locale therefore reads as a mix rather than as a screen of `Ns.someKey`
 * placeholders — the failure a member would actually report as "the app is
 * broken". `pnpm i18n:check` is what stops it reaching them in the first place.
 */
export function useTranslations(namespace: string) {
  const { locale } = useLocale()
  return useCallback(
    (key: string, values?: Values) => {
      const hit = lookup(locale, namespace, key) ?? lookup(DEFAULT_LOCALE, namespace, key)
      return hit === undefined ? `${namespace}.${key}` : interpolate(hit, values)
    },
    [locale, namespace]
  )
}
