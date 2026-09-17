import { Clubs } from '../club/Club';
import { Events } from '../events/Events';
import { EventClubs } from '../events/EventClubs';
import { EventSwipes } from '../events/EventSwipes';
import { ProfileClubs } from '../profile/ProfileClubs';
import { Profiles } from '../profiles/Profiles';
import {
  FRIEND_ACTIVITY_VISIBILITY,
  LISTING_PRIVACY_FIELDS,
  friendActivityVisibilityFor,
  withHostSignals,
} from './FriendActivityPrivacy';

/**
 * Keeping the stored answer true.
 *
 * Whether a friend may be shown a membership or an RSVP is decided once and
 * written on the row (`friendActivityVisibility`), so the publication can
 * select on it and never has to judge a listing while it is publishing. The
 * price of storing an answer is that it can go stale, and it depends on two
 * things that both change: the listing (an editor files a group under
 * 'support_group', a member tags it 'recovery') and the person (they turn
 * sharing on or off). Each function here recomputes the rows one of those
 * changes can reach, and writes only the rows whose answer actually differs.
 * A group reaches further than its own members: an RSVP is judged with the
 * groups that host the event, so a change to a group reaches those rows too.
 *
 * The functions that write are for the server, and every caller keeps them
 * there. They read other people's profiles, which a browser never holds, so a
 * method stub that ran one would mark private the very rows the server is
 * about to mark shareable.
 */

const ROW_FIELDS = { fields: { userId: 1, clubId: 1, eventId: 1, kind: 1, friendActivityVisibility: 1 } };

const distinct = values => [...new Set(values)];

/** Only `true` is consent. No profile, no field and `false` all mean no. */
export const sharesFriendActivity = userId => Boolean(userId) && Profiles.collection.findOne(
  { userId, friendActivitySharing: true },
  { fields: { _id: 1 } },
) !== undefined;

const sharingAmong = userIds => new Set(Profiles.collection.find(
  { userId: { $in: userIds }, friendActivitySharing: true },
  { fields: { userId: 1 } },
).map(profile => profile.userId));

const clubsById = ids => new Map(Clubs.collection.find(
  { _id: { $in: ids } },
  { fields: LISTING_PRIVACY_FIELDS },
).map(club => [club._id, club]));

/**
 * These events, each carrying its hosts' signals (see withHostSignals), by _id.
 *
 * An event names its host two ways and both are live. An EventClubs row is
 * what 'Events.insert', 'Clubs.organizeEvent' and ingestion write. The older
 * `eventID` holds the host's clubID, and 0 where there is no host; the pages
 * still read it, so it is read here. A link to a group that has since gone
 * finds nothing, and the event is then judged by what is left.
 */
const withHosts = events => {
  const links = EventClubs.collection.find(
    { eventId: { $in: events.map(event => event._id) } },
    { fields: { eventId: 1, clubId: 1 } },
  ).fetch();
  const hosts = Clubs.collection.find({
    $or: [
      { _id: { $in: distinct(links.map(link => link.clubId)) } },
      { clubID: { $in: distinct(events.map(event => event.eventID).filter(Boolean)) } },
    ],
  }, { fields: { ...LISTING_PRIVACY_FIELDS, clubID: 1 } }).fetch();

  const hostById = new Map(hosts.map(host => [host._id, host]));
  const hostByNumber = new Map(hosts.map(host => [host.clubID, host]));
  const linkedTo = new Map();
  links.forEach(link => linkedTo.set(link.eventId, [...(linkedTo.get(link.eventId) || []), hostById.get(link.clubId)]));

  return new Map(events.map(event => [event._id, withHostSignals(event, distinct([
    ...(linkedTo.get(event._id) || []),
    event.eventID ? hostByNumber.get(event.eventID) : undefined,
  ]).filter(Boolean))]));
};

const eventsById = ids => withHosts(Events.collection.find(
  { _id: { $in: ids } },
  { fields: { ...LISTING_PRIVACY_FIELDS, eventID: 1 } },
).fetch());

/**
 * One event, for the moment an RSVP to it is written. For the server, like
 * everything here that judges: a browser holds some of the groups and some of
 * the links, and an answer worked out from part of the hosts is not one.
 */
export const eventWithHostSignals = event => event && withHosts([event]).get(event._id);

