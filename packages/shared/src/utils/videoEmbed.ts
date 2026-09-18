// ─── YouTube / Vimeo, the ONE parser and embed-URL builder ────────────────────
//
// A video is stored as { provider, videoId } — never as an embed URL — so a
// published site cannot carry an arbitrary iframe source. This module is the
// only place that turns a pasted link into that pair and the pair back into a
// player address. Pure and dependency-free: the publish sanitizer (functions),
// the website renderer and editor, and the course player all use it.
//
// Player addresses are the privacy-friendly variants: youtube-nocookie.com, and
// Vimeo with dnt=1, so embedding a film sets no tracking cookies before a
// visitor presses play.

import type { VideoProvider } from '../types/website'

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const VIMEO_ID = /^\d{6,12}$/

/** Whether `videoId` has the shape the provider's ids actually have. */
export function isValidVideoId(provider: VideoProvider, videoId: string): boolean {
  return provider === 'youtube' ? YOUTUBE_ID.test(videoId) : VIMEO_ID.test(videoId)
}

/**
 * A pasted YouTube or Vimeo link → { provider, videoId }, or null when it is
 * neither. Accepts the forms people actually paste: watch?v=, youtu.be/,
 * /embed/, /shorts/, /live/, vimeo.com/{id}, vimeo.com/channels/…/{id},
 * player.vimeo.com/video/{id}.
 */
export function parseVideoUrl(input: string): { provider: VideoProvider; videoId: string } | null {
  // Parsed by hand, not with `URL`: this module is shared with Cloud Functions,
  // whose compile target has no DOM lib. The pattern only has to find the host,
  // path and query of an http(s) link — anything else is not a film.
  const match = /^https?:\/\/([^/?#:]+)(?::\d+)?([^?#]*)(\?[^#]*)?/i.exec(input.trim())
  if (!match) return null
  const host = match[1].toLowerCase().replace(/^www\.|^m\./, '')
  const segments: string[] = match[2].split('/').filter(Boolean)
  const query = match[3] ?? ''

  if (host === 'youtu.be') {
    const id = segments[0]
    return id && YOUTUBE_ID.test(id) ? { provider: 'youtube', videoId: id } : null
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    const fromQuery = /[?&]v=([^&]+)/.exec(query)?.[1]
    if (fromQuery && YOUTUBE_ID.test(fromQuery)) return { provider: 'youtube', videoId: fromQuery }
    const idx = segments.findIndex((segment) => ['embed', 'shorts', 'live', 'v'].includes(segment))
    const id = idx >= 0 ? segments[idx + 1] : undefined
    return id && YOUTUBE_ID.test(id) ? { provider: 'youtube', videoId: id } : null
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    // The id is the numeric segment; /channels/staffpicks/123 and /video/123 both work.
    const id = [...segments].reverse().find((segment) => VIMEO_ID.test(segment))
    return id ? { provider: 'vimeo', videoId: id } : null
  }
  return null
}

/** The player address for an embed iframe. `autoplay` is for a lightbox that
 *  opens on a click — the click is the visitor's consent to start playing. */
export function videoEmbedSrc(provider: VideoProvider, videoId: string, opts: { autoplay?: boolean } = {}): string {
  const autoplay = opts.autoplay ? '1' : '0'
  return provider === 'youtube'
    ? `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=${autoplay}&rel=0`
    : `https://player.vimeo.com/video/${videoId}?autoplay=${autoplay}&dnt=1`
}
