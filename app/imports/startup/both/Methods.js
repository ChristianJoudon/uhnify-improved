import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Roles } from 'meteor/alanning:roles';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { Profiles } from '../../api/profiles/Profiles';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes, SWIPE_DECISIONS, SWIPE_KIND_FOR_DECISION } from '../../api/events/EventSwipes';
import { Friends } from '../../api/friends/Friends';
import { Counters } from '../../api/counters/Counters';
import { parseMeetingTime } from '../../api/club/schedule';
import '../../api/recommendations/RecommendationsMethods';
import { recordRecommendationInteraction } from '../../api/recommendations/interactionRecorder';
import {
  RecommendationGraphEdges,
  RecommendationRequests,
} from '../../api/recommendations/RecommendationData';
import { friendActivityVisibilityFor, isSensitiveListing } from '../../api/privacy/FriendActivityPrivacy';
import {
  eventWithHostSignals,
  sharesFriendActivity,
  syncFriendActivityForClub,
  syncFriendActivityForEvent,
  syncFriendActivityForUser,
} from '../../api/privacy/friendActivitySync';
import { LIST_MAX_ENTRIES, TEXT_LIMITS, imageProblem } from '../../api/listing/limits';
import { INTEREST_TOPIC_KEYS, TOPICS } from '../../ui/utilities/topics';

/* eslint-disable no-console */

const addClubMethod = 'Clubs.insert';

const requireLoggedIn = (userId) => {
  if (!userId) {
    throw new Meteor.Error('not-logged-in', 'You must be signed in to do that.');
  }
};

const requireAdmin = (userId) => {
  requireLoggedIn(userId);
  if (!Roles.userIsInRole(userId, 'admin')) {
    throw new Meteor.Error('not-authorized', 'You must be an administrator to do that.');
  }
};

const getUsername = (userId) => {
  const user = Meteor.users.findOne(userId);
  return user?.username || user?.emails?.[0]?.address || userId;
};

/**
 * A group's categories, each held to a ceiling and the list to a count.
 *
 * The form fills these from a chip input that stops at ten short labels, so
 * nobody typing one meets either limit. They exist for a direct method call,
 * which until now could store a category of any length, as many of them as it
 * liked, and every visitor was then sent the lot with the card — the same hole
 * the scalar fields had before checkText. Cut rather than refused, as tags
 * are: a label past forty characters is not a category anyone meant.
 */
const normalizeCategories = categories => {
  if (!categories) {
    return ['Other'];
  }
  const list = Array.isArray(categories) ? categories : `${categories}`.split(',');
  return list
    .map(category => `${category}`.trim().slice(0, TEXT_LIMITS.category))
    .filter(Boolean)
    .slice(0, LIST_MAX_ENTRIES);
};

/**
 * The interests a profile may publish: the labels of the public topics, once
 * each, in the order given.
 *
 * Sign-up and Customize offer exactly those chips, and every reader resolves
 * an interest back to its topic, so anything else was never an interest — it
 * was a string of any length, stored as many times as the caller cared to
 * repeat it, on a document the people directory sends to every signed-in
 * user. Support Groups is a topic but not an interest: taking part can reveal
 * health or recovery information, which is why INTEREST_TOPIC_KEYS leaves it
 * out and it is dropped here rather than published.
 */
const publicInterestLabels = new Set(INTEREST_TOPIC_KEYS.map(key => TOPICS[key].label));

const publicProfileInterests = interests => [...new Set(
  (interests || []).map(interest => `${interest}`.trim()).filter(interest => publicInterestLabels.has(interest)),
)];

const toDate = value => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Meteor.Error('invalid-date', 'Please provide a valid event date.');
  }
  return date;
};

const parseNumericId = (value, label) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Meteor.Error('invalid-id', `Please provide a valid numeric ${label}.`);
  }
  return parsed;
};

/** Server clock. A client's is not evidence, and these fields are read as
    "when did this actually change". */
const now = () => new Date();

/** Recommendation telemetry must never break the product action it observes. */
const captureRecommendationInteraction = payload => {
  if (!Meteor.isServer) {
    return null;
  }
  try {
    return recordRecommendationInteraction(payload);
  } catch (error) {
    console.error('[recommendations] interaction capture failed:', error.message);
    return null;
  }
};

/** Trust model/tier details only when they belong to this user's server request. */
const verifiedRecommendationContext = (userId, supplied = {}) => {
  if (!Meteor.isServer) {
    return {};
  }
  const request = typeof supplied.requestId === 'string'
    ? RecommendationRequests.collection.findOne({ _id: supplied.requestId, userId })
    : null;
  const position = Number(supplied.position);
  return {
    clientEventId: typeof supplied.clientEventId === 'string' ? supplied.clientEventId.slice(0, 160) : undefined,
    requestId: request?._id,
    surface: request?.surface,
    position: Number.isInteger(position) && position >= 0 ? position : undefined,
    displaySize: ['standard', 'large', 'featured'].includes(supplied.displaySize)
      ? supplied.displaySize
      : undefined,
    modelVersion: request?.modelVersion,
    selectedTier: request?.selectedTier,
    componentsUsed: request?.availableComponents,
    predecessorId: typeof supplied.predecessorId === 'string' ? supplied.predecessorId.slice(0, 160) : undefined,
  };
};

