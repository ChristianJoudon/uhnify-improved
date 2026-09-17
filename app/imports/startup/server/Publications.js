import { Meteor } from 'meteor/meteor';
import { publishComposite } from 'meteor/reywood:publish-composite';
import { Roles } from 'meteor/alanning:roles';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { Profiles } from '../../api/profiles/Profiles';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Friends } from '../../api/friends/Friends';
import { AuditLog } from '../../api/audit/AuditLog';
import { FRIEND_ACTIVITY_VISIBILITY } from '../../api/privacy/FriendActivityPrivacy';

// `owner` is an account name, which `getUsername` resolves to an email address,
// and `createdBy` was the same address written a second time — stripping the
// first and not the second is how every creator's address stayed one console
// subscription away. Three of the publications below answer to anyone, no
// login required, and two more to any account, which sign-up makes anyone.
// The admin editor is the only screen that reads `owner`, through the admin
// publications, so every other cursor over a club or an event carries this
// projection: it costs nothing and closes the gap.
const PUBLIC_FIELDS = { fields: { owner: 0, createdBy: 0 } };
const PUBLIC_LISTING_SELECTOR = {
  $or: [
    { publicationStatus: 'published' },
    { publicationStatus: { $exists: false } },
  ],
};

Meteor.publish(Clubs.userPublicationName, function () {
  return Clubs.collection.find(PUBLIC_LISTING_SELECTOR, { sort: { name: 1 }, ...PUBLIC_FIELDS });
});

Meteor.publish(Clubs.adminPublicationName, function () {
  if (this.userId && Roles.userIsInRole(this.userId, 'admin')) {
    return Clubs.collection.find({}, { sort: { name: 1 } });
  }
  return this.ready();
});

Meteor.publish(Events.userPublicationName, function () {
  return Events.collection.find(PUBLIC_LISTING_SELECTOR, { sort: { date: 1 }, ...PUBLIC_FIELDS });
});

Meteor.publish(Events.adminPublicationName, function () {
  if (this.userId && Roles.userIsInRole(this.userId, 'admin')) {
    return Events.collection.find({}, { sort: { date: 1 } });
  }
  return this.ready();
});

Meteor.publish(Profiles.userPublicationName, function () {
  if (this.userId) {
    return Profiles.collection.find({ userId: this.userId });
  }
  return this.ready();
});

Meteor.publish(Profiles.adminPublicationName, function () {
  if (this.userId && Roles.userIsInRole(this.userId, 'admin')) {
    return Profiles.collection.find({}, { sort: { lastName: 1, firstName: 1 } });
  }
  return this.ready();
});

Meteor.publish('clubs.all', function () {
  return Clubs.collection.find(PUBLIC_LISTING_SELECTOR, { sort: { name: 1 }, ...PUBLIC_FIELDS });
});

Meteor.publish(null, function () {
  if (this.userId) {
    return Meteor.roleAssignment.find({ 'user._id': this.userId });
  }
  return this.ready();
});

Meteor.publish(ProfileClubs.membershipPublicationName, function () {
  if (this.userId) {
    return ProfileClubs.collection.find({ userId: this.userId });
  }
  return this.ready();
});

Meteor.publish(ProfileClubs.userPublicationName, function () {
  if (this.userId) {
    const profileClubs = ProfileClubs.collection.find({ userId: this.userId }).fetch();
    const clubIds = profileClubs.map(profileClub => profileClub.clubId);
    return Clubs.collection.find({
      $and: [{ _id: { $in: clubIds } }, PUBLIC_LISTING_SELECTOR],
    }, { sort: { name: 1 }, ...PUBLIC_FIELDS });
  }
  return this.ready();
});

// Friend edges where the user is either side.
Meteor.publish(Friends.userPublicationName, function () {
  if (!this.userId) {
    return this.ready();
  }
  return Friends.collection.find({ $or: [{ requesterId: this.userId }, { receiverId: this.userId }] });
});

// A limited people directory so users can find friends: public-safe fields only.
Meteor.publish('Profiles.publication.directory', function () {
  if (!this.userId) {
    return this.ready();
  }
  return Profiles.collection.find({}, { fields: { userId: 1, firstName: 1, lastName: 1, picture: 1, title: 1 } });
});

/**
 * The memberships of one person that a friend may be sent.
 *
 * 'shareable' is written on a row only when its owner has turned sharing on
 * AND the group is not a sensitive one (see FriendActivityPrivacy.js), so this
 * selects rows that have already passed both tests. It is the second of two
 * locks, not the only one: the publication below does not run it at all for a
 * friend whose profile does not say they share.
 */
