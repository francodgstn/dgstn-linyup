import type { Timestamp } from './common'
import type { Benefit } from './benefit'

// 'org' is reserved for a future slice where a parent org publishes courses to all
// member teams. MVP only writes 'team'.
export type CourseScope = 'team' | 'org'

export type CourseStatus = 'draft' | 'published' | 'archived'

export type LessonType = 'text' | 'audio' | 'video'

// Where a lesson's media comes from. 'upload' = a Firebase Storage download URL;
// everything else is an external embed/link.
//
// VIDEO IS EMBED-ONLY (2026-09-11): `storage.rules` refuses `video/*` uploads
// and the editor offers no upload for a video lesson — a hosted video is billed
// per byte delivered to every member who watches it, which is the largest line
// on a studio's bill (docs/scalability-2026-09.md §12). 'upload' therefore
// means AUDIO today; a video lesson stored with 'upload' predates the rule and
// still plays. Hosted video, if it comes, is a paid add-on on zero-egress
// infrastructure, not this bucket.
export type MediaSource = 'youtube' | 'vimeo' | 'url' | 'upload'

// Access gating for a course, enforced by Firestore/Storage rules and the public
// Space web area:
//  - 'free'         → open to anyone, no login (incl. media)
//  - 'registered'   → any signed-in contact of the team (display: "Sign-in required");
//                     does NOT require an active membership
//  - 'subscription' → a signed-in contact whose subscription_type_id is one of
//                     subscriptionTypeIds
//  - 'purchase'     → sold one-off in the shop for `priceAmount`. A signed-in contact
//                     gains lifetime access once they buy it (a course_purchases
//                     entitlement doc), OR for free if their subscription_type_id is one
//                     of subscriptionTypeIds (optional "included free for these subs").
// subscriptionTypeIds is an array so it is ready for the planned move to multiple
// concurrent active subscriptions per contact.
export interface CourseAccessRule {
  type: 'free' | 'registered' | 'subscription' | 'purchase'
  // THE GATE, on both plan-bearing tiers: the subs whose members get this course
  // FREE. On 'subscription' that is the only way in; on 'purchase' everyone else
  // buys it once. Additive with `benefit` (which prices it for the subs that get
  // it merely CHEAPER) and free wins where a sub is on both.
  subscriptionTypeIds?: string[] // team subscription_types ids
  // 'purchase' only: one-off price in the team's default currency (major units, e.g. 29.9).
  priceAmount?: number
}

// True when a course is sold one-off in the shop (has a 'purchase' rule + a price).
export function isSellableCourse(c: Pick<Course, 'accessRule'>): boolean {
  return c.accessRule.type === 'purchase' && typeof c.accessRule.priceAmount === 'number'
}

export interface Course {
  id: string
  scope: CourseScope // 'team' for MVP
  teamId: string // owner team (always set; org courses also carry orgId later)
  orgId?: string // reserved; unset in MVP
  title: string
  slug: string
  summary?: string
  coverImageUrl?: string
  status: CourseStatus
  accessRule: CourseAccessRule // default { type: 'registered' }
  // THE RATE: ONE price rule over the purchase price, naming the subs whose
  // holders get the course CHEAPER — the middle ground the free-or-full gate
  // above cannot express. Same shape and same one-rule-per-offering limit as
  // `Activity.memberBenefit`: every sub on it shares the one percentage.
  //
  // A benefit with effect 'included' is the LEGACY spelling of the gate, still
  // honoured by both rule files and by resolvePaymentOptions; the plan editor
  // reads it as part of the gate and absorbs it on first write. History: until
  // 2026-09-01 a benefit SUPPRESSED the gate list, which contradicted
  // firestore.rules — see the course arm of resolvePaymentOptions.
  benefit?: Benefit | null
  // When true, the course is omitted from the public shop catalogue
  // (/public/{slug}/shop). It stays openable via a direct link and still shows in a
  // contact's Space "My courses" if they have access. Absent ⇒ visible in the shop.
  hideFromShop?: boolean
  // Denormalised counters — maintained client-side, used for usage limits + list UI.
  moduleCount?: number
  lessonCount?: number
  order?: number
  created_at: Timestamp
  updated_at: Timestamp
  createdBy: string
  archived_at?: Timestamp | null
}

// Subcollection: courses/{courseId}/purchases/{contactId}
//
// A lifetime entitlement written by the Connect webhook when a contact buys a
// 'purchase'-tier course one-off. The doc id is the buyer's contactId, so a grant is
// idempotent. Security rules check `exists()` on this doc to unlock the course.
export interface CoursePurchase {
  courseId: string
  teamId: string
  contactId: string
  paymentIntentId?: string | null
  // PROVENANCE. The doc id is the CONTACT, so it proves nothing about WHICH
  // payment granted access — this does. Stamped by the one writer,
  // grantCourseEntitlement, on every rail; a reversal deletes the entitlement
  // only when it matches the payment being reversed, and reports
  // `skipped_not_owner` otherwise (a later purchase, a manual grant, or a
  // gift-card-funded one must survive a refund of some other charge).
  payment_ref?: string | null
  /** Rail label: 'manual' | 'stripe_connect' | 'gift_card' | … */
  source?: string
  amount?: number | null // charged amount in Rappen (minor units), as on member_payments
  currency?: string | null
  purchasedAt: Timestamp
}

// Subcollection: courses/{courseId}/modules
export interface CourseModule {
  id: string
  courseId: string
  teamId: string
  title: string
  summary?: string
  order: number
  created_at: Timestamp
  updated_at: Timestamp
}

// A downloadable resource attached to a lesson (PDF, image, etc.).
export interface LessonAttachment {
  name: string
  url: string
  size?: number // bytes
  contentType?: string
}

// Subcollection: courses/{courseId}/lessons
//
// A lesson is mixed content (as in most LMS): a rich-text body is always
// available, an optional "featured" media clip (video/audio) can sit alongside
// it, and any number of downloadable attachments can be added. `type` is the
// primary format, derived from the featured media — used for the list icon.
export interface Lesson {
  id: string
  courseId: string
  moduleId: string
  teamId: string
  title: string
  type: LessonType
  order: number
  // rich body — always available regardless of type
  body?: string // rich text (HTML, produced by the shared RichTextEditor)
  // optional featured media (when type is 'audio' | 'video')
  mediaSource?: MediaSource
  mediaUrl?: string // external URL or Storage download URL
  durationSeconds?: number
  // downloadable resources
  attachments?: LessonAttachment[]
  isPreview?: boolean // reserved for future gated preview
  created_at: Timestamp
  updated_at: Timestamp
}
