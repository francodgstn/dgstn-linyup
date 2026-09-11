'use client'

// Fullscreen idle screensaver. Any pointer/touch/key interaction dismisses it
// (handled by the parent's idle timer — see KioskApp's useIdleTimer) which also
// resets the walk-in flow. Crossfades between image items; a video item plays
// muted/looped while it's the current slide. Empty media ⇒ a branded clock
// screensaver. Respects prefers-reduced-motion (static swap, no crossfade).
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import type { KioskMediaItem } from '@linyup/shared'
import { useClock } from './useClock'
import { usePublicFormat } from '../usePublicFormat'

interface Props {
  media: KioskMediaItem[]
  teamName: string
  logoUrl?: string
}

const SLIDE_MS = 8000

export default function Standby({ media, teamName, logoUrl }: Props) {
  const t = useTranslations('Kiosk')
  const [index, setIndex] = useState(0)
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    setIndex(0)
  }, [media])

  useEffect(() => {
    if (media.length < 2) return
    const id = setInterval(() => setIndex((i) => (i + 1) % media.length), SLIDE_MS)
    return () => clearInterval(id)
  }, [media.length])

  if (media.length === 0) {
    return <ClockScreensaver teamName={teamName} logoUrl={logoUrl} tapHint={t('standbyTapHint')} />
  }

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black">
      {media.map((m, i) => (
        <div
          key={`${m.url}-${i}`}
          className={cn(
            'absolute inset-0',
            !reducedMotion && 'transition-opacity duration-1000 ease-in-out',
            i === index ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
        >
          {m.type === 'video' ? (
            <video
              src={m.url}
              className="h-full w-full object-cover"
              autoPlay
              muted
              loop
              playsInline
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={m.url} alt="" className="h-full w-full object-cover" />
          )}
        </div>
      ))}
      <p className="absolute bottom-6 left-1/2 -translate-x-1/2 text-sm font-medium text-white/70">
        {t('standbyTapHint')}
      </p>
    </div>
  )
}

function ClockScreensaver({
  teamName,
  logoUrl,
  tapHint,
}: {
  teamName: string
  logoUrl?: string
  tapHint: string
}) {
  const now = useClock()
  const fmt = usePublicFormat()
  const time = fmt.time(now)
  const date = fmt.custom(now, { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black text-white">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="mb-2 h-20 w-20 rounded-full object-cover" />
      ) : null}
      <p className="text-2xl font-semibold tracking-wide text-white/80">{teamName}</p>
      <p className="text-8xl font-bold tabular-nums">{time}</p>
      <p className="text-lg text-white/60">{date}</p>
      <p className="absolute bottom-6 text-sm font-medium text-white/50">{tapHint}</p>
    </div>
  )
}
