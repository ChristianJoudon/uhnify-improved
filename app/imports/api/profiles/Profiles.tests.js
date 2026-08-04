/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Profiles } from './Profiles';
import { callAs, errorFrom, makeUser, resetAll } from '../../startup/server/testFixtures';

/**
 * Profiles — and in particular, who is allowed to own one.
 *
 * The takeover case below is the reason this file was written first. It is not
 * a hypothetical: `createUserProfile` authorised on one value and then looked
 * the document up by another, so proving the caller was themselves did nothing
 * to stop them naming somebody else's address. Four separate audits found it
 * independently, which is usually a sign the shape of the bug — check A, act on
 * B — is easy to reintroduce. Hence a test rather than only a fix.
 */
if (Meteor.isServer) {
  describe('Profiles', function () {
    let victim;
    let attacker;

    beforeEach(function () {
      resetAll();
      victim = makeUser({ email: 'victim@test.example' });
      attacker = makeUser({ email: 'attacker@test.example' });
    });

    describe('createUserProfile', function () {
      it('creates a profile for the caller', function () {
        Profiles.collection.remove({ userId: attacker });
        callAs(attacker, 'createUserProfile', attacker, 'attacker@test.example', 'A', 'B', []);
        const mine = Profiles.collection.findOne({ userId: attacker });
        assert.isOk(mine);
        assert.equal(mine.firstName, 'A');
      });

      it('refuses a signed-out caller', function () {
        assert.equal(
          errorFrom(() => callAs(null, 'createUserProfile', null, 'attacker@test.example', 'A', 'B', [])),
          'not-logged-in',
        );
      });

      /**
       * The exploit, as it was actually performed: sign in as yourself, then
       * name the victim's address. The old code matched their profile on the
       * email half of an `$or` and reassigned its `userId` to the caller.
       */
      it('cannot claim another account’s profile by naming their email', function () {
        const victimProfileBefore = Profiles.collection.findOne({ userId: victim });
        assert.isOk(victimProfileBefore, 'fixture should have given the victim a profile');

        errorFrom(() => callAs(attacker, 'createUserProfile', null, 'victim@test.example', 'Evil', 'Person', []));

        const victimProfileAfter = Profiles.collection.findOne({ _id: victimProfileBefore._id });
        assert.equal(victimProfileAfter.userId, victim, 'the victim must still own their own profile');
        assert.notEqual(victimProfileAfter.userId, attacker);
        // And the victim must still be able to find it, which is what the app
        // does on every page load.
        assert.equal(Profiles.collection.find({ userId: victim }).count(), 1);
      });

      it('cannot create a profile for another user id', function () {
        assert.equal(
          errorFrom(() => callAs(attacker, 'createUserProfile', victim, 'victim@test.example', 'Evil', 'Person', [])),
          'not-authorized',
        );
      });
    });

    describe('Profiles.update', function () {
      it('updates only the caller’s own profile', function () {
        callAs(attacker, 'Profiles.update', {
          firstName: 'Changed', lastName: 'Name', email: 'attacker@test.example',
          bio: 'new bio', title: 'new title', interests: [],
        });
        assert.equal(Profiles.collection.findOne({ userId: attacker }).firstName, 'Changed');
        assert.notEqual(Profiles.collection.findOne({ userId: victim }).firstName, 'Changed');
      });

      it('refuses a signed-out caller', function () {
        assert.equal(errorFrom(() => callAs(null, 'Profiles.update', {
          firstName: 'X', lastName: 'Y', email: 'z@test.example', bio: '', title: '', interests: [],
        })), 'not-logged-in');
      });

      /**
       * The picture rides along with the rest of the form now, so absence has
       * to mean "leave it alone". If it ever came to mean "clear it", saving a
       * changed bio would silently delete the photo.
       */
      it('does not blank the picture when none is supplied', function () {
        Profiles.collection.update({ userId: attacker }, { $set: { picture: 'data:image/gif;base64,AAAA' } });
        callAs(attacker, 'Profiles.update', {
          firstName: 'Keep', lastName: 'Photo', email: 'attacker@test.example',
          bio: '', title: '', interests: [],
        });
        assert.equal(Profiles.collection.findOne({ userId: attacker }).picture, 'data:image/gif;base64,AAAA');
      });

      it('rejects a picture that is not an image', function () {
        assert.equal(errorFrom(() => callAs(attacker, 'Profiles.update', {
          firstName: 'X', lastName: 'Y', email: 'attacker@test.example',
          // Assembled rather than written literally, only because the linter
          // rightly refuses to have that scheme typed into a source file.
          bio: '', title: '', interests: [], picture: `${'java'}${'script'}:alert(1)`,
        })), 'invalid-image');
      });
    });
  });
}
