'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { EmailSenderConfig } from '@linyup/shared'
import { EMAIL_SENDER_INTEGRATION_DOC, ORGANIZATIONS_COLLECTION, TEAMS_COLLECTION, TEAM_INTEGRATIONS_SUBCOLLECTION } from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

type EmailSenderScope = 'team' | 'org'

interface RegisterDomainPayload {
  scope: EmailSenderScope
  entityId: string
  domain: string
  fromLocalPart: string
}

interface RegisterDomainResult {
  domain: string
  fromLocalPart: string
  dnsRecords: EmailSenderConfig['dns_records']
  status: 'pending'
}

interface CheckDomainPayload {
  scope: EmailSenderScope
  entityId: string
}

interface CheckDomainResult {
  status: 'pending' | 'verified'
  dnsRecords: EmailSenderConfig['dns_records']
}

interface UseManagedSenderPayload {
  scope: EmailSenderScope
  entityId: string
}

interface UseManagedSenderResult {
  model: 'managed'
}

interface SendTestEmailPayload {
  scope: EmailSenderScope
  entityId: string
  to?: string
}

export interface SendTestEmailResult {
  success: boolean
  sentTo: string
  skipped: boolean
  testMode: boolean
}

export interface UseEmailSenderSettingsResult {
  data: EmailSenderConfig | null
  isLoading: boolean
  registerDomain: (domain: string, fromLocalPart: string) => Promise<void>
  checkDomain: () => Promise<void>
  revertToManaged: () => Promise<void>
  sendTest: (to?: string) => Promise<SendTestEmailResult>
  isRegistering: boolean
  isChecking: boolean
  isReverting: boolean
  isSendingTest: boolean
}

function senderDocRef(scope: EmailSenderScope, entityId: string) {
  if (scope === 'team') {
    return doc(db, TEAMS_COLLECTION, entityId, TEAM_INTEGRATIONS_SUBCOLLECTION, EMAIL_SENDER_INTEGRATION_DOC)
  }
  return doc(db, ORGANIZATIONS_COLLECTION, entityId, TEAM_INTEGRATIONS_SUBCOLLECTION, EMAIL_SENDER_INTEGRATION_DOC)
}

export function useEmailSenderSettings(
  scope: EmailSenderScope,
  entityId: string | null
): UseEmailSenderSettingsResult {
  const qc = useQueryClient()
  const queryKey = ['email-sender-settings', scope, entityId]

  const { data = null, isLoading } = useQuery<EmailSenderConfig | null>({
    queryKey,
    enabled: !!entityId,
    queryFn: async () => {
      if (!entityId) return null
      const snap = await getDoc(senderDocRef(scope, entityId))
      return snap.exists() ? (snap.data() as EmailSenderConfig) : null
    },
  })

  const { mutateAsync: registerDomainMutation, isPending: isRegistering } = useMutation({
    mutationFn: async ({ domain, fromLocalPart }: { domain: string; fromLocalPart: string }) => {
      const fn = callFunction<RegisterDomainPayload, RegisterDomainResult>(
        'registerSenderDomain'
      )
      await fn({ scope, entityId: entityId!, domain, fromLocalPart })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey })
    },
  })

  const { mutateAsync: checkDomainMutation, isPending: isChecking } = useMutation({
    mutationFn: async () => {
      const fn = callFunction<CheckDomainPayload, CheckDomainResult>(
        'checkSenderDomain'
      )
      await fn({ scope, entityId: entityId! })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey })
    },
  })

  const { mutateAsync: revertToManagedMutation, isPending: isReverting } = useMutation({
    mutationFn: async () => {
      const fn = callFunction<UseManagedSenderPayload, UseManagedSenderResult>(
        'useManagedSender'
      )
      await fn({ scope, entityId: entityId! })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey })
    },
  })

  const { mutateAsync: sendTestMutation, isPending: isSendingTest } = useMutation({
    mutationFn: async (to?: string) => {
      const fn = callFunction<SendTestEmailPayload, SendTestEmailResult>(
        'sendTestEmail'
      )
      const result = await fn({ scope, entityId: entityId!, ...(to ? { to } : {}) })
      return result.data
    },
  })

  return {
    data,
    isLoading,
    registerDomain: (domain: string, fromLocalPart: string) =>
      registerDomainMutation({ domain, fromLocalPart }),
    checkDomain: () => checkDomainMutation(),
    revertToManaged: () => revertToManagedMutation(),
    sendTest: (to?: string) => sendTestMutation(to),
    isRegistering,
    isChecking,
    isReverting,
    isSendingTest,
  }
}
