'use client'

import { useEffect, useState, useMemo } from 'react'
import { collection, collectionGroup, doc, getDoc, getDocs, query, where, orderBy, limit, FirestoreError } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useTranslations, useLocale } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import {
  ChevronLeft, FileText, Video, Music, Paperclip, ChevronRight, ChevronDown, Lock,
} from 'lucide-react'
import type { Course, CourseModule, Lesson, LessonType } from '@linyup/shared'
import {
  COURSES_COLLECTION,
  COURSE_MODULES_SUBCOLLECTION,
  COURSE_LESSONS_SUBCOLLECTION,
  PUBLIC_PROFILE_SUBCOLLECTION,
} from '@linyup/shared'
import { formatCurrency } from '@/lib/format'
import { sanitizeRichHtml } from '@/lib/sanitizeHtml'
import { QueryErrorState } from '@/components/ui/query-error'
import { loadFailureDetail, reportPublicLoadFailure } from '@/lib/publicQueryError'
import { useSpaceAuth } from '../../SpaceAuthProvider'
import { usePublicTeam } from '../../../PublicTeamProvider'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LESSON_ICON: Record<LessonType, typeof FileText> = {
  text: FileText,
  video: Video,
  audio: Music,
}

function getYouTubeId(url: string): string | null {
  const m =
    url.match(/[?&]v=([^&]+)/) ??
    url.match(/youtu\.be\/([^?]+)/) ??
    url.match(/embed\/([^?]+)/)
  return m?.[1] ?? null
}

function getVimeoId(url: string): string | null {
  const m = url.match(/vimeo\.com\/(\d+)/)
  return m?.[1] ?? null
}

// ─── Media player ─────────────────────────────────────────────────────────────

