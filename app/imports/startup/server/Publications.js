import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { publishComposite } from 'meteor/reywood:publish-composite';
import { Roles } from 'meteor/alanning:roles';
import { Clubs } from '../../api/club/Club';
import { ClubJoinRequests } from '../../api/club/ClubJoinRequests';
import { Events } from '../../api/events/Events';
import { Profiles } from '../../api/profiles/Profiles';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Friends } from '../../api/friends/Friends';
import { AuditLog } from '../../api/audit/AuditLog';
import { FRIEND_ACTIVITY_VISIBILITY, isAnonymousListing } from '../../api/privacy/FriendActivityPrivacy';
import {
  PUBLIC_LISTING_SELECTOR,
  PUBLISHED_SELECTOR,
  WITHHELD_LISTING_FIELDS,
  eventWindow,
  eventsFrom,
  eventsWithin,
  startOfToday,
} from '../../api/listing/audience';
import { ownedListingSelector } from '../../api/listing/ownership';

/* eslint-disable no-console */

// `owner` is an account name, which `getUsername` resolves to an email address,
// and `createdBy` was the same address written a second time — stripping the
// first and not the second is how every creator's address stayed one console
// subscription away. Three of the publications below answer to anyone, no
// login required, and two more to any account, which sign-up makes anyone.
// The admin editor reads `owner` through the admin publications and a person
// managing their own listing through the owned ones; every other cursor over a
// club or an event carries this projection. It costs nothing and closes the
// gap — and since a private group's invite link became a field on the group,
// it is also what keeps that link from being handed out with the card.
const PUBLIC_FIELDS = { fields: WITHHELD_LISTING_FIELDS };

/**
 * The most events one subscription is ever sent: a safety valve, not paging.
 *
 * The windows below are what keep a subscription small. This is for the day
 * they do not — an import that lands four thousand events in one month, say —
 * when the alternative is every phone on the island downloading all of them on
 * the landing page. Soonest first, so what is cut is what is furthest away, and
 * it is logged, because a wall that silently stops in October is a bug report
 * nobody will know how to file.
 */
const EVENT_PUBLICATION_LIMIT = 1000;
const TRUNCATION_CHECK_EVERY_MS = 10 * 60 * 1000;
let truncationCheckedAt = 0;

// The count is a second pass over the events, and this runs for every page
// anybody opens. It is there to tell an operator something that stays true for
// hours, so it looks once in a while rather than every time.
const warnIfTruncated = (name, selector) => {
  if (Date.now() - truncationCheckedAt < TRUNCATION_CHECK_EVERY_MS) {
    return;
  }
  truncationCheckedAt = Date.now();
  const matching = Events.collection.find(selector).count();
  if (matching > EVENT_PUBLICATION_LIMIT) {
    console.warn(`[publications] ${name}: ${matching} events match and only the first ${EVENT_PUBLICATION_LIMIT} are sent.`);
  }
};

// The public directory of groups, under both of the names it has had.
// 'clubs.all' was a second copy of the same cursor, which is one more place
// for a rule like "not the private ones" to be added to one and not the other.
// No page asks for it any more; it stays registered so that a tab left open
// across a deploy resubscribes to something.
const publicGroups = function () {
  return Clubs.collection.find(PUBLIC_LISTING_SELECTOR, { sort: { name: 1 }, ...PUBLIC_FIELDS });
};

Meteor.publish(Clubs.userPublicationName, publicGroups);
Meteor.publish('clubs.all', publicGroups);

Meteor.publish(Clubs.adminPublicationName, function () {
  if (this.userId && Roles.userIsInRole(this.userId, 'admin')) {
    return Clubs.collection.find({}, { sort: { name: 1 } });
  }
  return this.ready();
});

/**
 * The public events, from this morning on.
 *
 * Every page subscribes to this, signed in or not, and it used to answer with
 * every published event there had ever been: 1,242 documents on the
 * development database, 865 of them already over, to draw a landing page that
 * shows six. With no arguments it now sends today and the next
 * EVENT_HORIZON_DAYS. A calendar that pages further ahead passes the dates it
 * is showing as `{ from, to }`; see eventWindow for what it may ask for.
 *
 * A subscription does not roll over at midnight: a tab left open keeps
 * yesterday's events until it subscribes again. They are events the person was
 * already sent, so nothing is disclosed, and every page resubscribes as it
 * mounts.
 */