/** Every event a group hosts, by either of the two links. */
const eventIdsHostedBy = clubId => {
  const club = Clubs.collection.findOne(clubId, { fields: { clubID: 1 } });
  return distinct([
    ...EventClubs.collection.find({ clubId }, { fields: { eventId: 1 } }).map(link => link.eventId),
    ...(club?.clubID ? Events.collection.find({ eventID: club.clubID }, { fields: { _id: 1 } }).map(event => event._id) : []),
  ]);
};

/**
 * Recompute the rows two selectors reach, against the listings as they are now
 * and against what each row's OWNER has chosen — never the caller's choice: the
 * caller is often an administrator editing a group, and their own preference
 * says nothing about its members'. A selector left out reaches nothing.
 * Returns how many rows changed.
 */
const syncRows = ({ memberships, swipes }) => {
  const membershipRows = memberships ? ProfileClubs.collection.find(memberships, ROW_FIELDS).fetch() : [];
  const swipeRows = swipes ? EventSwipes.collection.find(swipes, ROW_FIELDS).fetch() : [];
  const clubSwipes = swipeRows.filter(swipe => swipe.kind === 'club');
  const eventSwipes = swipeRows.filter(swipe => swipe.kind !== 'club');

  const sharing = sharingAmong(distinct([...membershipRows, ...swipeRows].map(row => row.userId)));
  const clubs = clubsById(distinct([
    ...membershipRows.map(membership => membership.clubId),
    ...clubSwipes.map(swipe => swipe.eventId),
  ]));
  const events = eventsById(distinct(eventSwipes.map(swipe => swipe.eventId)));

  let changed = 0;
  const settle = (collection, row, listing) => {
    const friendActivityVisibility = friendActivityVisibilityFor(listing, { sharing: sharing.has(row.userId) });
    if (row.friendActivityVisibility !== friendActivityVisibility) {
      collection.update(row._id, { $set: { friendActivityVisibility } });
      changed += 1;
    }
  };
  membershipRows.forEach(membership => settle(ProfileClubs.collection, membership, clubs.get(membership.clubId)));
  clubSwipes.forEach(swipe => settle(EventSwipes.collection, swipe, clubs.get(swipe.eventId)));
  eventSwipes.forEach(swipe => settle(EventSwipes.collection, swipe, events.get(swipe.eventId)));
  return changed;
};

/**
 * Every row, at boot.
 *
 * Sharing is off until a person turns it on, and nobody has yet. So the first
 * boot after the setting arrived turns EVERY existing row private — including
 * rows that friends could see the day before. That is intended: those rows were
 * shared without anybody having been asked, and the fix for that is not to keep
 * sharing them until they object. After that first pass this only catches
 * drift — a listing edited straight in the database, a row written by an older
 * build — and on a settled database it writes nothing.
 */
export const syncFriendActivityPrivacy = () => syncRows({ memberships: {}, swipes: {} });

/**
 * A group was edited or retagged: its memberships, the swipes that joined it,
 * and the RSVPs to every event it hosts. The last of those was missing, so a
 * group moved under 'lgbtq' hid its members at once and went on showing who
 * was going to its meetings until the next restart.
 */
export const syncFriendActivityForClub = clubId => syncRows({
  memberships: { clubId },
  swipes: {
    $or: [
      { eventId: clubId, kind: 'club' },
      { eventId: { $in: eventIdsHostedBy(clubId) }, kind: { $ne: 'club' } },
    ],
  },
});

/** An event was edited, or given a host: the RSVPs to it. */
export const syncFriendActivityForEvent = eventId => syncRows({
  swipes: { eventId, kind: { $ne: 'club' } },
});

/**
 * A person changed their mind.
 *
 * Off is two blunt updates rather than a walk, deliberately. Hiding everything
 * must not depend on finding a single listing, on judging one, or on a loop
 * that could stop half way: when this returns, no row of theirs is shareable.
 * `$ne` also reaches rows from before the field existed. On is the careful
 * direction — each row is shareable only where its own listing allows it.
 */
export const syncFriendActivityForUser = userId => {
  if (sharesFriendActivity(userId)) {
    return syncRows({ memberships: { userId }, swipes: { userId } });
  }
  const shown = { userId, friendActivityVisibility: { $ne: FRIEND_ACTIVITY_VISIBILITY.private } };
  const hide = { $set: { friendActivityVisibility: FRIEND_ACTIVITY_VISIBILITY.private } };
  return ProfileClubs.collection.update(shown, hide, { multi: true })
    + EventSwipes.collection.update(shown, hide, { multi: true });
};
