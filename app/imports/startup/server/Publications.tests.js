/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import { callAs, makeClub, makeEvent, makeUser, resetAll } from './testFixtures';
import {
  friendActivityPublication,
  friendClubActivitySelector,
  friendEventActivitySelector,
} from './Publications';

/**
 * What a stranger can see.
 *
 * Three of these publications answer to anyone at all — no account, no login —
 * because the directory is meant to be public. That makes their field list a
 * security boundary rather than a performance detail, and it was leaking: the
 * server stamps `owner` onto every club and event it creates, `owner` is an
 * account name, and an account name here resolves to an email address. Any
 * visitor could subscribe from a browser console and read the address of
 * everyone who had ever posted.
 *
 * Testing a publication means calling its handler the way the server does and
 * looking at the cursor it returns — there is no subscriber involved, which is
 * the point: this asserts what the SERVER would send, not what some client
 * happened to ask for.
 */
const publishAs = (userId, name) => {
  const handler = Meteor.server.publish_handlers[name];
  if (!handler) {
    throw new Error(`No such publication: ${name}`);
  }
  return handler.apply({ userId, ready: () => null, onStop: () => {} }, []);
};

const docsFrom = cursor => (cursor && typeof cursor.fetch === 'function' ? cursor.fetch() : []);

if (Meteor.isServer) {
  describe('public publications', function () {
    beforeEach(function () {
      resetAll();
      makeClub({ owner: 'someone@private.example' });
      // `createdBy` is what an older record still carries: the same address,
      // written a second time — and for a long while the copy not withheld.
      makeEvent({ owner: 'someone@private.example', createdBy: 'someone@private.example' });
    });

    it('does not send club owners to a signed-out visitor', function () {
      const docs = docsFrom(publishAs(null, Clubs.userPublicationName));
      assert.isAbove(docs.length, 0, 'the directory is public and should still be sent');
      docs.forEach(doc => assert.isUndefined(doc.owner, 'owner is an email address'));
    });

    it('does not send event owners to a signed-out visitor, under either name', function () {
      const docs = docsFrom(publishAs(null, Events.userPublicationName));
      assert.isAbove(docs.length, 0);
      docs.forEach(doc => {
        assert.isUndefined(doc.owner);
        assert.isUndefined(doc.createdBy, 'the same address under another key');
      });
    });

    it('does not send owners through clubs.all either', function () {
      const docs = docsFrom(publishAs(null, 'clubs.all'));
      docs.forEach(doc => assert.isUndefined(doc.owner));
    });

    it('keeps staged ingestion records out of public publications', function () {
      const draftClubId = makeClub({ publicationStatus: 'draft' });
      const draftEventId = makeEvent({ publicationStatus: 'draft' });

      const publicClubIds = docsFrom(publishAs(null, Clubs.userPublicationName)).map(doc => doc._id);
      const publicEventIds = docsFrom(publishAs(null, Events.userPublicationName)).map(doc => doc._id);
      const adminClubIds = docsFrom(publishAs(makeUser({ admin: true }), Clubs.adminPublicationName))
        .map(doc => doc._id);

      assert.notInclude(publicClubIds, draftClubId);
      assert.notInclude(publicEventIds, draftEventId);
      assert.include(adminClubIds, draftClubId, 'administrators can recover a staged projection');
    });

    /**
     * The admin editor is the only screen that reads `owner`, and it subscribes
     * to this one. Withholding it here would break that form, so the boundary
     * has to be drawn per-publication rather than per-field.
     */
    it('still sends owners to an administrator', function () {
      const admin = makeUser({ admin: true });
      const docs = docsFrom(publishAs(admin, Clubs.adminPublicationName));
      assert.isAbove(docs.length, 0);
      assert.isDefined(docs[0].owner, 'the admin editor needs this field');
    });

    it('still sends who posted an event to an administrator', function () {
      const admin = makeUser({ admin: true });
      const docs = docsFrom(publishAs(admin, Events.adminPublicationName));
      assert.isAbove(docs.length, 0);
      assert.equal(docs[0].owner, 'someone@private.example', 'the admin editor prints who posted it');
    });

    it('sends nothing to a non-administrator asking for the admin publication', function () {
      const plain = makeUser();
      assert.equal(docsFrom(publishAs(plain, Clubs.adminPublicationName)).length, 0);
    });

    it('does not publish profile interests through the people directory', function () {
      const viewer = makeUser();
      Profiles.collection.update({}, { $set: { interests: ['Support Groups'] } }, { multi: true });
      const docs = docsFrom(publishAs(viewer, 'Profiles.publication.directory'));
      assert.isAbove(docs.length, 0);
      docs.forEach(doc => assert.isUndefined(doc.interests));
    });

    // In each of the next three the friend has turned sharing on first. It is
    // off by default, and with it off every one of these selectors is empty
    // for a reason that has nothing to do with what the test is about.
    it('excludes support joins and RSVPs from friend-activity selectors', function () {
      const friendId = makeUser();
      callAs(friendId, 'Profiles.setFriendActivitySharing', true);
      const ordinaryClubId = makeClub({ categories: ['community'] });
      const supportClubId = makeClub({ categories: ['support_group'] });
      const ordinaryEventId = makeEvent({ categories: ['community'] });
      const supportEventId = makeEvent({ categories: ['support_group'] });
      callAs(friendId, 'profileClubs.add', ordinaryClubId);
      callAs(friendId, 'profileClubs.add', supportClubId);
      callAs(friendId, 'eventSwipes.record', ordinaryEventId, 'going');
      callAs(friendId, 'eventSwipes.record', supportEventId, 'going');
      callAs(friendId, 'eventSwipes.record', supportClubId, 'joined', 'club');

      assert.deepEqual(
        ProfileClubs.collection.find(friendClubActivitySelector(friendId)).map(row => row.clubId),
        [ordinaryClubId],
      );
      assert.deepEqual(
        EventSwipes.collection.find(friendEventActivitySelector(friendId)).map(row => row.eventId),
        [ordinaryEventId],
      );
    });

    /**
     * Going is the one swipe a friend is shown. Everything in this test is on
     * an ordinary, shareable listing, so the only thing keeping the other rows
     * out is the decision itself: a pass is nobody's business, and a swipe that
     * joined a group is already told by the membership.
     */
    it('shows friends the events a person is going to, and no other swipe', function () {
      const friendId = makeUser();
      callAs(friendId, 'Profiles.setFriendActivitySharing', true);
      const goingEventId = makeEvent({ categories: ['community'] });
      const passedEventId = makeEvent({ categories: ['community'] });
      const joinedClubId = makeClub({ categories: ['community'] });
      callAs(friendId, 'eventSwipes.record', goingEventId, 'going');
      callAs(friendId, 'eventSwipes.record', passedEventId, 'passed');
      // The join first, as the deck sends it: a 'joined' swipe with no
      // membership behind it is refused.
      callAs(friendId, 'profileClubs.add', joinedClubId);
      callAs(friendId, 'eventSwipes.record', joinedClubId, 'joined', 'club');

      assert.equal(friendEventActivitySelector(friendId).decision, 'going');
      assert.deepEqual(
        EventSwipes.collection.find(friendEventActivitySelector(friendId)).map(row => row.eventId),
        [goingEventId],
      );

      callAs(friendId, 'eventSwipes.remove', goingEventId, 'rsvp_canceled');
      assert.deepEqual(
        EventSwipes.collection.find(friendEventActivitySelector(friendId)).fetch(),
        [],
        'an RSVP taken back is no longer shown',
      );
    });

    it('removes an existing membership from a live selector when its group becomes sensitive', function () {
      const admin = makeUser({ admin: true });
      const friendId = makeUser();
      callAs(friendId, 'Profiles.setFriendActivitySharing', true);
      const clubId = makeClub({ categories: ['community'] });
      callAs(friendId, 'profileClubs.add', clubId);
      const selector = friendClubActivitySelector(friendId);
      assert.deepEqual(ProfileClubs.collection.find(selector).map(row => row.clubId), [clubId]);

      const club = Clubs.collection.findOne(clubId);
      callAs(admin, 'Clubs.update', clubId, {
        clubID: club.clubID,
        name: club.name,
        owner: club.owner,
        description: club.description,
        location: club.location,
        meetingTime: club.meetingTime,
        contactInfo: club.contactInfo || '',
        categories: ['support_group'],
        tags: club.tags || [],
      });

      assert.deepEqual(ProfileClubs.collection.find(selector).fetch(), []);
    });
  });

  /**
   * Who is told where a person goes.
   *
   * This publication used to send a friend every group a person had joined and
   * every event they were going to, to every friend, with no setting anywhere.
   * Sharing is now something a person turns on, and these tests are about the
   * default as much as about the switch: most people will never open the page
   * the switch is on, so what happens when nobody has touched anything is what
   * happens to nearly everyone.
   *
   * Most of them walk the publication's own tree — the same cursors, handed
   * the same arguments the composite hands them — because that is exact and
   * has no timing in it. The last one subscribes for real, since "a friend who
   * opts out disappears" is a claim about a live subscription and only a live
   * subscription can show it.
   */
  describe('Friends.publication.activity', function () {
    let viewer;
    let friend;
    let clubId;
    let eventId;
    let supportClubId;
    let prideEventId;

    const befriend = (requester, receiver) => {
      const edgeId = callAs(requester, 'friends.request', receiver);
      callAs(receiver, 'friends.accept', edgeId);
    };

    const sentFrom = (node, args = []) => docsFrom(node.find(...args)).flatMap(doc => [
      doc,
      ...(node.children || []).flatMap(child => sentFrom(child, [doc, ...args])),
    ]);

    /** The group ids and event ids a viewer would be sent, and whose they are. */
    const activitySentTo = userId => {
      const docs = sentFrom(friendActivityPublication(userId));
      const memberships = docs.filter(doc => doc.clubId);
      const rsvps = docs.filter(doc => doc.eventId);
      return {
        clubIds: memberships.map(doc => doc.clubId).sort(),
        eventIds: rsvps.map(doc => doc.eventId).sort(),
        userIds: [...new Set([...memberships, ...rsvps].map(doc => doc.userId))],
      };
    };

    beforeEach(function () {
      resetAll();
      viewer = makeUser();
      friend = makeUser();
      befriend(viewer, friend);
      clubId = makeClub({ categories: ['community'] });
      supportClubId = makeClub({ categories: ['community'], tags: ['grief circle'] });
      eventId = makeEvent({ categories: ['music'] });
      prideEventId = makeEvent({ categories: ['lgbtq', 'social'] });
      callAs(friend, 'profileClubs.add', clubId);
      callAs(friend, 'profileClubs.add', supportClubId);
      callAs(friend, 'eventSwipes.record', eventId, 'going');
      callAs(friend, 'eventSwipes.record', prideEventId, 'going');
    });

    it('sends nothing about a friend who has never touched the setting', function () {
      assert.deepEqual(activitySentTo(viewer), { clubIds: [], eventIds: [], userIds: [] });
    });

    it('sends the shareable rows of a friend who has opted in, and only those', function () {
      callAs(friend, 'Profiles.setFriendActivitySharing', true);

      assert.deepEqual(activitySentTo(viewer), { clubIds: [clubId], eventIds: [eventId], userIds: [friend] });
    });

    it('asks nothing of the viewer: a person who shares nothing still sees a friend who shares', function () {
      callAs(friend, 'Profiles.setFriendActivitySharing', true);

      assert.isUndefined(Profiles.collection.findOne({ userId: viewer }).friendActivitySharing);
      assert.deepEqual(activitySentTo(viewer).userIds, [friend]);
      assert.deepEqual(activitySentTo(friend).userIds, [], 'and the friend is sent nothing of theirs');
    });

    it('sends the consent level as a bare _id, never the setting itself', function () {
      callAs(friend, 'Profiles.setFriendActivitySharing', true);

      const profileId = Profiles.collection.findOne({ userId: friend })._id;
      const gate = sentFrom(friendActivityPublication(viewer)).filter(doc => doc._id === profileId);
      assert.deepEqual(gate, [{ _id: profileId }]);
    });

    it('stops for a friend who opts out again', function () {
      callAs(friend, 'Profiles.setFriendActivitySharing', true);
      callAs(friend, 'Profiles.setFriendActivitySharing', false);

      assert.deepEqual(activitySentTo(viewer), { clubIds: [], eventIds: [], userIds: [] });
    });

    /**
     * The two locks, tested apart. Rows can be left saying 'shareable' — a
     * rewrite cut short, a row written by an older build — and the profile is
     * what keeps them in. Written straight to the collection because no method
     * will produce this state, which is the point of having the second lock.
     */
    it('holds back rows still marked shareable when the profile does not say the friend shares', function () {
      ProfileClubs.collection.update({ userId: friend }, { $set: { friendActivityVisibility: 'shareable' } }, { multi: true });
      EventSwipes.collection.update({ userId: friend }, { $set: { friendActivityVisibility: 'shareable' } }, { multi: true });

      assert.deepEqual(activitySentTo(viewer), { clubIds: [], eventIds: [], userIds: [] });

      Profiles.collection.update({ userId: friend }, { $set: { friendActivitySharing: false } });
      assert.deepEqual(activitySentTo(viewer).userIds, [], 'an explicit no is a no as well');
    });

    it('sends nothing about somebody who is not an accepted friend, whatever they share', function () {
      const stranger = makeUser();
      const pending = makeUser();
      [stranger, pending].forEach(userId => {
        callAs(userId, 'Profiles.setFriendActivitySharing', true);
        callAs(userId, 'profileClubs.add', clubId);
      });
      callAs(pending, 'friends.request', viewer);

      assert.deepEqual(activitySentTo(viewer).userIds, []);
    });

    it('sends nothing to a signed-out visitor', async function () {
      const handler = Meteor.server.publish_handlers['Friends.publication.activity'];
      const sent = [];
      await handler.apply({
        userId: null,
        added: (collection, id) => sent.push(`${collection}:${id}`),
        changed: () => {},
        removed: () => {},
        ready: () => {},
        onStop: () => {},
      }, []);

      assert.deepEqual(sent, []);
    });

    /**
     * The real handler, a stand-in subscriber, and no sleeping: each wait is
     * for something that must HAPPEN — a row arriving, a row being withdrawn —
     * so a slow machine makes this slower and never wrong.
     */
    it('withdraws a friend’s rows from a live subscription the moment they opt out', async function () {
      this.timeout(10000);
      callAs(friend, 'Profiles.setFriendActivitySharing', true);

      const live = new Set();
      const stops = [];
      const handler = Meteor.server.publish_handlers['Friends.publication.activity'];
      await handler.apply({
        userId: viewer,
        added: (collection, id) => live.add(`${collection}:${id}`),
        changed: () => {},
        removed: (collection, id) => live.delete(`${collection}:${id}`),
        ready: () => {},
        onStop: stop => stops.push(stop),
      }, []);

      const eventually = async condition => {
        const deadline = Date.now() + 8000;
        while (!condition() && Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => { Meteor.setTimeout(resolve, 25); });
        }
        return condition();
      };
      const membership = ProfileClubs.collection.findOne({ userId: friend, clubId });
      const rsvp = EventSwipes.collection.findOne({ userId: friend, eventId });
      const sensitiveRsvp = EventSwipes.collection.findOne({ userId: friend, eventId: prideEventId });
      const shown = () => live.has(`${ProfileClubs.name}:${membership._id}`) && live.has(`${EventSwipes.name}:${rsvp._id}`);
      const withdrawn = () => !live.has(`${ProfileClubs.name}:${membership._id}`) && !live.has(`${EventSwipes.name}:${rsvp._id}`);

      try {
        assert.isTrue(await eventually(shown), 'the shareable rows arrive');
        assert.isFalse(live.has(`${EventSwipes.name}:${sensitiveRsvp._id}`), 'the sensitive one never does');

        callAs(friend, 'Profiles.setFriendActivitySharing', false);
        assert.isTrue(await eventually(withdrawn), 'and are withdrawn without a resubscribe');

        callAs(friend, 'Profiles.setFriendActivitySharing', true);
        assert.isTrue(await eventually(shown), 'opting back in brings them back, live');
      } finally {
        stops.forEach(stop => stop());
      }
    });
  });

  /**
   * The member publications answer to any account, and sign-up is open, so
   * "members only" is no boundary at all. They used to send whole documents:
   * join a group, and the address of whoever founded it — and of whoever
   * posted each of its events — arrived with the listing.
   */
  describe('member publications', function () {
    let member;

    beforeEach(function () {
      resetAll();
      member = makeUser();
      const clubId = makeClub({ owner: 'founder@private.example' });
      callAs(member, 'profileClubs.add', clubId);
      makeEvent({
        eventID: Clubs.collection.findOne(clubId).clubID,
        owner: 'poster@private.example',
        createdBy: 'poster@private.example',
      });
    });

    it('does not send who founded a joined group', function () {
      const docs = docsFrom(publishAs(member, ProfileClubs.userPublicationName));
      assert.isAbove(docs.length, 0, 'the joined group itself should still be sent');
      docs.forEach(doc => assert.isUndefined(doc.owner));
    });

    it('does not send who posted a joined group’s events', function () {
      const docs = docsFrom(publishAs(member, EventClubs.userPublicationName));
      assert.isAbove(docs.length, 0, 'the group’s event itself should still be sent');
      docs.forEach(doc => {
        assert.isUndefined(doc.owner);
        assert.isUndefined(doc.createdBy);
      });
    });
  });

  describe('Clubs.insert contact details', function () {
    beforeEach(function () {
      resetAll();
    });

    const base = {
      name: 'Contact Test',
      description: 'A group.',
      location: 'Līhuʻe',
      meetingTime: 'Mondays 5pm',
    };

    /**
     * Leaving the optional contact box empty used to publish the creator's
     * email on the card, because the default was their account name. Blank has
     * to mean blank — the card then draws no contact row at all.
     */
    it('leaves the contact blank when none was given', function () {
      const user = makeUser({ email: 'creator@test.example' });
      callAs(user, 'Clubs.insert', base);
      const club = Clubs.collection.findOne({ name: 'Contact Test' });
      assert.notInclude(club.contactInfo || '', 'creator@test.example');
      assert.isNotOk(club.contactInfo, 'blank means blank');
    });

    it('keeps a contact the organizer chose to publish', function () {
      const user = makeUser();
      callAs(user, 'Clubs.insert', { ...base, contactInfo: 'hello@theclub.example' });
      assert.equal(Clubs.collection.findOne({ name: 'Contact Test' }).contactInfo, 'hello@theclub.example');
    });
  });
}
