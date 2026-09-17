/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { ClubJoinRequests } from '../../api/club/ClubJoinRequests';
import { EventClubs } from '../../api/events/EventClubs';
import { Events } from '../../api/events/Events';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { AuditLog } from '../../api/audit/AuditLog';
import { callAs, errorFrom, makeUser, resetAll, resetRecommendations } from './testFixtures';
import {
  friendActivityPublication,
  joinRequestsForOwnerPublication,
  joinedGroupsPublication,
} from './Publications';

/**
 * One walk through the whole promise, by the methods and publications a real
 * person would touch and nothing else: no fixture writes a privacy field, a
 * token or a membership. Each lane pins its own link in this chain; this is
 * the chain.
 */

const publishAs = (userId, name, ...args) => {
  const added = [];
  const stops = [];
  const result = Meteor.server.publish_handlers[name].apply({
    userId,
    added: (collection, id, fields) => added.push({ _id: id, ...fields }),
    changed: () => {},
    removed: () => {},
    ready: () => null,
    onStop: stop => stops.push(stop),
  }, args);
  stops.forEach(stop => stop());
  return result || { fetch: () => added };
};

const docsFrom = cursor => (cursor && typeof cursor.fetch === 'function' ? cursor.fetch() : []);

const sentFrom = (node, args = []) => docsFrom(node.find(...args)).flatMap(doc => [
  doc,
  ...(node.children || []).flatMap(child => sentFrom(child, [doc, ...args])),
]);

const COMPOSITES = {
  [ProfileClubs.userPublicationName]: userId => joinedGroupsPublication(userId),
  [EventClubs.userPublicationName]: userId => joinedGroupsPublication(userId, { withEvents: true }),
  [ClubJoinRequests.ownerPublicationName]: joinRequestsForOwnerPublication,
  'Friends.publication.activity': friendActivityPublication,
};

/** Everything every registered publication would send this person. */
const everythingSentTo = userId => Object.keys(Meteor.server.publish_handlers).flatMap(name => {
  if (COMPOSITES[name]) {
    return userId ? sentFrom(COMPOSITES[name](userId)) : [];
  }
  const result = publishAs(userId, name);
  assert.isFalse(typeof result?.then === 'function', `${name} is a composite this walk does not know`);
  return [].concat(result || []).flatMap(docsFrom);
});

const mentions = (doc, id) => [doc._id, doc.clubId, doc.eventId].includes(id);

