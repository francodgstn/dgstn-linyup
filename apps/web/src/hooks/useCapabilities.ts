'use client'

import { useAuth } from '@/contexts/AuthContext'
import {
  resolveRoleCapabilities,
  dataScopeForRole,
  type Capability,
  type DataScope,
} from '@linyup/shared'

// Capability-based permission gate for the UI — the client mirror of the Cloud
// Function `requireCapability` guard and the Firestore rules. Mirrors the shape of
// usePlan(): derive from AuthContext, expose a small `can(...)` predicate. Use this
// instead of comparing `teamRole` directly so all permission logic reads from one
// capability catalog (packages/shared/src/types/capabilities.ts).
//
// `scope` says whether the member's SCOPED capabilities (contacts.*, schedule.*)
// apply to all team records ('all') or only their own ('own', i.e. a coach). The
// UI uses it to decide default filters; the security rules are the real enforcer.

export interface UseCapabilitiesResult {
  isLoading: boolean
  capabilities: Capability[]
  scope: DataScope
  /** Does the current member hold `cap`? Owner is always all-capable. */
  can: (cap: Capability) => boolean
  /** True when the member only sees their own contacts/schedule (a coach). */
  ownScoped: boolean
}

export function useCapabilities(): UseCapabilitiesResult {
  const { teamRole, teamCapabilities, teamScope, loading } = useAuth()

  // Prefer the capabilities denormalized on the member doc; fall back to the
  // role-derived defaults for members written before denormalization (system roles
  // resolve exactly; a legacy coach would get the default coach set).
  const capabilities: Capability[] = teamRole
    ? (teamCapabilities ?? resolveRoleCapabilities(teamRole))
    : []
  const scope: DataScope = teamScope ?? (teamRole ? dataScopeForRole(teamRole) : 'all')

  const capSet = new Set(capabilities)

  return {
    isLoading: loading,
    capabilities,
    scope,
    can: (cap) => teamRole === 'owner' || capSet.has(cap),
    ownScoped: scope === 'own',
  }
}
