/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { ProfileClubs } from './ProfileClubs';
import { callAs, errorFrom, makeClub, makeUser, resetAll } from '../../startup/server/testFixtures';

/**
 * Joining and leaving a group.
 *
 * The first backend test in the app, and deliberately over one of the simplest
 * methods: what it is really proving is that the harness itself works — that a
 * method can be invoked as a chosen user, that authorization can be asserted on,
 * and that the database resets between cases.
 */
if (Meteor.isServer) {
  describe('profileClubs', function () {
    let user;
    let clubId;

    beforeEach(function () {
      resetAll();
      user = makeUser();
      clubId = makeClub();
    });

    describe('add', function () {
      it('joins a group', function () {
        callAs(user, 'profileClubs.add', clubId);
        assert.equal(ProfileClubs.collection.find({ userId: user, clubId }).count(), 1);
      });

      it('refuses a signed-out caller', function () {
        assert.equal(errorFrom(() => callAs(null, 'profileClubs.add', clubId)), 'not-logged-in');
        assert.equal(ProfileClubs.collection.find().count(), 0);
      });

      it('does not join the same group twice', function () {
        callAs(user, 'profileClubs.add', clubId);
        callAs(user, 'profileClubs.add', clubId);
        // Whether it throws or quietly no-ops is the method's business; what
        // must never happen is two membership rows, because every count in the
        // app trusts this collection to hold one row per person per group.
        assert.equal(ProfileClubs.collection.find({ userId: user, clubId }).count(), 1);
      });
    });

    describe('remove', function () {
      it('leaves a group', function () {
        callAs(user, 'profileClubs.add', clubId);
        callAs(user, 'profileClubs.remove', clubId);
        assert.equal(ProfileClubs.collection.find({ userId: user, clubId }).count(), 0);
      });

      /**
       * The authorization case, and the reason this file exists.
       *
       * `profileClubs.remove` takes a club id and no user id, so the only thing
       * standing between one member and another's membership is that the
       * selector is scoped to `this.userId`. If that scoping is ever lost the
       * method still passes every happy-path test — it would just also remove
       * everyone else. This is the test that would catch it.
       */
      it('cannot remove another person from a group', function () {
        const other = makeUser();
        callAs(other, 'profileClubs.add', clubId);
        callAs(user, 'profileClubs.remove', clubId);
        assert.equal(ProfileClubs.collection.find({ userId: other, clubId }).count(), 1);
      });
    });
  });
}
