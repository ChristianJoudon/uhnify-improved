import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Roles } from 'meteor/alanning:roles';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { Profiles } from '../../api/profiles/Profiles';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Friends } from '../../api/friends/Friends';
import { Counters } from '../../api/counters/Counters';
import { parseMeetingTime } from '../../api/club/schedule';
import '../../api/recommendations/RecommendationsMethods';
import { recordRecommendationInteraction } from '../../api/recommendations/interactionRecorder';
import {
  RecommendationGraphEdges,
  RecommendationRequests,
} from '../../api/recommendations/RecommendationData';
import { friendActivityVisibilityFor } from '../../api/privacy/FriendActivityPrivacy';
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

    const friendActivityVisibility = friendActivityVisibilityFor({ categories });
    ProfileClubs.collection.update(
      { clubId },
      { $set: { friendActivityVisibility } },
      { multi: true },
    );
    EventSwipes.collection.update(
      { eventId: clubId, kind: 'club' },
      { $set: { friendActivityVisibility } },
      { multi: true },
    );
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

    const existing = ProfileClubs.collection.findOne({ userId: this.userId, clubId: club._id });
    if (existing) {
      ProfileClubs.collection.update(existing._id, {
        $set: { friendActivityVisibility: friendActivityVisibilityFor(club) },
      });
      return existing._id;
    }

    const membershipId = ProfileClubs.collection.insert({
      userId: this.userId,
      clubId: club._id,
      friendActivityVisibility: friendActivityVisibilityFor(club),
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

    const club = findClubByAnyId(clubId);
    const normalizedClubId = club?._id || clubId;
    const existing = ProfileClubs.collection.findOne({ userId: this.userId, clubId: normalizedClubId });
    ProfileClubs.collection.remove({ userId: this.userId, clubId: normalizedClubId });
    if (existing) {
      captureRecommendationInteraction({
        userId: this.userId,
        entityType: 'group',
        entityId: `${normalizedClubId}`,
        action: 'left_group',
        occurredAt: new Date(),
        ...verifiedRecommendationContext(this.userId, recommendationContext),
        source: 'legacy',
      });
    }
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

    const updatedEvent = Events.collection.findOne(eventId);
    EventSwipes.collection.update(
      { eventId, kind: { $ne: 'club' } },
      { $set: { friendActivityVisibility: friendActivityVisibilityFor(updatedEvent) } },
      { multi: true },
    );
  },

  'Events.remove'(eventId) {
    check(eventId, String);
    requireAdmin(this.userId);
    Events.collection.remove(eventId);
    EventClubs.collection.remove({ eventId });
    // Everyone who ever saved or passed this event still has a row pointing at
    // it. Those rows are why a deleted event could go on being counted in
    // someone's saved list and in the passed tally, for an event no page could
    // ever render again.
    EventSwipes.collection.remove({ eventId });
  },

  'eventSwipes.record'(eventId, decision, kind = 'event', recommendationContext = {}) {
    check(eventId, String);
    check(decision, String);
    check(kind, String);
    check(recommendationContext, Object);
    requireLoggedIn(this.userId);

    if (!['interested', 'passed'].includes(decision)) {
      throw new Meteor.Error('invalid-decision', 'A swipe decision must be either "interested" or "passed".');
    }
    if (!['event', 'club'].includes(kind)) {
      throw new Meteor.Error('invalid-kind', 'A swipe is on either an event or a club.');
    }

    // Only the server can authoritatively check existence; a client stub may
    // simply not have the record cached, which should not block the call.
    const collection = kind === 'club' ? Clubs.collection : Events.collection;
    const listing = collection.findOne(eventId);
    if (Meteor.isServer) {
      if (!listing) {
        throw new Meteor.Error('not-found', 'That listing could not be found.');
      }
    }
    const friendActivityVisibility = friendActivityVisibilityFor(listing);

    const existing = EventSwipes.collection.findOne({ userId: this.userId, eventId });
    const verifiedContext = verifiedRecommendationContext(this.userId, recommendationContext);
    if (existing) {
      EventSwipes.collection.update(existing._id, {
        $set: { decision, kind, friendActivityVisibility, createdAt: new Date() },
      });
      captureRecommendationInteraction({
        userId: this.userId,
        entityType: kind === 'club' ? 'group' : 'event',
        entityId: eventId,
        action: decision,
        occurredAt: new Date(),
        ...verifiedContext,
        source: 'legacy',
      });
      return existing._id;
    }

    const swipeId = EventSwipes.collection.insert({
      userId: this.userId,
      eventId,
      decision,
      kind,
      friendActivityVisibility,
      createdAt: new Date(),
    });
    captureRecommendationInteraction({
      userId: this.userId,
      entityType: kind === 'club' ? 'group' : 'event',
      entityId: eventId,
      action: decision,
      occurredAt: new Date(),
      ...verifiedContext,
      source: 'legacy',
    });
    return swipeId;
  },

  'eventSwipes.remove'(eventId, action = 'undo', recommendationContext = {}) {
    check(eventId, String);
    check(action, String);
    check(recommendationContext, Object);
    requireLoggedIn(this.userId);
    if (!['undo', 'unsaved', 'correction'].includes(action)) {
      throw new Meteor.Error('invalid-action', 'A removed swipe must be an undo, unsave, or correction.');
    }
    const existing = EventSwipes.collection.findOne({ userId: this.userId, eventId });
    const verifiedContext = verifiedRecommendationContext(this.userId, recommendationContext);
    EventSwipes.collection.remove({ userId: this.userId, eventId });
    if (existing) {
      captureRecommendationInteraction({
        userId: this.userId,
        entityType: existing.kind === 'club' ? 'group' : 'event',
        entityId: eventId,
        action,
        occurredAt: new Date(),
        ...verifiedContext,
        source: 'legacy',
      });
    }
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
    return EventClubs.collection.insert({ clubId: club._id, eventId: eventID, userId: this.userId, createdAt: new Date() });
  },
});

export { addClubMethod };
