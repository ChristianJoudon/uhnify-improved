/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Events } from './Events';
import { EventClubs } from './EventClubs';
import { EventSwipes } from './EventSwipes';
import { ProfileClubs } from '../profile/ProfileClubs';
import { Clubs } from '../club/Club';
import { callAs, errorFrom, makeClub, makeEvent, makeUser, resetAll } from '../../startup/server/testFixtures';

/**
 * Removing things, and what removing them leaves behind.
 *
 * Every delete in this app is a hard delete across several collections with no
 * transaction, so "what is still pointing at the thing that is gone" is not a
 * detail — it is the whole correctness question. These tests exist because two
 * of those cascades were incomplete: a deleted event kept every saved-and-passed
 * row anyone had ever written about it, and a deleted group kept the swipes on
 * the group itself. Orphans of that kind are invisible until a count is wrong.
 */
if (Meteor.isServer) {
  describe('removal cascades', function () {
    let admin;
    let member;

    beforeEach(function () {
      resetAll();
      admin = makeUser({ admin: true });
      member = makeUser();
    });

    describe('Events.remove', function () {
      it('needs an administrator', function () {
        const eventId = makeEvent();
        assert.equal(errorFrom(() => callAs(member, 'Events.remove', eventId)), 'not-authorized');
        assert.equal(errorFrom(() => callAs(null, 'Events.remove', eventId)), 'not-logged-in');
        assert.equal(Events.collection.find().count(), 1, 'nothing should have been removed');
      });

      it('takes the saved-and-passed rows with it', function () {
        const eventId = makeEvent();
        callAs(member, 'eventSwipes.record', eventId, 'interested');
        assert.equal(EventSwipes.collection.find({ eventId }).count(), 1);

        callAs(admin, 'Events.remove', eventId);

        assert.equal(Events.collection.find({ _id: eventId }).count(), 0);
        assert.equal(
          EventSwipes.collection.find({ eventId }).count(),
          0,
          'a swipe on a deleted event still counts towards someone’s saved list',
        );
      });

      it('takes its group links with it', function () {
        const eventId = makeEvent();
        const clubId = makeClub();
        EventClubs.collection.insert({ clubId, eventId, userId: member, createdAt: new Date() });

        callAs(admin, 'Events.remove', eventId);
        assert.equal(EventClubs.collection.find({ eventId }).count(), 0);
      });
    });

    describe('Clubs.remove', function () {
      it('takes memberships, links and swipes on the group itself', function () {
        const clubId = makeClub();
        callAs(member, 'profileClubs.add', clubId);
        callAs(member, 'eventSwipes.record', clubId, 'interested', 'club');
        EventClubs.collection.insert({ clubId, eventId: makeEvent(), userId: member, createdAt: new Date() });

        callAs(admin, 'Clubs.remove', clubId);

        assert.equal(Clubs.collection.find({ _id: clubId }).count(), 0);
        assert.equal(ProfileClubs.collection.find({ clubId }).count(), 0, 'membership of a deleted group');
        assert.equal(EventClubs.collection.find({ clubId }).count(), 0, 'link from a deleted group');
        assert.equal(EventSwipes.collection.find({ eventId: clubId }).count(), 0, 'swipe on a deleted group');
      });

      /**
       * The deliberate non-cascade, pinned so nobody "fixes" it into a delete.
       *
       * An event outlives the group that listed it: it may be linked to others,
       * and the wall reads it on its own terms. Deleting a group must remove the
       * LINK, never the listing.
       */
      it('does not delete the group’s events', function () {
        const clubId = makeClub();
        const eventId = makeEvent();
        EventClubs.collection.insert({ clubId, eventId, userId: member, createdAt: new Date() });

        callAs(admin, 'Clubs.remove', clubId);

        assert.equal(Events.collection.find({ _id: eventId }).count(), 1, 'the event itself must survive');
        assert.equal(EventClubs.collection.find({ clubId }).count(), 0, 'but not the link to a group that is gone');
      });
    });

    describe('eventSwipes.record', function () {
      it('refuses a signed-out caller', function () {
        assert.equal(errorFrom(() => callAs(null, 'eventSwipes.record', makeEvent(), 'interested')), 'not-logged-in');
      });

      it('refuses a decision it does not recognise', function () {
        assert.equal(
          errorFrom(() => callAs(member, 'eventSwipes.record', makeEvent(), 'maybe')),
          'invalid-decision',
        );
      });

      it('refuses a listing that does not exist', function () {
        assert.equal(errorFrom(() => callAs(member, 'eventSwipes.record', 'no-such-id', 'interested')), 'not-found');
      });

      it('records one row per person per listing, not one per swipe', function () {
        const eventId = makeEvent();
        callAs(member, 'eventSwipes.record', eventId, 'interested');
        callAs(member, 'eventSwipes.record', eventId, 'passed');
        assert.equal(EventSwipes.collection.find({ userId: member, eventId }).count(), 1);
        assert.equal(EventSwipes.collection.findOne({ userId: member, eventId }).decision, 'passed');
      });
    });
  });
}
