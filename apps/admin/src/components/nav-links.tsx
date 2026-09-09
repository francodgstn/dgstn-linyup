'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Users,
  Boxes,
  MessageSquare,
  Settings,
  HeartPulse,
  Smartphone,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// `Member app` here is for WATCHING it (store presence, adoption, reviews);
// `Settings → Member app` is for CONFIGURING it (the min-version gate, store
// URLs). Same subject, two verbs — the pages link to each other.
const LINKS = [
  { href: '/', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/accounts', label: 'Accounts', icon: Users, exact: false },
  { href: '/health', label: 'Health', icon: HeartPulse, exact: false },
  { href: '/member-app', label: 'Member app', icon: Smartphone, exact: false },
  { href: '/providers', label: 'Providers', icon: Boxes, exact: false },
  { href: '/feedback', label: 'Feedback', icon: MessageSquare, exact: false },
  { href: '/settings', label: 'Settings', icon: Settings, exact: false },
]

export function NavLinks() {
  const pathname = usePathname()
  return (
    <nav className="flex flex-col gap-1">
      {LINKS.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