export const friendClubActivitySelector = userId => ({
  userId,
  friendActivityVisibility: FRIEND_ACTIVITY_VISIBILITY.shareable,
});

/**
 * The same for events, and only the ones a person is going to. A pass is
 * nobody's business, and a swipe that joined a group is already told by the
 * membership above.
 */
export const friendEventActivitySelector = userId => ({
  userId,
  decision: 'going',
  kind: { $ne: 'club' },
  friendActivityVisibility: FRIEND_ACTIVITY_VISIBILITY.shareable,
});

/** The gate: matches a friend's profile only while it says, exactly, `true`. */
export const friendSharingSelector = userId => ({ userId, friendActivitySharing: true });

const friendOf = (edge, selfId) => (edge.requesterId === selfId ? edge.receiverId : edge.requesterId);

/**
 * What friends are up to: three levels, each live.
 *
 * The friendship: unfriending stops everything beneath it at once, and a new
 * friend appears without a reload.
 *
 * The friend's own consent. Sharing is off until a person turns it on, and
 * this level is where the publication itself knows that, rather than trusting
 * that every row was stamped correctly. A friend who is not sharing matches
 * nothing here, so the row queries below never run for them; one who turns it
 * off drops out of this cursor and takes their rows with them, whatever those
 * rows still say. Only `_id` is sent for the match — less than the people
 * directory already sends every signed-in user about the same profile.
 *
 * The rows, already filtered to the shareable ones.
 *
 * There is no reciprocity rule. A person who keeps their own activity private
 * still sees the friends who chose to share theirs.
 *
 * Exported as the plain tree so a test can walk the same cursors the
 * publication opens.
 */
export const friendActivityPublication = selfId => ({
  find() {
    return Friends.collection.find({
      status: 'accepted',
      $or: [{ requesterId: selfId }, { receiverId: selfId }],
    });
  },
  children: [
    {
      find(edge) {
        return Profiles.collection.find(friendSharingSelector(friendOf(edge, selfId)), { fields: { _id: 1 } });
      },
      // Each child is handed the document above it and then that one's own
      // arguments, so the friendship arrives second here.
      children: [
        {
          find(sharer, edge) {
            return ProfileClubs.collection.find(friendClubActivitySelector(friendOf(edge, selfId)));
          },
        },
        {
          find(sharer, edge) {
            return EventSwipes.collection.find(friendEventActivitySelector(friendOf(edge, selfId)));
          },
        },
      ],
    },
  ],
});

publishComposite('Friends.publication.activity', function () {
  if (!this.userId) {
    return null;
  }
  return friendActivityPublication(this.userId);
});

// Event-to-club links are public directory data (creator ids stripped) so pages
// can compute club-linked events reactively on the client.
Meteor.publish(EventClubs.linksPublicationName, function () {
  return EventClubs.collection.find({}, { fields: { eventId: 1, clubId: 1 } });
});

Meteor.publish(EventSwipes.userPublicationName, function () {
  if (this.userId) {
    return EventSwipes.collection.find({ userId: this.userId });
  }
  return this.ready();
});

Meteor.publish(EventClubs.userPublicationName, function () {
  if (!this.userId) {
    return this.ready();
  }

  const profileClubs = ProfileClubs.collection.find({ userId: this.userId }).fetch();
  const clubMongoIds = profileClubs.map(profileClub => profileClub.clubId);
  const joinedClubs = Clubs.collection.find({ _id: { $in: clubMongoIds } }).fetch();
  const joinedClubNumbers = joinedClubs.map(club => club.clubID);
  const linkedEvents = EventClubs.collection.find({ clubId: { $in: clubMongoIds } }).fetch();
  const linkedEventIds = linkedEvents.map(link => link.eventId);

  return Events.collection.find({
    $and: [
      {
        $or: [
          { _id: { $in: linkedEventIds } },
          { eventID: { $in: joinedClubNumbers } },
        ],
      },
      PUBLIC_LISTING_SELECTOR,
    ],
  }, { sort: { date: 1 }, ...PUBLIC_FIELDS });
});

/**
 * The trail, newest first, administrators only.
 *
 * Capped hard rather than paged: this is a log, its entries carry actor emails,
 * and shipping an unbounded personal-activity history to a browser is the leak
 * the redaction in auditTrail.js is there to prevent — it would be undone by
 * publishing all of it anyway.
 */
Meteor.publish(AuditLog.adminPublicationName, function () {
  if (this.userId && Roles.userIsInRole(this.userId, 'admin')) {
    return AuditLog.collection.find({}, { sort: { at: -1 }, limit: 200 });
  }
  return this.ready();
});
