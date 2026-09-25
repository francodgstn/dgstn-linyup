'use client'

// Program templates — reusable event programs.
//   team templates → teams/{teamId}/program_templates/{id}
//   org templates  → organizations/{orgId}/org_program_templates/{id}  (read-only for sub-teams)
// The scope model deliberately mirrors Places (see usePlaces.ts): an
// organisation authors the standard camp or competition program once and
// every member studio can apply it, but only an org admin can change it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  ORGANIZATIONS_COLLECTION,
  ORG_PROGRAM_TEMPLATES_SUBCOLLECTION,
  PROGRAM_TEMPLATES_SUBCOLLECTION,
  TEAMS_COLLECTION,
} from '@linyup/shared'
import type { ProgramTemplate } from '@linyup/shared'

export function teamTemplatesCol(teamId: string) {
  return collection(db, TEAMS_COLLECTION, teamId, PROGRAM_TEMPLATES_SUBCOLLECTION)
}
export function orgTemplatesCol(orgId: string) {
  return collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_PROGRAM_TEMPLATES_SUBCOLLECTION)
}

function byName(a: ProgramTemplate, b: ProgramTemplate): number {
  return (a.name ?? '').localeCompare(b.name ?? '')
}

/** A team's own templates plus any inherited org-wide ones (org are read-only).
 *  An unreadable org collection degrades to "no inherited templates" rather
 *  than failing the whole picker — same tolerance as usePlaces. */
export function useProgramTemplates(teamId: string | null, orgId?: string | null) {
  return useQuery<ProgramTemplate[]>({
    queryKey: ['program-templates', teamId, orgId ?? null],
    enabled: !!teamId || !!orgId,
    queryFn: async () => {
      let team: ProgramTemplate[] = []
      if (teamId) {
        const snap = await getDocs(teamTemplatesCol(teamId))
        team = snap.docs
          .map((d) => ({ ...(d.data() as Omit<ProgramTemplate, 'id'>), id: d.id, scope: 'team' as const }))
          .sort(byName)
      }
      let org: ProgramTemplate[] = []
      if (orgId) {
        try {
          const snap = await getDocs(orgTemplatesCol(orgId))
          org = snap.docs
            .map((d) => ({ ...(d.data() as Omit<ProgramTemplate, 'id'>), id: d.id, scope: 'org' as const }))
            .sort(byName)
        } catch {
          org = []
        }
      }
      return [...team, ...org]
    },
  })
}

/** An org's own templates (org-admin management view). */
export function useOrgProgramTemplates(orgId: string | null) {
  return useQuery<ProgramTemplate[]>({
    queryKey: ['org-program-templates', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const snap = await getDocs(orgTemplatesCol(orgId!))
      return snap.docs
        .map((d) => ({ ...(d.data() as Omit<ProgramTemplate, 'id'>), id: d.id, scope: 'org' as const }))
        .sort(byName)
    },
  })
}

/** ONE template, read directly rather than filtered out of the list — the
 *  standalone editor is deep-linkable, so it must resolve without the list
 *  query having run. */
export function useProgramTemplate(
  scope: 'team' | 'org',
  ownerId: string | null,
  templateId: string | null,
) {
  return useQuery<ProgramTemplate | null>({
    queryKey: ['program-template', scope, ownerId, templateId],
    enabled: !!ownerId && !!templateId,
    queryFn: async () => {
      const snap = await getDoc(templateDoc(scope, ownerId!, templateId!))
      if (!snap.exists()) return null
      return { ...(snap.data() as Omit<ProgramTemplate, 'id'>), id: snap.id, scope }
    },
  })
}

export type TemplateBody = Pick<
  ProgramTemplate,
  'days' | 'tracks' | 'items' | 'timezoneLabel' | 'note'
>

export interface SaveTemplateInput extends TemplateBody {
  /** Omit to create a new template; pass an id to overwrite an existing one. */
  templateId?: string
  name: string
  description?: string
}

function templateDoc(scope: 'team' | 'org', ownerId: string, templateId?: string) {
  const col = scope === 'org' ? orgTemplatesCol(ownerId) : teamTemplatesCol(ownerId)
  return templateId ? doc(col, templateId) : doc(col)
}

/** Create or overwrite a template.
 *
 *  `scope` is where it is SAVED, which is not necessarily where it came from: a
 *  studio that applies an org template and saves it back always produces a team
 *  template — the rules refuse a club write to the org's copy anyway. */
export function useSaveProgramTemplate(scope: 'team' | 'org', ownerId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: SaveTemplateInput) => {
      if (!ownerId) throw new Error('No owner for the template')
      const ref = templateDoc(scope, ownerId, input.templateId)
      await setDoc(
        ref,
        {
          scope,
          ...(scope === 'team' ? { teamId: ownerId } : { orgId: ownerId }),
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          ...(input.timezoneLabel ? { timezoneLabel: input.timezoneLabel } : {}),
          ...(input.note ? { note: input.note } : {}),
          days: input.days,
          tracks: input.tracks,
          items: input.items,
          itemCount: input.items.length,
          updated_at: serverTimestamp(),
          ...(input.templateId ? {} : { created_at: serverTimestamp() }),
        },
        { merge: !!input.templateId },
      )
      return ref.id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program-templates'] })
      qc.invalidateQueries({ queryKey: ['org-program-templates'] })
      qc.invalidateQueries({ queryKey: ['program-template'] })
    },
  })
}

/** Mint an EMPTY template and hand back its id, so the caller can open the
 *  editor on it.
 *
 *  Creating one with no days and no items is the point: a studio authoring its
 *  standard camp agenda in January should not have to invent an event to hang it
 *  on (see ProgramTemplateEditor's header). The empty state that results is a
 *  real one the editor renders and offers to fill. */
export function useCreateProgramTemplate(scope: 'team' | 'org', ownerId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ name, description }: { name: string; description?: string }) => {
      if (!ownerId) throw new Error('No owner for the template')
      const ref = templateDoc(scope, ownerId)
      await setDoc(ref, {
        scope,
        ...(scope === 'team' ? { teamId: ownerId } : { orgId: ownerId }),
        name,
        ...(description ? { description } : {}),
        days: [],
        tracks: [],
        items: [],
        itemCount: 0,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      })
      return ref.id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program-templates'] })
      qc.invalidateQueries({ queryKey: ['org-program-templates'] })
    },
  })
}

export function useRenameProgramTemplate(scope: 'team' | 'org', ownerId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ templateId, name, description }: {
      templateId: string; name: string; description?: string
    }) => {
      if (!ownerId) throw new Error('No owner for the template')
      await updateDoc(templateDoc(scope, ownerId, templateId), {
        name,
        description: description ?? '',
        updated_at: serverTimestamp(),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program-templates'] })
      qc.invalidateQueries({ queryKey: ['org-program-templates'] })
      qc.invalidateQueries({ queryKey: ['program-template'] })
    },
  })
}

export function useDeleteProgramTemplate(scope: 'team' | 'org', ownerId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (templateId: string) => {
      if (!ownerId) throw new Error('No owner for the template')
      await deleteDoc(templateDoc(scope, ownerId, templateId))
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program-templates'] })
      qc.invalidateQueries({ queryKey: ['org-program-templates'] })
      qc.invalidateQueries({ queryKey: ['program-template'] })
    },
  })
}
