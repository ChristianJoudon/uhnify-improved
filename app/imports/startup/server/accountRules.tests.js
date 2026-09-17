/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { Clubs } from '../../api/club/Club';
import { canManageListing } from '../../api/listing/ownership';
import { errorFrom, makeClub, makeUser, resetAll } from './testFixtures';
import { newAccountProblem } from './accountRules';

/**
 * Owning a listing is having the account name that is stamped on it, so what
 * an account may be called is an authorization rule, and it is tested from
 * the side of somebody trying to be called something they are not.
 */
if (Meteor.isServer) {
  describe('what an account may be called', function () {
    this.timeout(10000);

    beforeEach(function () {
      resetAll();
    });

    it('lets an account go by its own email address, which is what the sign-up page sends', function () {
      assert.isNull(newAccountProblem({ username: 'someone@test.example', emails: [{ address: 'someone@test.example' }] }));
      assert.isNull(newAccountProblem({ emails: [{ address: 'someone@test.example' }] }), 'or by no username at all');
      assert.isString(makeUser());
    });

    /**
     * `Accounts.createUser` can be called from any browser console, and took
     * any username nobody had yet. The listing below is stamped with an
     * address its owner never registered under that name.
     */
    it('refuses a username that is not the account’s own address, so a listing cannot be claimed by name', function () {
      const clubId = makeClub({ owner: 'organizer@test.example' });
      const claim = () => Accounts.createUser({
        username: 'organizer@test.example',
        email: 'somebody-else@test.example',
        password: 'test-password',
      });

      assert.equal(errorFrom(claim), 'invalid-username');
      assert.isUndefined(Meteor.users.findOne({ username: 'organizer@test.example' }));
      assert.equal(errorFrom(() => Accounts.createUser({ username: 'organizer@test.example', password: 'test-password' })), 'invalid-email');

      const honest = makeUser({ email: 'somebody-else@test.example' });
      assert.isFalse(canManageListing(honest, Clubs.collection.findOne(clubId)));
    });

    it('refuses an address that is not shaped like one, including the name the intake pipeline signs with', function () {
      ['MatchBook community intake', 'register', 'two words@test.example', 'nodomain@'].forEach(address => {
        assert.equal(
          errorFrom(() => Accounts.createUser({ username: address, email: address, password: 'test-password' })),
          'invalid-email',
          address,
        );
      });
      assert.equal(newAccountProblem({ emails: [{ address: `${'a'.repeat(250)}@test.example` }] }), 'invalid-email');
      assert.equal(newAccountProblem({}), 'invalid-email');
      assert.equal(newAccountProblem(undefined), 'invalid-email');
    });

    it('says what to do instead, in words', function () {
      try {
        Accounts.createUser({ username: 'a-name', email: 'someone@test.example', password: 'test-password' });
        assert.fail('should have been refused');
      } catch (error) {
        assert.equal(error.reason, 'Sign up with your email address.');
      }
    });
  });
}
