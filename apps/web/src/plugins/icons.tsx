// THE plugin icon map.
//
// A manifest names its icon as a STRING (`iconName`, and `navContributions[].icon`)
// because manifests are plain data — they are read by catalogues, by the sidebar
// and by the org console, and a component reference would drag lucide into every
// one of them. Something has to turn the string back into a component, and that
// something used to be three separate maps: the sidebar's, the studio
// marketplace's and the org catalogue's.
//
// They had already drifted. The org catalogue's copy was missing Tag, ListPlus,
// ClipboardList, FileText and Monitor, so five plugins quietly rendered a
// fallback puzzle piece on that page and nowhere else — the failure mode of a
// hand-maintained map is silent, which is why one map is worth the indirection.
//
// ── WHY NOT RESOLVE ANY LUCIDE NAME AT RUNTIME ───────────────────────────────
// `DynamicIcon` (components/ui/icon-picker) does exactly that and would delete
// this file — but it reaches it via `import * as LucideIcons`, which pulls the
// entire icon set into whatever bundle imports it. One of the three call sites
// is the authenticated layout, the hottest bundle in the app. So: an explicit
// map, and a new plugin adds its icon here. Do not "simplify" this to the
// dynamic resolver without measuring that bundle.
import {
  Award,
  BadgePercent,
  Boxes,
  Calculator,
  ClipboardList,
  Dumbbell,
  FileText,
  FolderTree,
  Gift,
  Globe,
  GraduationCap,
  HeartPulse,
  ListPlus,
  MessageCircle,
  Monitor,
  Puzzle,
  Settings2,
  Shield,
  Sparkles,
  Tag,
  Trophy,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export const PLUGIN_ICON_MAP: Record<string, LucideIcon> = {
  Award,
  BadgePercent,
  Boxes,
  Calculator,
  ClipboardList,
  Dumbbell,
  FileText,
  FolderTree,
  Gift,
  Globe,
  GraduationCap,
  HeartPulse,
  ListPlus,
  MessageCircle,
  Monitor,
  Puzzle,
  Settings2,
  Shield,
  Sparkles,
  Tag,
  Trophy,
  Zap,
}

/** Renders a manifest's named icon, falling back to a neutral puzzle piece for
 *  a name nobody added above. */
export function PluginIcon({ name, className }: { name: string; className?: string }) {
  const Icon = PLUGIN_ICON_MAP[name] ?? Puzzle
  return <Icon className={className} />
}
