/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { AuditLog } from './AuditLog';
import { installAuditTrail } from '../../startup/server/auditTrail';
import { callAs, errorFrom, makeClub, makeUser, resetAll } from '../../startup/server/testFixtures';

/**
 * The trail, and the three ways a trail is usually useless.
 *
 * It records nothing because it was wired in the wrong order; it records the
 * happy path only, so the refused calls that matter most are the ones missing;
 * or it records everything including the payloads, and outgrows the data it
 * describes. There is a test for each.
 */
if (Meteor.isServer) {
  describe('audit trail', function () {
    let member;

    before(function () {
      // `meteor test` does not run server/main.js, so the wrapper that main.js
      // installs at startup is not installed here. Installing it explicitly is
      // also the assertion that it is installable more than once without
      // double-wrapping — which is what the `mbAudited` flag is for.
      installAuditTrail();
      installAuditTrail();
    });

    beforeEach(function () {
      resetAll();
      AuditLog.collection.remove({});
      member = makeUser();
    });

    it('wraps the app’s own methods and not the framework’s', function () {
      const wrapped = installAuditTrail();
      assert.isAbove(wrapped, 15, 'should have found the app’s methods');
      // Account methods carry passwords and reset tokens.
      assert.isNotOk(Meteor.server.method_handlers.login?.mbAudited, 'login must not be audited');
    });

    it('records a successful change with its actor', function () {
      const clubId = makeClub();
      callAs(member, 'profileClubs.add', clubId);

      const entry = AuditLog.collection.findOne({ action: 'profileClubs.add' });
      assert.isOk(entry, 'the join should have been recorded');
      assert.equal(entry.actorId, member);
      assert.equal(entry.actorEmail, Meteor.users.findOne(member).username);
      assert.equal(entry.outcome, 'ok');
      assert.isAtLeast(entry.ms, 0);
      assert.instanceOf(entry.at, Date);
    });

    /**
     * The half most logs omit. One person hitting `not-authorized` twenty times
     * against one method is what probing looks like from the outside, and it is
     * invisible if only successes are written.
     */
    it('records a refused call, with the reason', function () {
      errorFrom(() => callAs(null, 'profileClubs.add', makeClub()));

      const entry = AuditLog.collection.findOne({ action: 'profileClubs.add' });
      assert.isOk(entry, 'a refused call must still be recorded');
      assert.equal(entry.outcome, 'error');
      assert.equal(entry.errorCode, 'not-logged-in');
      assert.isNotOk(entry.actorId, 'there was no actor to name');
    });

    it('does not let the caller’s error be swallowed by the logging', function () {
      // The method must still throw for the app; the trail is a bystander.
      assert.equal(errorFrom(() => callAs(null, 'profileClubs.add', makeClub())), 'not-logged-in');
    });

    /**
     * A profile picture is a multi-megabyte base64 string. Copying it into the
     * log would make the log larger than the collection it describes, and would
     * duplicate personal data into a place with different access rules.
     */
    it('summarises an image instead of storing it', function () {
      const bigPicture = `data:image/jpeg;base64,${'A'.repeat(40000)}`;
      callAs(member, 'Profiles.update', {
        firstName: 'A', lastName: 'B', email: Meteor.users.findOne(member).username,
        bio: '', title: '', interests: [], picture: bigPicture,
      });

      const entry = AuditLog.collection.findOne({ action: 'Profiles.update' });
      assert.isOk(entry);
      assert.notInclude(entry.summary, 'AAAA', 'the image must not be in the log');
      assert.isBelow(entry.summary.length, 320, 'the summary is bounded');
      // It still says an image was involved, which is the auditable fact.
      assert.include(entry.summary, 'picture');
    });

    it('keeps entries in the order they happened', function () {
      const clubId = makeClub();
      callAs(member, 'profileClubs.add', clubId);
      callAs(member, 'profileClubs.remove', clubId);

      const actions = AuditLog.collection.find({}, { sort: { at: 1 } }).fetch().map(e => e.action);
      assert.deepEqual(
        actions.filter(a => a.startsWith('profileClubs')),
        ['profileClubs.add', 'profileClubs.remove'],
      );
    });
  });
}
