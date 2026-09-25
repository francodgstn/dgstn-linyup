/**
 * MOVED to `/manage/online-courses`.
 *
 * The section that held these pages was renamed from Offer to Manage, and
 * "Offer" became the catalog PAGE — so `/offer/*` now says the opposite of
 * what it means. The routes were renamed to match rather than left to drift,
 * because a URL that disagrees with the nav is a thing every future reader has
 * to hold in their head (Franco, 2026-09-02).
 *
 * A REDIRECT RATHER THAN A DELETION, for the same reason the retired activities
 * and plans pages kept theirs: bookmarks, and anything already deployed that
 * links here. The query string is preserved so a deep link keeps its tab.
 */
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
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === 'string') sp.set(k, v)
    else if (Array.isArray(v)) v.forEach((x) => sp.append(k, x))
  }
  const qs = sp.toString()
  const path = `/manage/online-courses${qs ? `?${qs}` : ''}`
  redirect((locale === 'en' ? path : `/${locale}${path}`) as Route)
}
