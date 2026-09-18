/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import crypto from 'crypto';
import { Clubs } from '../club/Club';
import { Events } from '../events/Events';
import { Profiles } from '../profiles/Profiles';
import { ProfileClubs } from '../profile/ProfileClubs';
import { AuditLog } from '../audit/AuditLog';
import { accountNameOf } from '../listing/ownership';
import { callAs, errorFrom, makeClub, makeEvent, makeUser, resetAll } from '../../startup/server/testFixtures';

/** What the browser sends: the SHA-256 of the password, never the password. */
const hashed = password => ({ digest: crypto.createHash('sha256').update(password).digest('hex'), algorithm: 'sha-256' });

if (Meteor.isServer) {
  describe('the account itself', function () {
    this.timeout(15000);
    let user;
    let admin;
    beforeEach(function () {
      resetAll();
      user = makeUser({ verified: false });
      admin = makeUser({ admin: true });
    });

    describe('posting needs a confirmed address', function () {
      const club = { name: 'Posted', description: 'x', location: 'Kapaʻa', meetingTime: 'Thursdays at 6 PM' };
      it('refuses an unconfirmed account, and says what to do', function () {
        assert.equal(errorFrom(() => callAs(user, 'Clubs.insert', club)), 'email-unverified');
        assert.equal(errorFrom(() => callAs(user, 'Events.insert', { eventID: 0, title: 'T', date: new Date(), location: 'x' })), 'email-unverified');
      });
      it('lets a confirmed one, and an administrator, post', function () {
        Meteor.users.update(user, { $set: { 'emails.0.verified': true } });
        assert.isString(callAs(user, 'Clubs.insert', club));
        assert.isString(callAs(admin, 'Clubs.insert', { ...club, name: 'Admin posted' }));
      });
    });

    describe('sending the confirmation again', function () {
      it('does nothing for an address already confirmed', function () {
        Meteor.users.update(user, { $set: { 'emails.0.verified': true } });
        assert.equal(callAs(user, 'accounts.resendVerification'), 'verified');
      });
    });

    describe('deleting my account', function () {
      it('needs my password, and refuses somebody else’s', function () {
        assert.equal(errorFrom(() => callAs(user, 'accounts.deleteMine', hashed('not-it'))), 'wrong-password');
        assert.isOk(Meteor.users.findOne(user));
      });

      it('takes everything about me, and leaves what I posted for others without my name', function () {
        Meteor.users.update(user, { $set: { 'emails.0.verified': true } });
        const clubId = callAs(user, 'Clubs.insert', { name: 'Mine', description: 'x', location: 'Kapaʻa', meetingTime: 'Thursdays at 6 PM' });
        const eventId = callAs(user, 'Events.insert', { eventID: 0, title: 'Mine too', date: new Date(Date.now() + 864e5), location: 'x', email: 'me@test.example' });
        callAs(user, 'profileClubs.add', makeClub({ owner: accountNameOf(admin), memberCount: 0 }));
        callAs(user, 'eventSwipes.record', makeEvent({ owner: accountNameOf(admin), goingCount: 0 }), 'going', 'event');
        AuditLog.collection.insert({ at: new Date(), actorId: user, actorEmail: accountNameOf(user), action: 'Clubs.insert', outcome: 'ok' });

        assert.isTrue(callAs(user, 'accounts.deleteMine', hashed('test-password')));

        assert.isUndefined(Meteor.users.findOne(user));
        assert.equal(Profiles.collection.find({ userId: user }).count(), 0);
        assert.equal(ProfileClubs.collection.find({ userId: user }).count(), 0);
        assert.isOk(Clubs.collection.findOne(clubId), 'the group stays up');
        assert.equal(Clubs.collection.findOne(clubId).owner, 'deleted-account');
        const event = Events.collection.findOne(eventId);
        assert.isOk(event);
        assert.notProperty(event, 'owner');
        assert.notProperty(event, 'email', 'the contact address they printed goes too');
        const trail = AuditLog.collection.findOne({ action: 'Clubs.insert', actorId: 'deleted' });
        assert.isOk(trail);
        assert.notProperty(trail, 'actorEmail');
      });

      it('will not let the only administrator delete themselves', function () {
        assert.equal(errorFrom(() => callAs(admin, 'accounts.deleteMine', hashed('test-password'))), 'last-administrator');
      });
    });
  });
}
