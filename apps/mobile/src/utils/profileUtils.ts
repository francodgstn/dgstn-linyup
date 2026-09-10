import { planGrantIsCurrent } from '@linyup/shared';
import { AffiliationSummary, ContactAddress, Contact, RankingSystem } from '../types';

/** What a few helpers below need from `useTranslations(...)` — the caller's
 *  own namespace (these are plain utilities with no namespace of their own). */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** What the badge needs to draw a level, whatever scale it came from. */
export interface ResolvedRank {
  system: RankingSystem | null;
  value: number;
  label: string;
  color: string;
  secondColor?: string;
  emoji?: string;
  imageUrl?: string;
}

/**
 * THE contact's rank — resolved against the tenant's CONFIGURED ranking
 * systems only. No sport-specific fallback: a tenant that has not configured
 * any ranking system simply has nothing to show here, and the caller hides
 * the badge rather than inventing a default belt table.
 *
 * Returns null when there is nothing to show — no systems configured, or no
 * level recorded for the contact.
 */
export function resolvePrimaryRank(
  contact: Pick<Contact, 'ranks'>,
  systems: RankingSystem[] | undefined | null,
): ResolvedRank | null {
  const list = systems ?? [];
  const system = list.find((s) => s.is_primary) ?? list[0] ?? null;
  if (!system) return null;

  const value = contact.ranks?.[system.id];
  if (value == null) return null;
  const level = (system.levels ?? []).find((l) => l.value === value);
  if (!level) return null; // a level the scale no longer defines

  return {
    system,
    value,
    label: level.label,
    color: level.color ?? '#DDDDDD',
    secondColor: level.secondColor,
    emoji: level.emoji,
    imageUrl: level.imageUrl,
  };
}

// Returns white or black text depending on background luminance
export const contrastTextColor = (hex: string) => {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#FFFFFF';
};

export const formatDateValue = (value: unknown) => {
  if (!value) {
    return null;
  }

  let parsed: Date | null = null;

  if (value instanceof Date) {
    parsed = value;
  } else if (typeof value === 'string') {
    const asDate = new Date(value);
    if (!Number.isNaN(asDate.getTime())) {
      parsed = asDate;
    }
  } else if (typeof value === 'number') {
    parsed = new Date(value);
  } else if (typeof value === 'object' && value !== null) {
    const ref: any = value;
    if (typeof ref.toDate === 'function') {
      parsed = ref.toDate();
    } else if (typeof ref.seconds === 'number') {
      parsed = new Date(ref.seconds * 1000);
    } else if (typeof ref._seconds === 'number') {
      parsed = new Date(ref._seconds * 1000);
    }
  }

  return parsed ? parsed.toLocaleDateString() : null;
};

export const calculateAge = (birthdate: unknown): number | null => {
  let parsed: Date | null = null;

  if (birthdate instanceof Date) {
    parsed = birthdate;
  } else if (typeof birthdate === 'string') {
    const d = new Date(birthdate);
    if (!Number.isNaN(d.getTime())) parsed = d;
  } else if (typeof birthdate === 'number') {
    parsed = new Date(birthdate);
  } else if (typeof birthdate === 'object' && birthdate !== null) {
    const ref: any = birthdate;
    if (typeof ref.toDate === 'function') parsed = ref.toDate();
    else if (typeof ref.seconds === 'number') parsed = new Date(ref.seconds * 1000);
    else if (typeof ref._seconds === 'number') parsed = new Date(ref._seconds * 1000);
  }

  if (!parsed) return null;

  const today = new Date();
  let age = today.getFullYear() - parsed.getFullYear();
  const monthDiff = today.getMonth() - parsed.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < parsed.getDate())) {
    age--;
  }
  return age >= 0 ? age : null;
};

export const formatGender = (t: Translate, gender?: string): string | null => {
  if (!gender) return null;
  if (gender === 'M') return t('genderM');
  if (gender === 'F') return t('genderF');
  return gender;
};

/** `Contact.address` — narrower than the pre-migration `residence` (no
 *  region/country; see @linyup/shared's `ContactAddress`). */
export const formatAddress = (address?: ContactAddress | null) => {
  if (!address) {
    return null;
  }

  const firstLine = [address.route, address.street_number].filter(Boolean).join(' ').trim();
  const secondLine = [address.postal_code, address.locality].filter(Boolean).join(' ').trim();

  const lines = [firstLine, secondLine].filter(Boolean);

  return lines.length ? lines.join(', ') : null;
};

// ── Affiliation helpers ──────────────────────────────────────────────────────

/** Returns a short display label for the affiliation badge on the card. When
 *  there is exactly one active type, its name is the studio's own affiliation
 *  type identifier (Firestore-authored) and is never translated — only the
 *  "not affiliated" / "affiliated (N)" states are app copy. */
export const getAffiliationLabel = (t: Translate, summary?: AffiliationSummary): string => {
  if (!summary || !summary.has_active) return t('notAffiliated').toUpperCase();
  if (summary.types.length === 1) return summary.types[0].replace(/_/g, ' ').toUpperCase();
  return t('affiliatedCount', { count: summary.types.length }).toUpperCase();
};

/** Returns badge background/text colors for the affiliation badge. */
export const getAffiliationColors = (
  summary?: AffiliationSummary,
  themeColors?: any,
): { bg: string; text: string } => {
  if (summary?.has_active) return { bg: '#4CAF50', text: '#FFFFFF' };
  return {
    bg: themeColors?.surfaceVariant ?? '#E8E8E8',
    text: themeColors?.onSurfaceVariant ?? '#555555',
  };
};

type AffiliationTermLocale = 'en' | 'de' | 'fr' | 'it';

/**
 * Resolve the organisation's affiliation-concept label (`TeamPublicProfile
 * .affiliation_term`, e.g. "Membership", "Lizenz") for the device's language,
 * falling back to English then to the generic "Affiliation" — same rule the
 * org-facing web surfaces apply. `locale` is injectable for tests; defaults to
 * the device locale.
 */
export function resolveAffiliationTerm(
  term: Partial<Record<AffiliationTermLocale, string>> | null | undefined,
  locale: string = Intl.DateTimeFormat().resolvedOptions().locale ?? 'en',
): string {
  if (!term) return 'Affiliation';
  const short = locale.slice(0, 2).toLowerCase() as AffiliationTermLocale;
  return term[short] ?? term.en ?? 'Affiliation';
}

/**
 * The plan name to show a member — read off the contact's own denormalised
 * subscription snapshot, never from `teams/{id}/subscription_types/*` (rule-
 * denied to a contact session). Prefers the matching `active_subscriptions`
 * entry; falls back to the single-field snapshot for a manually-assigned
 * subscription that has no Stripe-maintained array entry yet.
 */
export function resolveSubscriptionTypeName(
  contact: Pick<
    Contact,
    'active_subscriptions' | 'subscription_type_id' | 'subscription_type_name' | 'subscription_expires_at'
  >,
): string | null {
  const active = contact.active_subscriptions ?? [];
  const matching = contact.subscription_type_id
    ? active.find((s) => s.subscription_type_id === contact.subscription_type_id)
    : undefined;
  const live = matching?.subscription_type_name ?? active[0]?.subscription_type_name;
  if (live != null) return live;
  // The flat grant ("2 months included") — a name only while it still COVERS
  // her, the same `planGrantIsCurrent` comparison the booking gate and the
  // Space's membership card make. This copy had no date check at all, so a
  // lapsed grant read as the member's current plan in the app alone.
  return planGrantIsCurrent(contact) ? (contact.subscription_type_name ?? null) : null;
}
