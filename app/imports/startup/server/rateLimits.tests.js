/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { addressLimitFor, rateLimitFor } from './rateLimits';

/**
 * These pin numbers, which is unusual for a test and deliberate here. The
 * per-address limits were once 15 sign-ins a minute and 5 sign-ups an hour,
 * which read as sensible for one person and would have refused a launch party
 * — everyone on the venue's Wi-Fi is one address, and a refused resume login
 * logs the person out rather than retrying. The figures are the product of
 * that reasoning, written up in rateLimits.js; a change to them should have to
 * come here and say why.
 */
if (Meteor.isServer) {
  describe('rate limits', function () {
    it('allows a room full of people to sign in from one address', function () {
      assert.deepEqual(addressLimitFor('login'), [30, 60]);
    });

    it('allows a table of friends to sign up from one address', function () {
      assert.deepEqual(addressLimitFor('createUser'), [20, 60 * 60]);
    });

    it('knows no other per-address rule', function () {
      assert.isNull(addressLimitFor('eventSwipes.record'));
    });

    it('keeps the deck above what a reader can physically produce', function () {
      // A card a second plus an undo, sustained: twenty calls in ten seconds.
      const [calls, seconds] = rateLimitFor('eventSwipes.record');
      assert.isAtLeast(calls / seconds, 2);
    });

    it('falls back to the general rule for anything unnamed', function () {
      assert.deepEqual(rateLimitFor('Profiles.somethingNew'), [30, 10]);
    });
  });
}
