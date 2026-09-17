import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Roles } from 'meteor/alanning:roles';
import { Random } from 'meteor/random';
import { Clubs } from '../../api/club/Club';
import { ClubJoinRequests, JOIN_REQUEST_COOLDOWN_MS } from '../../api/club/ClubJoinRequests';
import { Events } from '../../api/events/Events';
import { Profiles } from '../../api/profiles/Profiles';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes, SWIPE_DECISIONS, SWIPE_KIND_FOR_DECISION } from '../../api/events/EventSwipes';
import { Friends } from '../../api/friends/Friends';
import { Counters } from '../../api/counters/Counters';
import { normalizeSchedule, parseMeetingTime } from '../../api/club/schedule';
import '../../api/recommendations/RecommendationsMethods';
import { recordRecommendationInteraction } from '../../api/recommendations/interactionRecorder';
import {
  RecommendationGraphEdges,
  RecommendationRequests,
} from '../../api/recommendations/RecommendationData';
import {
  LISTING_PRIVACY_FIELDS,
  friendActivityVisibilityFor,
  friendActivityVisibilityOfRow,
  isAnonymousListing,
  isSensitiveListing,
  tookPartWhileAnonymous,
} from '../../api/privacy/FriendActivityPrivacy';
import {
  eventIdsHostedBy,
  eventWithHostSignals,
  sharesFriendActivity,
  syncFriendActivityForClub,
  syncFriendActivityForEvent,
  syncFriendActivityForUser,
} from '../../api/privacy/friendActivitySync';
import { anonymousMemberRows, nameNewProfile } from '../../api/privacy/anonymousNames';
import { EMAIL_SHAPE, LIST_MAX_ENTRIES, TEXT_LIMITS } from '../../api/listing/limits';
import { checkImage, insertWithPhoto, photoFieldFor, removePhoto } from '../../api/photos/photoStore';
import { OWNERSHIP_FIELDS, accountNameOf, canManageListing } from '../../api/listing/ownership';
import { isOpenToAll } from '../../api/listing/audience';
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

/** What a new listing's `owner` is stamped with. See api/listing/ownership.js,
    which is also where the question "is this theirs?" is answered. */
const getUsername = accountNameOf;

/**
 * The owner, or an administrator. The reason is the caller's to give, because
 * it is what the person reads and "you cannot do that" tells them nothing
 * about who can.
 */
