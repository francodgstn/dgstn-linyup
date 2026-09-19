'use client'

// WhatsApp integration — client data access for the owner-only ConfigPanel.
// Pattern: hooks/useConnect.ts (Stripe Connect) — a status read + typed
// mutations that invalidate it, never a client write of the integration doc
// itself (teams/{teamId}/integrations/whatsapp is function-written only —
// firestore.rules: "Only owners can view integration configuration").

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { collection, doc, getDoc, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  TEAMS_COLLECTION,
  PUBLIC_PROFILE_SUBCOLLECTION,
  TEAM_INTEGRATIONS_SUBCOLLECTION,
  WHATSAPP_INTEGRATION_DOC,
  WHATSAPP_TEMPLATES_SUBCOLLECTION,
  type WhatsAppIntegration,
  type WhatsAppStudioTemplate,
  type WhatsAppTemplateCategory,
} from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

function integrationRef(teamId: string) {
  return doc(db, TEAMS_COLLECTION, teamId, TEAM_INTEGRATIONS_SUBCOLLECTION, WHATSAPP_INTEGRATION_DOC)
}

/** The team's WhatsApp integration doc — owner-only readable per
 *  firestore.rules. `null` when never connected. */
export function useWhatsAppIntegration(teamId: string | null, enabled: boolean) {
  return useQuery<WhatsAppIntegration | null>({
    queryKey: ['whatsapp-integration', teamId],
    enabled: !!teamId && enabled,
    queryFn: async () => {
      const snap = await getDoc(integrationRef(teamId!))
      return snap.exists() ? (snap.data() as WhatsAppIntegration) : null
    },
  })
}

export type GetWhatsAppSignupConfigResult =
  | { available: false }
  | { available: true; appId: string; configId: string; graphVersion: string }

/** Whether Embedded Signup is configured at all on this deploy (Meta app id +
 *  signup config id) — distinct from "connected": a coach on a deploy with no
 *  Meta app configured sees "not available", not a broken Connect button. */
export function useWhatsAppSignupConfig(teamId: string | null, enabled: boolean) {
  return useQuery<GetWhatsAppSignupConfigResult>({
    queryKey: ['whatsapp-signup-config', teamId],
    enabled: !!teamId && enabled,
    queryFn: async () => {
      const fn = callFunction<{ teamId: string }, GetWhatsAppSignupConfigResult>(
        'getWhatsAppSignupConfig'
      )
      return (await fn({ teamId: teamId! })).data
    },
  })
}

function useInvalidateWhatsApp(teamId: string | null) {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['whatsapp-integration', teamId] })
  }
}

export interface ConnectWhatsAppRequest {
  teamId: string
  code: string
  wabaId: string
  phoneNumberId?: string
}

/** `connectWhatsApp`'s `HttpsError.details.reason` values. */
export type ConnectWhatsAppRefusalReason =
  | 'plugin_not_installed'
  | 'demo_tenant'
  | 'not_configured'
  | 'not_business_app'
  | 'number_taken'
  | 'no_number'
  | 'several_numbers'
  | 'meta_error'

export function useConnectWhatsApp(teamId: string | null) {
  const invalidate = useInvalidateWhatsApp(teamId)
  return useMutation({
    mutationFn: async (vars: ConnectWhatsAppRequest) => {
      const fn = callFunction<ConnectWhatsAppRequest, { ok: boolean }>('connectWhatsApp')
      return (await fn(vars)).data
    },
    onSuccess: invalidate,
  })
}

export function useRefreshWhatsAppStatus(teamId: string | null) {
  const invalidate = useInvalidateWhatsApp(teamId)
  return useMutation({
    mutationFn: async (vars: { teamId: string }) => {
      const fn = callFunction<{ teamId: string }, { ok: boolean }>('refreshWhatsAppStatus')
      return (await fn(vars)).data
    },
    onSuccess: invalidate,
  })
}

export function useDisconnectWhatsApp(teamId: string | null) {
  const invalidate = useInvalidateWhatsApp(teamId)
  return useMutation({
    mutationFn: async (vars: { teamId: string }) => {
      const fn = callFunction<{ teamId: string }, { ok: boolean }>('disconnectWhatsApp')
      return (await fn(vars)).data
    },
    onSuccess: invalidate,
  })
}

