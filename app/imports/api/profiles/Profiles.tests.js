/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Profiles } from './Profiles';
import { TEXT_LIMITS } from '../listing/limits';
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

      it('does not store support participation as a public profile interest', function () {
        Profiles.collection.remove({ userId: attacker });
        callAs(attacker, 'createUserProfile', attacker, 'attacker@test.example', 'A', 'B', [
          'Support Groups',
          'Music & Performance',
        ]);
        assert.deepEqual(Profiles.collection.findOne({ userId: attacker }).interests, ['Music & Performance']);
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

      it('holds a name to its limit', function () {
        Profiles.collection.remove({ userId: attacker });
        assert.equal(
          errorFrom(() => callAs(attacker, 'createUserProfile', attacker, 'attacker@test.example', 'A'.repeat(TEXT_LIMITS.firstName + 1), 'B', [])),
          'too-long',
        );
        assert.isNotOk(Profiles.collection.findOne({ userId: attacker }), 'nothing is stored from a refused call');
      });

      it('keeps only real topics as interests, once each', function () {
        Profiles.collection.remove({ userId: attacker });
        callAs(attacker, 'createUserProfile', attacker, 'attacker@test.example', 'A', 'B', [
          'Books & Ideas', 'x'.repeat(5000), 'Books & Ideas', 'Not a topic',
        ]);
        assert.deepEqual(Profiles.collection.findOne({ userId: attacker }).interests, ['Books & Ideas']);
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

      it('removes a supplied support-group interest before saving', function () {
        callAs(attacker, 'Profiles.update', {
          firstName: 'Private', lastName: 'Interest', email: 'attacker@test.example',
          bio: '', title: '', interests: ['Support Groups', 'Books & Ideas'],
        });
        assert.deepEqual(Profiles.collection.findOne({ userId: attacker }).interests, ['Books & Ideas']);
      });

      /**
       * An interest is a topic label — the pages offer nothing else, and every
       * reader resolves it back to its topic — so a string that is not one, or
       * one repeated, was only ever a way to store text of any length, any
       * number of times, on a document the people directory sends to every
       * signed-in user.
       */
      it('keeps only real topics as interests, once each', function () {
        const form = { firstName: 'X', lastName: 'Y', email: 'attacker@test.example', bio: '', title: '' };
        callAs(attacker, 'Profiles.update', {
          ...form,
          interests: ['Music & Performance', 'i'.repeat(TEXT_LIMITS.description), ' Books & Ideas ', 'Music & Performance'],
        });
        assert.deepEqual(Profiles.collection.findOne({ userId: attacker }).interests, ['Music & Performance', 'Books & Ideas']);
        callAs(attacker, 'Profiles.update', { ...form, interests: new Array(500).fill('Books & Ideas') });
        assert.deepEqual(Profiles.collection.findOne({ userId: attacker }).interests, ['Books & Ideas']);
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

      /**
       * The label is whatever the uploader wrote; the bytes are not. A
       * picture that says JPEG and begins like a PNG is refused, and one
       * whose bytes agree with it is kept.
       */
      it('reads the picture’s bytes, not its label', function () {
        const form = { firstName: 'X', lastName: 'Y', email: 'attacker@test.example', bio: '', title: '', interests: [] };
        assert.equal(errorFrom(() => callAs(attacker, 'Profiles.update', {
          ...form, picture: 'data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUg==',
        })), 'invalid-image');
        const jpeg = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString('base64')}`;
        callAs(attacker, 'Profiles.update', { ...form, picture: jpeg });
        // Kept, as the path it is now served from rather than on the profile.
        const profile = Profiles.collection.findOne({ userId: attacker });
        assert.match(profile.picture, new RegExp(`^/photo/profile/${profile._id}\\?v=\\d+$`));
      });

      it('refuses a bio past its limit and keeps one exactly at it', function () {
        const form = { firstName: 'X', lastName: 'Y', email: 'attacker@test.example', title: '', interests: [] };
        assert.equal(errorFrom(() => callAs(attacker, 'Profiles.update', { ...form, bio: 'b'.repeat(TEXT_LIMITS.bio + 1) })), 'too-long');
        callAs(attacker, 'Profiles.update', { ...form, bio: 'b'.repeat(TEXT_LIMITS.bio) });
        assert.equal(Profiles.collection.findOne({ userId: attacker }).bio.length, TEXT_LIMITS.bio);
      });

      it('stores a name trimmed and refuses a blank email', function () {
        const form = { firstName: '  Trimmed ', lastName: ' Name ', email: 'attacker@test.example', bio: '', title: '', interests: [] };
        callAs(attacker, 'Profiles.update', form);
        const mine = Profiles.collection.findOne({ userId: attacker });
        assert.equal(mine.firstName, 'Trimmed');
        assert.equal(mine.lastName, 'Name');
        assert.equal(errorFrom(() => callAs(attacker, 'Profiles.update', { ...form, email: '   ' })), 'required');
      });
    });
  });
}