const setFriendRecommendationEdges = (leftId, rightId, acceptedAt) => {
  if (!Meteor.isServer) {
    return;
  }
  try {
    [[leftId, rightId], [rightId, leftId]].forEach(([fromId, toId]) => {
      RecommendationGraphEdges.collection.upsert({ edgeKey: `friend:${fromId}:${toId}` }, {
        $set: {
          fromType: 'user',
          fromId,
          toType: 'user',
          toId,
          relation: 'accepted_friend',
          occurredAt: acceptedAt,
          privacyEligibility: 'private',
          graphVersion: 'source_projection_v1',
        },
        $setOnInsert: { validFrom: acceptedAt, createdAt: now() },
        $unset: { endedAt: '', validTo: '' },
      });
    });
  } catch (error) {
    console.error('[recommendations] friend graph projection failed:', error.message);
  }
};

const endFriendRecommendationEdges = (leftId, rightId) => {
  if (!Meteor.isServer) {
    return;
  }
  try {
    const endedAt = now();
    RecommendationGraphEdges.collection.update({
      edgeKey: { $in: [`friend:${leftId}:${rightId}`, `friend:${rightId}:${leftId}`] },
    }, {
      $set: { endedAt, validTo: endedAt, privacyEligibility: 'excluded' },
    }, { multi: true });
  } catch (error) {
    console.error('[recommendations] friend graph retirement failed:', error.message);
  }
};

/**
 * What a person wrote, trimmed and held to the ceiling in TEXT_LIMITS.
 *
 * Every method that stores text passes it through here, because until it
 * existed no field had a length limit at all: a few pages capped their inputs
 * with maxLength, which a direct method call never sees, and the server took
 * whatever arrived. The label is the one the form shows, since the reason is
 * what the person reads.
 */
const checkText = (value, key, label, { required = false } = {}) => {
  if (value !== undefined && typeof value !== 'string') {
    throw new Meteor.Error('invalid-text', `${label} must be text.`);
  }
  const text = (value || '').trim();
  if (required && !text) {
    throw new Meteor.Error('required', `${label} is required.`);
  }
  if (text.length > TEXT_LIMITS[key]) {
    throw new Meteor.Error('too-long', `${label} is limited to ${TEXT_LIMITS[key]} characters.`);
  }
  return text;
};

const IMAGE_PROBLEMS = {
  'invalid-image': 'Please choose a JPEG, PNG or WebP photo.',
  'image-too-large': 'That photo is too large — try a smaller one.',
};

/**
 * A stored image: one of the app's own, an https URL, or an inline JPEG, PNG
 * or WebP whose first bytes agree with its label. imageProblem says why
 * nothing else. There used to be two checks here — a 2.8 MB ceiling and a
 * list of prefixes — and between them they accepted any content at all, at a
 * size that was then sent to every visitor with the card.
 */
const checkImage = image => {
  const problem = imageProblem(image);
  if (problem) {
    throw new Meteor.Error(problem, IMAGE_PROBLEMS[problem]);
  }
  return image;
};

/** The listing forms send '' for "no photo", and a listing without one is
    drawn from its topic. Only a photo that is there is checked. */
const optionalImage = image => (image ? checkImage(image) : image);

/**
 * A contact email the organizer chose to print on the listing.
 *
 * Optional, and blank means "publish none" — the card then draws no mail row,
 * the same rule as a group's contact box. What is given is trimmed and
 * lowercased, so one address spelled two ways does not read as two, and it is
 * checked only for the shape every address has: one @, a dotted domain, no
 * whitespace, and the length ceiling the mail standards set. Anything stricter
 * turns away real addresses, and the reason here is shown to the person who
 * typed it.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const contactEmailOf = value => {
  const email = (value || '').trim().toLowerCase();
  if (!email) {
    return undefined;
  }
  if (email.length > TEXT_LIMITS.email || !EMAIL_SHAPE.test(email)) {
    throw new Meteor.Error('invalid-email', 'That contact email does not look right.');
  }
  return email;
};

const normalizeTag = tag => `${tag}`.trim().replace(/\s+/g, ' ').slice(0, TEXT_LIMITS.tag);

const normalizeSchedule = schedule => {
  if (!schedule || !Array.isArray(schedule.days) || schedule.days.length === 0) {
    return null;
  }
  const days = [...new Set(schedule.days.map(day => Number.parseInt(day, 10)).filter(day => day >= 0 && day <= 6))].sort();
  if (days.length === 0) {
    return null;
  }
  const time = /^\d{2}:\d{2}$/.test(schedule.time || '') ? schedule.time : '17:00';
  const cadence = schedule.cadence === 'biweekly' ? 'biweekly' : 'weekly';
  return { days, time, cadence };
};

/**
 * The next group number.
 *
 * This was max-plus-one over the collection, which raced (two creators read the
 * same maximum and both insert it) and reused (delete the newest group and the
 * next one takes its number back — along with the orphaned events that still
 * name it as their host). See api/counters/Counters.js.
 *
 * The client stub cannot do any of this: it has neither the counter nor a way
 * to increment one atomically. It returns a placeholder that the server's own
 * number replaces the moment the real call lands, which is exactly what
 * latency compensation is for.
 */
const nextNumericId = (collection, field) => {
  if (!Meteor.isServer) {
    const newest = collection.find({}, { sort: { [field]: -1 }, limit: 1 }).fetch()[0];
    return (newest?.[field] || 0) + 1;
  }
  const highest = collection.find({}, { sort: { [field]: -1 }, limit: 1 }).fetch()[0];
  return Counters.nextId(`${collection._name}.${field}`, highest?.[field] || 0);
};

