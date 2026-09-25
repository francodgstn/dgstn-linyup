import type { SaasStatus } from '@linyup/shared'
import { Badge } from '@/components/ui/badge'

const VARIANT: Record<SaasStatus, React.ComponentProps<typeof Badge>['variant']> = {
  active: 'success',
  trial: 'default',
  past_due: 'warning',
  cancelled: 'secondary',
  expired: 'destructive',
}

const LABEL: Record<SaasStatus, string> = {
  active: 'Active',
  trial: 'Trial',
  past_due: 'Past due',
  cancelled: 'Canceled',
  expired: 'Expired',
}

export function StatusBadge({ status }: { status: SaasStatus | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>
  return <Badge variant={VARIANT[status]}>{LABEL[status]}</Badge>
}

export function PlanBadge({ plan }: { plan: string | null }) {
  if (!plan) return <span className="text-muted-foreground">—</span>
  return <Badge variant="outline" className="capitalize">{plan}</Badge>
}

// Stripe Connect (member → studio) onboarding status for the operator console.
export type PaymentsStatus =
  | 'enabled'
  | 'restricted'
  | 'pending'
  | 'rejected'
  | 'not_setup'
  | 'disabled'

const PAY_VARIANT: Record<PaymentsStatus, React.ComponentProps<typeof Badge>['variant']> = {
  enabled: 'success',
  restricted: 'warning',
  pending: 'default',
  rejected: 'destructive',
  not_setup: 'outline',
  disabled: 'secondary',
}

const PAY_LABEL: Record<PaymentsStatus, string> = {
  enabled: 'Enabled',
  restricted: 'Restricted',
  pending: 'Pending',
  rejected: 'Rejected',
  not_setup: 'Not set up',
  disabled: 'Disabled',
}

export function PaymentsBadge({ status }: { status: PaymentsStatus | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>
  return <Badge variant={PAY_VARIANT[status]}>{PAY_LABEL[status]}</Badge>
}
