'use client'

import { Fragment } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Minus } from 'lucide-react'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { usePlanName } from '@/hooks/usePlanName'
import { PLAN_ORDER, PLAN_PRICING, type SaasPlan } from '@linyup/shared'

// Full feature comparison, ported from the marketing landing
// (apps/landing/src/components/Pricing.astro). Columns follow PLAN_ORDER
// [free, coach, studio, organization]. Cell values: true = ✓, false = —, or a
// sentinel ('unlimited' | 'addon' | 'soon'). The contacts row is computed from
// PLAN_PRICING so the caps can never drift from the billing source of truth.
type Cell = boolean | 'unlimited' | 'addon' | 'soon' | 'limited'

interface CmpRow {
  label: string
  /** Translation key for a small note rendered under the row label. */
  note?: string
  /** Computed from PLAN_PRICING.includedContacts instead of a literal. */
  contacts?: boolean
  values?: Cell[]
}

const GROUPS: { heading: string; rows: CmpRow[] }[] = [
  {
    heading: 'groupUsage',
    rows: [
      { label: 'rowContacts', note: 'contactsNote', contacts: true },
      { label: 'rowMigration', values: [false, true, true, true] },
      { label: 'rowBranding', values: [false, false, true, true] },
      { label: 'rowMembers', values: [false, false, true, true] },
    ],
  },
  {
    heading: 'groupCore',
    rows: [
      { label: 'rowSessions', values: [true, true, true, true] },
      { label: 'rowBookings', values: [true, true, true, true] },
      { label: 'rowBioLink', values: [true, true, true, true] },
      { label: 'rowAppointments', values: [true, true, true, true] },
      { label: 'rowCheckins', values: [true, true, true, true] },
      { label: 'rowMemberships', values: [true, true, true, true] },
      { label: 'rowPayments', values: [true, true, true, true] },
      { label: 'rowAutomations', values: ['limited', 'limited', true, true] },
      { label: 'rowGoals', values: [true, true, true, true] },
      { label: 'rowGroups', values: [false, true, true, true] },
      { label: 'rowCustomFields', values: [false, true, true, true] },
      { label: 'rowPlaces', values: [true, true, true, true] },
      { label: 'rowDocuments', note: 'documentsNote', values: [true, true, true, true] },
      { label: 'rowForms', values: [false, 'addon', true, true] },
      { label: 'rowMobileApp', values: [false, true, true, true] },
      { label: 'rowGamification', values: [false, 'addon', true, true] },
      { label: 'rowReferrals', values: [false, 'addon', true, true] },
      { label: 'rowCourses', values: [false, 'addon', true, true] },
      { label: 'rowWebsite', note: 'websiteNote', values: [false, 'addon', true, true] },
      { label: 'rowCustomDomain', values: [false, true, true, true] },
      { label: 'rowProducts', values: [false, 'addon', true, true] },
      { label: 'rowGiftCards', values: [false, 'addon', true, true] },
      { label: 'rowPromoCodes', values: [false, false, true, true] },
      { label: 'rowFinance', note: 'financeNote', values: [false, 'addon', true, true] },
      { label: 'rowKiosk', note: 'kioskNote', values: [false, false, true, true] },
      { label: 'rowAnalytics', values: [false, false, true, true] },
      { label: 'rowApi', values: [false, false, true, true] },
      { label: 'rowWhatsapp', values: [false, false, 'soon', 'soon'] },
    ],
  },
  {
    heading: 'groupOrg',
    rows: [
      { label: 'rowMultiTeam', values: [false, false, false, true] },
      { label: 'rowCentralAdmin', values: [false, false, false, true] },
      { label: 'rowCrossTeam', values: [false, false, false, true] },
      { label: 'rowPermissions', values: [false, false, false, true] },
    ],
  },
]

export function PlanComparison({ currentPlan }: { currentPlan: SaasPlan | null }) {
  const t = useTranslations('Pricing')
  const planName = usePlanName()
  const currentIdx = currentPlan ? PLAN_ORDER.indexOf(currentPlan) : -1

  // Contacts row — derived from the billing source of truth.
  const contactsValues = PLAN_ORDER.map((p) => {
    const inc = PLAN_PRICING[p].includedContacts
    return inc == null ? t('unlimited') : String(inc)
  })

  const cellContent = (v: Cell | string) => {
    if (v === true)
      return <Check className="mx-auto h-4 w-4 text-emerald-600 dark:text-emerald-400" />
    if (v === false) return <Minus className="mx-auto h-4 w-4 text-muted-foreground/40" />
    if (v === 'unlimited') return <span className="font-medium">{t('unlimited')}</span>
    if (v === 'addon') return <span className="text-xs font-medium">{t('addon')}</span>
    if (v === 'limited') return <span className="text-xs font-medium text-muted-foreground">{t('limited')}</span>
    if (v === 'soon') return <span className="text-xs font-medium text-muted-foreground">{t('soon')}</span>
    return <span className="font-medium">{v}</span>
  }

  const colCls = (idx: number) =>
    idx === currentIdx ? 'bg-primary/5' : undefined

  return (
    <Accordion defaultValue={['compare']} className="w-full">
      <AccordionItem value="compare" className="border-none">
        <AccordionTrigger className="text-primary">
          {t('compareToggle')}
        </AccordionTrigger>
        <AccordionContent>
          <div className="overflow-x-auto">
            {/* `table-fixed` so the declared column widths BIND. Auto layout
                sizes to content, and the contacts note (a long sentence) grew the
                label column until it pushed the plan columns off their share. */}
            <Table className="min-w-[640px] table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[40%]" />
                  {PLAN_ORDER.map((p, i) => (
                    <TableHead
                      key={p}
                      className={`text-center font-semibold text-foreground ${colCls(i)}`}
                    >
                      {planName(p)}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {GROUPS.map((group) => (
                  <Fragment key={group.heading}>
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={PLAN_ORDER.length + 1}
                        className="bg-muted/50 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {t(group.heading)}
                      </TableCell>
                    </TableRow>
                    {group.rows.map((row) => {
                      const values = row.contacts ? contactsValues : row.values!
                      return (
                        <TableRow key={row.label}>
                          <TableCell className="align-top text-sm font-medium">
                            {t(row.label)}
                            {row.note && (
                              <span className="mt-0.5 block text-[0.6875rem] font-normal leading-snug text-balance text-muted-foreground">
                                {t(row.note as Parameters<typeof t>[0])}
                              </span>
                            )}
                          </TableCell>
                          {values.map((v, i) => (
                            <TableCell key={i} className={`text-center text-sm ${colCls(i)}`}>
                              {cellContent(v)}
                            </TableCell>
                          ))}
                        </TableRow>
                      )
                    })}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