Meteor.publish(Events.userPublicationName, function (asked) {
  check(asked, Match.Maybe({ from: Match.Maybe(Date), to: Match.Maybe(Date) }));
  const dates = eventWindow(asked);
  if (!dates) {
    return this.ready();
  }
  const selector = { $and: [PUBLIC_LISTING_SELECTOR, eventsWithin(dates)] };
  warnIfTruncated(Events.userPublicationName, selector);
  return Events.collection.find(selector, { sort: { date: 1 }, limit: EVENT_PUBLICATION_LIMIT, ...PUBLIC_FIELDS });
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

/**
 * The link rows of a group that one of its members is sent, as the events
 * they point at.
 *
 * A page joins a group to its events by these rows as well as by host number,
 * and the public links publication withholds every row about a private group,
 * so its members get theirs here. Not all of them: a row is two ids, and the
 * id of a private event says that the event exists. A row is sent when its
 * event is still to come and is either public or names THIS group as its host.
 * A row from some other group to a private event is sent to nobody, whoever
 * wrote it; joinedGroupsPublication says who once could.
 *
 * Read once, as a list of what may be sent rather than of what may not, so
 * that a row written later waits for the next subscription instead of going
 * out unjudged. Nothing is lost by the wait: the events arrive by host number
 * whether or not their rows do.
 */
const linkedEventIdsFor = (club, upcoming) => {
  const linked = EventClubs.collection.find({ clubId: club._id }, { fields: { eventId: 1 } }).map(link => link.eventId);
  const hostedHere = Number.isInteger(club.clubID) ? [{ $and: [PUBLISHED_SELECTOR, { eventID: club.clubID }] }] : [];
  return Events.collection
    .find(
      { $and: [{ _id: { $in: linked } }, upcoming, { $or: [PUBLIC_LISTING_SELECTOR, ...hostedHere] }] },
      { fields: { _id: 1 } },
    )
    .map(event => event._id);
};

/**
 * The groups a person is in and, when asked, what those groups have on. The
 * memberships, the groups and their events are all live; only the link rows
 * are read once (see linkedEventIdsFor).
 *
 * Both member publications used to read the memberships once, with a fetch,
 * and build a cursor from the ids they found. Leaving a group left its card on
 * the page until a reload, which a page then had to work around; and a person
 * approved into a private group — which no other publication will send them —
 * would have been looking at nothing until they thought to refresh.
 *
 * Membership is the whole test here, so this is where a PRIVATE listing is
 * sent: a private group to the people in it, and a private event to the
 * members of the group hosting it. Published still applies, the projection is
 * the public one (being in a group is no reason to be told its founder's
 * address, or handed its invite link), and events have the same floor as
 * everywhere else.
 *
 * The group hosting an event is the one the event NAMES: `eventID` holds its
 * host's `clubID`, written by whoever posted it. A row in EventClubs used to
 * count as well, with a cursor of its own for every row, and it was a way in.
 * 'Clubs.organizeEvent' wrote one for anybody signed in, so a stranger could
 * start a group, join it, link it to a private event whose id they held, and
 * be sent the whole event as a member of its "host" — and an event that was
 * public before its group went private has had its id sent to every visitor.
 * The method asks who is calling now; the rows from before are still in the
 * collection, and this does not rest on every writer of it staying careful.
 * Following them was also most of what this publication cost: links are never
 * pruned, so a person in a few imported groups held hundreds of live cursors
 * on events long over. A link now carries nobody to anything. There is one
 * cursor per group, by host number; whatever a link alone reaches has to be
 * public, and the public events publication sends that to everyone inside its
 * horizon.
 *
 * Every group is sent whole, even to a page that only wanted the events. A
 * level trimmed to the one field the next needs would leave nameless stubs in
 * the browser's copy of the collection for some list to draw as blank cards.
 *
 * Exported as the plain tree so a test can walk the same cursors.
 */
export const joinedGroupsPublication = (userId, { withEvents = false } = {}) => {
  const upcoming = eventsFrom(startOfToday());
  return {
    find() {
      return ProfileClubs.collection.find({ userId });
    },
    children: [
      {
        find(membership) {
          return Clubs.collection.find({ $and: [{ _id: membership.clubId }, PUBLISHED_SELECTOR] }, PUBLIC_FIELDS);
        },
        children: !withEvents ? [] : [
          {
            // A host number that is missing would become a selector matching
            // every event that lacks one, private or not.
            find(club) {
              return Number.isInteger(club.clubID)
                ? Events.collection.find({ $and: [{ eventID: club.clubID }, PUBLISHED_SELECTOR, upcoming] }, PUBLIC_FIELDS)
                : undefined;
            },
          },
          {
            // Most groups have nothing coming up, and a cursor that can match
            // nothing is still a cursor the server has to keep open.
            find(club) {
              const eventIds = linkedEventIdsFor(club, upcoming);
              return eventIds.length === 0 ? undefined : EventClubs.collection.find(
                { clubId: club._id, eventId: { $in: eventIds } },
                { fields: { eventId: 1, clubId: 1 } },
              );
            },
          },
        ],
      },
    ],
  };
};

publishComposite(ProfileClubs.userPublicationName, function () {
  if (!this.userId) {
    return null;
  }
  return joinedGroupsPublication(this.userId);
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
 * AND the group is neither anonymous nor private (see FriendActivityPrivacy.js;
 * a sensitive group is always the first), so this selects rows that have
 * already passed every test. A row is sent whole, with the _id of the group in
 * it, which is why private counts: to a friend who is not in the group, that
 * _id is the news that it exists. It is the second of two locks, not the only
 * one: the publication below does not run it at all for a friend whose profile
 * does not say they share.
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

const idsNotPublic = collection => collection
  .find({ $nor: [PUBLIC_LISTING_SELECTOR] }, { fields: { _id: 1 } })
  .map(doc => doc._id);

/**
 * Which event belongs to which group: two ids a row, to anyone, so a page can
 * work out a group's events in the browser.
 *
 * A row is only ids, but the rows about a private group say that it exists
 * and how much it has on, to a visitor with no account, and hand over the id
 * every method is called with. So a link is sent only when both ends are
 * public.
 * A member gets the rest of theirs from the member publication below.
 *
 * Published by hand, because a cursor could not keep that promise. It was one,
 * with the ids of everything not public read into it when the subscription
 * started, and 'Events.insert' writes a link for every event it makes: a
 * private event posted while a tab was open, or the first event of a private
 * group started that afternoon, was in neither list, and its row went out to
 * every open tab, signed in or not. The rows that are there when the
 * subscription starts are still judged against the two lists, which is two
 * queries for all of them. A row that arrives afterwards is judged when it
 * arrives, by looking up both of its ends, and a link to something that cannot
 * be found is not sent.
 *
 * A listing made private afterwards keeps its links in the tabs that already
 * had them, which tells those tabs nothing they were not sent a minute
 * earlier.
 */
Meteor.publish(EventClubs.linksPublicationName, function () {
  const hiddenClubIds = new Set(idsNotPublic(Clubs.collection));
  const hiddenEventIds = new Set(idsNotPublic(Events.collection));
  const isPublic = (source, _id) => Boolean(
    source.collection.findOne({ $and: [{ _id }, PUBLIC_LISTING_SELECTOR] }, { fields: { _id: 1 } }),
  );
  const sent = new Set();
  let starting = true;

  const withdraw = id => {
    if (sent.delete(id)) {
      this.removed(EventClubs.name, id);
    }
  };
  const judge = (id, link) => {
    const open = starting
      ? !hiddenClubIds.has(link.clubId) && !hiddenEventIds.has(link.eventId)
      : isPublic(Clubs, link.clubId) && isPublic(Events, link.eventId);
    if (open) {
      sent.add(id);
      this.added(EventClubs.name, id, link);
    }
  };

  // On the server the rows already there are delivered before observeChanges
  // returns, so `starting` is true for exactly those. Nothing edits a link in
  // place; if something ever does, the row is withdrawn rather than left in a
  // browser pointing at wherever it used to.
  const handle = EventClubs.collection.find({}, { fields: { eventId: 1, clubId: 1 } }).observeChanges({
    added: judge,
    changed: withdraw,
    removed: withdraw,
  });
  starting = false;
  this.onStop(() => handle.stop());
  this.ready();
});

/**
 * A person's own swipes, and with them the events they said they are going
 * to.
 *
 * The second cursor is for what the horizon cut off. The public events
 * publication stops EVENT_HORIZON_DAYS out, a calendar can page past that, and
 * an RSVP made out there disappeared from "Going" and from the agenda as soon
 * as the calendar was closed: the row was sent and the event it names was not.
 * Every page that reads these rows reads the events beside them, so they come
 * from here and no page has to ask.
 *
 * It sends only what is public and still to come, in the public projection,
 * so it cannot send anybody anything the public cursor would not if asked for
 * the right month. A private event somebody is going to reaches them the way
 * it always did, as a member of its group.
 *
 * The ids are read once. A cursor for each RSVP would be live, and would be
 * what the member tree used to cost with its cursor for each link: an RSVP is
 * never pruned either, and nearly all of a regular's would be watching events
 * long over. Nothing is missed for it. An RSVP is made from a page that
 * already holds the event, and the next page subscribes again as it mounts.
 */
Meteor.publish(EventSwipes.userPublicationName, function () {
  if (!this.userId) {
    return this.ready();
  }
  const goingIds = EventSwipes.collection
    .find({ userId: this.userId, decision: 'going', kind: { $ne: 'club' } }, { fields: { eventId: 1 } })
    .map(swipe => swipe.eventId);
  const swipes = EventSwipes.collection.find({ userId: this.userId });
  return goingIds.length === 0 ? swipes : [
    swipes,
    Events.collection.find(
      { $and: [{ _id: { $in: goingIds } }, PUBLIC_LISTING_SELECTOR, eventsFrom(startOfToday())] },
      PUBLIC_FIELDS,
    ),
  ];
});

// What the groups a person is in have on: the tree above, walked to its events.
publishComposite(EventClubs.userPublicationName, function () {
  if (!this.userId) {
    return null;
  }
  return joinedGroupsPublication(this.userId, { withEvents: true });
});

// "Theirs" is the account name stamped on a record when it was made, resolved
// by the ownership helper like everywhere else. Only ever called for a
// signed-in caller: the helper hands back a userId it cannot find an account
// for, and no record is owned by one of those. The selector is the helper's
// own, so that an imported listing — owned by nobody, whatever address the
// import stamped on it — is left out here exactly as the methods refuse it.
const ownedBy = ownedListingSelector;

/**
 * A person's own listings, as only they and an administrator are sent them:
 * whole, with `owner`, and for a group with the invite link in it. These two
 * and the admin publications are the only cursors that carry either field.
 *
 * Own is not widened to the events other people post under a group somebody
 * owns. `owner` on those is the poster's address, and an anonymous group has
 * promised that the person running it is not told who is in it.
 *
 * Drafts and archived listings are included, because they are still theirs.
 * Events keep the floor and have no horizon.
 */
Meteor.publish('Clubs.publication.owned', function () {
  if (!this.userId) {
    return this.ready();
  }
  return Clubs.collection.find(ownedBy(this.userId));
});

Meteor.publish('Events.publication.owned', function () {
  if (!this.userId) {
    return this.ready();
  }
  return Events.collection.find({ $and: [ownedBy(this.userId), eventsFrom(startOfToday())] }, { sort: { date: 1 } });
});

/**
 * What became of the requests a person has made to join a group. Who answered
 * is withheld: the person asked a group, and a name would make a refusal
 * something to take up with somebody.
 */
Meteor.publish(ClubJoinRequests.minePublicationName, function () {
  if (!this.userId) {
    return this.ready();
  }
  return ClubJoinRequests.collection.find({ userId: this.userId }, { fields: { respondedBy: 0 } });
});

/**
 * The people waiting for an answer from the groups a person owns, each with
 * enough of their profile to be recognised by: a name and a picture. That is
 * no more than the people directory sends every signed-in account, and it is
 * sent here only for somebody who asked this owner for something.
 *
 * An anonymous group has no requests to show. Approving one means reading a
 * name, which is the thing it promises nobody does, so the methods refuse to
 * make them — and this does not rely on that. A group is judged as it is now,
 * every time it changes: one that turns anonymous, or is re-filed under a
 * sensitive category, takes its waiting requests out of the owner's browser
 * as it does.
 *
 * The top level is the same cursor as 'Clubs.publication.owned', whole
 * documents, for the same reason the member tree sends whole groups.
 */
export const joinRequestsForOwnerPublication = userId => ({
  find() {
    return Clubs.collection.find(ownedBy(userId));
  },
  children: [
    {
      find(club) {
        if (isAnonymousListing(club)) {
          return undefined;
        }
        return ClubJoinRequests.collection.find(
          { clubId: club._id, status: 'pending' },
          { fields: { clubId: 1, userId: 1, status: 1, createdAt: 1 } },
        );
      },
      children: [
        {
          find(request) {
            return Profiles.collection.find(
              { userId: request.userId },
              { fields: { userId: 1, firstName: 1, lastName: 1, picture: 1 } },
            );
          },
        },
      ],
    },
  ],
});

publishComposite(ClubJoinRequests.ownerPublicationName, function () {
  if (!this.userId) {
    return null;
  }
  return joinRequestsForOwnerPublication(this.userId);
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
