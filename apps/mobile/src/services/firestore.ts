import { db, getFunctions } from '../config/firebase';
import { doc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs, collectionGroup, orderBy, Timestamp, addDoc, serverTimestamp, limit, writeBatch } from 'firebase/firestore';
import { CONTACTS_COLLECTION, SESSIONS_COLLECTION, TEAMS_COLLECTION, PARTICIPANTS_SUBCOLLECTION, densifyWeeklyCounts, isoWeekKeysBack } from '@linyup/shared';
import {
  Contact,
  TeamPublicProfile,
  ReferralInfo,
  HydratedSession,
  WeeklyReport,
  ContactAlert,
  Leaderboard,
  GamificationSettings,
  Goal,
  GoalCreatedBy,
  GoalEvaluation,
  GoalType,
  PerformanceCheckin,
  PerformanceIndicator,
  AppointmentWithStatus,
  ListAvailabilityCoach,
  MyBookingsResult,
  MobileAppTelemetry,
  RankingSystem,
  SessionParticipationStatus,
} from '../types';
import { detectPerformanceProfile, resolveCoachingDimensions, resolveGoalCategories } from '../utils/goalContract';
import { readAlert, alertIsFired, RawContactAlert } from '../utils/contactAlerts';
import { mapPublicProfileMirror } from '../utils/publicProfileMapper';
import { resolveAffiliationTerm } from '../utils/profileUtils';
import { httpsCallable } from 'firebase/functions';
import { SESSION_MIRROR_TYPE } from './sessionMirror';

export { SESSION_MIRROR_TYPE };

/** Sessions live at `sessions/{sessionId}/bookings/{contactId}` — no shared
 *  path constant exists for this subcollection yet (functions code keeps it
 *  as a local literal too — see packages/functions/src/booking/myBookings.ts). */
const BOOKINGS_SUBCOLLECTION = 'bookings';
const PUBLIC_PROFILE_SUBCOLLECTION = 'public_profile';

/** Map one `sessions/{id}/public_profile/{id}` mirror doc to the app's view. */
function mapSessionPublicProfile(sessionId: string, data: Record<string, unknown>): HydratedSession {
  const start = data.start as { toDate?: () => Date } | undefined;
  const end = data.end as { toDate?: () => Date } | undefined;
  return {
    id: sessionId,
    activityId: data.activityId as string | undefined,
    activityName: (data.activityName as string) || '',
    teamId: data.teamId as string,
    start: start?.toDate?.() || new Date(data.start as any),
    end: end?.toDate?.() || new Date(data.end as any),
    location: data.location as string | null | undefined,
    providerName: data.providerName as string | undefined,
    allowBooking: data.allowBooking as boolean | undefined,
  };
}

