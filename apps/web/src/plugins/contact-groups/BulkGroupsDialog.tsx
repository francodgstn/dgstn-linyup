'use client'

// Group picker used by the contacts list bulk bar — "Add to group" /
// "Remove from group". Selection is applied by the caller (arrayUnion/arrayRemove).

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FolderTree } from 'lucide-react'
import type { ContactGroup } from '@linyup/shared'
import { flattenGroupTree, isDynamicGroup } from './hooks'

export function BulkGroupsDialog({
  open, onOpenChange, mode, groups, count, onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: 'add' | 'remove'
  groups: ContactGroup[]
  count: number
  onConfirm: (groupId: string) => Promise<void>
}) {
  const t = useTranslations('ContactGroups')
  const tContacts = useTranslations('Contacts')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (open) setPicked(null) }, [open])

  const handleConfirm = async () => {
    if (!picked) return
    setBusy(true)
    try { await onConfirm(picked); onOpenChange(false) } finally { setBusy(false) }
  }

  // Manual groups only — a dynamic group has no membership to bulk-write into.
  const flat = flattenGroupTree(groups).filter(({ group }) => !isDynamicGroup(group))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{mode === 'add' ? t('bulkAddTitle') : t('bulkRemoveTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1 py-1 max-h-72 overflow-y-auto">
          {flat.map(({ group, depth }) => (
            <button key={group.id} type="button"
              onClick={() => setPicked(picked === group.id ? null : group.id)}
              style={{ paddingLeft: `${12 + depth * 16}px` }}
              className={`w-full text-left pr-3 py-2 rounded-lg border text-sm transition-colors flex items-center gap-2 ${
                picked === group.id ? 'border-primary bg-primary/5' : 'hover:bg-muted'
              }`}
            >
              <span className="h-2.5 w-2.5 rounded-full shrink-0 border border-border/40"
                style={{ background: group.color ?? 'transparent' }} />
              <span className="font-medium truncate">{group.name}</span>
            </button>
          ))}
          {flat.length === 0 && (
            <div className="text-sm text-muted-foreground text-center py-6 space-y-2">
              <FolderTree className="h-5 w-5 mx-auto opacity-40" />
              <p>{t('noGroupsYet')}</p>
              <Link href={'/plugins/contact-groups' as Route} className="text-primary hover:underline text-xs">
                {t('manageGroups')}
              </Link>
            </div>
          )}
        </div>
        <DialogFooter>
          <button onClick={() => onOpenChange(false)}
            className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">
            {tContacts('cancel')}
          </button>
          <button onClick={handleConfirm} disabled={busy || !picked}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
            {tContacts('bulkApplyTo', { count })}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