// ─── Studio templates (Phase 2, "6b") ──────────────────────────────────────────
// teams/{teamId}/whatsapp_templates/{id} — readable by any team member
// (firestore.rules), written only by the callables below. Unlike the
// integration doc, this is NOT owner-only, which is what lets a manager with
// `outreach.manage` author messages even though the connection card itself is
// owner-only.

function templatesRef(teamId: string) {
  return collection(db, TEAMS_COLLECTION, teamId, WHATSAPP_TEMPLATES_SUBCOLLECTION)
}

export function useWhatsAppStudioTemplates(teamId: string | null, enabled = true) {
  return useQuery<WhatsAppStudioTemplate[]>({
    queryKey: ['whatsapp-studio-templates', teamId],
    enabled: !!teamId && enabled,
    queryFn: async () => {
      const snap = await getDocs(templatesRef(teamId!))
      return snap.docs.map((d) => ({ ...(d.data() as Omit<WhatsAppStudioTemplate, 'id'>), id: d.id }))
    },
  })
}

function useInvalidateWhatsAppTemplates(teamId: string | null) {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['whatsapp-studio-templates', teamId] })
}

export interface SubmitWhatsAppTemplateRequest {
  teamId: string
  templateId?: string
  label: string
  category: WhatsAppTemplateCategory
  body: string
}

/** `submitWhatsAppTemplate`'s `HttpsError.details.reason` values. */
export type SubmitWhatsAppTemplateRefusalReason =
  | 'label'
  | 'body'
  | 'not_connected'
  | 'plugin_not_installed'
  | 'meta_error'

export function useSubmitWhatsAppTemplate(teamId: string | null) {
  const invalidate = useInvalidateWhatsAppTemplates(teamId)
  return useMutation({
    mutationFn: async (vars: SubmitWhatsAppTemplateRequest) => {
      const fn = callFunction<SubmitWhatsAppTemplateRequest, { id: string; status: string }>(
        'submitWhatsAppTemplate'
      )
      return (await fn(vars)).data
    },
    onSuccess: invalidate,
  })
}

export function useDeleteWhatsAppTemplate(teamId: string | null) {
  const invalidate = useInvalidateWhatsAppTemplates(teamId)
  return useMutation({
    mutationFn: async (vars: { teamId: string; templateId: string }) => {
      const fn = callFunction<{ teamId: string; templateId: string }, { ok: boolean }>(
        'deleteWhatsAppTemplate'
      )
      return (await fn(vars)).data
    },
    onSuccess: invalidate,
  })
}

// ─── Usage (Phase 2, "6e") ──────────────────────────────────────────────────────
// What WhatsApp costs the studio this month, by Meta category. Meta bills the
// studio directly; this is a count, never a re-billing.

export interface WhatsAppUsage {
  since: string
  byCategory: { utility: number; marketing: number; service: number; authentication: number }
}

export function useWhatsAppUsage(teamId: string | null, enabled: boolean) {
  return useQuery<WhatsAppUsage>({
    queryKey: ['whatsapp-usage', teamId],
    enabled: !!teamId && enabled,
    queryFn: async () => {
      const fn = callFunction<{ teamId: string }, WhatsAppUsage>('getWhatsAppUsage')
      return (await fn({ teamId: teamId! })).data
    },
  })
}

/**
 * Is WhatsApp connected — asked the way a MANAGER can ask it. A manager cannot
 * read the integration doc (owner-only), but the team's public profile carries
 * `whatsapp_opt_in_offered`: the plugin installed AND a number connected, the
 * same fact the public forms read.
 */
export function useWhatsAppConnectedForTeam(teamId: string | null, enabled: boolean) {
  return useQuery<boolean>({
    queryKey: ['whatsapp-connected-public', teamId],
    enabled: !!teamId && enabled,
    queryFn: async () => {
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId!, PUBLIC_PROFILE_SUBCOLLECTION, teamId!))
      return snap.data()?.whatsapp_opt_in_offered === true
    },
  })
}