function MediaPlayer({ lesson }: { lesson: Lesson }) {
  if (!lesson.mediaUrl) return null
  const src = lesson.mediaUrl
  const source = lesson.mediaSource

  if (source === 'youtube') {
    const id = getYouTubeId(src)
    if (!id) return null
    return (
      <div className="aspect-video w-full overflow-hidden rounded-lg">
        <iframe
          src={`https://www.youtube.com/embed/${id}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="w-full h-full"
          title="YouTube video"
        />
      </div>
    )
  }

  if (source === 'vimeo') {
    const id = getVimeoId(src)
    if (!id) return null
    return (
      <div className="aspect-video w-full overflow-hidden rounded-lg">
        <iframe
          src={`https://player.vimeo.com/video/${id}`}
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
          className="w-full h-full"
          title="Vimeo video"
        />
      </div>
    )
  }

  if (lesson.type === 'video') {
    return (
      <video controls src={src} className="w-full rounded-lg" />
    )
  }

  if (lesson.type === 'audio') {
    return (
      <audio controls src={src} className="w-full" />
    )
  }

  return null
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  courseSlug: string
  /** Where the visitor opened the course from — 'shop' returns to the shop's
   *  Online courses tab; anything else (incl. absent) returns to the Space. */
  from?: string
}

// WHY 'purchase' IS HERE (UX-52). It was missing — from this union AND from
// `CourseSummary.accessType` below — and the denied-read branch fell back to
// 'registered' for anything it did not recognise. So a signed-in member who
// opened a SOLD course by a shared link was shown the sign-in gate: a padlock,
// "Sign in to access", and a Sign in button, to somebody already signed in.
//
// The LOCK ITSELF WAS CORRECT — `canReadPublishedCourse` refuses a purchase-tier
// course to anyone without an entitlement at `courses/{id}/purchases/{contactId}`,
// and she genuinely had not bought it. Only the REASON was wrong, and it sent
// her to the one action that could not possibly help. The fix is a gate that
// names the price and links to the till, not a widened read.
type GateReason = 'registered' | 'subscription' | 'purchase' | null

// Always-readable public summary (from courses/{id}/public_profile/{id}). Lets us
// render a branded gated screen even when the full course doc read is denied.
interface CourseSummary {
  title: string
  coverImageUrl?: string
  accessType: 'free' | 'registered' | 'subscription' | 'purchase'
  /** 'purchase' tier: the one-off price, major units. */
  priceAmount?: number
}

export default function CoursePlayer({ courseSlug, from }: Props) {
  const t = useTranslations('Space')
  const { slug, teamId, isAuthenticated, openSignIn } = useSpaceAuth()
  const locale = useLocale()
  const { team } = usePublicTeam()
  const currency = team?.default_currency ?? 'CHF'
  // Return the visitor to where they came from (shop catalogue vs their Space).
  const backHref = (from === 'shop'
    ? `/public/${slug}/shop?tab=courses`
    : `/public/${slug}/space`) as Route
  const [summary, setSummary] = useState<CourseSummary | null>(null)
  const [course, setCourse] = useState<Course | null>(null)
  const [modules, setModules] = useState<CourseModule[]>([])
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  // "This course does not exist" is a strong claim, and only ONE of the three
  // ways this load can end earns it: a lookup that SUCCEEDED and came back empty
  // (or a course doc that is genuinely gone). A failed lookup and an unexpected
  // read error must not be laundered into it — the contact may own this course,
  // and telling them it does not exist is worse than telling them nothing.
  const [loadError, setLoadError] = useState<unknown>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [gateReason, setGateReason] = useState<GateReason>(null)
  // Kept because the BUY gate needs it: the shop takes a course id
  // (`/shop?tab=courses&course={id}`), and the id is only known here, from the
  // public_profile lookup that resolved the slug.
  const [gatedCourseId, setGatedCourseId] = useState<string | null>(null)
  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setGateReason(null)
    setNotFound(false)
    setLoadError(null)
    setGatedCourseId(null)

    async function load() {
      // Resolve courseId + public summary (client-side, always readable).
      let courseId: string | null = null
      let accessType: CourseSummary['accessType'] = 'registered'
      try {
        const ppSnap = await getDocs(
          query(
            collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
            where('type', '==', 'course'),
            where('teamId', '==', teamId),
            where('slug', '==', courseSlug),
            limit(1)
          )
        )
        if (cancelled) return
        if (!ppSnap.empty) {
          const pp = ppSnap.docs[0].data() as CourseSummary
          courseId = ppSnap.docs[0].ref.parent.parent?.id ?? null
          accessType = pp.accessType ?? 'registered'
          setGatedCourseId(courseId)
          setSummary({
            title: pp.title,
            coverImageUrl: pp.coverImageUrl,
            accessType,
            priceAmount: pp.priceAmount,
          })
        }
      } catch (err: unknown) {
        // The slug lookup FAILED — which tells us nothing about whether the
        // course exists. Stop here rather than falling through to not-found.
        if (cancelled) return
        reportPublicLoadFailure('space/course-summary', err)
        setLoadError(err)
        setLoading(false)
        return
      }
      if (cancelled) return
      // Reached only on a SUCCESSFUL lookup that matched nothing — the one path
      // that has actually established the course is not there.
      if (!courseId) { setNotFound(true); setLoading(false); return }

      // Attempt the gated reads. A permission-denied means this tier is locked
      // for the current visitor — show the gate that matches the access tier.
      try {
        const courseSnap = await getDoc(doc(db, COURSES_COLLECTION, courseId))
        if (cancelled) return
        if (!courseSnap.exists()) { setNotFound(true); setLoading(false); return }
        setCourse({ id: courseSnap.id, ...courseSnap.data() } as Course)

        const [modSnap, lesSnap] = await Promise.all([
          getDocs(query(collection(db, COURSES_COLLECTION, courseId, COURSE_MODULES_SUBCOLLECTION), orderBy('order', 'asc'))),
          getDocs(query(collection(db, COURSES_COLLECTION, courseId, COURSE_LESSONS_SUBCOLLECTION), orderBy('order', 'asc'))),
        ])
        if (cancelled) return
        const mods = modSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as CourseModule)
        const lsns = lesSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Lesson)
        setModules(mods)
        setLessons(lsns)
        if (lsns.length > 0) setSelectedLessonId(lsns[0].id)
      } catch (err: unknown) {
        if (cancelled) return
        if (err instanceof FirestoreError && err.code === 'permission-denied') {
          // The ONE justified mapping: the rules refused the read, so the tier
          // is locked for this visitor. Show the gate that matches THE TIER —
          // every tier by name, never a catch-all, because the catch-all was
          // "sign in" and it was told to people who already had (UX-52).
          setGateReason(
            accessType === 'subscription'
              ? 'subscription'
              : accessType === 'purchase'
                ? 'purchase'
                : 'registered'
          )
        } else {
          // Anything else (offline, unavailable, aborted) is a failure to READ a
          // course we already resolved by slug. It exists; we just could not
          // fetch it. Say that, and offer the retry.
          reportPublicLoadFailure('space/course-content', err)
          setLoadError(err)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [courseSlug, teamId, isAuthenticated, retryKey])

  const selectedLesson = useMemo(
    () => lessons.find((l) => l.id === selectedLessonId) ?? null,
    [lessons, selectedLessonId]
  )

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  // Checked BEFORE not-found, and `notFound` is never set alongside it: a load we
  // could not complete is a different answer from a course that is not there.
  if (loadError != null) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 px-4">
        {/* The player deliberately sits outside SpaceShell (it wants full width),
            so it renders on the app's own surface — app tokens are correct here,
            unlike inside the team-branded portal. */}
        <QueryErrorState
          onRetry={() => setRetryKey((k) => k + 1)}
          title={t('courseLoadFailed')}
          detail={loadFailureDetail(loadError)}
        />
        <Link href={backHref} className="text-sm text-primary hover:underline">
          {t('backToCourses')}
        </Link>
      </div>
    )
  }

  if (notFound || (!course && !gateReason)) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center px-4">
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
        <Link href={backHref} className="text-sm text-primary hover:underline">
          {t('backToCourses')}
        </Link>
      </div>
    )
  }

  // ─── Gated view ────────────────────────────────────────────────────────────

  if (gateReason === 'registered') {
    return (
      <div className="min-h-screen">
        <div className="max-w-[640px] mx-auto px-5 py-10 space-y-6">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('backToCourses')}
          </Link>
          {summary?.coverImageUrl && (
            <div className="aspect-video rounded-xl overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={summary.coverImageUrl} alt="" className="w-full h-full object-cover" />
            </div>
          )}
          <div className="rounded-xl border bg-card p-6 text-center space-y-4">
            <Lock className="h-8 w-8 mx-auto text-muted-foreground" />
            <h1 className="text-xl font-bold">{summary?.title}</h1>
            {/* A visitor who is ALREADY signed in and still refused is not
                someone to hand a Sign in button to. It means this course belongs
                to another studio's team, or was unpublished between the summary
                and the read — so say the course is not available to this account
                and stop, rather than offering an action that changes nothing. */}
            {isAuthenticated ? (
              <p className="text-sm text-muted-foreground">{t('gatedUnavailableForAccount')}</p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t('gatedRegisteredTitle')}</p>
                <p className="text-sm text-muted-foreground">{t('gatedRegisteredDesc')}</p>
                <button
                  onClick={() => openSignIn()}
                  className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors"
                >
                  {t('signIn')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // SOLD, and not owned by this visitor. The lock is right; the ACTION is the
  // till, not the sign-in form. Priced courses are bought in the shop next to
  // products and memberships, so the CTA deep-links the shop's course checkout
  // by id (`?course=`) rather than duplicating a second checkout here.
  if (gateReason === 'purchase') {
    return (
      <div className="min-h-screen">
        <div className="max-w-[640px] mx-auto px-5 py-10 space-y-6">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('backToCourses')}
          </Link>
          {summary?.coverImageUrl && (
            <div className="aspect-video rounded-xl overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={summary.coverImageUrl} alt="" className="w-full h-full object-cover" />
            </div>
          )}
          <div className="rounded-xl border bg-card p-6 text-center space-y-4">
            <Lock className="h-8 w-8 mx-auto text-muted-foreground" />
            <h1 className="text-xl font-bold">{summary?.title}</h1>
            <p className="text-sm text-muted-foreground">{t('gatedPurchaseTitle')}</p>
            {/* The price is on the world-readable summary, so it can be named
                even though the course itself is unreadable. Naming it is the
                point: "buy" without a figure is the same dead end in a
                friendlier voice. */}
            {typeof summary?.priceAmount === 'number' && (
              <p className="text-lg font-semibold">
                {formatCurrency(summary.priceAmount, currency, locale)}
              </p>
            )}
            {gatedCourseId && (
              <Link
                href={`/public/${slug}/shop?tab=courses&course=${gatedCourseId}` as Route}
                className="block w-full py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors"
              >
                {t('gatedPurchaseCta')}
              </Link>
            )}
            {/* Signing in does not unlock a course you have not bought — but a
                buyer arriving on a fresh device is signed OUT, and her purchase
                is on her account. So the offer stands, quietly, and only for
                somebody who is not signed in. */}
            {!isAuthenticated && (
              <button
                onClick={() => openSignIn()}
                className="text-sm text-muted-foreground hover:text-foreground hover:underline"
              >
                {t('gatedPurchaseAlreadyBought')}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (gateReason === 'subscription') {
    return (
      <div className="min-h-screen">
        <div className="max-w-[640px] mx-auto px-5 py-10 space-y-6">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('backToCourses')}
          </Link>
          <div className="rounded-xl border bg-card p-6 text-center space-y-4">
            <Lock className="h-8 w-8 mx-auto text-muted-foreground" />
            <h1 className="text-xl font-bold">{summary?.title}</h1>
            <p className="text-sm text-muted-foreground">{t('gatedSubscriptionTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('gatedSubscriptionDesc')}</p>
          </div>
        </div>
      </div>
    )
  }

  // ─── Player view ───────────────────────────────────────────────────────────

  if (!course) return null

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        {/* Back link */}
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          {t('backToCourses')}
        </Link>

        <h1 className="text-2xl font-bold">{course.title}</h1>

        {/* Mobile nav toggle */}
        <button
          className="lg:hidden w-full flex items-center justify-between rounded-lg border bg-card px-4 py-2.5 text-sm font-medium"
          onClick={() => setNavOpen((v) => !v)}
        >
          <span>{t('lessonNav')}</span>
          {navOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <div className="grid gap-6 lg:grid-cols-[280px_1fr] items-start">
          {/* ── Sidebar nav ── */}
          <div className={`${navOpen ? 'block' : 'hidden'} lg:block space-y-2 lg:sticky lg:top-6`}>
            {modules.length === 0 ? (
              <p className="text-sm text-muted-foreground px-2">{t('noLessons')}</p>
            ) : (
              modules.map((mod) => {
                const modLessons = lessons.filter((l) => l.moduleId === mod.id)
                return (
                  <div key={mod.id} className="rounded-lg border bg-card overflow-hidden">
                    <div className="px-3 py-2.5 border-b">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {mod.title}
                      </p>
                    </div>
                    <div className="p-1">
                      {modLessons.map((lesson) => {
                        const Icon = LESSON_ICON[lesson.type]
                        const active = lesson.id === selectedLessonId
                        return (
                          <button
                            key={lesson.id}
                            onClick={() => { setSelectedLessonId(lesson.id); setNavOpen(false) }}
                            className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                              active
                                ? 'bg-primary/10 text-primary'
                                : 'hover:bg-accent text-foreground'
                            }`}
                          >
                            <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                            <span className="truncate">{lesson.title}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* ── Lesson content ── */}
          <div className="space-y-6">
            {selectedLesson ? (
              <>
                <h2 className="text-xl font-semibold">{selectedLesson.title}</h2>

                {/* Media player */}
                {selectedLesson.mediaUrl && (
                  <MediaPlayer lesson={selectedLesson} />
                )}

                {/* Rich-text body — same .prose-notes styling as the editor (WYSIWYG).
                    SANITIZED: lesson bodies are written client-side with no server-side
                    sanitization, and this renders to contacts (and to anonymous visitors
                    for a free course), so raw HTML here would be stored XSS. */}
                {selectedLesson.body && (
                  <div
                    className="prose-notes prose-relaxed max-w-none"
                    dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(selectedLesson.body) }}
                  />
                )}

                {/* Attachments */}
                {selectedLesson.attachments && selectedLesson.attachments.length > 0 && (
                  <div className="rounded-lg border bg-card p-4 space-y-2">
                    <p className="text-sm font-semibold">{t('attachmentsTitle')}</p>
                    <ul className="space-y-1">
                      {selectedLesson.attachments.map((att) => (
                        <li key={att.url}>
                          <a
                            href={att.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 text-sm text-primary hover:underline"
                          >
                            <Paperclip className="h-3.5 w-3.5 shrink-0" />
                            {att.name}
                            {att.size && (
                              <span className="text-xs text-muted-foreground">
                                ({Math.round(att.size / 1024)} KB)
                              </span>
                            )}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('noLessons')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
