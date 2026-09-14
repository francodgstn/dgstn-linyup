// Vertex AI client for the in-app assistant and offer drafting. Auth is via ADC
// — in production the Cloud Functions runtime service account (granted
// roles/aiplatform.user in infra/modules/iam) is used automatically; locally you
// need developer ADC (`gcloud auth application-default login`). No API key is
// stored.
//
// ── WHY @google/genai AND NOT @google-cloud/vertexai ────────────────────────
//
// The `VertexAI` class and everything under it was deprecated on 2025-06-24 and
// is REMOVED on 2026-06-24. Moving while there were two call sites behind this
// one module was the cheapest this migration was ever going to be; waiting
// would have meant doing it under a deadline with more callers (Franco,
// 2026-09-02).
//
// Two things got better rather than merely newer, and both matter here:
//
//   `response.text` REPLACES A FOUR-LEVEL OPTIONAL CHAIN. Reading a reply used
//   to mean `result.response?.candidates?.[0]?.content?.parts?.map(…)`, which
//   returns undefined silently at any of four steps — the same shape of hazard
//   `utils/stripe/objectShape.ts` exists to stop.
//
//   `responseJsonSchema` CONSTRAINS GENERATION. Offer drafting used to describe
//   its shape in the prompt and rely entirely on `parseOfferingDraft` to catch
//   what came back wrong. The schema now bounds the model too, so the parser is
//   the SECOND line rather than the only one — it still refuses everything it
//   refused before, because a constrained model is a better first draft and not
//   a security boundary.
//
// ── THINKING SPENDS THE OUTPUT CAP ──────────────────────────────────────────
//
// On `gemini-2.5-flash` thinking is ON by default, and thinking tokens count
// against `maxOutputTokens`. A call that sets a cap and says nothing about
// thinking can be stopped before its answer is written — which is how contact
// summaries were stored as sentence fragments. So every call states its
// thinking budget: 0 where the task needs no reasoning, a bounded number with
// the cap raised well above it where it does. And every call asks
// `replyWasStopped` whether the reply was cut, and treats a cut reply as
// incomplete. `vertexCalls.test.ts` reads each call site from the source and
// fails the build for one that does neither.
import { GoogleGenAI } from '@google/genai'
import { getVertexLocation } from './env'

// Default model for a help/navigation copilot and for offer drafting: cheap +
// fast, good enough for grounded Q&A and for a structured proposal. Swap for a
// Pro model here if quality demands it.
export const ASSISTANT_MODEL = 'gemini-2.5-flash'

let cached: GoogleGenAI | null = null

/**
 * The shared Vertex client. Cached per instance, as the old `getGenerativeModel`
 * result was — the model name is no longer bound at construction, so callers
 * pass it to `generateContent` instead.
 */
export function getGenAI(): GoogleGenAI {
  if (cached) return cached
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT
  if (!project) throw new Error('GCLOUD_PROJECT not set — cannot init Vertex AI')
  cached = new GoogleGenAI({ vertexai: true, project, location: getVertexLocation() })
  return cached
}

/** The part of a reply `replyWasStopped` reads. */
export interface ReplyFinish {
  candidates?: Array<{ finishReason?: unknown }>
}

/**
 * Did the model stop because it reached `maxOutputTokens`? The ONE reader of
 * `finishReason`. A stopped reply is incomplete whatever its text looks like:
 * a sentence may be half-written, a JSON array may have closed early.
 */
export function replyWasStopped(response: ReplyFinish | null | undefined): boolean {
  return String(response?.candidates?.[0]?.finishReason ?? '') === 'MAX_TOKENS'
}
