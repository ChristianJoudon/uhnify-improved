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

// `owner` is an account name, which `getUsername` resolves to an email address,
// and these three publications answer to anyone — no login required. It is read
// nowhere but the admin editor, which subscribes to the admin publication
// below, so withholding it here costs nothing and stops every creator's address
// being one console subscription away.
const PUBLIC_FIELDS = { fields: { owner: 0 } };

Meteor.publish(Clubs.userPublicationName, function () {
  return Clubs.collection.find({}, { sort: { name: 1 }, ...PUBLIC_FIELDS });
});

Meteor.publish(Clubs.adminPublicationName, function () {
  if (this.userId && Roles.userIsInRole(this.userId, 'admin')) {
    return Clubs.collection.find({}, { sort: { name: 1 } });
  }
  return this.ready();
});

Meteor.publish(Events.userPublicationName, function () {
  return Events.collection.find({}, { sort: { date: 1 }, ...PUBLIC_FIELDS });
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
  return Clubs.collection.find({}, { sort: { name: 1 }, ...PUBLIC_FIELDS });
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
    return Clubs.collection.find({ _id: { $in: clubIds } }, { sort: { name: 1 } });
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
  return Profiles.collection.find({}, { fields: { userId: 1, firstName: 1, lastName: 1, picture: 1, title: 1, interests: 1 } });
});

// Accepted friends' public activity: the clubs they joined and events they saved.
// Reactive join — unfriending stops publishing immediately; new friends appear live.
publishComposite('Friends.publication.activity', function () {
  if (!this.userId) {
    return null;
  }
  const selfId = this.userId;
  return {
    find() {
      return Friends.collection.find({
        status: 'accepted',
        $or: [{ requesterId: selfId }, { receiverId: selfId }],
      });
    },
    children: [
      {
        find(edge) {
          const friendId = edge.requesterId === selfId ? edge.receiverId : edge.requesterId;
          return ProfileClubs.collection.find({ userId: friendId });
        },
      },
      {
        find(edge) {
          const friendId = edge.requesterId === selfId ? edge.receiverId : edge.requesterId;
          return EventSwipes.collection.find({ userId: friendId, decision: 'interested' });
        },
      },
    ],
  };
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
    $or: [
      { _id: { $in: linkedEventIds } },
      { eventID: { $in: joinedClubNumbers } },
    ],
  }, { sort: { date: 1 } });
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