export const FirestoreService = {
  /**
   * Ask for this account to be closed. Nothing is destroyed — the server only
   * schedules it, and the account keeps working for the whole window. See
   * packages/functions/src/contacts/selfDeletion.ts.
   */
  async requestAccountDeletion(): Promise<{ scheduledForMs: number; graceDays: number }> {
    const fn = httpsCallable<Record<string, never>, { scheduledForMs: number; graceDays: number }>(
      getFunctions(),
      'requestContactDeletion'
    );
    const res = await fn({});
    return res.data;
  },

  /** Change your mind, any time before the sweep actually runs. */
  async cancelAccountDeletion(): Promise<void> {
    const fn = httpsCallable(getFunctions(), 'cancelContactDeletion');
    await fn({});
  },

  // Send verification code via existing membership signup function
  async sendVerificationCode(
    email: string,
    teamId?: string
  ): Promise<{
    codeId: string;
    expiresAt: number;
    matchedContacts?: any[];
    teamSummaries?: { id: string; name: string }[] | null;
  }> {
    try {
      const sendContactVerificationCode = httpsCallable(
        getFunctions(),
        'sendContactVerificationCode'
      );

      const payload: { email: string; teamId?: string } = {
        email: email.toLowerCase(),
      };

      if (teamId) {
        payload.teamId = teamId;
      }

      const result = await sendContactVerificationCode(payload);

      return result.data as any;
    } catch (error) {
      console.error('Error sending verification code:', error);
      throw error;
    }
  },

  // Verify code and log in via loginContactWithCode (validates OTP + mints session).
  // Always sent as the mobile client (`client: 'mobile'`) — the ONE thing that
  // separates the app's login from the web Space's: it activates the
  // `member_app` plan gate server-side (packages/functions/src/auth/loginContactWithCode.ts).
  async verifyCode(codeId: string, code: string, selectedContactId?: string): Promise<{
    verified: boolean;
    email: string;
    requiresSignup?: boolean;
    matchedContacts?: Contact[];
    requiresContactSelection?: boolean;
    customToken?: string | null;
    sessionExpires?: number | null;
    contact?: Contact | null;
    teamSummaries?: { id: string; name: string }[] | null;
    /** Every match existed, but none of their teams' plans include the member
     *  app — no session was minted. See AuthContext / LoginScreen for how this
     *  is surfaced. */
    appNotIncluded?: boolean;
    teams?: { teamId: string; teamName: string | null; slug: string | null }[];
  }> {
    try {
      const loginContactWithCode = httpsCallable(getFunctions(), 'loginContactWithCode');

      const result = await loginContactWithCode({
        codeId,
        code,
        selectedContactId,
        client: 'mobile',
      });

      const data = result.data as any;

      // loginContactWithCode returns customToken+contact on success,
      // requiresContactSelection for multi-match, requiresSignup for no match,
      // or appNotIncluded when every match's team lacks the member_app plan
      // feature. Map to the shape AuthContext expects.
      if (data.appNotIncluded) {
        return { verified: true, email: data.email ?? '', appNotIncluded: true, teams: data.teams ?? [] };
      }
      if (data.customToken) {
        return { verified: true, email: data.email ?? '', ...data };
      }
      if (data.requiresContactSelection) {
        return { verified: true, email: data.email ?? '', ...data };
      }
      if (data.requiresSignup) {
        return { verified: true, email: data.email ?? '', requiresSignup: true };
      }

      return { verified: false, email: data.email ?? '' };
    } catch (error) {
      console.error('Error verifying code:', error);
      throw error;
    }
  },

  // Get contact profile (requires authenticated session with custom claims)
  async getContact(contactId: string): Promise<Contact | null> {
    try {
      const contactRef = doc(db, CONTACTS_COLLECTION, contactId);
      const contactSnap = await getDoc(contactRef);

      if (!contactSnap.exists()) {
        return null;
      }

      const data = contactSnap.data();
      return {
        id: contactSnap.id,
        ...data,
        // Normalise legacy contacts: teacher field is the old name for teamId
        teamId: data.teamId || data.teacher || undefined,
      } as Contact;
    } catch (error) {
      console.error('Error fetching contact:', error);
      return null;
    }
  },

  // Get the team's public profile — the ONE world-readable mirror a contact
  // session may read. Everything the member surfaces need that used to live on
  // `teams/{id}` or `organizations/{id}` (ranking systems, affiliation term,
  // gamification settings, coaching axes, goal categories) is denormalised onto
  // this doc by syncTeamPublicProfile precisely so a contact session — which has
  // no `team_members` row and fails every `teams/`/`organizations/` rule check —
  // never needs to read those collections at all.
  async getTeamPublicProfile(teamId: string): Promise<TeamPublicProfile | null> {
    try {
      const publicProfileRef = doc(db, TEAMS_COLLECTION, teamId, PUBLIC_PROFILE_SUBCOLLECTION, teamId);
      const profileSnap = await getDoc(publicProfileRef);
      if (!profileSnap.exists()) {
        return null;
      }
      return mapPublicProfileMirror(teamId, profileSnap.data());
    } catch (error) {
      console.error('Error fetching team public profile:', error);
      return null;
    }
  },

  /**
   * The ranking systems that apply to a team — already the EFFECTIVE list
   * (the organisation's when it has any, otherwise the team's own), computed
   * server-side by `syncTeamPublicProfile` and mirrored onto `public_profile`.
   * No client-side org lookup needed or possible (a contact session cannot
   * read `organizations/{id}`).
   */
  async getRankingSystems(teamId: string): Promise<RankingSystem[]> {
    const profile = await this.getTeamPublicProfile(teamId);
    return profile?.ranking_systems ?? [];
  },

  async getOrgAffiliationTerm(teamId: string): Promise<string> {
    const profile = await this.getTeamPublicProfile(teamId);
    return resolveAffiliationTerm(profile?.affiliation_term);
  },

  // Get all contacts for an email (for managing multiple contacts)
  async getContactsByEmail(email: string): Promise<Contact[]> {
    try {
      const contactsRef = collection(db, CONTACTS_COLLECTION);
      const q = query(contactsRef, where('email', '==', email.toLowerCase()));
      const querySnapshot = await getDocs(q);

      return querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as Contact));
    } catch (error) {
      console.error('Error fetching contacts by email:', error);
      return [];
    }
  },

  async switchContact(contactId: string): Promise<{
    customToken: string;
    sessionExpires: number;
    contact: Contact;
  } | null> {
    try {
      const switchActiveContact = httpsCallable(
        getFunctions(),
        'switchActiveContact'
      );

      // `client: 'mobile'` activates the same member_app plan gate the login
      // applies (packages/functions/src/contacts/switchActiveContact.ts).
      const result = await switchActiveContact({ contactId, client: 'mobile' });

      return result.data as any;
    } catch (error) {
      // The plan gate's refusal carries a member-facing message — let it reach
      // the screen (AuthContext.selectContact's catch) instead of collapsing
      // into the generic "failed to switch".
      if ((error as { details?: { reason?: string } })?.details?.reason === 'app_not_included') throw error;
      console.error('Error switching contact:', error);
      return null;
    }
  },

  // (`getActiveTeams` — an anonymous, UNFILTERED read of every public_profile
  // mirror on the platform (sessions, activities, courses, everything), made on
  // every login-screen mount just to name studios — is gone. The names now come
  // from `sendContactVerificationCode`'s `teamSummaries`, which the server
  // resolves for exactly the teams the email belongs to.)

  // Get QR code data for check-in (calls getContactQR cloud function)
  async getContactQR(): Promise<{
    success: boolean;
    contactId: string;
    hash: string;
    qrData: string;
    contact: {
      firstname: string;
      lastname: string;
      avatar_url: string | null;
    };
  } | null> {
    try {
      const getContactQRFn = httpsCallable(getFunctions(), 'getContactQR');
      const result = await getContactQRFn({});
      return result.data as any;
    } catch (error) {
      console.error('Error getting membership QR:', error);
      return null;
    }
  },

  // Update the weight field on a contact document
  async updateContactWeight(contactId: string, weight: number): Promise<void> {
    const contactRef = doc(db, CONTACTS_COLLECTION, contactId);
    await updateDoc(contactRef, { weight });
  },

  /**
   * Record that the contact was seen (app came to foreground). Writes EXACTLY
   * the self-update rules arm admits — `last_seen_at` + `mobile_app` — nothing
   * else at top level. See `Contact.mobile_app` (MobileAppTelemetry) in
   * @linyup/shared and the matching `hasOnly([...])` clause in firestore.rules.
   */
  async updateLastSeen(contactId: string, telemetry?: MobileAppTelemetry): Promise<void> {
    const contactRef = doc(db, CONTACTS_COLLECTION, contactId);
    await updateDoc(contactRef, {
      last_seen_at: serverTimestamp(),
      ...(telemetry ? { mobile_app: telemetry } : {}),
    });
  },

  // Get upcoming sessions for a team from the public_profile mirror
  async getUpcomingSessions(teamId: string, date: Date = new Date()): Promise<HydratedSession[]> {
    try {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const upperLimit = new Date(startOfDay);
      upperLimit.setMonth(upperLimit.getMonth() + 3);

      const publicProfileSnapshot = await getDocs(
        query(
          collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
          where('teamId', '==', teamId),
          where('type', '==', SESSION_MIRROR_TYPE),
          where('start', '>=', Timestamp.fromDate(startOfDay)),
          where('start', '<=', Timestamp.fromDate(upperLimit)),
          orderBy('start', 'asc'),
          limit(200)
        )
      );

      return publicProfileSnapshot.docs
        .map(docSnap => mapSessionPublicProfile(docSnap.ref.path.split('/')[1], docSnap.data()))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
    } catch (error) {
      console.error('Error fetching upcoming sessions:', error);
      return [];
    }
  },

  // Get attended sessions for a contact within a date range. Attendance is a
  // fact the member surface cannot get from `getMyBookings` (that callable
  // answers UPCOMING bookings only), so this is the one place a per-session
  // fan-out remains legitimate — it checks her own `participants` doc, which
  // firestore.rules permits for a contact session (doc id == her contactId).
  async getContactAttendance(
    contactId: string,
    startDate: Date,
    endDate: Date,
    teamId?: string
  ): Promise<HydratedSession[]> {
    try {
      const sessions = await this.getTeamSessionsInRange(teamId ?? '', startDate, endDate);

      const attendedSessions: HydratedSession[] = [];
      await Promise.all(
        sessions.map(async (session) => {
          try {
            const participantRef = doc(db, SESSIONS_COLLECTION, session.id, PARTICIPANTS_SUBCOLLECTION, contactId);
            const participantSnap = await getDoc(participantRef);
            if (participantSnap.exists()) {
              attendedSessions.push(session);
            }
          } catch (e) {
            console.warn(`Failed to check participation for session ${session.id}`, e);
          }
        })
      );

      return attendedSessions;
    } catch (error) {
      console.error('Error fetching contact attendance:', error);
      return [];
    }
  },

  // All sessions for a team within a date range (the public_profile mirror).
  async getTeamSessionsInRange(
    teamId: string,
    startDate: Date,
    endDate: Date
  ): Promise<HydratedSession[]> {
    try {
      if (!teamId) return [];
      const publicProfileSnapshot = await getDocs(
        query(
          collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
          where('teamId', '==', teamId),
          where('type', '==', SESSION_MIRROR_TYPE),
          where('start', '>=', Timestamp.fromDate(startDate)),
          where('start', '<=', Timestamp.fromDate(endDate)),
          orderBy('start', 'asc')
        )
      );

      return publicProfileSnapshot.docs.map(docSnap =>
        mapSessionPublicProfile(docSnap.ref.path.split('/')[1], docSnap.data())
      );
    } catch (error) {
      console.error('Error fetching team sessions in range:', error);
      return [];
    }
  },

  /**
   * Sessions for a team within range, with the contact's own participation /
   * booking status attached. The booking half comes from ONE `getMyBookings`
   * call (never a per-session `bookings/{contactId}` fan-out — see the module
   * header of packages/functions/src/booking/myBookings.ts for why that fan-out
   * was wrong in three ways); attendance for PAST sessions still needs the
   * per-session `participants` check, since `getMyBookings` only answers
   * upcoming bookings.
   */
  async getSessionsWithParticipation(
    contactId: string,
    teamId: string,
    startDate: Date,
    endDate: Date
  ): Promise<(HydratedSession & { status: SessionParticipationStatus })[]> {
    try {
      const [sessions, bookingsResult] = await Promise.all([
        this.getTeamSessionsInRange(teamId, startDate, endDate),
        this.getMyBookings(teamId).catch(() => ({ bookings: [], cursor: null, scanned: 0 }) as MyBookingsResult),
      ]);

      const bookedSessionIds = new Set(
        bookingsResult.bookings.filter(b => b.kind === 'class').map(b => b.sessionId)
      );

      const now = new Date();
      const pastSessions = sessions.filter(s => s.start < now);
      const attendedIds = new Set<string>();
      await Promise.all(
        pastSessions.map(async (session) => {
          try {
            const participantRef = doc(db, SESSIONS_COLLECTION, session.id, PARTICIPANTS_SUBCOLLECTION, contactId);
            const participantSnap = await getDoc(participantRef);
            if (participantSnap.exists()) attendedIds.add(session.id);
          } catch (e) {
            console.warn(`Failed to check participation for session ${session.id}`, e);
          }
        })
      );

      return sessions.map((session) => {
        const isPast = session.start < now;
        let status: SessionParticipationStatus;
        if (isPast) {
          status = attendedIds.has(session.id) ? 'attended' : 'not attended';
        } else {
          status = bookedSessionIds.has(session.id) ? 'booked' : 'book';
        }
        return { ...session, status };
      });
    } catch (error) {
      console.error('Error fetching sessions with participation:', error);
      return [];
    }
  },

  // Get weekly reports for a contact (attendance chart data).
  //
  // A WEEK WITH NO ROW IS A WEEK WITH NO ATTENDANCE: `weeklyReports` writes a
  // document only for a contact who turned up, so the stored rows are sparse and
  // row count says nothing about elapsed time. Ask for a window of weeks and let
  // the shared densifier fill the gaps with zero — the same rule the web chart
  // reads through, so the two platforms cannot disagree about what a missing
  // week means.
  //
  // Nothing calls this yet; the window also replaces an unbounded fetch that
  // would have pulled every row a long-standing contact has (migrated HMD
  // contacts carry years of them).
  async getContactWeeklyReports(contactId: string, weeks = 16): Promise<WeeklyReport[]> {
    try {
      const window = isoWeekKeysBack(weeks);
      const reportsRef = collection(db, CONTACTS_COLLECTION, contactId, 'contact_weekly_reports');
      const q = query(reportsRef, where('iso_week', '>=', window[0]), orderBy('iso_week', 'asc'));
      const snapshot = await getDocs(q);

      return densifyWeeklyCounts(
        snapshot.docs.map(doc => ({
          iso_week: doc.data().iso_week as string,
          sessions_count: (doc.data().sessions_count as number) || 0,
        })),
        weeks,
      ).map(r => ({ id: r.iso_week, ...r }));
    } catch (error) {
      console.error('Error fetching weekly reports:', error);
      return [];
    }
  },

  // Get team leaderboard (denormalized document for gamification)
  async getTeamLeaderboard(teamId: string): Promise<Leaderboard | null> {
    try {
      const leaderboardRef = doc(db, TEAMS_COLLECTION, teamId, 'leaderboard', 'current');
      const leaderboardSnap = await getDoc(leaderboardRef);

      if (!leaderboardSnap.exists()) {
        return null;
      }

      const data = leaderboardSnap.data();
      return {
        month: data.month,
        entries: data.entries || [],
        entries_count: data.entries_count || 0,
        updated_at: data.updated_at?.toDate?.() || new Date(),
      } as Leaderboard;
    } catch (error) {
      console.error('Error fetching team leaderboard:', error);
      return null;
    }
  },

  // Get gamification settings (badge thresholds + coach badges) from the
  // public_profile mirror — never `teams/{id}.settings.gamification`, which a
  // contact session cannot read.
  async getTeamGamificationSettings(teamId: string): Promise<GamificationSettings | null> {
    const profile = await this.getTeamPublicProfile(teamId);
    return profile?.gamification_settings ?? null;
  },

  // Get active alerts for a contact: fired, not dismissed, and flagged to
  // show in the app. Reads BOTH document shapes a contact_alerts doc may
  // carry (flat schedule_type/schedule_value from the studio web app + the
  // HMD migration, nested schedule{} from bookSession + the automation
  // engine) and uses the shared fired predicate — see utils/contactAlerts.ts.
  // `totalSessions` is Contact.total_sessions, needed for sessions_countdown.
  async getContactAlerts(contactId: string, totalSessions?: number | null): Promise<ContactAlert[]> {
    try {
      const alertsRef = collection(db, CONTACTS_COLLECTION, contactId, 'contact_alerts');
      const q = query(
        alertsRef,
        where('show_in_app', '==', true),
        where('archived_at', '==', null),
        orderBy('created_at', 'desc')
      );
      const snapshot = await getDocs(q);

      return snapshot.docs
        .map(doc => readAlert(doc.id, doc.data() as RawContactAlert))
        .filter(alert => alertIsFired(alert, { totalSessions }));
    } catch (error) {
      console.error('Error fetching contact alerts:', error);
      return [];
    }
  },

  // Request contact update via cloud function. Like bookSession, the signed-in
  // contact session rides along on the callable and identifies us server-side.
  //
  // NOTE: this payload shape is `requestContactUpdate`'s OWN wire contract
  // (packages/functions/src/contacts/requestContactUpdate.ts /
  // manageContactUpdateRequest.ts's ALLOWED_UPDATE_FIELDS) — it is not
  // `Partial<Contact>`, and it predates the shared Contact type's field names.
  // `taxnumber` is deliberately absent: the approval flow's allow-list has
  // never included it, so a submitted value was silently dropped either way.
  async requestContactUpdate(params: {
    contactDetails: {
      firstname: string;
      lastname: string;
      phone: string;
      birthdate: string | null;
      birthplace: string;
      gender: string;
      residence: { route: string; street_number: string; postal_code: string; locality: string };
      emergencyContact: { name: string; phone: string };
      weight?: number;
    };
    note?: string;
  }): Promise<{ success: boolean; requestId: string }> {
    try {
      const requestContactUpdateFn = httpsCallable(getFunctions(), 'requestContactUpdate');
      const result = await requestContactUpdateFn(params);
      return result.data as any;
    } catch (error) {
      console.error('Error requesting contact update:', error);
      throw error;
    }
  },

  // Book a session as the signed-in contact. No token dance: our contact session
  // (the custom token minted at login) rides along on the callable automatically,
  // and bookSession reads contactId/teamId from its claims — so the booking is
  // always stored under the contact's own ID (required for cancellation to work).
  async bookSession(params: {
    teamId: string;
    sessionId: string;
  }): Promise<{ success: boolean; message?: string }> {
    try {
      const bookSessionFn = httpsCallable(getFunctions(), 'bookSession');
      const result = await bookSessionFn({
        teamId: params.teamId,
        sessionId: params.sessionId,
      });
      return result.data as any;
    } catch (error) {
      console.error('Error booking session:', error);
      throw error;
    }
  },

  /**
   * The signed-in contact's own upcoming bookings — class AND appointment,
   * including ones the studio entered on her behalf. THE ONE READ for "my
   * bookings" anywhere in this app; see the module header of
   * packages/functions/src/booking/myBookings.ts for why a client-side
   * `sessions` query could never answer this honestly (the `doc_type` bug, the
   * team-volume cap, and bookings with no public mirror at all).
   */
  async getMyBookings(teamId: string, cursor?: number | null): Promise<MyBookingsResult> {
    const fn = httpsCallable(getFunctions(), 'getMyBookings');
    const result = await fn({ teamId, cursor: cursor ?? null });
    return result.data as MyBookingsResult;
  },

  // Get booked sessions for a contact within a date range — sourced from
  // `getMyBookings` (ONE call) rather than a `bookings/{contactId}` fan-out
  // per session in range.
  async getContactBookings(
    contactId: string,
    startDate: Date,
    endDate: Date,
    teamId?: string
  ): Promise<HydratedSession[]> {
    try {
      if (!teamId) return [];
      const [sessions, bookingsResult] = await Promise.all([
        this.getTeamSessionsInRange(teamId, startDate, endDate),
        this.getMyBookings(teamId),
      ]);
      const bookedIds = new Set(bookingsResult.bookings.filter(b => b.kind === 'class').map(b => b.sessionId));
      return sessions.filter(s => bookedIds.has(s.id));
    } catch (error) {
      console.error('Error fetching contact bookings:', error);
      return [];
    }
  },

  // Cancel a booking (class or appointment) via its `booking_token` —
  // `getMyBookings` / `getUpcomingAppointments` already hand back a
  // `cancelToken` for every cancellable row, so this never needs a lookup.
  async cancelBookingByToken(token: string): Promise<{ success: boolean; message?: string }> {
    const cancelBookingFn = httpsCallable(getFunctions(), 'cancelBooking');
    const result = await cancelBookingFn({ token });
    return result.data as any;
  },

  // Cancel a CLASS booking by session — looks up the booking token once (a
  // single doc read on this user action, not a listing fan-out) and delegates
  // to cancelBookingByToken.
  async cancelSession(params: {
    sessionId: string;
    contactId: string;
  }): Promise<{ success: boolean; message?: string }> {
    try {
      const bookingRef = doc(db, SESSIONS_COLLECTION, params.sessionId, BOOKINGS_SUBCOLLECTION, params.contactId);
      let bookingSnap = await getDoc(bookingRef);

      if (!bookingSnap.exists()) {
        // Fallback: check participants for bookings not yet migrated
        const participantRef = doc(db, SESSIONS_COLLECTION, params.sessionId, PARTICIPANTS_SUBCOLLECTION, params.contactId);
        bookingSnap = await getDoc(participantRef);
      }

      if (!bookingSnap.exists()) {
        throw new Error('Booking not found');
      }

      const bookingData = bookingSnap.data();
      const bookingStatus = bookingData?.status;
      if (bookingStatus && bookingStatus !== 'pending') {
        throw new Error('This booking can no longer be cancelled.');
      }

      const bookingToken = bookingData?.booking_token;
      if (!bookingToken) {
        throw new Error('No booking token found for this session');
      }

      return await this.cancelBookingByToken(bookingToken);
    } catch (error) {
      console.error('Error cancelling session:', error);
      throw error;
    }
  },

  // Self check-in via team QR code scan.
  // teamSlug: from the scanned QR ({"team":"<slug>"})
  // sessionId: optional — if omitted the function resolves active sessions automatically
  async selfCheckIn(params: {
    teamSlug: string;
    sessionId?: string;
  }): Promise<
    | { status: 'checked_in'; alreadyCheckedIn: boolean; sessionName: string; sessionStart: number }
    | { status: 'session_required'; sessions: { id: string; activityName: string; start: any; end: any }[] }
    | { status: 'no_sessions' }
  > {
    const fn = httpsCallable(getFunctions(), 'selfCheckIn');
    const result = await fn(params);
    return result.data as any;
  },

  // Get the authenticated student's personal referral code and shareable URL
  async getMyReferralCode(): Promise<ReferralInfo | null> {
    try {
      const fn = httpsCallable(getFunctions(), 'getMyReferralCode');
      const result = await fn({});
      return result.data as ReferralInfo;
    } catch (error) {
      console.error('Error getting referral code:', error);
      return null;
    }
  },

  // Get the count of rewards received by the authenticated student
  async getMyReferralStats(): Promise<{ rewarded_count: number }> {
    try {
      const fn = httpsCallable(getFunctions(), 'getMyReferralStats');
      const result = await fn({});
      return result.data as { rewarded_count: number };
    } catch (error) {
      console.error('Error getting referral stats:', error);
      return { rewarded_count: 0 };
    }
  },

  // Goals

  async getGoals(contactId: string): Promise<Goal[]> {
    try {
      const goalsRef = collection(db, CONTACTS_COLLECTION, contactId, 'goals');
      const q = query(goalsRef, orderBy('created_at', 'desc'));
      const snapshot = await getDocs(q);
      const all = snapshot.docs.map(docSnap => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          ...data,
          // Docs written before `type` existed predate the goal/task split —
          // default to 'goal', mirroring the web admin's `g.type === 'goal'
          // || !g.type` fallback so they don't fall through the cracks.
          type: (data.type as GoalType | undefined) ?? 'goal',
        } as Goal;
      });
      // A goal the coach archived is hidden here too, with its steps — the same
      // rule the admin tab and the member Space apply. IN MEMORY, because
      // `archived_at` is absent on older goals and a `where(== null)` would
      // match none of them.
      const archivedGoalIds = new Set(
        all.filter(g => g.type !== 'task' && !!g.archived_at).map(g => g.id),
      );
      return all.filter(
        g =>
          !g.archived_at &&
          !(g.type === 'task' && g.parent_goal_id && archivedGoalIds.has(g.parent_goal_id)),
      );
    } catch (error) {
      console.error('Error fetching goals:', error);
      return [];
    }
  },

  async updateGoal(contactId: string, goalId: string, data: Partial<Omit<Goal, 'id'>>): Promise<void> {
    try {
      const goalRef = doc(db, CONTACTS_COLLECTION, contactId, 'goals', goalId);
      await updateDoc(goalRef, data as any);
    } catch (error) {
      console.error('Error updating goal:', error);
      throw error;
    }
  },

  async deleteGoal(contactId: string, goalId: string): Promise<void> {
    try {
      const goalRef = doc(db, CONTACTS_COLLECTION, contactId, 'goals', goalId);
      await deleteDoc(goalRef);
    } catch (error) {
      console.error('Error deleting goal:', error);
      throw error;
    }
  },

  async createGoal(contactId: string, data: Omit<Goal, 'id'>): Promise<string> {
    try {
      const goalsRef = collection(db, CONTACTS_COLLECTION, contactId, 'goals');
      const docRef = await addDoc(goalsRef, data);
      return docRef.id;
    } catch (error) {
      console.error('Error creating goal:', error);
      throw error;
    }
  },

  async getGoalEvaluations(contactId: string, goalId: string): Promise<GoalEvaluation[]> {
    try {
      const evalsRef = collection(db, CONTACTS_COLLECTION, contactId, 'goals', goalId, 'evaluations');
      const q = query(evalsRef, orderBy('evaluated_at', 'desc'));
      const snapshot = await getDocs(q);
      return snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data(),
      } as GoalEvaluation));
    } catch (error) {
      console.error('Error fetching goal evaluations:', error);
      return [];
    }
  },

  /**
   * `goalCreatedBy` decides whether the status cascade below is even
   * attempted. firestore.rules lets a member (self-contact) update a goal
   * doc only when `resource.data.created_by == 'student'` — a coach-created
   * goal's status is the coach's to move. The evaluation write itself never
   * needs that: a member can always record a score + note against ANY of
   * their own goals (`evaluated_by == 'student'` is the only rules check),
   * so skipping the cascade here lets that half of the write still land
   * instead of the whole call throwing on a denied goal update.
   */
  async addGoalEvaluation(
    contactId: string,
    goalId: string,
    data: Omit<GoalEvaluation, 'id'>,
    goalCreatedBy: GoalCreatedBy,
  ): Promise<void> {
    try {
      const evalsRef = collection(db, CONTACTS_COLLECTION, contactId, 'goals', goalId, 'evaluations');
      // ONE BATCH: the evaluation and the status it moves the goal to are a
      // single fact. Landing one without the other leaves a goal whose status
      // its own newest evaluation contradicts, and nothing reconciles them.
      const batch = writeBatch(db);
      batch.set(doc(evalsRef), data);
      if (goalCreatedBy === 'student') {
        batch.update(doc(db, CONTACTS_COLLECTION, contactId, 'goals', goalId), { status: data.status_after });
      }
      await batch.commit();
    } catch (error) {
      console.error('Error adding goal evaluation:', error);
      throw error;
    }
  },

  async updateGoalEvaluation(
    contactId: string,
    goalId: string,
    evalId: string,
    data: Partial<Omit<GoalEvaluation, 'id'>>,
    goalCreatedBy: GoalCreatedBy,
  ): Promise<void> {
    try {
      const evalRef = doc(db, CONTACTS_COLLECTION, contactId, 'goals', goalId, 'evaluations', evalId);
      const batch = writeBatch(db);
      batch.update(evalRef, { ...data, edited: true });
      if (data.status_after && goalCreatedBy === 'student') {
        batch.update(doc(db, CONTACTS_COLLECTION, contactId, 'goals', goalId), { status: data.status_after });
      }
      await batch.commit();
    } catch (error) {
      console.error('Error updating goal evaluation:', error);
      throw error;
    }
  },

  // Performance check-ins

  async getPerformanceCheckins(contactId: string, limitCount: number = 10): Promise<PerformanceCheckin[]> {
    try {
      const checkinsRef = collection(db, CONTACTS_COLLECTION, contactId, 'performance_checkins');
      const q = query(checkinsRef, orderBy('taken_at', 'desc'), limit(limitCount));
      const snapshot = await getDocs(q);
      return snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data(),
      } as PerformanceCheckin));
    } catch (error) {
      console.error('Error fetching performance check-ins:', error);
      return [];
    }
  },

  async addPerformanceCheckin(contactId: string, data: Omit<PerformanceCheckin, 'id'>): Promise<void> {
    try {
      const checkinsRef = collection(db, CONTACTS_COLLECTION, contactId, 'performance_checkins');

      const profile = detectPerformanceProfile(data.scores);
      const payload = { ...data, ...profile };

      // Enforce one-per-day per author: overwrite if exists
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const existingQ = query(
        checkinsRef,
        where('filled_by', '==', data.filled_by),
        where('taken_at', '>=', Timestamp.fromDate(todayStart)),
        where('taken_at', '<=', Timestamp.fromDate(todayEnd)),
        limit(1)
      );
      const existingSnap = await getDocs(existingQ);

      if (!existingSnap.empty) {
        const existingDocRef = doc(db, CONTACTS_COLLECTION, contactId, 'performance_checkins', existingSnap.docs[0].id);
        await updateDoc(existingDocRef, { ...payload });
        return;
      }

      await addDoc(checkinsRef, payload);
    } catch (error) {
      console.error('Error adding performance check-in:', error);
      throw error;
    }
  },

  /**
   * The team's performance check-in axes — HOW SOMEONE IS DOING, the radar's
   * dimensions (see `resolveCoachingDimensions`). Read from the public_profile
   * mirror — never `teams/{id}`, which a contact session cannot read.
   *
   * NOT the goal categories: that is `getGoalCategories` below.
   */
  async getCoachingDimensions(teamId: string): Promise<PerformanceIndicator[]> {
    const profile = await this.getTeamPublicProfile(teamId);
    return resolveCoachingDimensions({ performance_indicators: profile?.performance_indicators ?? null });
  },

  /**
   * The team's goal categories — WHAT A GOAL IS ABOUT (see
   * `resolveGoalCategories`), read from the public_profile mirror. Falls back
   * to the defaults for a team that never configured its own.
   */
  async getGoalCategories(teamId: string): Promise<PerformanceIndicator[]> {
    const profile = await this.getTeamPublicProfile(teamId);
    return resolveGoalCategories({ goal_categories: profile?.goal_categories ?? null });
  },

  // ── Appointments (backed by sessions with activityType === 'appointment') ────

  /**
   * The contact's OWN upcoming booked appointments — derived from
   * `getMyBookings`, never a root `sessions` query (appointments are
   * availability-only: nothing exists until booked, and the studio may have
   * booked one on the member's behalf with online booking off).
   */
  async getUpcomingAppointments(teamId: string): Promise<AppointmentWithStatus[]> {
    try {
      const result = await this.getMyBookings(teamId);
      return result.bookings
        .filter(b => b.kind === 'appointment')
        .map((b): AppointmentWithStatus => ({
          id: b.sessionId,
          providerName: b.providerName,
          activityName: b.activityName,
          start: b.start ? new Date(b.start) : new Date(),
          end: b.end ? new Date(b.end) : new Date(),
          location: b.location,
          bookingStatus: b.sessionCancelled ? 'cancelled' : 'booked',
          cancelToken: b.cancelToken,
          cancellable: b.cancellable,
        }));
    } catch (error) {
      console.error('Error fetching appointments:', error);
      return [];
    }
  },

  /**
   * The team's PUBLISHED availability — the *when* — grouped coach-first, with
   * each coach's bookable `type: 'appointment'` activities and their free start
   * times per day/duration. Pure read, no writes; mirrors the public web picker
   * at /public/{slug}/appointments. See `listAvailability` in
   * packages/functions/src/appointments/window.ts and
   * @linyup/shared's `ListAvailabilityResult` — the ONE typed owner of this
   * payload.
   */
  async listAppointmentAvailability(teamId: string, days: number = 60): Promise<ListAvailabilityCoach[]> {
    const listAvailabilityFn = httpsCallable(getFunctions(), 'listAvailability');
    const result = await listAvailabilityFn({ teamId, days });
    return (result.data as { coaches: ListAvailabilityCoach[] })?.coaches ?? [];
  },

  /**
   * Book a specific start time from published availability. The caller's
   * identity comes from the signed-in contact SESSION — the custom-token claims
   * (contactId/teamId/sessionExpires) that `httpsCallable` automatically attaches
   * as `request.auth` once the student is signed in (see AuthContext). No OTP /
   * email step is needed: `bookAppointment` trusts `request.auth.token.contactId`
   * as a first-class authenticated path (see
   * packages/functions/src/appointments/window.ts).
   */
  async bookAppointment(params: {
    teamId: string;
    providerId: string;
    activityId: string;
    startMs: number;
    durationMinutes: number;
  }): Promise<{ success: boolean }> {
    const bookAppointmentFn = httpsCallable(getFunctions(), 'bookAppointment');
    const result = await bookAppointmentFn(params);
    return result.data as { success: boolean };
  },

  // Cancel an appointment booking by its `booking_token` — the token
  // `getUpcomingAppointments` already hands back per row, so no lookup is needed.
  async cancelAppointment(params: { cancelToken: string }): Promise<{ success: boolean }> {
    return this.cancelBookingByToken(params.cancelToken);
  },
};