const requireListingManager = (userId, record, reason) => {
  if (!canManageListing(userId, record)) {
    throw new Meteor.Error('not-authorized', reason);
  }
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

/** The listing forms send '' for "no photo", and a listing without one is
    drawn from its topic. Only a photo that is there is checked. What may be
    an image at all is checkImage's to say: api/photos/photoStore.js. */
const optionalImage = image => (image ? checkImage(image) : image);

/**
 * What an edit stores in a listing's `image`, or a profile's `picture`.
 *
 * On the server that is photoFieldFor's answer. An upload used to be written
 * onto the document as it arrived — up to 700,000 characters that every
 * publication then sent to every visitor with the card. It goes to the photo
 * store now and the document keeps the path it is served from; a photo taken
 * down is removed from the store, not just from the form; and a path that
 * names some other listing's photo is refused.
 *
 * A browser's stub has no store to put anything in, so it only checks the
 * value, and the person sees what they sent until the server's record
 * replaces it. The same goes for an edit aimed at a record that is not there:
 * nothing is kept on behalf of a listing that does not exist.
 *
 * Call it LAST, after every other field has been accepted. It writes, and a
 * new photo stored for an edit that was then refused over its title would be
 * a change the person was told had not happened.
 */
const editedImage = (kind, record, value, field = 'image') => (Meteor.isServer && record
  ? photoFieldFor({ kind, ownerId: record._id, value, previous: record[field] })
  : optionalImage(value));

/**
 * A contact email the organizer chose to print on the listing.
 *
 * Optional, and blank means "publish none" — the card then draws no mail row,
 * the same rule as a group's contact box. What is given is trimmed and
 * lowercased, so one address spelled two ways does not read as two, and it is
 * checked only for the shape every address has (EMAIL_SHAPE) and the length
 * ceiling the mail standards set. Anything stricter turns away real
 * addresses, and the reason here is shown to the person who typed it.
 */
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

/** The two values the product writes. The events schema allows more, from the
    ingestion pipeline's first draft; see visibilityOf for how those are read. */
const VISIBILITY = Match.OneOf('public', 'private');

/**
 * Public or private, and nothing in between. Absent is public, because that
 * is what every listing made before the field existed is. Any OTHER value is
 * private — an old 'members' or 'unlisted', or a word added next year — so
 * that a value this code has never heard of hides a listing rather than
 * showing it. The test itself is the publications' own (isOpenToAll), so the
 * methods and the wall cannot come to disagree about what "public" means.
 */
const visibilityOf = record => (isOpenToAll(record) ? 'public' : 'private');

/**
 * Whether anonymity is out of the owner's hands: it would still hold with
 * their own flag off. For a group that means it is sensitive. An event is
 * judged with its hosts (pass eventWithHostSignals), so for one it also means
 * a group that hosts it is anonymous — going to an anonymous group's meeting
 * says who is in the group. The event's own flag is put down BEFORE the
 * hosts' are gathered in, or it would be indistinguishable from theirs.
 */
const anonymityIsLocked = (record, withHosts = listing => listing) => isAnonymousListing(
  withHosts({ ...record, anonymous: false }),
);

/** The group an event NAMES as its host, in its own `eventID`; 0 is none. */
const namedHostOf = event => (event?.eventID ? Clubs.collection.findOne({ clubID: event.eventID }) : undefined);

/**
 * Whoever may decide things about an event: the person who posted it, the
 * person who runs the group it names as its host, or an administrator.
 *
 * One answer, because two methods ask and they must not come apart. Setting
 * an event's privacy is the obvious one. Giving it a host is the other, and
 * is the same power by another door: an RSVP is judged with every group that
 * hosts the event, and the members of a hosting group are sent the event even
 * when it is private.
 */
const canManageEvent = (userId, event, namedHost = namedHostOf(event)) => canManageListing(userId, event)
  || canManageListing(userId, namedHost);

const isMemberOf = (userId, clubIds) => clubIds.length > 0 && Boolean(ProfileClubs.collection.findOne(
  { userId, clubId: { $in: clubIds } },
  { fields: { _id: 1 } },
));

/** Said by both methods that can put a private group's event on the wall. */
const PRIVATE_HOST_REASON = 'Events for a private group stay private unless the person who runs it says otherwise.';

/**
 * Whether a listing is this person's to swipe on.
 *
 * A public one is anybody's. A private one belongs to the people it is sent
 * to, and the test is the member publication's own: a private group to the
 * people in it, a private event to the members of a group that hosts it, by
 * either of the two links an event has to a group — and to whoever runs any of
 * them, who may not have joined their own group.
 *
 * For the server. A browser holds some memberships and some links, and part
 * of the answer is not the answer.
 */
const mayTakePartIn = (userId, kind, listing) => {
  if (isOpenToAll(listing) || canManageListing(userId, listing)) {
    return true;
  }
  const groups = kind === 'club' ? [listing] : Clubs.collection.find({
    $or: [
      { _id: { $in: EventClubs.collection.find({ eventId: listing._id }, { fields: { clubId: 1 } }).map(link => link.clubId) } },
      ...(listing.eventID ? [{ clubID: listing.eventID }] : []),
    ],
  }, { fields: OWNERSHIP_FIELDS }).fetch();
  return groups.some(group => canManageListing(userId, group))
    || isMemberOf(userId, groups.map(group => group._id));
};

/**
 * A stored count, moved by one.
 *
 * Down is conditional on there being something left to take, inside the same
 * update, so the floor at zero is the database's. A read followed by a write
 * is passed by two people leaving at once, and a count that has gone negative
 * is refused by the schema on every later write to it. A count that has
 * drifted the other way heals at the next boot: see backfillListingCounts.
 */
const adjustCount = (collection, _id, field, by) => {
  if (by > 0) {
    collection.update(_id, { $inc: { [field]: 1 } });
    return;
  }
  collection.update({ _id, [field]: { $gt: 0 } }, { $inc: { [field]: -1 } });
};

/** A group asks first only when its owner said so AND it is not anonymous:
    a request is a name handed to the owner, which an anonymous group — by
    choice or because it is sensitive — has promised nobody will be given. */
const takesJoinRequests = club => club.approveMembers === true && !isAnonymousListing(club);

/**
 * Put a person in a group. The ONE way in.
 *
 * There are three doors — "Join" on a public group, an invite link, and an
 * owner approving a request — and they used to be one, so nothing could
 * disagree. Written three times, the third copy is the one that forgets the
 * member count, or judges friend visibility by the OWNER's sharing choice
 * because the owner happens to be the caller. So `userId` here is always the
 * person joining, never `this.userId` by habit.
 *
 * Joining twice is not an error and not a second row: the membership that is
 * there has its friend visibility re-judged, and nothing else happens.
 *
 * A join made while the group is anonymous says so on the row
 * (`joinedAnonymous`), here and nowhere else, because 'clubs.members' shows a
 * made-up name for those rows alone. The second "Join" above leaves it as it
 * was: somebody the owner has already been shown by name must not be turned
 * into a made-up row by opening the link again after the group went anonymous.
 *
 * A request the person still had open is settled on the way in. They may have
 * come through an invite link while the owner was deciding, and a request left
 * pending would sit in the owner's list asking about somebody already here —
 * or, left declined, would refuse them for a month the next time they ask.
 * Only the server settles it: a browser does not hold other people's requests
 * and has nothing to gain from guessing at its own.
 */
const joinClub = (userId, club, verifiedContext = {}) => {
  const choice = { sharing: sharesFriendActivity(userId) };
  const existing = ProfileClubs.collection.findOne({ userId, clubId: club._id });
  if (existing) {
    // Judged as the row it is, by when it was made. Somebody who joined while
    // the group was anonymous and opens the invite link a second time has not
    // agreed to anything new, and this used to be one more place that put them
    // back in their friends' feeds once the anonymity had ended.
    ProfileClubs.collection.update(existing._id, {
      $set: { friendActivityVisibility: friendActivityVisibilityOfRow(club, existing, choice) },
    });
    return existing._id;
  }

  const membershipId = ProfileClubs.collection.insert({
    userId,
    clubId: club._id,
    friendActivityVisibility: friendActivityVisibilityFor(club, choice),
    createdAt: now(),
    ...(isAnonymousListing(club) ? { joinedAnonymous: true } : {}),
  });
  adjustCount(Clubs.collection, club._id, 'memberCount', 1);
  if (Meteor.isServer) {
    ClubJoinRequests.collection.update(
      { clubId: club._id, userId, status: { $ne: 'approved' } },
      { $set: { status: 'approved', respondedAt: now() } },
    );
  }
  captureRecommendationInteraction({
    userId,
    entityType: 'group',
    entityId: club._id,
    action: 'joined_group',
    occurredAt: now(),
    ...verifiedContext,
    source: 'legacy',
  });
  return membershipId;
};

/**
 * Ask to join, or find out that the asking is already done.
 *
 * One row per person per group, reused. A second ask while the first is
 * pending changes nothing, so pressing the button twice does not put the name
 * in front of the owner twice. A declined request holds for
 * JOIN_REQUEST_COOLDOWN_MS from the moment it was answered — see that constant
 * for why — and after that the same row goes back to pending, as new.
 */
const requestToJoin = (userId, club) => {
  const existing = ClubJoinRequests.collection.findOne({ clubId: club._id, userId });
  if (!existing) {
    return ClubJoinRequests.collection.insert({ clubId: club._id, userId, status: 'pending', createdAt: now() });
  }
  if (existing.status === 'declined') {
    const waitMs = (existing.respondedAt?.getTime() || 0) + JOIN_REQUEST_COOLDOWN_MS - Date.now();
    if (waitMs > 0) {
      const days = Math.ceil(waitMs / (24 * 60 * 60 * 1000));
      throw new Meteor.Error(
        'request-declined',
        `This group said no for now. You can ask again in ${days} day${days === 1 ? '' : 's'}.`,
      );
    }
    ClubJoinRequests.collection.update(existing._id, {
      $set: { status: 'pending', createdAt: now() },
      $unset: { respondedAt: '', respondedBy: '' },
    });
  }
  return existing._id;
};

/**
 * A group's privacy changed, or something that decides it did: every stored
 * answer that rests on it is brought up to date before the caller hears back.
 *
 * First, the moment anonymity ENDED, if this was it. The owner's decisions are
 * that every switch goes both ways and that an anonymous group's members are
 * shown to nobody, the owner included — and those two met here: anonymous
 * off, read the member list, anonymous back on, and everyone who joined
 * because there was no list had been put on one without a word. The switch
 * still moves. What it cannot do is reach backwards: `anonymousUntil` marks
 * where the promise stopped, and 'clubs.members' names only people who joined
 * after it. It is taken from the group as it WAS and as it IS, judged the way
 * everything else judges, so the other two ways out of anonymity are covered
 * without being listed — an owner removing the 'recovery' tag, an editor
 * re-filing the group — and it is why this is handed the group from before
 * the change rather than its _id.
 *
 * It is stamped BEFORE the rows are judged, because the rows are judged by
 * it. It used to come last, and the sync ahead of it saw a group that was no
 * longer anonymous and had never been: every sharing member went back into
 * their friends' feeds, the people who joined under the promise with the
 * rest, and the person who runs the group could read there the names the
 * member list would not give them.
 *
 * Then friend visibility — the members' rows, and the RSVPs to everything
 * the group hosts — because "who can see I am in this" is the promise being
 * made, and a group that turns anonymous has to be gone from friends' feeds
 * at once, not at the next restart. Then the waiting requests: a group that
 * no longer takes them (it went anonymous, or its owner stopped asking first)
 * has no business holding a list of names, and the people on it can now
 * simply join.
 *
 * For the server, like everything that judges other people's rows.
 */
const followClubPrivacy = clubBefore => {
  if (!Meteor.isServer || !clubBefore) {
    return;
  }
  const clubId = clubBefore._id;
  const club = Clubs.collection.findOne(clubId, { fields: { ...LISTING_PRIVACY_FIELDS, approveMembers: 1 } });
  if (club && isAnonymousListing(clubBefore) && !isAnonymousListing(club)) {
    Clubs.collection.update(clubId, { $set: { anonymousUntil: now() } });
  }
  syncFriendActivityForClub(clubId);
  if (club && !takesJoinRequests(club)) {
    ClubJoinRequests.collection.remove({ clubId, status: 'pending' });
  }
};

/**
 * The same for an event, whose RSVPs are its members. It is anonymous by its
 * own switch, by its own words, or by a group that hosts it, so it is judged
 * with its hosts both times — hand over what eventWithHostSignals made of it
 * BEFORE the change, links and all. A group that stops being anonymous needs
 * nothing from here: its own stamp reaches the RSVPs to everything it hosts.
 */
const followEventPrivacy = (eventId, judgedBefore) => {
  if (!Meteor.isServer) {
    return;
  }
  const event = Events.collection.findOne(eventId, { fields: { ...LISTING_PRIVACY_FIELDS, eventID: 1 } });
  if (event && judgedBefore && isAnonymousListing(judgedBefore) && !isAnonymousListing(eventWithHostSignals(event))) {
    Events.collection.update(eventId, { $set: { anonymousUntil: now() } });
  }
  syncFriendActivityForEvent(eventId);
};

/**
 * A group that is being removed takes its signals with it, and its events stay.
 *
 * An RSVP is judged with the groups that host the event: going to a recovery
 * group's Thursday meeting is private because the GROUP is, and the meeting's
 * own record often says nothing. Remove the group and that reason is gone —
 * the next time the rows are re-judged (any boot does it), every sharing
 * member's RSVP to those meetings would turn shareable, and their friends
 * would be told. Removing a group is what an administrator does to a listing
 * that should not be up; it must not be the act that publishes who went.
 *
 * So what the group knew is written onto the events before it goes: anonymous
 * if the group was (by its switch or by what it is), and otherwise the date
 * its anonymity ended, where that is later than the event's own. Stamped by
 * hand, so the events stop following a group that no longer exists.
 */
const keepHostedEventsPrivate = clubId => {
  if (!Meteor.isServer) {
    return;
  }
  const club = Clubs.collection.findOne(clubId, { fields: { ...LISTING_PRIVACY_FIELDS, anonymousUntil: 1 } });
  const eventIds = club ? eventIdsHostedBy(clubId) : [];
  if (eventIds.length === 0) {
    return;
  }
  if (isAnonymousListing(club)) {
    Events.collection.update(
      { _id: { $in: eventIds }, anonymous: { $ne: true } },
      { $set: { anonymous: true, privacyInherited: false } },
      { multi: true },
    );
  } else if (club.anonymousUntil) {
    Events.collection.update(
      {
        _id: { $in: eventIds },
        $or: [{ anonymousUntil: { $exists: false } }, { anonymousUntil: { $lt: club.anonymousUntil } }],
      },
      { $set: { anonymousUntil: club.anonymousUntil } },
      { multi: true },
    );
  }
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
 *
 * The member count comes down only if a row really went — counted from what
 * the remove reports, not from the read before it, so two "Leave" calls
 * racing each other take one off the count between them.
 *
 * The person's join request goes too, unless it was declined. An approved
 * one is a standing pass back into a private group, and leaving hands it in:
 * coming back means being invited or asking again. A pending one is simply
 * withdrawn, which is what "Leave" on a group you only asked to join means.
 * A declined one stays, because it is the owner's answer and not the
 * requester's to delete — removing it here would reset the wait.
 */
const leaveClub = (userId, clubId, verifiedContext) => {
  const club = findClubByAnyId(clubId);
  const normalizedClubId = club?._id || clubId;
  const existing = ProfileClubs.collection.findOne({ userId, clubId: normalizedClubId });
  const removed = ProfileClubs.collection.remove({ userId, clubId: normalizedClubId });
  if (removed > 0) {
    adjustCount(Clubs.collection, normalizedClubId, 'memberCount', -1);
  }
  if (Meteor.isServer) {
    ClubJoinRequests.collection.remove({ clubId: normalizedClubId, userId, status: { $ne: 'declined' } });
  }
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
 *
 * Crossing it also makes the group anonymous, so what follows is everything
 * a privacy change is followed by — including letting go of the requests it
 * was holding, which name people to an owner who may no longer be told.
 */
const followTagChange = clubBefore => {
  if (!Meteor.isServer) {
    return;
  }
  const clubNow = Clubs.collection.findOne(clubBefore._id);
  if (isSensitiveListing(clubBefore) !== isSensitiveListing(clubNow)) {
    followClubPrivacy(clubBefore);
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
      // Carried over as it stands. An uploaded photo is keyed by the
      // profile's _id, not the account's, and the profile below is updated in
      // place — so a path it already holds still names its own photo.
      picture: existingProfile?.picture || '/images/defaultprofilepic.png',
      interests: publicProfileInterests(interests),
    };

    let profileId = existingProfile?._id;
    if (existingProfile) {
      Profiles.collection.update(existingProfile._id, { $set: profileData });
    } else {
      profileId = Profiles.collection.insert(profileData);
    }
    // Who they will be in an anonymous group, given now so the invitation page
    // can say it before they join one. Both branches: a profile adopted by its
    // email was made by the seed, around everything that gives a name. Only
    // the server can — the hash is keyed, and the key is not in a browser.
    if (Meteor.isServer) {
      nameNewProfile(targetUserId);
    }
    return profileId;
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
    // After the text, because this one writes: see editedImage. A new photo
    // goes to the photo store under the profile's _id and the profile keeps
    // its path, so the people directory sends every member a short string
    // where it used to send every member's avatar. '' takes the photo down,
    // and the profile is then drawn with the default one.
    if (profileData.picture !== undefined) {
      fields.picture = editedImage('profile', profile, profileData.picture, 'picture');
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
    // The photo is kept apart from the profile now, so it has to be taken
    // down apart from it too. Left behind it would still be served, to anyone
    // holding its address, as the face of a profile that no longer exists.
    if (Meteor.isServer) {
      removePhoto({ kind: 'profile', ownerId: profileId });
    }
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
      visibility: Match.Optional(VISIBILITY),
      anonymous: Match.Optional(Boolean),
      approveMembers: Match.Optional(Boolean),
    });
    requireLoggedIn(this.userId);
    const listing = {
      name: checkText(clubData.name, 'name', 'Name', { required: true }),
      description: checkText(clubData.description, 'description', 'Description'),
      location: checkText(clubData.location, 'location', 'Location', { required: true }),
      meetingTime: checkText(clubData.meetingTime, 'meetingTime', 'Meeting time', { required: true }),
      // Blank stays blank. This used to fall back to the creator's account
      // name, which `getUsername` resolves to their EMAIL — so leaving the
      // optional "how to reach us" box empty published your address on the
      // group's card to everyone, including signed-out visitors. An organizer
      // who types a contact has chosen to publish it; one who does not has
      // chosen the opposite, and the card simply draws no contact row.
      contactInfo: checkText(clubData.contactInfo, 'contactInfo', 'Contact'),
    };
    // Checked here with everything else, so that a refused photo does not use
    // up a group number. It is not part of the record: an upload is stored
    // apart from the group, under an _id the group does not have yet, which
    // is insertWithPhoto's business below.
    const image = optionalImage(clubData.image);

    const categories = normalizeCategories(clubData.categories);
    const tags = (clubData.tags || []).map(normalizeTag).filter(tag => tag.length >= 2).slice(0, LIST_MAX_ENTRIES);
    // The owner's choices, stored as they made them. `anonymous` is only ever
    // their own flag: a sensitive group is anonymous whatever it says, and is
    // not stamped `true` here, because a flag the app set would go on holding
    // after an editor re-filed the group and nobody had chosen it. Asking
    // first is the one that has to give way now — there is no approving a
    // request without reading a name.
    const anonymous = clubData.anonymous === true;
    const privacy = {
      visibility: clubData.visibility || 'public',
      anonymous,
      approveMembers: clubData.approveMembers === true && !isAnonymousListing({ categories, tags, anonymous }),
    };

    // Numbered only once everything about it has been accepted, so a refused
    // listing does not use up a group number.
    const clubID = nextNumericId(Clubs.collection, 'clubID');
    return insertWithPhoto({
      kind: 'club',
      collection: Clubs.collection,
      field: 'image',
      value: image,
      record: {
        clubID,
        createdAt: now(),
        updatedAt: now(),
        ...listing,
        owner: getUsername(this.userId),
        categories,
        tags,
        // What the form sent, through the one validator in api/club/schedule.js.
        // A copy of it lived in this file and knew two cadences and three
        // keys, so "first and third Thursday, 6 to 7:30" would have been
        // stored as every Thursday at 6 with no end, and nobody told. Without
        // a schedule worth keeping, the meeting text is read instead.
        schedule: normalizeSchedule(clubData.schedule) || parseMeetingTime(listing.meetingTime) || undefined,
        ...privacy,
        memberCount: 0,
        // A private group is reached by its link and by nothing else, so it
        // has one from its first moment. Minted on the server only: a
        // browser's guess at the secret would be replaced a moment later
        // anyway, and a capability should not exist anywhere it does not
        // have to.
        ...(Meteor.isServer && privacy.visibility === 'private' ? { inviteToken: Random.secret() } : {}),
      },
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
    // The group as it stands: its photo, for editedImage, and what it is
    // judged by, for followClubPrivacy, which has to know what it WAS.
    const stored = Clubs.collection.findOne(clubId, { fields: { ...LISTING_PRIVACY_FIELDS, image: 1 } });
    Clubs.collection.update(clubId, {
      $set: {
        name: checkText(clubData.name, 'name', 'Name', { required: true }),
        // An account name, which is an email address, so it shares that ceiling.
        owner: checkText(clubData.owner, 'email', 'Owner', { required: true }),
        description: checkText(clubData.description, 'description', 'Description'),
        location: checkText(clubData.location, 'location', 'Location', { required: true }),
        meetingTime,
        contactInfo: checkText(clubData.contactInfo, 'contactInfo', 'Contact'),
        categories,
        ...(clubData.tags ? { tags: clubData.tags.map(normalizeTag).filter(tag => tag.length >= 2).slice(0, LIST_MAX_ENTRIES) } : {}),
        updatedAt: now(),
        // Last in the list because it writes: see editedImage. An edit sent
        // without the key leaves the photo alone, which is what it always
        // did — the driver drops an undefined — and is why the stored photo
        // is only touched when the form actually said something about it.
        ...(clubData.image !== undefined ? { image: editedImage('club', stored, clubData.image) } : {}),
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
    followClubPrivacy(stored);
  },

  /**
   * Who can find a group, who can see its members, and whether joining asks
   * first. Every one of them can be changed at any time, in either direction,
   * by the person who runs the group — with one exception, below.
   *
   * Only what is named changes; a key left out is left alone, so a page with
   * one toggle sends one key. Sent nothing, this writes nothing and answers
   * with how things stand, which is how a settings page learns about the lock
   * without working it out for itself.
   *
   * The exception is a sensitive group. It is anonymous because of what it is
   * and not because anybody ticked a box, so turning anonymity OFF is refused
   * — out loud, because quietly keeping it on would leave the owner believing
   * they had a member list coming.
   *
   * Anonymous wins over asking first. An approval is somebody reading a name,
   * so `approveMembers` is written false whenever the group is anonymous,
   * whatever was sent, and the answer says so.
   *
   * Anonymity switched off is off from then on, not from the beginning. The
   * people who joined while nobody could see them stay unseen: see
   * followClubPrivacy, and 'clubs.members'.
   *
   * The group's events follow it while they are still marked
   * `privacyInherited`, and only those: an event whose privacy somebody set by
   * hand keeps that decision. The ones that follow are the ones that NAME this
   * group as their host (`eventID`). A link row in EventClubs is not enough.
   * It says the group is one of an event's hosts, and is written from the
   * event's side — by ingestion, by an editor, by whoever posted the event —
   * which does not hand the event to the person running each group it was
   * linked to. 'Clubs.organizeEvent' once let anyone at all write one, and an
   * event that whoever linked a group to it could take private could be taken
   * down by anybody.
   *
   * Nothing here is simulated. The browser does not hold the owner field, the
   * members' rows or the token, and a guess at any of them helps nobody.
   */
  'Clubs.setPrivacy'(clubId, settings) {
    check(clubId, String);
    check(settings, {
      visibility: Match.Optional(VISIBILITY),
      anonymous: Match.Optional(Boolean),
      approveMembers: Match.Optional(Boolean),
    });
    requireLoggedIn(this.userId);
    if (!Meteor.isServer) {
      return undefined;
    }

    const club = Clubs.collection.findOne(clubId);
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That group could not be found.');
    }
    requireListingManager(this.userId, club, 'Only the person who runs this group can change its privacy.');

    const anonymousLocked = anonymityIsLocked(club);
    if (settings.anonymous === false && anonymousLocked) {
      throw new Meteor.Error(
        'anonymous-locked',
        'Groups like this one are always anonymous, so nobody can see who is in them.',
      );
    }

    const visibility = settings.visibility || visibilityOf(club);
    const anonymous = settings.anonymous ?? club.anonymous === true;
    const approveMembers = !(anonymous || anonymousLocked) && (settings.approveMembers ?? club.approveMembers === true);
    const next = { visibility, anonymous, approveMembers };
    const current = {
      visibility: visibilityOf(club),
      anonymous: club.anonymous === true,
      approveMembers: club.approveMembers === true,
    };
    const answer = { ...next, anonymous: anonymous || anonymousLocked, anonymousLocked };
    // The link exists from the moment there is something for it to open. One
    // already handed out keeps working: going public and back should not
    // break every invitation the owner ever sent.
    const needsInvite = visibility === 'private' && !club.inviteToken;
    const unchanged = Object.keys(next).every(key => next[key] === current[key]);
    if (Object.keys(settings).length === 0 || (unchanged && !needsInvite)) {
      return answer;
    }

    Clubs.collection.update(clubId, {
      $set: {
        ...next,
        updatedAt: now(),
        ...(needsInvite ? { inviteToken: Random.secret() } : {}),
      },
    });
    if (club.clubID && (visibility !== current.visibility || anonymous !== current.anonymous)) {
      Events.collection.update(
        { eventID: club.clubID, privacyInherited: true },
        { $set: { visibility, anonymous, updatedAt: now() } },
        { multi: true },
      );
    }
    followClubPrivacy(club);
    return answer;
  },

  'Clubs.remove'(clubId) {
    check(clubId, String);
    requireAdmin(this.userId);
    // Before anything is taken away, because it reads the group and its links.
    keepHostedEventsPrivate(clubId);
    Clubs.collection.remove(clubId);
    ProfileClubs.collection.remove({ clubId });
    EventClubs.collection.remove({ clubId });
    // Requests to join a group that is gone are names kept for no reason.
    ClubJoinRequests.collection.remove({ clubId });
    // Its photo is stored apart from it, and would otherwise go on being
    // served to anyone holding the address — for a private group, the one
    // thing about it that was ever reachable without being a member.
    if (Meteor.isServer) {
      removePhoto({ kind: 'club', ownerId: clubId });
    }
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

  /**
   * "Join", and what it turns into on a group that is not simply open.
   *
   * The answer says which of two things happened, because the page has to
   * draw them differently: { status: 'joined', membershipId } or
   * { status: 'requested', requestId }. It used to return a bare membership
   * id, which left "you are in" and "you have asked" looking the same.
   *
   * In the order they are asked:
   *   - Someone already in is in. Nothing below can put a member out.
   *   - The person who runs the group, or an administrator, walks in. Asking
   *     an owner for the invitation to their own group would be absurd, and
   *     they are the one holding it anyway.
   *   - A valid invite token joins, always — past "private", past "ask
   *     first", past an earlier "no". The owner handed it out; that was the
   *     approval. It rides in an options object rather than as an argument
   *     of its own because the audit trail records a method's bare strings
   *     and only the KEYS of its objects, and a capability does not belong
   *     in an operations log.
   *   - A request the owner already approved joins. It is normally used up
   *     the moment it is approved; this is for the join that did not land.
   *   - A private group stops there: without its link there is no way in.
   *   - A group that asks first takes a request instead — unless it is
   *     anonymous, where nobody may be shown the name a request carries, so
   *     there is nothing to ask and the person simply joins.
   *
   * The browser simulates only the open case. For every other it holds too
   * little to know the outcome — not the token, not the requests — and an
   * optimistic "joined" that the server then takes back is worse than a
   * moment's wait.
   */
  'profileClubs.add'(clubId, recommendationContext = {}, options = {}) {
    check(clubId, Match.OneOf(String, Number));
    check(recommendationContext, Object);
    check(options, { inviteToken: Match.Optional(String) });
    requireLoggedIn(this.userId);

    const club = findClubByAnyId(clubId);
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That club could not be found.');
    }
    const open = visibilityOf(club) === 'public' && !takesJoinRequests(club);
    if (!Meteor.isServer && !open) {
      return undefined;
    }

    const join = () => ({
      status: 'joined',
      membershipId: joinClub(this.userId, club, verifiedRecommendationContext(this.userId, recommendationContext)),
    });
    if (open
      || ProfileClubs.collection.findOne({ userId: this.userId, clubId: club._id }, { fields: { _id: 1 } })
      || canManageListing(this.userId, club)
      || (Boolean(club.inviteToken) && options.inviteToken === club.inviteToken)
      || ClubJoinRequests.collection.findOne({ clubId: club._id, userId: this.userId, status: 'approved' }, { fields: { _id: 1 } })) {
      return join();
    }
    if (visibilityOf(club) === 'private') {
      throw new Meteor.Error('invite-required', 'This group is private. You need an invite link from the person who runs it.');
    }
    return { status: 'requested', requestId: requestToJoin(this.userId, club) };
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
      visibility: Match.Optional(VISIBILITY),
      anonymous: Match.Optional(Boolean),
    });
    requireLoggedIn(this.userId);
    const contactEmail = contactEmailOf(eventData.email);

    const hostClubID = parseNumericId(eventData.eventID, 'host club ID');
    const hostClub = findClubByAnyId(hostClubID);
    // Anyone can post, and anyone can name a public group as the host. A
    // private one is different: the event copies its host's name, and group
    // numbers count up from one, so without this a stranger could post an
    // event against each number in turn and read the name of every private
    // group on the island off their own listings. Only the server can tell —
    // a browser does not reliably hold the caller's memberships.
    if (Meteor.isServer && hostClub && !isOpenToAll(hostClub) && !canManageListing(this.userId, hostClub)) {
      if (!isMemberOf(this.userId, [hostClub._id])) {
        throw new Meteor.Error('not-a-member', 'Only its members can post an event for a private group.');
      }
      // A member may post for the group. What a member may not do is publish
      // it: the event carries the group's name and categories, and "the owner
      // can override" means the person who runs the group, not everyone they
      // invited. Without this the guard above kept strangers from reading a
      // private group's name, and let any one member print it on the wall.
      if (eventData.visibility === 'public') {
        throw new Meteor.Error('private-host', PRIVATE_HOST_REASON);
      }
    }

    /**
     * An event made without privacy settings of its own takes its host
     * group's, and is marked as still following them, so that an anonymous
     * group's meetings are anonymous without the organizer remembering to say
     * so each Thursday — and stay in step when the group changes its mind.
     *
     * Given either setting, the event is the poster's own decision and follows
     * nothing. The half they did not give still STARTS from the host, because
     * the other default would be 'public', and "I only ticked anonymous" must
     * not be what puts a private group's meeting on the public wall.
     */
    const ownPrivacy = eventData.visibility !== undefined || eventData.anonymous !== undefined;
    const privacy = {
      visibility: eventData.visibility || (hostClub ? visibilityOf(hostClub) : 'public'),
      anonymous: eventData.anonymous ?? hostClub?.anonymous === true,
      privacyInherited: Boolean(hostClub) && !ownPrivacy,
    };

    // An uploaded photo is stored apart from the event, under the _id the
    // event is about to be given; insertWithPhoto makes the two in that order
    // and takes the event back out if the photo cannot be kept.
    const eventId = insertWithPhoto({
      kind: 'event',
      collection: Events.collection,
      field: 'image',
      value: eventData.image || '/images/codingWorkshop.png',
      record: {
        createdAt: now(),
        updatedAt: now(),
        eventID: hostClubID,
        ...privacy,
        goingCount: 0,
        title: checkText(eventData.title, 'title', 'Name', { required: true }),
        description: checkText(eventData.description, 'description', 'Description'),
        date: toDate(eventData.date),
        location: checkText(eventData.location, 'location', 'Location', { required: true }),
        // `owner` is the whole record of who posted this, and the public
        // publications withhold it. A `createdBy` used to be written beside it
        // holding the same account email — and that one they did not withhold.
        owner: getUsername(this.userId),
        // Absent rather than '' when none was given: an empty string is a
        // value the record would then carry, and every reader would have to
        // know it means nothing.
        ...(contactEmail ? { email: contactEmail } : {}),
        ...(hostClub?.name ? { hostName: hostClub.name } : {}),
        ...(hostClub?.categories?.length ? { categories: hostClub.categories } : {}),
      },
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
    // As an RSVP to it is judged NOW, hosts and all, before the edit moves it
    // to another: see followEventPrivacy.
    const judgedBefore = Meteor.isServer ? eventWithHostSignals(existingEvent) : undefined;
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
        // After every field that can be refused, because it writes: see
        // editedImage. No photo — cleared, or not sent — is the stock image,
        // as it always was, and an upload the event had is taken down.
        image: editedImage('event', existingEvent, eventData.image) || '/images/codingWorkshop.png',
        updatedAt: now(),
        ...(contactEmail ? { email: contactEmail } : {}),
        ...locallyAuthoredFields,
        // An event that follows its host follows it to a new one. Without
        // this, moving a meeting under an anonymous group left it saying
        // whatever the old host had said until the new one next changed.
        ...(existingEvent?.privacyInherited && hostClub
          ? { visibility: visibilityOf(hostClub), anonymous: hostClub.anonymous === true }
          : {}),
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
    // the edit. See 'Clubs.update'. Moved out from under an anonymous group,
    // the event keeps hidden the people who said Going while it was there.
    followEventPrivacy(eventId, judgedBefore);
  },

  /**
   * An event's own privacy, set by hand. From this call on the event stops
   * following its host group (`privacyInherited` goes false), so a later
   * change to the group does not quietly undo what somebody decided here.
   *
   * Three people may: whoever posted the event, whoever runs the group it
   * NAMES as its host, and an administrator (canManageEvent). The host is the
   * one in the event's own `eventID` and not any group with a link row to it,
   * for the reason given on 'Clubs.setPrivacy': a link says a group is one of
   * the hosts, and must not be a way to take somebody else's event off the
   * wall.
   *
   * One of the three is held back in one direction. Whoever posted an event
   * for a PRIVATE group, and does not run that group, cannot make it public:
   * the event carries the group's name, and publishing that is for the person
   * who runs the group. They can still make it private again, or anonymous.
   *
   * Anonymity can be locked from two directions. The event is sensitive —
   * judged, as an RSVP to it is, with its hosts' signals — or a group that
   * hosts it is anonymous. Either way who is going says who is in the group,
   * so it stays hidden whatever the event itself would prefer, and being told
   * so beats a switch that moves and does nothing.
   *
   * Sent nothing, it writes nothing and says how things stand. Not simulated,
   * for the reasons 'Clubs.setPrivacy' gives.
   */
  'Events.setPrivacy'(eventId, settings) {
    check(eventId, String);
    check(settings, {
      visibility: Match.Optional(VISIBILITY),
      anonymous: Match.Optional(Boolean),
    });
    requireLoggedIn(this.userId);
    if (!Meteor.isServer) {
      return undefined;
    }

    const event = Events.collection.findOne(eventId);
    if (!event) {
      throw new Meteor.Error('event-not-found', 'That event could not be found.');
    }
    const namedHost = namedHostOf(event);
    if (!canManageEvent(this.userId, event, namedHost)) {
      throw new Meteor.Error(
        'not-authorized',
        'Only the person who posted this event, or who runs its group, can change its privacy.',
      );
    }
    // Only a change that would WIDEN it: a page that sends 'public' for an
    // event the group's owner already made public is not refused for it.
    if (settings.visibility === 'public' && visibilityOf(event) !== 'public'
      && namedHost && !isOpenToAll(namedHost) && !canManageListing(this.userId, namedHost)) {
      throw new Meteor.Error('private-host', PRIVATE_HOST_REASON);
    }

    const anonymousLocked = anonymityIsLocked(event, eventWithHostSignals);
    if (settings.anonymous === false && anonymousLocked) {
      throw new Meteor.Error('anonymous-locked', isSensitiveListing(eventWithHostSignals(event))
        ? 'Events like this one are always anonymous, so nobody can see who is going.'
        : 'This event belongs to an anonymous group, so who is going stays hidden too.');
    }

    const visibility = settings.visibility || visibilityOf(event);
    const anonymous = settings.anonymous ?? event.anonymous === true;
    const answer = { visibility, anonymous: anonymous || anonymousLocked, anonymousLocked };
    if (Object.keys(settings).length === 0) {
      return answer;
    }

    const judgedBefore = eventWithHostSignals(event);
    Events.collection.update(eventId, {
      $set: { visibility, anonymous, privacyInherited: false, updatedAt: now() },
    });
    // Everyone going is judged again, at once: an event that has just turned
    // anonymous must be gone from their friends' feeds before this returns.
    // And one that has just stopped keeps hidden whoever said Going while it
    // was: anonymous off is off from then on, for an event as for a group.
    followEventPrivacy(eventId, judgedBefore);
    return answer;
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
    // And its photo, which is stored apart from it: see 'Clubs.remove'.
    if (Meteor.isServer) {
      removePhoto({ kind: 'event', ownerId: eventId });
    }
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
      // A private listing the caller was never let into is answered exactly
      // as one that is not there, so the reply cannot be used to find out
      // which ids are real. It used to be enough to hold the _id — which a
      // former member does, and anyone a link was once shown to — and "Going"
      // then counted on an event the person had never been invited to.
      if (!listing || !mayTakePartIn(this.userId, kind, listing)) {
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
    // neither anonymous — which a sensitive one always is — nor private.
    // Their own choice, read once; without it, 'private'.
    // An RSVP is judged with the groups that host the event, because going to
    // a group's meeting says what belonging to the group says. Only the server
    // holds every host, and the row a stub writes is replaced by the server's.
    //
    // The same decision said twice is the same decision: it keeps its date,
    // and is judged as the row that stands. A second "Going" used to stamp
    // the RSVP with today, which carried one made while the event was
    // anonymous across the line that keeps those from friends for good.
    const existing = EventSwipes.collection.findOne({ userId: this.userId, eventId });
    const standing = existing?.decision === decision ? existing : undefined;
    const judged = Meteor.isServer && kind === 'event' ? eventWithHostSignals(listing) : listing;
    const choice = { sharing: sharesFriendActivity(this.userId) };
    const friendActivityVisibility = standing
      ? friendActivityVisibilityOfRow(judged, standing, choice)
      : friendActivityVisibilityFor(judged, choice);

    const verifiedContext = verifiedRecommendationContext(this.userId, recommendationContext);
    let swipeId = existing?._id;
    if (existing) {
      EventSwipes.collection.update(existing._id, {
        $set: { decision, kind, friendActivityVisibility, ...(standing ? {} : { createdAt: new Date() }) },
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

    // The event's Going count follows the decision, not the call: it moves
    // only when this write turned somebody into going or out of it. A second
    // "going" counts nothing, and a left swipe over a standing RSVP takes one
    // off. After the write, so a swipe the database refused never counted.
    if (kind === 'event' && (existing?.decision === 'going') !== (decision === 'going')) {
      adjustCount(Events.collection, eventId, 'goingCount', decision === 'going' ? 1 : -1);
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
    const removed = EventSwipes.collection.remove({ userId: this.userId, eventId });
    if (!existing) {
      return;
    }
    if (existing.decision === 'going') {
      // Counted from what the remove reports: two "Not going" calls racing
      // each other both read the row, and only one of them took it away.
      if (removed > 0) {
        adjustCount(Events.collection, eventId, 'goingCount', -1);
      }
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
    requireListingManager(this.userId, club, 'Only the club owner or an admin can remove tags.');
    Clubs.collection.update(clubId, { $pull: { tags: tag } });
    followTagChange(club);
  },

  /**
   * The owner's answer to somebody asking to join.
   *
   * Yes goes through joinClub like every other way in, judged by the
   * REQUESTER's sharing choice and counted once. The status is written before
   * the join, so that if the join were cut short the person holds an approved
   * request — which 'profileClubs.add' honours — rather than a pending one the
   * owner has to find and answer again.
   *
   * Only a pending request is answered. One that is already settled is left
   * as it is and its status handed back: the owner's list was a moment stale,
   * the person came in by invite link meanwhile, and "approve" on somebody
   * already here is not a mistake worth an error.
   */
  'clubs.respondToRequest'(requestId, approve) {
    check(requestId, String);
    check(approve, Boolean);
    requireLoggedIn(this.userId);
    if (!Meteor.isServer) {
      return undefined;
    }

    const request = ClubJoinRequests.collection.findOne(requestId);
    const club = request && Clubs.collection.findOne(request.clubId);
    if (!club) {
      throw new Meteor.Error('request-not-found', 'That request is not there any more.');
    }
    requireListingManager(this.userId, club, 'Only the person who runs this group can answer its requests.');
    if (request.status !== 'pending') {
      return { status: request.status };
    }

    const status = approve ? 'approved' : 'declined';
    ClubJoinRequests.collection.update(requestId, {
      $set: { status, respondedAt: now(), respondedBy: this.userId },
    });
    if (approve) {
      joinClub(request.userId, club);
    }
    return { status };
  },

  /**
   * A new invite link, and the end of the old one. For when a link has
   * travelled further than the owner meant: there is no list of who holds it
   * to strike a name from, so the only revocation is to replace it. People who
   * already joined stay — the token opens the door, it is not the membership.
   *
   * Works on a public group too. A group that asks first may still want a
   * link that lets its own people straight in.
   */
  'clubs.rotateInvite'(clubId) {
    check(clubId, String);
    requireLoggedIn(this.userId);
    if (!Meteor.isServer) {
      return undefined;
    }

    const club = Clubs.collection.findOne(clubId, { fields: OWNERSHIP_FIELDS });
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That group could not be found.');
    }
    requireListingManager(this.userId, club, 'Only the person who runs this group can change its invite link.');
    const inviteToken = Random.secret();
    Clubs.collection.update(clubId, { $set: { inviteToken, updatedAt: now() } });
    return inviteToken;
  },

  /**
   * What an invite link leads to, for the page that asks "join this?".
   *
   * A private group is in no publication the holder of a link can reach, so
   * this is the one place they learn its name — and its name, its size and
   * whether it is anonymous are ALL they learn. Not the owner, not the
   * description, not where it meets: the link is an invitation to join, and
   * the rest is what joining shows.
   *
   * A wrong token and no token get one and the same answer, and the method is
   * tightly rate limited (see rateLimits.js), because its reply is the only
   * thing in the app that says whether a guess was right. Signed-in only, so
   * the guessing at least costs a verified account.
   */
  'clubs.inviteInfo'(token) {
    check(token, String);
    requireLoggedIn(this.userId);
    if (!Meteor.isServer) {
      return undefined;
    }

    const club = token
      ? Clubs.collection.findOne({ inviteToken: token }, { fields: { ...LISTING_PRIVACY_FIELDS, name: 1, memberCount: 1 } })
      : undefined;
    if (!club) {
      throw new Meteor.Error('not-found', 'That invite link does not work any more. Ask for a new one.');
    }
    return {
      clubId: club._id,
      name: club.name,
      anonymous: isAnonymousListing(club),
      memberCount: club.memberCount || 0,
    };
  },

  /**
   * Who is in a group, for the person who runs it.
   *
   * For an anonymous group the answer is made-up names: a handle, a name like
   * "Sleepy Honu" and the day they joined, and NOTHING else — no userId, no
   * real name, no picture (see api/privacy/anonymousNames.js). It used to be
   * a refusal, 'anonymous-group', to the owner and an administrator alike,
   * and that kept the promise at the price of the owner never knowing three
   * regulars from thirty strangers. What anonymous means has not moved:
   * nobody is shown WHO. A roster that can be asked for, photographed or left
   * on a bus now reads as a page of geckos and roosters. Other members and
   * friends are still shown nothing at all.
   *
   * Nobody is ever shown BOTH ways. A made-up name is the same in every
   * anonymous group, so one membership seen once by name and once made-up is
   * that person's name in all of them. This first gave a made-up row to
   * everybody in a group that is anonymous NOW, and an owner had only to read
   * a named list, switch anonymity on — or add the tag 'recovery' — and read
   * it again. So a membership is one of three things, decided by how it was
   * MADE and not by what the group is today:
   *   - joined while the group was anonymous (`joinedAnonymous`, written by
   *     joinClub): a made-up row, for good, whatever the group becomes. The
   *     promise is kept, and anonymity is not a switch away from meaning
   *     nothing: off, read, on again.
   *   - joined a named group that has not been anonymous since: a named row,
   *     for as long as the group is not anonymous. "Since" is
   *     tookPartWhileAnonymous, the rule the friends' feed reads, so the two
   *     cannot drift apart.
   *   - anything else is not sent at all: somebody the owner has seen by name
   *     before the group turned anonymous, and a membership from before the
   *     flag existed, which cannot show which kind it was. They are in the
   *     count, and the page says how many are not listed.
   * The made-up rows come first — in a named group they are all the earlier
   * joins — and the named rows follow in the order people joined.
   *
   * What this does NOT cover, so that nothing is built on it. Leaving and
   * joining again is a new membership, judged by the group as it is that day:
   * somebody who joined under the promise, leaves, and comes back once the
   * anonymity has ended returns by name as their made-up row goes, and an
   * owner who compares the two lists can pair them. The same is true the
   * other way about. Marking every later join to a once-anonymous group as
   * made-up would close that and open worse — such a group can ask first, and
   * its owner would approve a request by name and watch the made-up row
   * arrive. And whoever decides who is let in can always let in one person:
   * a made-up name hides somebody in a crowd, not in a group of one.
   *
   * Authorization is checked first, and it is the same for every kind of
   * group: a stranger and a plain member are refused in the same words
   * whether or not there was anything to see.
   */
  'clubs.members'(clubId) {
    check(clubId, String);
    requireLoggedIn(this.userId);
    if (!Meteor.isServer) {
      return undefined;
    }

    const club = Clubs.collection.findOne(
      clubId,
      { fields: { ...LISTING_PRIVACY_FIELDS, ...OWNERSHIP_FIELDS, anonymousUntil: 1 } },
    );
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That group could not be found.');
    }
    requireListingManager(this.userId, club, 'Only the person who runs this group can see its members.');

    const memberships = ProfileClubs.collection.find(
      { clubId },
      { fields: { userId: 1, createdAt: 1, joinedAnonymous: 1 }, sort: { createdAt: 1 } },
    ).fetch();
    const madeUp = memberships.filter(membership => membership.joinedAnonymous === true);
    const named = isAnonymousListing(club) ? [] : memberships
      .filter(membership => membership.joinedAnonymous !== true && !tookPartWhileAnonymous(club, membership));
    // Only the people who will be shown by name are looked up by name.
    const profiles = new Map(Profiles.collection.find(
      { userId: { $in: named.map(membership => membership.userId) } },
      { fields: { userId: 1, firstName: 1, lastName: 1, picture: 1 } },
    ).map(profile => [profile.userId, profile]));
    return [
      ...anonymousMemberRows(clubId, madeUp),
      ...named.map(({ userId, createdAt }) => {
        const profile = profiles.get(userId);
        return {
          userId,
          firstName: profile?.firstName || '',
          lastName: profile?.lastName || '',
          picture: profile?.picture,
          joinedAt: createdAt,
        };
      }),
    ];
  },

  /**
   * Say that a group is one of an event's hosts.
   *
   * This took any group and any event id from anyone signed in, and a link
   * row is not a label. The members of a hosting group are SENT the event,
   * private or not — so: start a group, link it to a private event, and read
   * the event. An RSVP is judged with every host — so: link an anonymous
   * group to somebody else's event, and its owner is told, falsely, that it
   * "belongs to an anonymous group" and cannot be switched back, while every
   * friend stops seeing who is going. And it walked round the rule in
   * 'Events.insert' that only a private group's own people may name it.
   *
   * So a host is given to an event by the people who may set the event's
   * privacy (canManageEvent), because that is what it does. Not by the
   * group's side alone, even for a public event: a group can turn anonymous,
   * or be tagged 'recovery' by any member, AFTER the link is made, and the
   * event would follow it.
   * And a private group is named only by its own people, as it is when an
   * event is posted.
   *
   * Refused before the link is looked for, so that the answer does not say
   * whether one exists. Only the server can tell: a browser holds neither the
   * event's owner nor, reliably, the caller's memberships. Who may CLAIM an
   * event for a group they run is a question for the ownership work still to
   * come; nothing here stands in its way.
   */
  'Clubs.organizeEvent'({ clubID, eventID }) {
    check(clubID, Match.OneOf(Number, String));
    check(eventID, String);
    requireLoggedIn(this.userId);

    const club = findClubByAnyId(clubID);
    if (!club) {
      throw new Meteor.Error('club-not-found', 'That club could not be found.');
    }
    if (Meteor.isServer) {
      const event = Events.collection.findOne(eventID, { fields: { ...OWNERSHIP_FIELDS, eventID: 1 } });
      if (!event) {
        throw new Meteor.Error('event-not-found', 'That event could not be found.');
      }
      if (!canManageEvent(this.userId, event)) {
        throw new Meteor.Error(
          'not-authorized',
          'Only the person who posted this event, or who runs its group, can link it to a group.',
        );
      }
      if (!isOpenToAll(club) && !canManageListing(this.userId, club) && !isMemberOf(this.userId, [club._id])) {
        throw new Meteor.Error('not-a-member', 'Only its members can link an event to a private group.');
      }
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
