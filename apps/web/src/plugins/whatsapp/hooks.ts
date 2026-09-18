'use client'

// WhatsApp integration — client data access for the owner-only ConfigPanel.
// Pattern: hooks/useConnect.ts (Stripe Connect) — a status read + typed
// mutations that invalidate it, never a client write of the integration doc
// itself (teams/{teamId}/integrations/whatsapp is function-written only —
// firestore.rules: "Only owners can view integration configuration").

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import {
  TEAMS_COLLECTION,
  TEAM_INTEGRATIONS_SUBCOLLECTION,
  WHATSAPP_INTEGRATION_DOC,
  type WhatsAppIntegration,
} from '@linyup/shared'

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
      const fn = httpsCallable<{ teamId: string }, GetWhatsAppSignupConfigResult>(
        functions,
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
      const fn = httpsCallable<ConnectWhatsAppRequest, { ok: boolean }>(functions, 'connectWhatsApp')
      return (await fn(vars)).data
    },
    onSuccess: invalidate,
  })
}

export function useRefreshWhatsAppStatus(teamId: string | null) {
  const invalidate = useInvalidateWhatsApp(teamId)
  return useMutation({
    mutationFn: async (vars: { teamId: string }) => {
      const fn = httpsCallable<{ teamId: string }, { ok: boolean }>(functions, 'refreshWhatsAppStatus')
      return (await fn(vars)).data
    },
    onSuccess: invalidate,
  })
}

export function useDisconnectWhatsApp(teamId: string | null) {
  const invalidate = useInvalidateWhatsApp(teamId)
  return useMutation({
    mutationFn: async (vars: { teamId: string }) => {
      const fn = httpsCallable<{ teamId: string }, { ok: boolean }>(functions, 'disconnectWhatsApp')
      return (await fn(vars)).data
    },
    onSuccess: invalidate,
  })
}