const findClubByAnyId = clubId => {
  if (!clubId && clubId !== 0) {
    return null;
  }
  const direct = Clubs.collection.findOne(clubId);
  if (direct) {
    return direct;
  }
  const numericClubId = Number.parseInt(clubId, 10);
  if (!Number.isNaN(numericClubId)) {
    return Clubs.collection.findOne({ clubID: numericClubId });
  }
  return null;
};

/**
 * Take a person out of a group, and tell the recommender they left.
 *
 * There are two ways out and they must not drift apart: "Leave" on a page
 * ('profileClubs.remove') and rewinding a right swipe in the deck's groups
 * mode ('eventSwipes.remove'). The rewind used to put the card back on the
 * deck and leave the person in the group — an undo that undid the part nobody
 * cared about. A helper rather than one method calling the other: the inner
 * call would check a login and arguments that have just been checked, and
 * verify a second time a recommendation context that is already verified.
 *
 * 'left_group' is recorded only when there was a membership to leave, so
 * rewinding a join that never landed says nothing.
 *
 * The 'joined' swipe goes with the membership. Left behind after "Leave" on a
 * page, it went on saying 'joined' about a group the person was no longer in,
 * and because the deck never deals a group that has a swipe on it — and
 * "bring back passed" clears only passes — the group could not be met again
 * by any route. On the rewind path the row is already gone and this removes
 * nothing. It records nothing either way: 'left_group' has said it.
 */
const leaveClub = (userId, clubId, verifiedContext) => {
  const club = findClubByAnyId(clubId);
  const normalizedClubId = club?._id || clubId;
  const existing = ProfileClubs.collection.findOne({ userId, clubId: normalizedClubId });
  ProfileClubs.collection.remove({ userId, clubId: normalizedClubId });
  EventSwipes.collection.remove({ userId, eventId: `${normalizedClubId}`, kind: 'club', decision: 'joined' });
  if (existing) {
    captureRecommendationInteraction({
      userId,
      entityType: 'group',
      entityId: `${normalizedClubId}`,
      action: 'left_group',
      occurredAt: new Date(),
      ...verifiedContext,
      source: 'legacy',
    });
  }
};

/**
 * What the recommender is told when a swipe is recorded.
 *
 * Going is an RSVP and is recorded as one. 'joined' is deliberately absent: the
 * same gesture calls 'profileClubs.add', which records 'joined_group', and the
 * swipe used to add an 'interested' on top — one thumb movement counted as two
 * signals, the weaker of which diluted the stronger.
 */
const SWIPE_INTERACTION_FOR_DECISION = { going: 'rsvp_going', passed: 'passed' };

const captureSwipeInteraction = (swipe, action, verifiedContext, extra = {}) => captureRecommendationInteraction({
  userId: swipe.userId,
  entityType: swipe.kind === 'club' ? 'group' : 'event',
  entityId: swipe.eventId,
  action,
  occurredAt: new Date(),
  ...verifiedContext,
  ...extra,
  source: 'legacy',
});

/**
 * An RSVP that stopped standing, whichever way it stopped: "Not going" on a
 * page, a rewind in the deck, or a left swipe over the top of it. The
 * recommender is told 'rsvp_canceled' in every case, because what it keeps is
 * whether the person is going; HOW they took it back goes in `context.reason`
 * for anyone who later needs to tell a changed mind from a slipped thumb.
 */
const captureCanceledRsvp = (swipe, reason, verifiedContext, extra = {}) => captureSwipeInteraction(
  swipe,
  'rsvp_canceled',
  verifiedContext,
  { ...extra, context: { reason } },
);

/**
 * A tag can carry a group across the privacy line by itself — any member can
 * add 'recovery' — and the memberships already there were judged before it
 * arrived. They used to wait for the next restart to be judged again, which
 * for the one case that matters is the wrong time to be late. Only a change
 * that actually crosses the line touches the rows; most tags are 'hiking'.
 */
const followTagChange = clubBefore => {
  if (!Meteor.isServer) {
    return;
  }
  const clubNow = Clubs.collection.findOne(clubBefore._id);
  if (isSensitiveListing(clubBefore) !== isSensitiveListing(clubNow)) {
    syncFriendActivityForClub(clubBefore._id);
  }
};

