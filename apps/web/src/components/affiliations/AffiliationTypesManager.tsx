'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  updateDoc,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  TEAMS_COLLECTION,
  AFFILIATION_TYPES_SUBCOLLECTION,
  planSupportsAffiliations,
} from '@linyup/shared'
import type { Team, AffiliationType, AffiliationIssuer } from '@linyup/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Plus, Pencil, Trash2 } from 'lucide-react'

/**
 * Manage the team's affiliation TYPES (e.g. club membership, federation licence).
 * Lives under Offer → Affiliations. Plan-gated (Studio+); below that it shows an
 * upsell. The `affiliations_enabled` toggle gates the type management surface.
 *
 * Extracted from the former Settings → Team → "Affiliations" tab.
 */
export function AffiliationTypesManager({ team, teamId }: { team: Team; teamId: string }) {
  const t = useTranslations('TeamAffiliationTypes')
  const tSettings = useTranslations('TeamSettings')
  const qc = useQueryClient()

  const { data: types = [], isLoading } = useQuery<AffiliationType[]>({
    queryKey: ['team-affiliation-types', teamId],
    queryFn: async () => {
      const snap = await getDocs(
        collection(db, TEAMS_COLLECTION, teamId, AFFILIATION_TYPES_SUBCOLLECTION)
      )
      return snap.docs
        .map((d) => ({ ...d.data(), id: d.id }) as AffiliationType)
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    },
    staleTime: 5 * 60_000,
  })

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AffiliationType | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AffiliationType | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }
  function invalidate() {
    qc.invalidateQueries({ queryKey: ['team-affiliation-types', teamId] })
  }

  function AffTypeDialog() {
    const [key, setKey] = useState(editing?.key ?? '')
    const [label, setLabel] = useState(editing?.label ?? '')
    const [defaultIssuer, setDefaultIssuer] = useState<AffiliationIssuer>(
      editing?.default_issuer ?? 'team'
    )
    const [validityMonths, setValidityMonths] = useState(
      editing?.default_validity_months?.toString() ?? ''
    )
    const [feeAmount, setFeeAmount] = useState(editing?.fee_amount?.toString() ?? '')
    const [issuerUrl, setIssuerUrl] = useState(editing?.issuer_url ?? '')
    const [active, setActive] = useState(editing?.active ?? true)
    const [saving, setSaving] = useState(false)

    async function handleSave() {
      if (!key.trim() || !label.trim()) return
      setSaving(true)
      try {
        const id =
          editing?.id ??
          `${key
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '_')
            .replace(/[^a-z0-9_]/g, '')}_${Date.now()}`
        const payload: Omit<AffiliationType, 'id'> = {
          key: key.trim(),
          label: label.trim(),
          default_issuer: defaultIssuer,
          ...(validityMonths ? { default_validity_months: Number(validityMonths) } : {}),
          ...(feeAmount ? { fee_amount: Number(feeAmount) } : {}),
          ...(issuerUrl.trim() ? { issuer_url: issuerUrl.trim() } : {}),
          active,
          order: editing?.order ?? types.length,
        }
        await setDoc(
          doc(db, TEAMS_COLLECTION, teamId, AFFILIATION_TYPES_SUBCOLLECTION, id),
          payload,
          { merge: true }
        )
        // DEFINING A TYPE IS THE DECISION. `Team.affiliations_enabled` is still
        // the gate four callables and `completeSignup` refuse on — it is not
        // going away — but nobody should have to answer "do you want this?"
        // twice, once as a switch and once by naming the thing they want. The
        // flag is now DERIVED from the act, so the switch could go.
        //
        // Never written false here: removing the last type does not revoke the
        // affiliations a team already granted, and a flag that flickered off
        // would refuse the callables that maintain them.
        if (!team.affiliations_enabled) {
          await updateDoc(doc(db, TEAMS_COLLECTION, teamId), { affiliations_enabled: true })
          qc.invalidateQueries({ queryKey: ['team', teamId] })
        }
        invalidate()
        showToast(t('saved'))
        setFormOpen(false)
        setEditing(null)
      } finally {
        setSaving(false)
      }
    }

    return (
      <Dialog
        open={formOpen}
        onOpenChange={(v) => {
          if (!v) {
            setFormOpen(false)
            setEditing(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? t('editTitle') : t('addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>{t('keyLabel')}</Label>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={t('keyPlaceholder')}
                disabled={!!editing}
              />
              <p className="text-xs text-muted-foreground">{t('keyHelp')}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t('labelLabel')}</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t('labelPlaceholder')}
                autoFocus={!editing}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('issuerLabel')}</Label>
              <Select
                value={defaultIssuer}
                onValueChange={(v) => setDefaultIssuer(v as AffiliationIssuer)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="team">{t('issuer_team')}</SelectItem>
                  <SelectItem value="org">{t('issuer_org')}</SelectItem>
                  <SelectItem value="external">{t('issuer_external')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('defaultValidityLabel')}</Label>
              <Input
                type="number"
                min={0}
                value={validityMonths}
                onChange={(e) => setValidityMonths(e.target.value)}
                placeholder={t('defaultValidityPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('feeAmountLabel')}</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={feeAmount}
                onChange={(e) => setFeeAmount(e.target.value)}
                placeholder={t('feeAmountPlaceholder')}
              />
              <p className="text-xs text-muted-foreground">{t('feeAmountHelp')}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t('issuerUrlLabel')}</Label>
              <Input
                type="url"
                value={issuerUrl}
                onChange={(e) => setIssuerUrl(e.target.value)}
                placeholder={t('issuerUrlPlaceholder')}
              />
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="h-4 w-4 rounded border-input accent-primary"
              />
              {t('activeLabel')}
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setFormOpen(false)
                setEditing(null)
              }}
              disabled={saving}
            >
              {t('cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving || !key.trim() || !label.trim()}>
              {saving ? '…' : t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  if (!planSupportsAffiliations(team.plan ?? null)) {
    return (
      <div className="rounded-lg border border-dashed py-10 text-center text-muted-foreground text-sm">
        <p>{tSettings('affiliationsUpsell')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">{t('description')}</p>
            <div className="flex items-center gap-3 shrink-0">
              {/* The link out to the roster is gone: this manager now opens FROM
                  the roster, so it would point at the page it is sitting on
                  top of. */}
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null)
                  setFormOpen(true)
                }}
              >
                <Plus className="h-4 w-4 mr-1.5" />
                {t('addButton')}
              </Button>
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : types.length === 0 ? (
            <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              {t('noTypes')}
            </div>
          ) : (
            <div className="divide-y rounded-md border">
              {types.map((at) => (
                <div key={at.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{at.label}</p>
                    <p className="text-xs text-muted-foreground font-mono">{at.key}</p>
                  </div>
                  <Badge variant="outline" className="text-xs shrink-0">
                    {t(`issuer_${at.default_issuer}` as 'issuer_team')}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      setEditing(at)
                      setFormOpen(true)
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setDeleteTarget(at)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}

      {formOpen && <AffTypeDialog />}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmDeleteMessage')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteTarget) return
                await deleteDoc(
                  doc(db, TEAMS_COLLECTION, teamId, AFFILIATION_TYPES_SUBCOLLECTION, deleteTarget.id)
                )
                invalidate()
                showToast(t('deleted'))
                setDeleteTarget(null)
              }}
            >
              {t('deleteButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {toast && (
        <div className="fixed bottom-4 right-4 px-4 py-2.5 rounded-lg shadow-lg text-sm text-white bg-green-600 z-50">
          {toast}
        </div>
      )}
    </div>
  )
}

// `AffiliationsPage` lived here as the wrapper the "Plans & affiliations" tab
// rendered — a skeleton, a payments link and this manager. The tab is gone
// (the manager opens from the roster now), so the wrapper had no caller and is
// removed rather than left as a second, unreachable way to mount this.
