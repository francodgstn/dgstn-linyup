'use client'

// Client mirror of the experimental-features registry
// (packages/shared/src/types/experimental.ts). Reads the team doc AuthContext
// already subscribes to with onSnapshot — so no extra Firestore read, and a
// toggle flipped in Settings shows up on the consuming surface immediately.
//
// Two callers by design: the settings list (`features`, to render the toggles)
// and each consuming surface (`isEnabled`, to decide whether to mount).

import { useAuth } from '@/contexts/AuthContext'
import {
  EXPERIMENTAL_FEATURES,
  resolveExperimentalFeatures,
  type ExperimentalFeature,
  type ExperimentalFeatureId,
  type ExperimentalFeatureSettings,
} from '@linyup/shared'

export interface UseExperimentalFeaturesResult {
  /** The registry, in list order — what the settings page renders. */
  features: readonly ExperimentalFeature[]
  /** The stored map, normalized (unknown ids dropped, only `true` counts). */
  enabled: ExperimentalFeatureSettings
  /** Off unless the team explicitly switched it on. */
  isEnabled: (id: ExperimentalFeatureId) => boolean
  /** True while the team doc has not arrived — treat as "off, not yet known". */
  isLoading: boolean
}

export function useExperimentalFeatures(): UseExperimentalFeaturesResult {
  const { team, loading } = useAuth()
  const enabled = resolveExperimentalFeatures(team)
  return {
    features: EXPERIMENTAL_FEATURES,
    enabled,
    isEnabled: (id) => enabled[id] === true,
    isLoading: loading || !team,
  }
}