Meteor.methods({
  createUserProfile(userId, email, firstName = '', lastName = '', interests = []) {
    check(userId, Match.Maybe(String));
    check(email, String);
    check(firstName, String);
    check(lastName, String);
    check(interests, Match.Optional([String]));

    // The caller's own id, not one they named. `requireLoggedIn(targetUserId)`
    // asserts a *supplied argument* is truthy, which is not a login check at
    // all — the real one is `this.userId`, and it has to come first.
    requireLoggedIn(this.userId);
    const targetUserId = userId || this.userId;
    const address = checkText(email, 'email', 'Email', { required: true });
    const first = checkText(firstName, 'firstName', 'First name');
    const last = checkText(lastName, 'lastName', 'Last name');

    const isAdmin = Roles.userIsInRole(this.userId, 'admin');
    if (this.userId !== targetUserId && !isAdmin) {
      throw new Meteor.Error('not-authorized', 'You can only create a profile for your own account.');
    }

    /**
     * The email must be the account's own.
     *
     * Without this the method was a profile takeover, and the check above did
     * not stop it: that check only proves `targetUserId` is you, while the
     * lookup below ORs on an email you supply. Sign in as anyone, call
     *
     *     Meteor.call('createUserProfile', null, 'victim@example.com', …)
     *
     * and the `$or` matches the victim's profile by email, whereupon the update
     * sets that document's `userId` to yours. Their profile becomes your
     * profile — your publication serves it and they are told theirs cannot be
     * found. Both branches of the `$or` are needed (an account created before
     * its profile has no profile to find by userId), so the fix is to make the
     * email untrusted input that must match the account it claims.
     */
    const account = Meteor.users.findOne(targetUserId);
    const accountEmail = account?.username || account?.emails?.[0]?.address;
    if (!isAdmin && accountEmail && address !== accountEmail) {
      throw new Meteor.Error('not-authorized', 'That email does not belong to your account.');
    }

    const existingProfile = Profiles.collection.findOne({ $or: [{ userId: targetUserId }, { email: address }] });
    // Belt and braces: even matched by an email that passed the check above, a
    // profile already owned by somebody else is never adopted.
    if (existingProfile && existingProfile.userId && existingProfile.userId !== targetUserId) {
      throw new Meteor.Error('profile-taken', 'A profile already exists for that account.');
    }
    const profileData = {
      userId: targetUserId,
      email: address,
      firstName: first,
      lastName: last,
      bio: existingProfile?.bio || '',
      title: existingProfile?.title || 'Student',
      picture: existingProfile?.picture || '/images/defaultprofilepic.png',
      interests: publicProfileInterests(interests),
    };

    if (existingProfile) {
      Profiles.collection.update(existingProfile._id, { $set: profileData });
      return existingProfile._id;
    }

    return Profiles.collection.insert(profileData);
  },

  'Profiles.update'(profileData) {
    check(profileData, {
      firstName: String,
      lastName: String,
      email: String,
      bio: String,
      title: String,
      interests: Match.Optional([String]),
      // Optional, and absent means "leave it alone" rather than "clear it".
      // The Customize page carries one Save for the whole form now, including
      // the photo, so that a reader has exactly one thing to press and one
      // answer to the question of whether their edits are stored.
      picture: Match.Optional(String),
    });
    requireLoggedIn(this.userId);

    const profile = Profiles.collection.findOne({ userId: this.userId });
    if (!profile) {
      throw new Meteor.Error('profile-not-found', 'No profile exists for this account yet.');
    }

    const fields = {
      firstName: checkText(profileData.firstName, 'firstName', 'First name'),
      lastName: checkText(profileData.lastName, 'lastName', 'Last name'),
      email: checkText(profileData.email, 'email', 'Email', { required: true }),
      bio: checkText(profileData.bio, 'bio', 'Bio'),
      title: checkText(profileData.title, 'profileTitle', 'Title'),
      interests: publicProfileInterests(profileData.interests),
    };
    if (profileData.picture !== undefined) {
      fields.picture = checkImage(profileData.picture);
    }

    Profiles.collection.update(profile._id, { $set: { ...fields, updatedAt: now() } });
  },

  /**
   * Turn sharing with friends on or off, for the caller and nobody else.
   *
   * A method of its own rather than one more field on 'Profiles.update',
   * because it is not one more field. That method saves a form, and a form
   * that happened to be sent without this key must never be able to change who
   * can see where somebody goes. And the flag is only half of it: what the
   * publication selects on is stored on each membership and RSVP, so every row
   * the person already has is rewritten here, in the same call. Off makes all
   * of them private before this returns. On makes a row shareable only where
   * its listing allows it, so a support group joined last year stays private.
   *
   * The flag is written first. The publication checks it as well as the rows,
   * so friends stop being sent anything the moment it is off, even if the
   * rewrite behind it were cut short.
   */
  'Profiles.setFriendActivitySharing'(enabled) {
    check(enabled, Boolean);
    requireLoggedIn(this.userId);

    const profile = Profiles.collection.findOne({ userId: this.userId });
    if (!profile) {
      throw new Meteor.Error('profile-not-found', 'No profile exists for this account yet.');
    }
    // By userId rather than by the _id just found. Nothing should ever make a
    // second profile for one account, but if something had, the copy left
    // saying `true` would go on sharing after its owner said stop.
    Profiles.collection.update(
      { userId: this.userId },
      { $set: { friendActivitySharing: enabled, updatedAt: now() } },
      { multi: true },
    );
    if (Meteor.isServer) {
      syncFriendActivityForUser(this.userId);
    }
    return enabled;
  },

  'Profiles.remove'(profileId) {
    check(profileId, String);
    requireAdmin(this.userId);
    Profiles.collection.remove(profileId);
  },

  'Clubs.insert'(clubData) {
    check(clubData, {
      name: String,
      description: String,
      location: String,
      image: Match.Optional(String),
      meetingTime: String,
      contactInfo: Match.Optional(String),
      categories: Match.Optional(Match.OneOf(String, [String])),
      tags: Match.Optional([String]),
      schedule: Match.Optional(Object),
    });
    requireLoggedIn(this.userId);
    const listing = {
      name: checkText(clubData.name, 'name', 'Name', { required: true }),
      description: checkText(clubData.description, 'description', 'Description'),
      location: checkText(clubData.location, 'location', 'Location', { required: true }),
      image: optionalImage(clubData.image),
      meetingTime: checkText(clubData.meetingTime, 'meetingTime', 'Meeting time', { required: true }),
      // Blank stays blank. This used to fall back to the creator's account
      // name, which `getUsername` resolves to their EMAIL — so leaving the
      // optional "how to reach us" box empty published your address on the
      // group's card to everyone, including signed-out visitors. An organizer
      // who types a contact has chosen to publish it; one who does not has
      // chosen the opposite, and the card simply draws no contact row.
      contactInfo: checkText(clubData.contactInfo, 'contactInfo', 'Contact'),
    };

    // Numbered only once everything about it has been accepted, so a refused
    // listing does not use up a group number.
    const clubID = nextNumericId(Clubs.collection, 'clubID');
    return Clubs.collection.insert({
      clubID,
      createdAt: now(),
      updatedAt: now(),
      ...listing,
      owner: getUsername(this.userId),
      categories: normalizeCategories(clubData.categories),
      tags: (clubData.tags || []).map(normalizeTag).filter(tag => tag.length >= 2).slice(0, LIST_MAX_ENTRIES),
      schedule: normalizeSchedule(clubData.schedule) || parseMeetingTime(listing.meetingTime) || undefined,
    });
  },

  'Clubs.update'(clubId, clubData) {
    check(clubId, String);
    check(clubData, {
      clubID: Match.Optional(Match.OneOf(Number, String)),
      name: String,
      owner: String,
      description: String,
      location: String,
      image: Match.Optional(String),
      meetingTime: String,
      contactInfo: Match.Optional(String),
      categories: Match.Optional(Match.OneOf(String, [String])),
      tags: Match.Optional([String]),
      schedule: Match.Optional(Object),
    });
    requireAdmin(this.userId);
    const meetingTime = checkText(clubData.meetingTime, 'meetingTime', 'Meeting time', { required: true });

    const categories = normalizeCategories(clubData.categories);
    Clubs.collection.update(clubId, {
      $set: {
        name: checkText(clubData.name, 'name', 'Name', { required: true }),
        // An account name, which is an email address, so it shares that ceiling.
        owner: checkText(clubData.owner, 'email', 'Owner', { required: true }),
        description: checkText(clubData.description, 'description', 'Description'),
        location: checkText(clubData.location, 'location', 'Location', { required: true }),
        image: optionalImage(clubData.image),
        meetingTime,
        contactInfo: checkText(clubData.contactInfo, 'contactInfo', 'Contact'),
        categories,
        ...(clubData.tags ? { tags: clubData.tags.map(normalizeTag).filter(tag => tag.length >= 2).slice(0, LIST_MAX_ENTRIES) } : {}),
        updatedAt: now(),
      },
    });

    // Explicit schedule wins; otherwise re-derive from the (possibly edited) meeting
    // text — and clear it when the text no longer describes a recurring meeting.
    const derived = normalizeSchedule(clubData.schedule) || parseMeetingTime(meetingTime);
    if (derived) {
      Clubs.collection.update(clubId, { $set: { schedule: derived } });
    } else {
      Clubs.collection.update(clubId, { $unset: { schedule: '' } });
    }

    // An edit can move a group across the line either way — filed under
    // 'support_group', or no longer — and every member's row has to follow,
    // along with every RSVP to an event the group hosts.
    // This was one update stamped onto all of them, which stopped being right
    // when sharing became each member's own choice: the caller here is an
    // administrator, and their preference is not the members'. It also judged
    // the new categories alone, where tags now count as well.
    if (Meteor.isServer) {
      syncFriendActivityForClub(clubId);
    }
  },

  'Clubs.remove'(clubId) {
    check(clubId, String);
    requireAdmin(this.userId);
    Clubs.collection.remove(clubId);
    ProfileClubs.collection.remove({ clubId });
    EventClubs.collection.remove({ clubId });
    // A group can be swiped on just as an event can — `EventSwipes.eventId`
    // holds whichever kind of _id was swiped. Left behind, these are rows that
    // point at nothing, and they count towards the "passed" tally the deck
    // offers to clear.
    EventSwipes.collection.remove({ eventId: clubId });
    // Deliberately NOT deleting the group's events. An event outlives the group
    // that listed it — it may be linked to others, and the wall reads it on its
    // own terms. What it must not do is keep a link to a group that is gone,
    // which is what the EventClubs removal above is for.
  },

  'profileClubs.add'(clubId, recommendationContext = {}) {
    check(clubId, Match.OneOf(String, Number));
    check(recommendationContext, Object);
    requireLoggedIn(this.userId);

    const club = findClubByAnyId(clubId);
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That club could not be found.');
    }

    // The joiner's own choice, read once. Without it the answer is 'private'.
    const friendActivityVisibility = friendActivityVisibilityFor(club, {
      sharing: sharesFriendActivity(this.userId),
    });
    const existing = ProfileClubs.collection.findOne({ userId: this.userId, clubId: club._id });
    if (existing) {
      ProfileClubs.collection.update(existing._id, { $set: { friendActivityVisibility } });
      return existing._id;
    }

    const membershipId = ProfileClubs.collection.insert({
      userId: this.userId,
      clubId: club._id,
      friendActivityVisibility,
      createdAt: new Date(),
    });
    captureRecommendationInteraction({
      userId: this.userId,
      entityType: 'group',
      entityId: club._id,
      action: 'joined_group',
      occurredAt: new Date(),
      ...verifiedRecommendationContext(this.userId, recommendationContext),
      source: 'legacy',
    });
    return membershipId;
  },

  'profileClubs.remove'(clubId, recommendationContext = {}) {
    check(clubId, Match.OneOf(String, Number));
    check(recommendationContext, Object);
    requireLoggedIn(this.userId);

    leaveClub(this.userId, clubId, verifiedRecommendationContext(this.userId, recommendationContext));
  },

  'Events.insert'(eventData) {
    check(eventData, {
      eventID: Match.OneOf(Number, String),
      title: String,
      description: Match.Optional(String),
      date: Match.OneOf(Date, String),
      location: String,
      email: Match.Optional(String),
      image: Match.Optional(String),
    });
    requireLoggedIn(this.userId);
    const contactEmail = contactEmailOf(eventData.email);

    const hostClubID = parseNumericId(eventData.eventID, 'host club ID');
    const hostClub = findClubByAnyId(hostClubID);
    const eventId = Events.collection.insert({
      createdAt: now(),
      updatedAt: now(),
      eventID: hostClubID,
      title: checkText(eventData.title, 'title', 'Name', { required: true }),
      description: checkText(eventData.description, 'description', 'Description'),
      date: toDate(eventData.date),
      location: checkText(eventData.location, 'location', 'Location', { required: true }),
      // `owner` is the whole record of who posted this, and the public
      // publications withhold it. A `createdBy` used to be written beside it
      // holding the same account email — and that one they did not withhold.
      owner: getUsername(this.userId),
      image: optionalImage(eventData.image) || '/images/codingWorkshop.png',
      // Absent rather than '' when none was given: an empty string is a value
      // the record would then carry, and every reader would have to know it
      // means nothing.
      ...(contactEmail ? { email: contactEmail } : {}),
      ...(hostClub?.name ? { hostName: hostClub.name } : {}),
      ...(hostClub?.categories?.length ? { categories: hostClub.categories } : {}),
    });

    if (hostClub) {
      EventClubs.collection.insert({ clubId: hostClub._id, eventId, userId: this.userId, createdAt: new Date() });
    }

    return eventId;
  },

  'Events.update'(eventId, eventData) {
    check(eventId, String);
    check(eventData, {
      eventID: Match.OneOf(Number, String),
      title: String,
      description: Match.Optional(String),
      date: Match.OneOf(Date, String),
      location: String,
      email: Match.Optional(String),
      image: Match.Optional(String),
    });
    requireAdmin(this.userId);
    const contactEmail = contactEmailOf(eventData.email);

    const hostClubID = parseNumericId(eventData.eventID, 'host club ID');
    const existingEvent = Events.collection.findOne(eventId);
    const hostClub = findClubByAnyId(hostClubID);
    const locallyAuthoredFields = existingEvent && !existingEvent.importedFrom
      ? {
        ...(hostClub?.name ? { hostName: hostClub.name } : {}),
        ...(hostClub?.categories?.length ? { categories: hostClub.categories } : {}),
      }
      : {};
    Events.collection.update(eventId, {
      $set: {
        eventID: hostClubID,
        title: checkText(eventData.title, 'title', 'Name', { required: true }),
        description: checkText(eventData.description, 'description', 'Description'),
        date: toDate(eventData.date),
        location: checkText(eventData.location, 'location', 'Location', { required: true }),
        image: optionalImage(eventData.image) || '/images/codingWorkshop.png',
        updatedAt: now(),
        ...(contactEmail ? { email: contactEmail } : {}),
        ...locallyAuthoredFields,
      },
      // Clearing the box takes the address down. A blank left in its place
      // would print nothing and still sit on the record for anyone reading it.
      ...(contactEmail ? {} : { $unset: { email: '' } }),
    });

    if (existingEvent && !existingEvent.importedFrom) {
      const unset = {};
      if (!hostClub?.name) unset.hostName = '';
      if (!hostClub?.categories?.length) unset.categories = '';
      if (Object.keys(unset).length) Events.collection.update(eventId, { $unset: unset });
    }

    EventClubs.collection.remove({ eventId });
    if (hostClub) {
      EventClubs.collection.insert({ clubId: hostClub._id, eventId, userId: this.userId, createdAt: new Date() });
    }

    // A new host can bring new categories, so everyone going is judged again —
    // each against their own sharing choice, not the administrator's who made
    // the edit. See 'Clubs.update'.
    if (Meteor.isServer) {
      syncFriendActivityForEvent(eventId);
    }
  },

  'Events.remove'(eventId) {
    check(eventId, String);
    requireAdmin(this.userId);
    Events.collection.remove(eventId);
    EventClubs.collection.remove({ eventId });
    // Everyone who ever said they were going to this event, or passed on it,
    // still has a row pointing at it. Those rows are why a deleted event could
    // go on being counted in someone's Going list and in the passed tally, for
    // an event no page could ever render again.
    EventSwipes.collection.remove({ eventId });
  },

  'eventSwipes.record'(eventId, decision, kind = 'event', recommendationContext = {}) {
    check(eventId, String);
    check(decision, String);
    check(kind, String);
    check(recommendationContext, Object);
    requireLoggedIn(this.userId);

    if (!SWIPE_DECISIONS.includes(decision)) {
      throw new Meteor.Error('invalid-decision', 'A swipe says you are going, that you joined, or that you passed.');
    }
    if (!['event', 'club'].includes(kind)) {
      throw new Meteor.Error('invalid-kind', 'A swipe is on either an event or a club.');
    }
    // Refused rather than quietly corrected. A 'going' stored against a group
    // would be read back under the wrong list and offered to friends as an RSVP
    // to something that has no date, and the caller that sent it has a bug
    // worth hearing about.
    const fittingKind = SWIPE_KIND_FOR_DECISION[decision];
    if (fittingKind && fittingKind !== kind) {
      throw new Meteor.Error('decision-kind-mismatch', decision === 'going'
        ? 'Going is for events. To be part of a group, join it.'
        : 'Joining is for groups. For an event, say you are going.');
    }

    // Only the server can authoritatively check existence; a client stub may
    // simply not have the record cached, which should not block the call.
    const collection = kind === 'club' ? Clubs.collection : Events.collection;
    const listing = collection.findOne(eventId);
    if (Meteor.isServer) {
      if (!listing) {
        throw new Meteor.Error('not-found', 'That listing could not be found.');
      }
      // 'joined' is a fact about a membership, so it is stored only where there
      // is one. The deck sends the join and then this swipe as two calls, and
      // the join can fail by itself: it shares the general rate limit with
      // every other method, where this one has its own. The swipe then landed
      // alone, the card was hidden for good, and the row said 'joined' about
      // someone who was not a member. Methods from one client run in order, so
      // by the time this runs the join has finished, one way or the other.
      if (decision === 'joined' && !ProfileClubs.collection.findOne({ userId: this.userId, clubId: listing._id })) {
        throw new Meteor.Error('not-a-member', 'That join did not go through. Try again.');
      }
    }
    // Shareable only if this person has turned sharing on AND the listing is
    // not a sensitive one. Their own choice, read once; without it, 'private'.
    // An RSVP is judged with the groups that host the event, because going to
    // a group's meeting says what belonging to the group says. Only the server
    // holds every host, and the row a stub writes is replaced by the server's.
    const friendActivityVisibility = friendActivityVisibilityFor(
      Meteor.isServer && kind === 'event' ? eventWithHostSignals(listing) : listing,
      { sharing: sharesFriendActivity(this.userId) },
    );

    const existing = EventSwipes.collection.findOne({ userId: this.userId, eventId });
    const verifiedContext = verifiedRecommendationContext(this.userId, recommendationContext);
    let swipeId = existing?._id;
    if (existing) {
      EventSwipes.collection.update(existing._id, {
        $set: { decision, kind, friendActivityVisibility, createdAt: new Date() },
      });
    } else {
      swipeId = EventSwipes.collection.insert({
        userId: this.userId,
        eventId,
        decision,
        kind,
        friendActivityVisibility,
        createdAt: new Date(),
      });
    }

    // The recommender hears about a decision, not about a call. Saying "going"
    // to an event the person is already going to — a double tap, a call resent
    // after a dropped connection — changes nothing, and used to be counted as a
    // second RSVP.
    if (existing?.decision === decision) {
      return swipeId;
    }
    // Swiping left over a standing RSVP really does cancel it, so that is said
    // first and said separately: 'passed' alone would leave the recommender
    // holding an RSVP for someone who is no longer going. It needs an id of its
    // own, because the recorder treats a repeated clientEventId as a retry and
    // would drop whichever of the two came second.
    if (existing?.decision === 'going') {
      captureCanceledRsvp(existing, decision, verifiedContext, verifiedContext.clientEventId
        ? { clientEventId: `${verifiedContext.clientEventId}:rsvp_canceled` }
        : {});
    }
    const interaction = SWIPE_INTERACTION_FOR_DECISION[decision];
    if (interaction) {
      captureSwipeInteraction({ userId: this.userId, eventId, kind }, interaction, verifiedContext);
    }
    return swipeId;
  },

  'eventSwipes.remove'(eventId, action = 'undo', recommendationContext = {}) {
    check(eventId, String);
    check(action, String);
    check(recommendationContext, Object);
    requireLoggedIn(this.userId);
    if (!['undo', 'rsvp_canceled', 'correction'].includes(action)) {
      throw new Meteor.Error(
        'invalid-action',
        'A swipe is taken back by undoing it, by saying you are not going, or as a correction.',
      );
    }
    const existing = EventSwipes.collection.findOne({ userId: this.userId, eventId });
    const verifiedContext = verifiedRecommendationContext(this.userId, recommendationContext);
    EventSwipes.collection.remove({ userId: this.userId, eventId });
    if (!existing) {
      return;
    }
    if (existing.decision === 'going') {
      captureCanceledRsvp(existing, action, verifiedContext);
      return;
    }
    if (existing.decision === 'joined') {
      // Rewinding a right swipe on a group takes back the join it made, which
      // is where 'left_group' comes from. The swipe row itself told the
      // recommender nothing when it was written, so removing it for any other
      // reason has nothing to retract — and must not end a membership the
      // person never asked to end.
      if (action === 'undo') {
        leaveClub(this.userId, eventId, verifiedContext);
      }
      return;
    }
    // A passed row was never an RSVP. "Not going" arriving for one — a page
    // that had not yet heard the row changed — is recorded as the correction it
    // amounts to, not as the cancelling of an RSVP that was never made.
    if (action === 'rsvp_canceled') {
      captureSwipeInteraction(existing, 'correction', verifiedContext, { context: { reason: action } });
      return;
    }
    captureSwipeInteraction(existing, action, verifiedContext);
  },

  'eventSwipes.clearPassed'() {
    requireLoggedIn(this.userId);
    EventSwipes.collection.find({ userId: this.userId, decision: 'passed' }).forEach(swipe => {
      captureRecommendationInteraction({
        userId: this.userId,
        entityType: swipe.kind === 'club' ? 'group' : 'event',
        entityId: swipe.eventId,
        action: 'correction',
        occurredAt: new Date(),
        context: { reason: 'clear_passed' },
        source: 'legacy',
      });
    });
    EventSwipes.collection.remove({ userId: this.userId, decision: 'passed' });
  },

  'friends.request'(receiverId) {
    check(receiverId, String);
    requireLoggedIn(this.userId);

    if (receiverId === this.userId) {
      throw new Meteor.Error('invalid-friend', 'You cannot friend yourself.');
    }
    if (Meteor.isServer && !Meteor.users.findOne(receiverId)) {
      throw new Meteor.Error('user-not-found', 'That user could not be found.');
    }
    const existing = Friends.collection.findOne({
      $or: [
        { requesterId: this.userId, receiverId },
        { requesterId: receiverId, receiverId: this.userId },
      ],
    });
    if (existing) {
      return existing._id;
    }
    return Friends.collection.insert({
      requesterId: this.userId,
      receiverId,
      pairKey: [this.userId, receiverId].sort().join(':'),
      status: 'pending',
      createdAt: new Date(),
    });
  },

  'friends.accept'(edgeId) {
    check(edgeId, String);
    requireLoggedIn(this.userId);

    const edge = Friends.collection.findOne(edgeId);
    if (!edge || edge.receiverId !== this.userId) {
      throw new Meteor.Error('not-authorized', 'Only the request receiver can accept it.');
    }
    const acceptedAt = now();
    Friends.collection.update(edgeId, { $set: { status: 'accepted', respondedAt: acceptedAt } });
    setFriendRecommendationEdges(edge.requesterId, edge.receiverId, acceptedAt);
  },

  'friends.decline'(edgeId) {
    check(edgeId, String);
    requireLoggedIn(this.userId);

    const edge = Friends.collection.findOne(edgeId);
    if (!edge || edge.receiverId !== this.userId) {
      throw new Meteor.Error('not-authorized', 'Only the request receiver can decline it.');
    }
    Friends.collection.remove(edgeId);
  },

  'friends.remove'(otherUserId) {
    check(otherUserId, String);
    requireLoggedIn(this.userId);

    Friends.collection.remove({
      $or: [
        { requesterId: this.userId, receiverId: otherUserId },
        { requesterId: otherUserId, receiverId: this.userId },
      ],
    });
    endFriendRecommendationEdges(this.userId, otherUserId);
  },

  'clubs.addTag'(clubId, tag) {
    check(clubId, String);
    check(tag, String);
    requireLoggedIn(this.userId);

    const clean = normalizeTag(tag);
    if (clean.length < 2) {
      throw new Meteor.Error('invalid-tag', 'Tags need at least 2 characters.');
    }
    const club = Clubs.collection.findOne(clubId);
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That club could not be found.');
    }
    // Server-only: the client cache does not always contain membership docs.
    if (Meteor.isServer) {
      const isMember = ProfileClubs.collection.findOne({ userId: this.userId, clubId });
      if (!isMember && !Roles.userIsInRole(this.userId, 'admin')) {
        throw new Meteor.Error('not-a-member', 'Join the club to add tags.');
      }
    }
    const tags = club.tags || [];
    const taken = [...tags, ...(club.categories || [])];
    if (taken.some(existing => `${existing}`.toLowerCase() === clean.toLowerCase())) {
      return;
    }
    if (tags.length >= 20) {
      throw new Meteor.Error('too-many-tags', 'This club already has 20 tags.');
    }
    Clubs.collection.update(clubId, { $push: { tags: clean } });
    followTagChange(club);
  },

  'clubs.removeTag'(clubId, tag) {
    check(clubId, String);
    check(tag, String);
    requireLoggedIn(this.userId);

    const club = Clubs.collection.findOne(clubId);
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That club could not be found.');
    }
    const isOwner = club.owner === getUsername(this.userId);
    if (!isOwner && !Roles.userIsInRole(this.userId, 'admin')) {
      throw new Meteor.Error('not-authorized', 'Only the club owner or an admin can remove tags.');
    }
    Clubs.collection.update(clubId, { $pull: { tags: tag } });
    followTagChange(club);
  },

  'Clubs.organizeEvent'({ clubID, eventID }) {
    check(clubID, Match.OneOf(Number, String));
    check(eventID, String);
    requireLoggedIn(this.userId);

    const club = findClubByAnyId(clubID);
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That club could not be found.');
    }
    const exists = EventClubs.collection.findOne({ clubId: club._id, eventId: eventID });
    if (exists) {
      return exists._id;
    }
    const linkId = EventClubs.collection.insert({ clubId: club._id, eventId: eventID, userId: this.userId, createdAt: new Date() });
    // A new host is a new thing an RSVP can give away, so the people already
    // going are judged again, as they are when 'Events.update' changes a host.
    if (Meteor.isServer) {
      syncFriendActivityForEvent(eventID);
    }
    return linkId;
  },
});

export { addClubMethod };
