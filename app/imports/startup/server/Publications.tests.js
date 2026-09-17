/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { ClubJoinRequests } from '../../api/club/ClubJoinRequests';
import { Events } from '../../api/events/Events';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { EVENT_HORIZON_DAYS, EVENT_WINDOW_MAX_DAYS, startOfToday } from '../../api/listing/audience';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import { callAs, errorFrom, makeClub, makeEvent, makeUser, resetAll } from './testFixtures';
import {
  friendActivityPublication,
  friendClubActivitySelector,
  friendEventActivitySelector,
  joinRequestsForOwnerPublication,
  joinedGroupsPublication,
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
 *
 * Most handlers answer with a cursor. One publishes by hand, calling `added`
 * for each row and keeping an observer open; what it added before it returned
 * is handed back in a cursor's shape so every caller reads both kinds alike,
 * and whatever it left running is stopped, because nothing else here will.
 */
const publishAs = (userId, name, ...args) => {
  const handler = Meteor.server.publish_handlers[name];
  if (!handler) {
    throw new Error(`No such publication: ${name}`);
  }
  const added = [];
  const stops = [];
  const result = handler.apply({
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

/**
 * Everything a composite publication would send: its tree, walked the way the
 * package walks it, each child handed the document above it and then that
 * one's own arguments. The same cursors, and no timing.
 */
const sentFrom = (node, args = []) => docsFrom(node.find(...args)).flatMap(doc => [
  doc,
  ...(node.children || []).flatMap(child => sentFrom(child, [doc, ...args])),
]);

/**
 * For the few claims that are about a LIVE subscription: the real handler and
 * a stand-in subscriber. Nothing here sleeps for its own sake — `eventually`
 * waits for something that must HAPPEN, a row arriving or being withdrawn, so
 * a slow machine makes a test slower and never wrong.
 */
const eventually = async condition => {
  const deadline = Date.now() + 8000;
  while (!condition() && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => { Meteor.setTimeout(resolve, 25); });
  }
  return condition();
};

const subscribeLive = async (userId, name) => {
  const live = new Set();
  const stops = [];
  await Meteor.server.publish_handlers[name].apply({
    userId,
    added: (collection, id) => live.add(`${collection}:${id}`),
    changed: () => {},
    removed: (collection, id) => live.delete(`${collection}:${id}`),
    ready: () => {},
    onStop: stop => stops.push(stop),
  }, []);
  return { live, stop: () => stops.forEach(stop => stop()) };
};

const DAY_MS = 24 * 60 * 60 * 1000;

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

    it('withdraws a friend’s rows from a live subscription the moment they opt out', async function () {
      this.timeout(10000);
      callAs(friend, 'Profiles.setFriendActivitySharing', true);

      const { live, stop } = await subscribeLive(viewer, 'Friends.publication.activity');
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
        stop();
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
    let clubId;
    let eventId;

    beforeEach(function () {
      resetAll();
      member = makeUser();
      clubId = makeClub({ owner: 'founder@private.example', inviteToken: 'a-link-somebody-was-given' });
      callAs(member, 'profileClubs.add', clubId);
      eventId = makeEvent({
        eventID: Clubs.collection.findOne(clubId).clubID,
        owner: 'poster@private.example',
        createdBy: 'poster@private.example',
      });
    });

    it('does not send who founded a joined group, or its invite link', function () {
      const docs = sentFrom(joinedGroupsPublication(member));
      const group = docs.find(doc => doc._id === clubId);
      assert.isDefined(group, 'the joined group itself should still be sent');
      assert.isDefined(group.name);
      docs.forEach(doc => {
        assert.isUndefined(doc.owner);
        assert.isUndefined(doc.inviteToken, 'belonging to a group is not a licence to invite people to it');
      });
    });

    it('does not send who posted a joined group’s events', function () {
      const docs = sentFrom(joinedGroupsPublication(member, { withEvents: true }));
      assert.isDefined(docs.find(doc => doc._id === eventId), 'the group’s event itself should still be sent');
      docs.forEach(doc => {
        assert.isUndefined(doc.owner);
        assert.isUndefined(doc.createdBy);
      });
    });

    it('sends neither to a signed-out visitor', async function () {
      const sent = [];
      const subscriber = {
        userId: null,
        added: (collection, id) => sent.push(`${collection}:${id}`),
        changed: () => {},
        removed: () => {},
        ready: () => {},
        onStop: () => {},
      };
      await Meteor.server.publish_handlers[ProfileClubs.userPublicationName].apply(subscriber, []);
      await Meteor.server.publish_handlers[EventClubs.userPublicationName].apply(subscriber, []);

      assert.deepEqual(sent, []);
    });

    /**
     * What the fetch-once version could not do. Both directions matter: the
     * card of a group somebody left used to sit on the page until a reload,
     * and a person let into a private group — which nothing else will send
     * them — would have been shown an empty page until they thought to
     * refresh it.
     */
    it('follows a membership live: a group arrives when it is joined and goes when it is left', async function () {
      this.timeout(10000);
      const hiddenClubId = makeClub({ visibility: 'private' });
      const hiddenEventId = makeEvent({
        eventID: Clubs.collection.findOne(hiddenClubId).clubID,
        visibility: 'private',
      });
      const { live, stop } = await subscribeLive(member, EventClubs.userPublicationName);
      const shown = () => live.has(`${Clubs.name}:${hiddenClubId}`) && live.has(`${Events.name}:${hiddenEventId}`);
      const withdrawn = () => !live.has(`${Clubs.name}:${hiddenClubId}`) && !live.has(`${Events.name}:${hiddenEventId}`);

      try {
        assert.isTrue(await eventually(() => live.has(`${Events.name}:${eventId}`)), 'what they already belong to arrives');
        assert.isTrue(withdrawn(), 'and a private group they are not in does not');

        // Straight into the collection: how a person comes to be in a private
        // group is the methods' business, and this is about what follows.
        const membershipId = ProfileClubs.collection.insert({ userId: member, clubId: hiddenClubId });
        assert.isTrue(await eventually(shown), 'the group and its event arrive without a resubscribe');

        ProfileClubs.collection.remove(membershipId);
        assert.isTrue(await eventually(withdrawn), 'and leave when the membership does');
      } finally {
        stop();
      }
    });
  });

  /**
   * Private means it is not sent. Not "hidden by the page": a page hides
   * things from people who use the page, and a subscription from a browser
   * console is four lines.
   *
   * The first tests ask every publication there is, by walking the server's
   * own table of them, so that one added later is asked too without anyone
   * remembering this file. A composite cannot be asked that way — what it
   * sends arrives later, on its own schedule — so each is listed here with its
   * tree, and a composite that is NOT listed fails the test rather than
   * slipping past it.
   */
  describe('private listings', function () {
    const COMPOSITES = {
      [ProfileClubs.userPublicationName]: userId => joinedGroupsPublication(userId),
      [EventClubs.userPublicationName]: userId => joinedGroupsPublication(userId, { withEvents: true }),
      [ClubJoinRequests.ownerPublicationName]: joinRequestsForOwnerPublication,
      'Friends.publication.activity': friendActivityPublication,
    };

    const everythingSentTo = userId => Object.keys(Meteor.server.publish_handlers).flatMap(name => {
      if (COMPOSITES[name]) {
        // Signed out, every composite answers null before it builds a tree;
        // 'sends neither to a signed-out visitor' above holds them to that.
        return userId ? sentFrom(COMPOSITES[name](userId)) : [];
      }
      const result = publishAs(userId, name);
      assert.isFalse(
        typeof result?.then === 'function',
        `${name} answers asynchronously: list its tree in COMPOSITES so that it is checked`,
      );
      return [].concat(result || []).flatMap(docsFrom);
    });

    const mentions = (doc, id) => [doc._id, doc.clubId, doc.eventId].includes(id);
    const numberOf = clubId => Clubs.collection.findOne(clubId).clubID;

    let owner;
    let member;
    let stranger;
    let publicClubId;
    let publicEventId;
    let privateClubId;
    let hidden;

    beforeEach(function () {
      resetAll();
      ClubJoinRequests.collection.remove({});
      owner = makeUser({ email: 'owner@private.example' });
      member = makeUser();
      stranger = makeUser();

      publicClubId = makeClub({ owner: 'owner@private.example', inviteToken: 'from-when-it-was-private' });
      publicEventId = makeEvent({
        eventID: numberOf(publicClubId),
        owner: 'owner@private.example',
        createdBy: 'owner@private.example',
      });
      EventClubs.collection.insert({ eventId: publicEventId, clubId: publicClubId });

      privateClubId = makeClub({ owner: 'owner@private.example', visibility: 'private', inviteToken: 'the-way-in' });
      // Every way an event is kept from the public: under a private group by
      // its host number, under one by a link alone, private under a PUBLIC
      // group, and one of the values the schema allows and the product no
      // longer writes.
      const byHostNumber = makeEvent({
        eventID: numberOf(privateClubId),
        visibility: 'private',
        owner: 'owner@private.example',
        createdBy: 'owner@private.example',
      });
      EventClubs.collection.insert({ eventId: byHostNumber, clubId: privateClubId });
      const byLinkAlone = makeEvent({ visibility: 'private' });
      EventClubs.collection.insert({ eventId: byLinkAlone, clubId: privateClubId });
      const underPublicGroup = makeEvent({ eventID: numberOf(publicClubId), visibility: 'private' });
      EventClubs.collection.insert({ eventId: underPublicGroup, clubId: publicClubId });
      const membersOnly = makeEvent({ visibility: 'members' });
      hidden = { byHostNumber, byLinkAlone, underPublicGroup, membersOnly };
      // And a public event the private group has put on its own page. The
      // event is everybody's; the row tying it to the group names the group.
      EventClubs.collection.insert({ eventId: publicEventId, clubId: privateClubId });

      ProfileClubs.collection.insert({ userId: member, clubId: privateClubId });

      // The stranger has a friend on the inside: somebody who shares what they
      // do, was let into the private group, and is going to its event. Made
      // through the methods, so that each row says what the app would have
      // written on it. A friend's feed is a publication like any other, and a
      // row in it carries the id of the group or the event it is about.
      const insider = makeUser();
      callAs(insider, 'Profiles.setFriendActivitySharing', true);
      callAs(insider, 'profileClubs.add', privateClubId, {}, { inviteToken: 'the-way-in' });
      callAs(insider, 'eventSwipes.record', byHostNumber, 'going');
      callAs(insider, 'friends.accept', callAs(stranger, 'friends.request', insider));
    });

    [
      ['a signed-out visitor', () => null],
      ['a stranger with an account', () => stranger],
    ].forEach(([who, userIdOf]) => {
      it(`sends ${who} nothing private through any publication`, function () {
        const docs = everythingSentTo(userIdOf());

        assert.isTrue(docs.some(doc => doc._id === publicClubId), 'the public group is still sent');
        assert.isTrue(docs.some(doc => doc._id === publicEventId), 'and the public event');
        assert.isTrue(docs.some(doc => doc.eventId === publicEventId), 'and the link between them');
        [privateClubId, ...Object.values(hidden)].forEach(id => {
          assert.deepEqual(docs.filter(doc => mentions(doc, id)), [], 'not the listing, and not a row naming it');
        });
      });

      it(`sends ${who} no owner, no createdBy and no invite link through any publication`, function () {
        everythingSentTo(userIdOf()).forEach(doc => {
          assert.notProperty(doc, 'owner');
          assert.notProperty(doc, 'createdBy');
          assert.notProperty(doc, 'inviteToken');
        });
      });
    });

    it('sends a member their private group and its private events, without the owner or the link', function () {
      const docs = everythingSentTo(member);

      assert.isTrue(docs.some(doc => doc._id === privateClubId && doc.visibility === 'private'));
      assert.isTrue(docs.some(doc => doc._id === hidden.byHostNumber), 'the event that names the group as its host');
      assert.isTrue(
        docs.some(doc => doc.eventId === hidden.byHostNumber && doc.clubId === privateClubId),
        'with the link row a page joins them by',
      );
      assert.isTrue(
        docs.some(doc => doc.eventId === publicEventId && doc.clubId === privateClubId),
        'and the row for a public event the group has on its page',
      );
      docs.forEach(doc => {
        assert.notProperty(doc, 'owner');
        assert.notProperty(doc, 'createdBy');
        assert.notProperty(doc, 'inviteToken');
      });
    });

    // A row proves nothing about who hosts what: for a long while anybody
    // could write one. This one happens to point at the right group; the
    // publication cannot know that, and the next test is the row that does not.
    it('does not send a member a private event that only a link row ties to their group', function () {
      const docs = everythingSentTo(member);
      assert.deepEqual(docs.filter(doc => mentions(doc, hidden.byLinkAlone)), [], 'not the event, and not the row');
    });

    /**
     * The way in that a link row was. 'Clubs.organizeEvent' wrote one for
     * anybody signed in; the member tree followed every link row of every
     * group a person had joined to the event at the other end, and asked of
     * that event only whether it was published. So: start a group, join it,
     * link it to a private event, subscribe. The id is not hard to come by —
     * an event that was public before its group went private had it sent to
     * every visitor.
     *
     * The method asks who is calling now, and says so in its own tests. The
     * rows are written straight to the collection here because that is where
     * the ones from before still are, and because a publication that is safe
     * only while no method slips again is the arrangement that failed.
     */
    describe('a stranger who links a group of their own to a private event', function () {
      let theirClubId;

      beforeEach(function () {
        theirClubId = makeClub();
        callAs(stranger, 'profileClubs.add', theirClubId);
      });

      const linkTo = eventId => EventClubs.collection.insert({
        clubId: theirClubId,
        eventId,
        userId: stranger,
        createdAt: new Date(),
      });

      it('is sent nothing for it, through any publication', function () {
        Object.values(hidden).forEach(linkTo);
        assert.equal(EventClubs.collection.find({ clubId: theirClubId }).count(), 4, 'the rows are written');

        const docs = everythingSentTo(stranger);
        assert.isTrue(docs.some(doc => doc._id === theirClubId), 'their own group is sent');
        [privateClubId, ...Object.values(hidden)].forEach(id => {
          assert.deepEqual(docs.filter(doc => mentions(doc, id)), [], 'not the event, and not the row they wrote');
        });
      });

      it('is sent nothing for it by a subscription already open when the row is written', async function () {
        this.timeout(10000);
        const { live, stop } = await subscribeLive(stranger, EventClubs.userPublicationName);

        try {
          assert.isTrue(await eventually(() => live.has(`${Clubs.name}:${theirClubId}`)), 'their own group arrives');
          linkTo(hidden.byHostNumber);
          // Something that must arrive, written after the row: once it is
          // here the row has had its turn.
          const laterEventId = makeEvent({ eventID: numberOf(theirClubId) });
          assert.isTrue(await eventually(() => live.has(`${Events.name}:${laterEventId}`)), 'their own event arrives');

          assert.isFalse(live.has(`${Events.name}:${hidden.byHostNumber}`), 'not the event');
          const row = EventClubs.collection.findOne({ clubId: theirClubId, eventId: hidden.byHostNumber });
          assert.isFalse(live.has(`${EventClubs.name}:${row._id}`), 'and not the row');
        } finally {
          stop();
        }
      });
    });

    /**
     * The public links were a cursor, with the ids of everything private read
     * into it when the subscription began. 'Events.insert' writes a link for
     * every event it makes, so whatever was made private-from-the-start while
     * a tab was open was in nobody's list, and its row went to every tab:
     * that a private group exists, the id its methods are called with, and
     * how much it has on. A claim about a subscription that is already open,
     * so it is made of one.
     */
    it('judges a link written while a tab is open, and sends it only if both ends are public', async function () {
      this.timeout(10000);
      const { live, stop } = await subscribeLive(null, EventClubs.linksPublicationName);
      const link = (eventId, clubId) => EventClubs.collection.insert({ eventId, clubId });
      const sent = linkId => live.has(`${EventClubs.name}:${linkId}`);

      try {
        const already = EventClubs.collection.findOne({ eventId: publicEventId, clubId: publicClubId })._id;
        assert.isTrue(sent(already), 'what was public when the tab opened is there from the start');
        assert.lengthOf([...live], 1, 'and nothing else is');

        const newClubId = makeClub({ visibility: 'private' });
        const withheld = [
          // A private group started this afternoon, and its first event.
          link(makeEvent({ eventID: numberOf(newClubId), visibility: 'private' }), newClubId),
          // A public event it put on its page: the row still names the group.
          link(publicEventId, newClubId),
          // A private event posted under the public group.
          link(makeEvent({ eventID: numberOf(publicClubId), visibility: 'private' }), publicClubId),
          // A draft, and a link to nothing at all.
          link(makeEvent({ publicationStatus: 'draft' }), publicClubId),
          link('no-such-event', publicClubId),
        ];
        // Written last, and public at both ends: when it has arrived, every
        // row before it has been judged.
        const open = link(makeEvent({ eventID: numberOf(publicClubId) }), publicClubId);

        assert.isTrue(await eventually(() => sent(open)), 'a public event’s link arrives without a resubscribe');
        withheld.forEach(linkId => assert.isFalse(sent(linkId)));

        EventClubs.collection.remove(open);
        assert.isTrue(await eventually(() => !sent(open)), 'and goes when the link does');
      } finally {
        stop();
      }
    });

    it('sends a private event under a public group to that group’s members and nobody else', function () {
      assert.isFalse(everythingSentTo(member).some(doc => mentions(doc, hidden.underPublicGroup)));

      ProfileClubs.collection.insert({ userId: member, clubId: publicClubId });
      assert.isTrue(everythingSentTo(member).some(doc => doc._id === hidden.underPublicGroup));
    });

    it('stops sending a group’s events to somebody who is no longer in it', function () {
      ProfileClubs.collection.remove({ userId: member });

      const docs = everythingSentTo(member);
      [privateClubId, ...Object.values(hidden)].forEach(id => {
        assert.deepEqual(docs.filter(doc => mentions(doc, id)), []);
      });
    });

    it('does not send a member a draft or an archived listing', function () {
      Clubs.collection.update(privateClubId, { $set: { publicationStatus: 'archived' } });

      const docs = everythingSentTo(member);
      assert.isFalse(docs.some(doc => doc._id === privateClubId));
      assert.isFalse(docs.some(doc => doc._id === hidden.byHostNumber), 'nor anything reached through it');
    });

    describe('owned publications', function () {
      const ownedBy = userId => [
        ...docsFrom(publishAs(userId, 'Clubs.publication.owned')),
        ...docsFrom(publishAs(userId, 'Events.publication.owned')),
      ];

      it('sends an owner their own listings whole: owner, invite link, private ones included', function () {
        const docs = ownedBy(owner);

        assert.sameMembers(
          docs.map(doc => doc._id),
          [publicClubId, privateClubId, publicEventId, hidden.byHostNumber],
        );
        docs.forEach(doc => assert.equal(doc.owner, 'owner@private.example'));
        assert.equal(docs.find(doc => doc._id === privateClubId).inviteToken, 'the-way-in');
      });

      it('sends them to nobody else', function () {
        assert.deepEqual(ownedBy(member), [], 'being in a group is not owning it');
        assert.deepEqual(ownedBy(stranger), []);
        assert.deepEqual(ownedBy(null), []);
      });

      // Most of the register's events were imported and have no owner at all.
      // A selector built from a name that resolved to nothing would match
      // every one of them.
      it('does not hand the unowned listings to a caller whose account cannot be found', function () {
        makeEvent();
        assert.deepEqual(ownedBy('no-such-user'), []);
      });

      it('keeps an owner’s past events out, like everyone’s', function () {
        const overId = makeEvent({ owner: 'owner@private.example', date: new Date(startOfToday().getTime() - DAY_MS) });
        assert.notInclude(ownedBy(owner).map(doc => doc._id), overId);
      });
    });
  });

  /**
   * Past events are not shown, and the rest are loaded a stretch at a time.
   * The floor is the start of today on Kauaʻi rather than the present moment,
   * so every date here is built from it and none from the clock: the tests
   * mean the same thing at five to midnight as at noon.
   */
  describe('event dates', function () {
    const floor = () => startOfToday().getTime();
    const sentIds = (...args) => docsFrom(publishAs(null, Events.userPublicationName, ...args)).map(doc => doc._id);

    beforeEach(function () {
      resetAll();
    });

    it('starts today at midnight in Honolulu, whatever the server’s own zone', function () {
      // 09:59 UTC on the 17th is 23:59 on the 16th in Honolulu, which keeps no
      // daylight time; a minute later it is the 17th there too.
      assert.equal(startOfToday(new Date('2026-09-17T09:59:00Z')).toISOString(), '2026-09-16T10:00:00.000Z');
      assert.equal(startOfToday(new Date('2026-09-17T10:00:00Z')).toISOString(), '2026-09-17T10:00:00.000Z');
    });

    it('drops what is over and keeps this morning', function () {
      const earlierToday = makeEvent({ date: new Date(floor() + 1000) });
      const lastNight = makeEvent({ date: new Date(floor() - 1000) });
      const endedYesterday = makeEvent({ date: new Date(floor() - 3 * DAY_MS), endDate: new Date(floor() - 1000) });
      const stillRunning = makeEvent({ date: new Date(floor() - 3 * DAY_MS), endDate: new Date(floor() + DAY_MS) });

      const ids = sentIds();
      assert.include(ids, earlierToday, 'the market that opened at seven is still on the wall at noon');
      assert.include(ids, stillRunning, 'a festival on its third day is not over');
      assert.notInclude(ids, lastNight);
      assert.notInclude(ids, endedYesterday, 'an end date that has passed is the end');
    });

    it('stops at the horizon unless a window asks for what is beyond it', function () {
      const near = makeEvent({ date: new Date(floor() + (EVENT_HORIZON_DAYS - 1) * DAY_MS) });
      const far = makeEvent({ date: new Date(floor() + (EVENT_HORIZON_DAYS + 10) * DAY_MS) });

      assert.sameMembers(sentIds(), [near]);
      assert.sameMembers(sentIds({
        from: new Date(floor() + EVENT_HORIZON_DAYS * DAY_MS),
        to: new Date(floor() + (EVENT_HORIZON_DAYS + 31) * DAY_MS),
      }), [far]);
    });

    it('raises a window that reaches into the past to today', function () {
      const lastWeek = makeEvent({ date: new Date(floor() - 7 * DAY_MS) });
      const tomorrow = makeEvent({ date: new Date(floor() + DAY_MS) });

      // A year back is far wider than any window allowed; what is left after
      // the past is cut off is ten days, and that is what is measured.
      const ids = sentIds({ from: new Date(floor() - 365 * DAY_MS), to: new Date(floor() + 10 * DAY_MS) });
      assert.include(ids, tomorrow);
      assert.notInclude(ids, lastWeek);
    });

    it('answers a window that is entirely over with nothing, and no error', function () {
      makeEvent({ date: new Date(floor() - 7 * DAY_MS) });
      makeEvent();
      assert.deepEqual(sentIds({ from: new Date(floor() - 30 * DAY_MS), to: new Date(floor() - DAY_MS) }), []);
    });

    it('refuses a window wider than it allows, or one that is not dates', function () {
      const wide = { from: new Date(floor()), to: new Date(floor() + (EVENT_WINDOW_MAX_DAYS + 1) * DAY_MS) };
      assert.equal(errorFrom(() => publishAs(null, Events.userPublicationName, wide)), 'window-too-wide');
      assert.equal(
        errorFrom(() => publishAs(null, Events.userPublicationName, { to: new Date(floor() + 200 * DAY_MS) })),
        'window-too-wide',
        'an open start is today, so this is two hundred days',
      );
      assert.equal(
        errorFrom(() => publishAs(null, Events.userPublicationName, { from: new Date('not a date') })),
        'invalid-window',
      );
      assert.isNotNull(errorFrom(() => publishAs(null, Events.userPublicationName, { from: 'tomorrow' })));
      assert.isNotNull(errorFrom(() => publishAs(null, Events.userPublicationName, { $where: 'true' })));
    });

    /**
     * The horizon cut an RSVP in half. The row saying "going" was sent; the
     * event it names, found through a calendar paged past the horizon, was
     * not, and so was on neither "Going" nor the agenda once the calendar
     * closed. The events now come with the rows — the public ones, which is
     * all this cursor may carry.
     */
    it('sends the events a person is going to along with their swipes, however far off', function () {
      const person = makeUser();
      const beyond = new Date(floor() + (EVENT_HORIZON_DAYS + 40) * DAY_MS);
      const far = makeEvent({ date: beyond, owner: 'poster@private.example', createdBy: 'poster@private.example' });
      const farAndPassedOn = makeEvent({ date: beyond });
      // Theirs to go to, as a member of the group that hosts it; and theirs to
      // be sent on that ground, by the member publication and not by this one.
      const clubId = makeClub({ visibility: 'private' });
      ProfileClubs.collection.insert({ userId: person, clubId });
      const farAndPrivate = makeEvent({
        date: beyond,
        visibility: 'private',
        eventID: Clubs.collection.findOne(clubId).clubID,
      });
      const over = makeEvent({ date: new Date(floor() - DAY_MS) });
      [far, farAndPrivate, over].forEach(eventId => callAs(person, 'eventSwipes.record', eventId, 'going'));
      callAs(person, 'eventSwipes.record', farAndPassedOn, 'passed');

      const sentWithSwipes = userId => [].concat(publishAs(userId, EventSwipes.userPublicationName)).flatMap(docsFrom);
      const docs = sentWithSwipes(person);
      const events = docs.filter(doc => doc.title);

      assert.lengthOf(docs.filter(doc => doc.eventId), 4, 'every swipe, as before');
      assert.notInclude(sentIds(), far, 'the public cursor stops short of it');
      assert.deepEqual(events.map(doc => doc._id), [far], 'not what is over, passed on, or private');
      assert.notProperty(events[0], 'owner');
      assert.notProperty(events[0], 'createdBy');
      assert.deepEqual(sentWithSwipes(makeUser()), [], 'and only to the person going');
      assert.deepEqual(sentWithSwipes(null), []);
    });

    it('holds a joined group’s events to the same floor', function () {
      const member = makeUser();
      const clubId = makeClub();
      const eventID = Clubs.collection.findOne(clubId).clubID;
      ProfileClubs.collection.insert({ userId: member, clubId });
      const upcoming = makeEvent({ eventID });
      const over = makeEvent({ eventID, date: new Date(floor() - DAY_MS) });
      const overByLink = makeEvent({ date: new Date(floor() - DAY_MS) });
      EventClubs.collection.insert({ eventId: overByLink, clubId });
      // Next year's retreat: a group's own events are few, and have no horizon.
      const distant = makeEvent({ eventID, date: new Date(floor() + 300 * DAY_MS) });

      const docs = sentFrom(joinedGroupsPublication(member, { withEvents: true }));
      const ids = docs.map(doc => doc._id);
      assert.includeMembers(ids, [upcoming, distant]);
      assert.notInclude(ids, over);
      assert.notInclude(ids, overByLink);
      // Links are never pruned, and a row to an event nobody is sent is a row
      // a page can do nothing with.
      assert.isFalse(docs.some(doc => doc.eventId === overByLink), 'nor the link to it');
    });
  });

  /**
   * Asking to join names a person to the owner, and an anonymous group has
   * promised that nobody is named to anyone. The methods refuse to create a
   * request for one; these tests write the rows directly, because the
   * publication must hold even for a row that should not exist — a group can
   * turn anonymous with people already waiting.
   */
  describe('join requests', function () {
    let owner;
    let asker;
    let clubId;
    let requestId;

    const request = (overrides = {}) => ClubJoinRequests.collection.insert({
      clubId,
      userId: asker,
      status: 'pending',
      createdAt: new Date(),
      ...overrides,
    });

    const requestsSentTo = userId => sentFrom(joinRequestsForOwnerPublication(userId))
      .filter(doc => doc.status);

    beforeEach(function () {
      resetAll();
      ClubJoinRequests.collection.remove({});
      owner = makeUser({ email: 'organizer@test.example' });
      asker = makeUser();
      Profiles.collection.update({ userId: asker }, { $set: { picture: '/photo/profile/asker', interests: ['Support Groups'] } });
      clubId = makeClub({ owner: 'organizer@test.example', approveMembers: true, categories: ['community'] });
      requestId = request();
    });

    it('sends an owner the people waiting, with a name and a picture and nothing else', function () {
      const docs = sentFrom(joinRequestsForOwnerPublication(owner));
      const sentRequest = docs.find(doc => doc._id === requestId);
      const profileId = Profiles.collection.findOne({ userId: asker })._id;

      assert.deepEqual(Object.keys(sentRequest).sort(), ['_id', 'clubId', 'createdAt', 'status', 'userId']);
      assert.deepEqual(docs.find(doc => doc._id === profileId), {
        _id: profileId,
        userId: asker,
        firstName: Profiles.collection.findOne(profileId).firstName,
        lastName: 'Test',
        picture: '/photo/profile/asker',
      }, 'not the address, and not the interests');
    });

    it('sends only the requests still waiting', function () {
      ClubJoinRequests.collection.update(requestId, { $set: { status: 'declined', respondedAt: new Date(), respondedBy: owner } });
      assert.deepEqual(requestsSentTo(owner), []);
    });

    it('sends nothing to anyone who does not own the group', function () {
      const admin = makeUser({ admin: true });
      [asker, makeUser(), admin].forEach(userId => assert.deepEqual(requestsSentTo(userId), []));
    });

    it('sends nothing to a signed-out visitor', async function () {
      const sent = [];
      await Meteor.server.publish_handlers[ClubJoinRequests.ownerPublicationName].apply({
        userId: null,
        added: (collection, id) => sent.push(`${collection}:${id}`),
        changed: () => {},
        removed: () => {},
        ready: () => {},
        onStop: () => {},
      }, []);
      assert.deepEqual(sent, []);
    });

    it('sends nothing for a group its owner made anonymous', function () {
      Clubs.collection.update(clubId, { $set: { anonymous: true } });
      assert.deepEqual(requestsSentTo(owner), []);
    });

    it('sends nothing for a sensitive group, which is anonymous whatever its owner chose', function () {
      Clubs.collection.update(clubId, { $set: { categories: ['support_group'], anonymous: false } });
      assert.deepEqual(requestsSentTo(owner), []);
    });

    it('takes the waiting names out of a live subscription when the group turns anonymous', async function () {
      this.timeout(10000);
      const { live, stop } = await subscribeLive(owner, ClubJoinRequests.ownerPublicationName);
      const named = () => live.has(`${ClubJoinRequests.name}:${requestId}`);

      try {
        assert.isTrue(await eventually(named), 'the request arrives');
        Clubs.collection.update(clubId, { $set: { anonymous: true } });
        assert.isTrue(await eventually(() => !named()), 'and is withdrawn without a resubscribe');
      } finally {
        stop();
      }
    });

    it('sends a person their own requests, without who answered', function () {
      ClubJoinRequests.collection.update(requestId, { $set: { status: 'declined', respondedAt: new Date(), respondedBy: owner } });
      const mine = userId => docsFrom(publishAs(userId, ClubJoinRequests.minePublicationName));

      assert.lengthOf(mine(asker), 1);
      assert.equal(mine(asker)[0].status, 'declined');
      assert.notProperty(mine(asker)[0], 'respondedBy');
      assert.deepEqual(mine(owner), [], 'the owner’s view of it is the other publication');
      assert.deepEqual(mine(null), []);
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
