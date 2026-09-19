import type { LeadDemoMarker } from '../types/team'

/**
 * The public shape of `Team.lead_demo` (see its doc comment): null for a real
 * studio; for a lead demo tenant the marker, with the official URL kept only
 * when it is an https link — it is rendered as an href on every public page.
 *
 * Written by syncTeamPublicProfile and by the lead seeder's direct mirror write,
 * so the two can never disagree about what reaches the public profile.
 */
export function leadDemoMarkerOf(raw: unknown): LeadDemoMarker | null {
  if (!raw || typeof raw !== 'object') return null
  const url = (raw as { official_url?: unknown }).official_url
  return { official_url: typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null }
}

/** The official URL as a visitor reads it: host and path, no scheme or `www.`. */
export function leadDemoUrlLabel(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
}