if (Meteor.isServer) {
  describe('privacy, end to end', function () {
    beforeEach(function () {
      resetAll();
      resetRecommendations();
      ClubJoinRequests.collection.remove({});
      AuditLog.collection.remove({});
    });

    it('walks a group from public to private and anonymous, through its invite link, to a dead link, and back into the open', function () {
      // Five accounts, each a bcrypt hash, and every publication walked ten
      // times: honest work, and more of it than mocha's two seconds.
      this.timeout(30000);
      const owner = makeUser();
      const stranger = makeUser();
      const member = makeUser();
      const friend = makeUser();

      // The member and their friend have BOTH opted in to sharing, and are
      // friends, so nothing but the group's anonymity keeps the friend blind.
      callAs(member, 'Profiles.setFriendActivitySharing', true);
      callAs(friend, 'Profiles.setFriendActivitySharing', true);
      callAs(member, 'friends.accept', callAs(friend, 'friends.request', member));

      // Which is shown, not supposed: an ordinary group the member is in does
      // reach the friend. Without this every "sees nothing" below would pass
      // just as well with the friends' feed broken.
      const openClubId = callAs(owner, 'Clubs.insert', {
        name: 'Open Paddlers',
        description: 'A paddle.',
        location: 'Hanalei',
        meetingTime: 'Saturdays 8am',
        categories: ['Outdoors'],
      });
      callAs(member, 'profileClubs.add', openClubId);
      const toldAbout = id => everythingSentTo(friend)
        .filter(doc => doc.userId === member && mentions(doc, id));
      assert.lengthOf(toldAbout(openClubId), 1, 'the friend is told about an ordinary group');

      // A plain public group with a meeting that follows it.
      const clubId = callAs(owner, 'Clubs.insert', {
        name: 'Thursday Walkers',
        description: 'A walk.',
        location: 'Kapaʻa',
        meetingTime: 'Thursdays 5pm',
        categories: ['Outdoors'],
      });
      const club = Clubs.collection.findOne(clubId);
      const eventId = callAs(owner, 'Events.insert', {
        eventID: club.clubID,
        title: 'This Thursday',
        date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        location: 'Kapaʻa',
      });
      assert.isTrue(Events.collection.findOne(eventId).privacyInherited, 'the event follows its group');
      assert.isTrue(everythingSentTo(stranger).some(doc => doc._id === clubId), 'public to begin with');
      assert.isTrue(everythingSentTo(null).some(doc => doc._id === eventId), 'and so is its event');

      // 1. The owner makes it private and anonymous.
      const answer = callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private', anonymous: true, approveMembers: true });
      assert.deepEqual(answer, { visibility: 'private', anonymous: true, approveMembers: false, anonymousLocked: false });
      assert.notProperty(answer, 'inviteToken');
      const inherited = Events.collection.findOne(eventId);
      assert.equal(inherited.visibility, 'private', 'the cascade reached the inherited event');
      assert.isTrue(inherited.anonymous);

      // 2. A stranger's publications, a visitor's, and the recommender no
      //    longer contain the group, its event, or a row naming either.
      [null, stranger, friend].forEach(who => {
        const docs = everythingSentTo(who);
        [clubId, eventId].forEach(id => assert.deepEqual(docs.filter(doc => mentions(doc, id)), []));
        docs.forEach(doc => ['owner', 'createdBy', 'inviteToken'].forEach(field => assert.notProperty(doc, field)));
      });
      ['group', 'event'].forEach(kind => {
        const dealt = callAs(stranger, 'recommendations.get', { kind, surface: 'test' }).items.map(item => item._id);
        assert.notInclude(dealt, clubId);
        assert.notInclude(dealt, eventId);
      });

      // 3. Without the link there is no way in, and no request is taken.
      assert.equal(errorFrom(() => callAs(member, 'profileClubs.add', clubId)), 'invite-required');
      assert.equal(errorFrom(() => callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: 'a-guess' })), 'invite-required');
      assert.equal(errorFrom(() => callAs(member, 'eventSwipes.record', eventId, 'going')), 'not-found');
      assert.equal(ClubJoinRequests.collection.find().count(), 0);

      // 4. The owner — and only the owner — is sent the link. The invitee
      //    reads what it leads to, and joins with it.
      const owned = docsFrom(publishAs(owner, 'Clubs.publication.owned')).find(doc => doc._id === clubId);
      const token = owned.inviteToken;
      assert.isString(token);
      assert.isAtLeast(token.length, 40);
      assert.deepEqual(callAs(member, 'clubs.inviteInfo', token), {
        clubId, name: 'Thursday Walkers', anonymous: true, memberCount: 0,
      });
      const joined = callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: token });
      assert.equal(joined.status, 'joined');
      assert.equal(joined.membershipId, ProfileClubs.collection.findOne({ userId: member, clubId })._id);

      // 5. One member, as a number.
      assert.equal(Clubs.collection.findOne(clubId).memberCount, 1);
      assert.equal(callAs(member, 'clubs.inviteInfo', token).memberCount, 1);

      // The member is sent their group and its meeting, without owner or link.
      const toMember = everythingSentTo(member);
      assert.isTrue(toMember.some(doc => doc._id === clubId));
      assert.isTrue(toMember.some(doc => doc._id === eventId));
      toMember.forEach(doc => ['owner', 'createdBy', 'inviteToken'].forEach(field => assert.notProperty(doc, field)));
      callAs(member, 'eventSwipes.record', eventId, 'going');
      assert.equal(Events.collection.findOne(eventId).goingCount, 1);

      // 6. There is no list — not for the owner, not for an administrator.
      const admin = makeUser({ admin: true });
      assert.equal(errorFrom(() => callAs(owner, 'clubs.members', clubId)), 'anonymous-group');
      assert.equal(errorFrom(() => callAs(admin, 'clubs.members', clubId)), 'anonymous-group');
      // And nothing the owner is sent ties the member to the group or its
      // meeting. (The people directory sends every profile; that is not it.)
      assert.deepEqual(
        everythingSentTo(owner).filter(doc => doc.userId === member && (mentions(doc, clubId) || mentions(doc, eventId))),
        [],
      );

      // 7. The friend, who shares and whose friend shares, sees nothing: not
      //    the membership, not the RSVP.
      const toFriend = everythingSentTo(friend);
      assert.deepEqual(toFriend.filter(doc => mentions(doc, clubId) || mentions(doc, eventId)), []);
      assert.equal(ProfileClubs.collection.findOne({ userId: member, clubId }).friendActivityVisibility, 'private');

      // 8. The owner makes a new link, and the old one is dead — for reading
      //    and for joining — while the member who used it stays.
      const fresh = callAs(owner, 'clubs.rotateInvite', clubId);
      assert.notEqual(fresh, token);
      assert.equal(errorFrom(() => callAs(stranger, 'clubs.inviteInfo', token)), 'not-found');
      assert.equal(errorFrom(() => callAs(stranger, 'profileClubs.add', clubId, {}, { inviteToken: token })), 'invite-required');
      assert.equal(callAs(stranger, 'clubs.inviteInfo', fresh).clubId, clubId);
      assert.isOk(ProfileClubs.collection.findOne({ userId: member, clubId }));
      assert.equal(Clubs.collection.findOne(clubId).memberCount, 1);

      // 9. Every switch goes both ways, so the owner opens the group up again
      //    and takes anonymity off. It is public once more, and the person who
      //    came in under the promise is still nobody's to see: not on the
      //    owner's list, and not in the feed of a friend — who could as easily
      //    have been the owner.
      const opened = callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'public', anonymous: false });
      assert.include(opened, { visibility: 'public', anonymous: false });
      assert.isTrue(everythingSentTo(stranger).some(doc => doc._id === clubId), 'public again');
      assert.deepEqual(callAs(owner, 'clubs.members', clubId), []);
      assert.equal(Clubs.collection.findOne(clubId).memberCount, 1, 'still counted');
      assert.deepEqual(toldAbout(clubId), [], 'the membership');
      assert.deepEqual(toldAbout(eventId), [], 'and the RSVP');
      assert.lengthOf(toldAbout(openClubId), 1, 'while the friends’ feed is as live as it was');
    });
  });
}
