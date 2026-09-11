import { doc, setDoc, arrayUnion, arrayRemove } from 'firebase/firestore'
import { db } from './firebase'
import { USERS_COLLECTION } from '@linyup/shared'

/**
 * Helpers for the in-app feedback widget.
 *
 * Per-user prompt state lives at `users/{uid}.feedback` (merge-writes, same
 * pattern as src/lib/onboarding.ts) so muted/answered prompts sync across
 * devices. Read the state from `useAuth().profile.feedback`.
 */

/** Hide a prompt question from the badge/prompt list (still answerable). */
export async function mutePrompt(uid: string, promptId: string): Promise<void> {
  await setDoc(
    doc(db, USERS_COLLECTION, uid),
    { feedback: { mutedPrompts: arrayUnion(promptId) } },
    { merge: true }
  )
}

/** Bring a muted prompt question back. */
export async function unmutePrompt(uid: string, promptId: string): Promise<void> {
  await setDoc(
    doc(db, USERS_COLLECTION, uid),
    { feedback: { mutedPrompts: arrayRemove(promptId) } },
    { merge: true }
  )
}

/** Record that the user answered a prompt question (clears it from the badge). */
export async function markPromptAnswered(uid: string, promptId: string): Promise<void> {
  await setDoc(
    doc(db, USERS_COLLECTION, uid),
    { feedback: { answeredPrompts: arrayUnion(promptId) } },
    { merge: true }
  )
}

/** True where the native tab-capture API exists (desktop browsers; not mobile). */
export function isScreenshotSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  )
}

/**
 * Capture one frame of the current tab as a PNG blob via the native
 * getDisplayMedia API (no DOM-rendering library — Tailwind v4's oklch colors
 * break html2canvas-style renderers, and this captures exactly what the user
 * sees). The browser shows its share picker once; `preferCurrentTab` /
 * `selfBrowserSurface` are Chromium-only hints that preselect the current tab.
 * Returns null if the user cancels the picker.
 */
export async function captureTabScreenshot(): Promise<Blob | null> {
  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // Chromium-only hints, absent from the TS lib DOM types.
      video: { displaySurface: 'browser' },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    } as MediaStreamConstraints)

    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    await video.play()
    // One extra frame so the compositor has painted real content.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx || canvas.width === 0) return null
    ctx.drawImage(video, 0, 0)

    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((blob) => resolve(blob), 'image/png')
    )
  } catch {
    // User dismissed the picker (NotAllowedError) or capture is unavailable.
    return null
  } finally {
    // Always release the capture, or the browser's "sharing" indicator sticks.
    stream?.getTracks().forEach((t) => t.stop())
  }
}
