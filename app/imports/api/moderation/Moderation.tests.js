/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../club/Club';
import { ClubJoinRequests } from '../club/ClubJoinRequests';
import { Events } from '../events/Events';
import { ProfileClubs } from '../profile/ProfileClubs';
import { accountNameOf } from '../listing/ownership';
import { PUBLIC_LISTING_SELECTOR } from '../listing/audience';
import { memberHandle } from '../privacy/anonymousNames';
import { ClubBlocks, Flags } from './Moderation';
import { callAs, errorFrom, makeClub, makeEvent, makeUser, resetAll } from '../../startup/server/testFixtures';

/**
 * Flag, take down, ban, block, cancel — and who may do each.
 *
 * Anyone can post and nothing asks them to prove they are a person, so this is
 * the whole of what stands between the walls and whatever somebody decides to
 * put on them. Each rule is tested from the side of the person it has to stop.
 */
if (Meteor.isServer) {
  describe('moderation', function () {
    this.timeout(15000);

    let admin;
    let owner;
    let member;
    let stranger;

    const ownedClub = (overrides = {}) => makeClub({ owner: accountNameOf(owner), memberCount: 0, ...overrides });
    const ownedEvent = (overrides = {}) => makeEvent({ owner: accountNameOf(owner), goingCount: 0, ...overrides });
    const isPublic = (collection, _id) => collection.find({ $and: [{ _id }, PUBLIC_LISTING_SELECTOR] }).count() === 1;

    beforeEach(function () {
      resetAll();
      Flags.collection.remove({});
      ClubBlocks.collection.remove({});
      ClubJoinRequests.collection.remove({});
      admin = makeUser({ admin: true });
      owner = makeUser();
      member = makeUser();
      stranger = makeUser();
    });

    describe('flags', function () {
      it('takes a report from anyone signed in, and from nobody else', function () {
        const eventId = ownedEvent();
        assert.equal(errorFrom(() => callAs(null, 'moderation.flag', 'event', eventId, 'spam', '')), 'not-logged-in');
        const flagId = callAs(stranger, 'moderation.flag', 'event', eventId, 'spam', '  selling timeshares  ');
        const flag = Flags.collection.findOne(flagId);
        assert.equal(flag.status, 'open');
        assert.equal(flag.note, 'selling timeshares');
        assert.equal(flag.reporterId, stranger);
        assert.isString(flag.listingTitle);
      });

      it('refuses a reason it does not know, a note that is a novel, and a listing that is not up', function () {
        const eventId = ownedEvent();
        assert.equal(errorFrom(() => callAs(stranger, 'moderation.flag', 'event', eventId, 'because', '')), 'invalid-reason');
        assert.equal(errorFrom(() => callAs(stranger, 'moderation.flag', 'event', eventId, 'spam', 'x'.repeat(501))), 'too-long');
        assert.equal(errorFrom(() => callAs(stranger, 'moderation.flag', 'venue', eventId, 'spam', '')), 'invalid-kind');
        assert.equal(errorFrom(() => callAs(stranger, 'moderation.flag', 'event', 'nope', 'spam', '')), 'not-found');
      });

      it('counts one person once, however often they say it', function () {
        const eventId = ownedEvent();
        const first = callAs(stranger, 'moderation.flag', 'event', eventId, 'spam', '');
        const second = callAs(stranger, 'moderation.flag', 'event', eventId, 'unsafe', 'on reflection');
        assert.equal(first, second);
        assert.equal(Flags.collection.find({ listingId: eventId }).count(), 1);
        assert.equal(Flags.collection.findOne(first).reason, 'unsafe');
      });

      it('lets only an administrator answer one', function () {
        const flagId = callAs(stranger, 'moderation.flag', 'event', ownedEvent(), 'spam', '');
        [owner, member, stranger, null].forEach(userId => {
          assert.equal(errorFrom(() => callAs(userId, 'moderation.resolveFlag', flagId, 'takedown', '')), 'not-authorized');
        });
        assert.equal(callAs(admin, 'moderation.resolveFlag', flagId, 'dismiss', ''), 'dismissed');
        assert.equal(Flags.collection.findOne(flagId).resolution, 'dismissed');
      });

      it('takes the listing off every wall, answers everyone who flagged it, and leaves the reason for its owner', function () {
        const eventId = ownedEvent();
        const flagId = callAs(stranger, 'moderation.flag', 'event', eventId, 'not-real', '');
        callAs(member, 'moderation.flag', 'event', eventId, 'spam', '');
        assert.isTrue(isPublic(Events.collection, eventId));

        callAs(admin, 'moderation.resolveFlag', flagId, 'takedown', '');

        assert.isFalse(isPublic(Events.collection, eventId));
        assert.equal(Flags.collection.find({ listingId: eventId, status: 'open' }).count(), 0);
        const event = Events.collection.findOne(eventId);
        assert.equal(event.moderation.reason, 'It is not a real listing');
        assert.equal(event.moderation.takenDownBy, admin);
        assert.equal(errorFrom(() => callAs(stranger, 'moderation.flag', 'event', eventId, 'spam', '')), 'not-found');
      });

      it('can be put back, by an administrator only', function () {
        const clubId = ownedClub();
        callAs(admin, 'moderation.takeDown', 'club', clubId, 'Checking with the organizer.');
        assert.isFalse(isPublic(Clubs.collection, clubId));
        assert.equal(errorFrom(() => callAs(owner, 'moderation.restore', 'club', clubId)), 'not-authorized');
        callAs(admin, 'moderation.restore', 'club', clubId);
        assert.isTrue(isPublic(Clubs.collection, clubId));
        assert.notProperty(Clubs.collection.findOne(clubId), 'moderation');
      });

      it('will not take something down without saying why', function () {
        assert.equal(errorFrom(() => callAs(admin, 'moderation.takeDown', 'club', ownedClub(), '   ')), 'required');
      });
    });

    describe('bans', function () {
      it('is an administrator’s to give, with a reason, and never to themselves or another administrator', function () {
        assert.equal(errorFrom(() => callAs(owner, 'moderation.ban', stranger, 'spam')), 'not-authorized');
        assert.equal(errorFrom(() => callAs(admin, 'moderation.ban', stranger, '  ')), 'required');
        assert.equal(errorFrom(() => callAs(admin, 'moderation.ban', admin, 'oops')), 'not-allowed');
        assert.equal(errorFrom(() => callAs(admin, 'moderation.ban', makeUser({ admin: true }), 'rival')), 'not-allowed');
        assert.equal(errorFrom(() => callAs(admin, 'moderation.ban', 'nobody', 'spam')), 'not-found');
      });

      it('ends their sessions, takes down what they posted, and leaves imported listings alone', function () {
        const clubId = ownedClub();
        const eventId = ownedEvent();
        const imported = makeEvent({ owner: accountNameOf(owner), importedFrom: 'register' });
        Meteor.users.update(owner, { $set: { 'services.resume.loginTokens': [{ hashedToken: 'abc', when: new Date() }] } });

        callAs(admin, 'moderation.ban', owner, 'Posting adverts as events.');

        const account = Meteor.users.findOne(owner);
        assert.equal(account.banned.reason, 'Posting adverts as events.');
        assert.deepEqual(account.services.resume.loginTokens, []);
        assert.isFalse(isPublic(Clubs.collection, clubId));
        assert.isFalse(isPublic(Events.collection, eventId));
        assert.isTrue(isPublic(Events.collection, imported));
        assert.include(Events.collection.findOne(eventId).moderation.reason, 'suspended');
      });

      it('is lifted without putting the listings back', function () {
        const eventId = ownedEvent();
        callAs(admin, 'moderation.ban', owner, 'spam');
        callAs(admin, 'moderation.unban', owner);
        assert.notProperty(Meteor.users.findOne(owner), 'banned');
        assert.isFalse(isPublic(Events.collection, eventId));
      });
    });

    describe('a group’s shut door', function () {
      it('is the owner’s or an administrator’s to shut', function () {
        const clubId = ownedClub();
        callAs(member, 'profileClubs.add', clubId);
        [member, stranger, null].forEach(userId => {
          assert.include(['not-authorized', 'not-logged-in'], errorFrom(() => callAs(userId, 'Clubs.block', clubId, { userId: member })));
        });
        assert.isTrue(callAs(admin, 'Clubs.block', clubId, { userId: member }));
      });

      it('puts the person out, keeps them out by every door, and keeps them from its events', function () {
        const clubId = ownedClub({ visibility: 'private' });
        const token = callAs(owner, 'clubs.rotateInvite', clubId);
        const eventId = makeEvent({ eventID: Clubs.collection.findOne(clubId).clubID, goingCount: 0 });
        callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: token });
        assert.equal(Clubs.collection.findOne(clubId).memberCount, 1);

        callAs(owner, 'Clubs.block', clubId, { userId: member });

        assert.equal(ProfileClubs.collection.find({ clubId, userId: member }).count(), 0);
        assert.equal(Clubs.collection.findOne(clubId).memberCount, 0);
        assert.equal(errorFrom(() => callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: token })), 'not-allowed');
        assert.equal(errorFrom(() => callAs(member, 'eventSwipes.record', eventId, 'going', 'event')), 'not-found');
      });

      it('blocks a member of an anonymous group by handle, and never says who that is', function () {
        const clubId = ownedClub({ anonymous: true });
        callAs(member, 'profileClubs.add', clubId);
        const [row] = callAs(owner, 'clubs.members', clubId);
        assert.equal(row.handle, memberHandle(clubId, member));

        callAs(owner, 'Clubs.block', clubId, { handle: row.handle });

        assert.equal(ClubBlocks.collection.findOne({ clubId }).userId, member);
        const [blocked] = callAs(owner, 'Clubs.blocks', clubId);
        assert.equal(blocked.label, row.anonymousName);
        assert.hasAllKeys(blocked, ['_id', 'label', 'createdAt']);
        assert.equal(errorFrom(() => callAs(owner, 'Clubs.block', clubId, { handle: 'made-up-handle' })), 'not-found');
      });

      it('cannot be shut on the person who runs the group, and can be opened again', function () {
        const clubId = ownedClub();
        assert.equal(errorFrom(() => callAs(admin, 'Clubs.block', clubId, { userId: owner })), 'not-allowed');
        callAs(member, 'profileClubs.add', clubId);
        callAs(owner, 'Clubs.block', clubId, { userId: member });
        const [blocked] = callAs(owner, 'Clubs.blocks', clubId);
        assert.equal(errorFrom(() => callAs(stranger, 'Clubs.unblock', clubId, blocked._id)), 'not-authorized');
        callAs(owner, 'Clubs.unblock', clubId, blocked._id);
        assert.equal(callAs(member, 'profileClubs.add', clubId).status, 'joined');
      });
    });

    describe('owners and their own listings', function () {
      it('lets whoever posted an event call it off and put it back on, and nobody else', function () {
        const eventId = ownedEvent();
        assert.equal(errorFrom(() => callAs(stranger, 'Events.cancel', eventId, true)), 'not-authorized');
        assert.equal(callAs(owner, 'Events.cancel', eventId, true), 'canceled');
        assert.equal(Events.collection.findOne(eventId).cancellationStatus, 'canceled');
        assert.isTrue(isPublic(Events.collection, eventId), 'cancelled is marked, not hidden');
        assert.equal(callAs(admin, 'Events.cancel', eventId, false), 'scheduled');
      });

      it('lets an owner edit their group but not hand it to somebody else', function () {
        const clubId = ownedClub();
        const edit = { name: 'Renamed', owner: accountNameOf(stranger), description: 'Still here.', location: 'Kapaʻa', meetingTime: 'Thursdays at 6 PM' };
        assert.equal(errorFrom(() => callAs(stranger, 'Clubs.update', clubId, edit)), 'not-authorized');
        callAs(owner, 'Clubs.update', clubId, edit);
        const club = Clubs.collection.findOne(clubId);
        assert.equal(club.name, 'Renamed');
        assert.equal(club.owner, accountNameOf(owner));
        callAs(admin, 'Clubs.update', clubId, edit);
        assert.equal(Clubs.collection.findOne(clubId).owner, accountNameOf(stranger));
      });

      it('lets whoever posted an event edit it, and refuses a stranger', function () {
        const eventId = ownedEvent({ eventID: 0 });
        const edit = { eventID: 0, title: 'Retitled', date: new Date(Date.now() + 864e5), location: 'Hanalei' };
        assert.equal(errorFrom(() => callAs(stranger, 'Events.update', eventId, edit)), 'not-authorized');
        callAs(owner, 'Events.update', eventId, edit);
        assert.equal(Events.collection.findOne(eventId).title, 'Retitled');
      });
    });
  });
}
