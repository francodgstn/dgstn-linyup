// Legacy path. The plugins marketplace is a FULL PAGE again, at /plugins —
// where its per-plugin editors already live (/plugins/website, /plugins/finance,
// …), so the catalogue and the things it installs finally share a prefix.
//
// It spent 2026-08→09 inside the settings shell so it would read like a settings
// section (UX-61). It does not: it is a catalogue you browse, compare and buy
// from, and the rail beside it cost the card grid a third of its width on the
// one screen in the app that is nothing but a grid (Franco, 2026-09-20).
//
// THE REDIRECT CARRIES THE QUERY. `?plugin=<id>` is how every deep link into the
// marketplace opens a plugin's detail modal — the sidebar suggestions, the
// public-pages "Set up" buttons, `PluginNotInstalled`, the setup checklist — and
// those strings are in bookmarks and in released builds. Dropping it would land
// people on the bare grid with no idea which card they were sent for.
import { redirect } from 'next/navigation'
import type { Route } from 'next'

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { locale } = await params
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach((v) => qs.append(key, v))
    else if (value !== undefined) qs.set(key, value)
  }
  const query = qs.toString()
  const base = locale === 'en' ? '/plugins' : `/${locale}/plugins`
  redirect((query ? `${base}?${query}` : base) as Route)
}
