import { heldMemberships, resolveAffiliationTerm as resolveSharedAffiliationTerm, type AffiliationTerm } from '@linyup/shared';
import { AffiliationSummary, ContactAddress, Contact } from '../types';

/** What a few helpers below need from `useTranslations(...)` — the caller's
 *  own namespace (these are plain utilities with no namespace of their own). */
type Translate = (key: string, values?: Record<string, string | number>) => string;

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

/**
 * The organisation's affiliation-concept label (`TeamPublicProfile
 * .affiliation_term`, e.g. "Membership", "Lizenz") — THE shared fallback chain
 * (`resolveAffiliationTerm` in @linyup/shared, the same one the org-facing web
 * surfaces run), asked for the DEVICE's language. That default is this app's
 * only contribution; rewiring it to the app's chosen locale is a separate,
 * behaviour-changing step (docs/scalability-2026-09.md item 29). `locale` is
 * injectable for tests.
 */
export function resolveAffiliationTerm(
  term: AffiliationTerm | null | undefined,
  locale: string = Intl.DateTimeFormat().resolvedOptions().locale ?? 'en',
): string {
  return resolveSharedAffiliationTerm(term, locale);
}

/** What the profile's plan row shows. */
export interface HeldPlanSummary {
  /** The first plan's name, with `+N` when the member holds more than one. */
  name: string | null;
  /** The plan's billing rhythm — only when there is exactly one to name. */
  recurrence: string | null;
}

/**
 * The plans to show a member — read off the contact's own plan list
 * (`held_plans`, docs/multi-plan-holdings.md), never from
 * `teams/{id}/subscription_types/*` (rule-denied to a contact session).
 * `heldMemberships` is the one display definition of "subscribed" that the
 * web header, contacts list and member Space also read, so a lapsed grant or
 * an ended subscription drops out here exactly as it does there, and a second
 * plan is counted rather than hidden. Credit packs are not memberships.
 */
export function resolveHeldPlanSummary(
  contact: Pick<Contact, 'held_plans'>,
  nowMs: number = Date.now(),
): HeldPlanSummary {
  const plans = heldMemberships(contact, nowMs);
  if (plans.length === 0) return { name: null, recurrence: null };
  const first = plans[0].subscription_type_name || plans[0].subscription_type_id;
  if (plans.length === 1) return { name: first, recurrence: plans[0].recurrence ?? null };
  return { name: `${first} +${plans.length - 1}`, recurrence: null };
}
