/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from './Club';
import { ClubJoinRequests, JOIN_REQUEST_COOLDOWN_MS } from './ClubJoinRequests';
import { Events } from '../events/Events';
import { EventClubs } from '../events/EventClubs';
import { EventSwipes } from '../events/EventSwipes';
import { ProfileClubs } from '../profile/ProfileClubs';
import { AuditLog } from '../audit/AuditLog';
import { RecommendationInteractions } from '../recommendations/RecommendationData';
import { FRIEND_ACTIVITY_VISIBILITY } from '../privacy/FriendActivityPrivacy';
import { syncFriendActivityPrivacy } from '../privacy/friendActivitySync';
import { accountNameOf, canManageListing, isListingOwner, ownedListingSelector } from '../listing/ownership';
import { installAuditTrail } from '../../startup/server/auditTrail';
import {
  callAs,
  errorFrom,
  makeClub,
  makeEvent,
  makeUser,
  resetAll,
  resetRecommendations,
} from '../../startup/server/testFixtures';

/**
 * Private, anonymous, ask-first — and the counts that are all an anonymous
 * listing shows.
 *
 * The owner's decisions, which these hold the code to:
 *   - a group or an event can be private and/or anonymous, and every one of
 *     those can be switched either way by whoever runs it;
 *   - anonymous means NOBODY sees who is in it, the organizer included;
 *   - a sensitive listing is anonymous always, and that cannot be switched;
 *   - an event follows its host group until somebody sets it by hand.
 *
 * Nearly every test here is about a refusal, because that is the half that
 * rots. A privacy rule that stops holding fails silently: the page still
 * loads, the join still works, and the only symptom is a name on a screen it
 * should not be on. So each rule is tested from the side of the person it is
 * supposed to keep out.
 */
const { shareable, private: hidden } = FRIEND_ACTIVITY_VISIBILITY;

const DAY_MS = 24 * 60 * 60 * 1000;

if (Meteor.isServer) {
  describe('privacy of groups and events', function () {
    // Several accounts per test, and each one is a password hashed.
    this.timeout(15000);

    let owner;
    let admin;
    let member;
    let stranger;

    /** A group the way 'Clubs.insert' leaves one, owned by `owner`. */
    const ownedClub = (overrides = {}) => makeClub({ owner: accountNameOf(owner), memberCount: 0, ...overrides });
    /** An event that names `clubId` as its host and still follows it. */
    const hostedEvent = (clubId, overrides = {}) => makeEvent({
      eventID: Clubs.collection.findOne(clubId).clubID,
      privacyInherited: true,
      goingCount: 0,
      ...overrides,
    });
    const club = clubId => Clubs.collection.findOne(clubId);
    const event = eventId => Events.collection.findOne(eventId);
    const membershipsOf = (userId, clubId) => ProfileClubs.collection.find({ userId, clubId }).count();
    const requestOf = (userId, clubId) => ClubJoinRequests.collection.findOne({ userId, clubId });
    const share = userId => callAs(userId, 'Profiles.setFriendActivitySharing', true);

    beforeEach(function () {
      resetAll();
      resetRecommendations();
      ClubJoinRequests.collection.remove({});
      owner = makeUser();
      admin = makeUser({ admin: true });
      member = makeUser();
      stranger = makeUser();
    });

    describe('who a listing belongs to', function () {
      it('is the account whose name is on it, and an administrator may act for them', function () {
        const mine = club(ownedClub());
        assert.isTrue(isListingOwner(owner, mine));
        assert.isFalse(isListingOwner(stranger, mine));
        assert.isFalse(isListingOwner(admin, mine), 'an administrator manages it; they do not own it');
        assert.isTrue(canManageListing(admin, mine));
        assert.isFalse(canManageListing(stranger, mine));
      });

      /**
       * The register stamps the importing address on every record it brings
       * in. On a deployment where nobody holds that address, whoever signed
       * up with it first would have owned every imported group — its invite
       * link, its switches, its member list.
       */
      it('is nobody, for an imported listing, whatever name the import stamped on it', function () {
        const imported = ownedClub({ importedFrom: 'kauai-register' });
        callAs(member, 'profileClubs.add', imported);

        assert.isFalse(isListingOwner(owner, club(imported)));
        assert.isFalse(canManageListing(owner, club(imported)));
        assert.isTrue(canManageListing(admin, club(imported)), 'an administrator still looks after it');
        assert.equal(errorFrom(() => callAs(owner, 'Clubs.setPrivacy', imported, { visibility: 'private' })), 'not-authorized');
        // These two load the group through a projection, which has to carry
        // the field that says it was imported.
        assert.equal(errorFrom(() => callAs(owner, 'clubs.members', imported)), 'not-authorized');
        assert.equal(errorFrom(() => callAs(owner, 'clubs.rotateInvite', imported)), 'not-authorized');
        assert.notProperty(club(imported), 'inviteToken');

        assert.deepEqual(ownedListingSelector(owner), { owner: accountNameOf(owner), importedFrom: { $exists: false } });
        assert.equal(Clubs.collection.find(ownedListingSelector(owner)).count(), 0);
      });

      /**
       * Most of the register was imported and has no owner, and a signed-out
       * caller has no name. `undefined === undefined` would hand every
       * imported group to every visitor.
       */
      it('never matches a listing with no owner, or a caller with no account', function () {
        const imported = club(makeClub({ owner: 'register' }));
        Clubs.collection.update(imported._id, { $unset: { owner: '' } }, { bypassCollection2: true });
        assert.isFalse(isListingOwner(stranger, club(imported._id)));
        assert.isFalse(isListingOwner(null, club(imported._id)));
        assert.isFalse(isListingOwner(undefined, club(ownedClub())));
        assert.isFalse(canManageListing(null, club(imported._id)));
      });
    });

    describe('Clubs.setPrivacy', function () {
      it('is for the person who runs the group, or an administrator, and nobody else', function () {
        const clubId = ownedClub();
        callAs(member, 'profileClubs.add', clubId);

        assert.equal(errorFrom(() => callAs(null, 'Clubs.setPrivacy', clubId, { visibility: 'private' })), 'not-logged-in');
        assert.equal(errorFrom(() => callAs(member, 'Clubs.setPrivacy', clubId, { visibility: 'private' })), 'not-authorized');
        assert.equal(errorFrom(() => callAs(stranger, 'Clubs.setPrivacy', clubId, { anonymous: true })), 'not-authorized');
        assert.notEqual(club(clubId).visibility, 'private');
        assert.isNotOk(club(clubId).anonymous);

        assert.equal(callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private' }).visibility, 'private');
        assert.equal(callAs(admin, 'Clubs.setPrivacy', clubId, { visibility: 'public' }).visibility, 'public');
        assert.equal(club(clubId).visibility, 'public');
      });

      it('takes public or private and nothing else', function () {
        const clubId = ownedClub();
        ['members', 'unlisted', '', 1].forEach(visibility => {
          assert.isOk(errorFrom(() => callAs(owner, 'Clubs.setPrivacy', clubId, { visibility })), `${visibility}`);
        });
        assert.isOk(errorFrom(() => callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: 'yes' })));
        assert.isOk(errorFrom(() => callAs(owner, 'Clubs.setPrivacy', clubId, { inviteToken: 'mine' })));
      });

      it('changes only what it was sent, and every switch goes both ways', function () {
        const clubId = ownedClub();
        assert.deepEqual(
          callAs(owner, 'Clubs.setPrivacy', clubId, { approveMembers: true }),
          { visibility: 'public', anonymous: false, approveMembers: true, anonymousLocked: false },
        );
        assert.deepEqual(
          callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private' }),
          { visibility: 'private', anonymous: false, approveMembers: true, anonymousLocked: false },
        );
        callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: true });
        assert.deepEqual(
          callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'public', anonymous: false }),
          { visibility: 'public', anonymous: false, approveMembers: false, anonymousLocked: false },
        );
        const stored = club(clubId);
        assert.equal(stored.visibility, 'public');
        assert.isFalse(stored.anonymous);
      });

      it('sent nothing, says how things stand and writes nothing', function () {
        const clubId = ownedClub({ visibility: 'private', anonymous: true });
        const before = club(clubId);
        assert.deepEqual(
          callAs(owner, 'Clubs.setPrivacy', clubId, {}),
          { visibility: 'private', anonymous: true, approveMembers: false, anonymousLocked: false },
        );
        assert.deepEqual(club(clubId), before);
      });

      /**
       * The one switch that does not move. A recovery meeting whose organizer
       * unticked a box is still a recovery meeting.
       */
      it('refuses to take anonymity off a sensitive group, whoever asks', function () {
        const clubId = ownedClub({ categories: ['support_group'] });
        assert.equal(errorFrom(() => callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: false })), 'anonymous-locked');
        assert.equal(errorFrom(() => callAs(admin, 'Clubs.setPrivacy', clubId, { anonymous: false })), 'anonymous-locked');

        const byTag = ownedClub({ tags: ['sober'] });
        assert.equal(errorFrom(() => callAs(owner, 'Clubs.setPrivacy', byTag, { anonymous: false })), 'anonymous-locked');

        // Everything else about it is still the owner's to change, and the
        // answer tells the page the switch is on and stuck.
        assert.deepEqual(
          callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private' }),
          { visibility: 'private', anonymous: true, approveMembers: false, anonymousLocked: true },
        );
        assert.isTrue(callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: true }).anonymous);
      });

      /** Approving a request is somebody reading a name. */
      it('turns asking first off whenever the group is anonymous', function () {
        const clubId = ownedClub();
        callAs(owner, 'Clubs.setPrivacy', clubId, { approveMembers: true });
        assert.isFalse(callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: true }).approveMembers, 'turned anonymous');
        assert.isFalse(club(clubId).approveMembers);

        assert.isFalse(callAs(owner, 'Clubs.setPrivacy', clubId, { approveMembers: true }).approveMembers, 'asked for while anonymous');
        assert.isFalse(club(clubId).approveMembers);

        const both = ownedClub();
        assert.isFalse(callAs(owner, 'Clubs.setPrivacy', both, { anonymous: true, approveMembers: true }).approveMembers, 'both at once');
        assert.isFalse(club(both).approveMembers);

        const sensitive = ownedClub({ categories: ['lgbtq'] });
        assert.isFalse(callAs(owner, 'Clubs.setPrivacy', sensitive, { approveMembers: true }).approveMembers, 'sensitive');
        assert.isNotOk(club(sensitive).approveMembers);
      });

      it('lets go of the requests it was holding when it stops taking them', function () {
        const anonymous = ownedClub({ approveMembers: true });
        const open = ownedClub({ approveMembers: true });
        callAs(member, 'profileClubs.add', anonymous);
        callAs(member, 'profileClubs.add', open);
        callAs(stranger, 'profileClubs.add', open);
        callAs(owner, 'clubs.respondToRequest', requestOf(stranger, open)._id, false);

        callAs(owner, 'Clubs.setPrivacy', anonymous, { anonymous: true });
        assert.isUndefined(requestOf(member, anonymous), 'a name an anonymous group may not keep');

        callAs(owner, 'Clubs.setPrivacy', open, { approveMembers: false });
        assert.isUndefined(requestOf(member, open));
        assert.equal(requestOf(stranger, open).status, 'declined', 'an answer already given is not the group’s to forget');
      });

      it('gives a group its invite link the moment it becomes private, and keeps it', function () {
        const clubId = ownedClub();
        assert.notProperty(club(clubId), 'inviteToken');
        callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private' });
        const { inviteToken } = club(clubId);
        assert.isString(inviteToken);
        assert.isAtLeast(inviteToken.length, 40);

        callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'public' });
        callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private' });
        assert.equal(club(clubId).inviteToken, inviteToken, 'links already sent still work');
      });

      it('never hands the invite link back in its answer', function () {
        const clubId = ownedClub();
        assert.notProperty(callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private' }), 'inviteToken');
      });

      describe('and the events the group hosts', function () {
        it('takes the events that still follow it along, both settings', function () {
          const clubId = ownedClub();
          const following = hostedEvent(clubId);
          callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private', anonymous: true });
          assert.include(event(following), { visibility: 'private', anonymous: true, privacyInherited: true });

          callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'public' });
          assert.include(event(following), { visibility: 'public', anonymous: true });
        });

        it('leaves alone an event whose privacy somebody set by hand', function () {
          const clubId = ownedClub();
          const following = hostedEvent(clubId);
          const byHand = hostedEvent(clubId);
          callAs(owner, 'Events.setPrivacy', byHand, { visibility: 'public' });

          callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private' });
          assert.equal(event(following).visibility, 'private');
          assert.equal(event(byHand).visibility, 'public', 'a decision made on purpose is not undone by the group');
        });

        /**
         * A link row says a group is one of an event's hosts. If that were
         * enough, an event linked to two groups could be taken off the wall
         * by either. 'Clubs.organizeEvent' no longer lets a stranger write
         * one, so it is written straight in, as ingestion and an editor do:
         * the cascade must not trust a link however it got there.
         */
        it('does not reach an event that the group is merely linked to', function () {
          const theirClub = ownedClub();
          const theirEvent = hostedEvent(theirClub);
          const mine = makeClub({ owner: accountNameOf(stranger) });
          EventClubs.collection.insert({ clubId: mine, eventId: theirEvent, createdAt: new Date() });

          callAs(stranger, 'Clubs.setPrivacy', mine, { visibility: 'private', anonymous: true });
          assert.notEqual(event(theirEvent).visibility, 'private');
          assert.isNotOk(event(theirEvent).anonymous);
        });
      });

      describe('and what friends are shown', function () {
        let clubId;
        let eventId;

        beforeEach(function () {
          clubId = ownedClub();
          eventId = hostedEvent(clubId);
          share(member);
          callAs(member, 'profileClubs.add', clubId);
          callAs(member, 'eventSwipes.record', clubId, 'joined', 'club');
          callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        });

        const rowsOf = userId => [
          ProfileClubs.collection.findOne({ userId, clubId }),
          EventSwipes.collection.findOne({ userId, eventId: clubId }),
          EventSwipes.collection.findOne({ userId, eventId }),
        ].map(row => row.friendActivityVisibility);
        const rows = () => rowsOf(member);
        /** Shares, joins, swipes the join and says Going: the three rows. */
        const takePart = userId => {
          share(userId);
          callAs(userId, 'profileClubs.add', clubId);
          callAs(userId, 'eventSwipes.record', clubId, 'joined', 'club');
          callAs(userId, 'eventSwipes.record', eventId, 'going', 'event');
        };

        it('withdraws every member’s and attendee’s row the moment the group turns anonymous', function () {
          assert.deepEqual(rows(), [shareable, shareable, shareable], 'shared, to begin with');
          callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: true });
          assert.deepEqual(rows(), [hidden, hidden, hidden]);
        });

        it('withdraws the RSVPs to an event set by hand as well, because its host is still anonymous', function () {
          callAs(owner, 'Events.setPrivacy', eventId, { visibility: 'public' });
          callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: true });
          assert.deepEqual(rows(), [hidden, hidden, hidden]);
        });

        /**
         * The member list will not name the people who joined while there
         * was no list ('clubs.members'). This was the way round it: switch
         * anonymity off, and every one of them who shares went back into
         * their friends' feeds, by name, beside the group's id — and the
         * person who runs the group can be one of those friends. So the
         * switch still moves, and still does not reach backwards. That holds
         * for whoever was already in when the group turned anonymous, too:
         * they were in it while it was, and one date cannot tell them apart.
         */
        it('gives nobody back when the owner switches it off again, and shows only who takes part from then on', function () {
          callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: true });
          takePart(stranger);
          callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: false });
          assert.deepEqual(rowsOf(stranger), [hidden, hidden, hidden], 'joined because nobody could see');
          assert.deepEqual(rows(), [hidden, hidden, hidden], 'was in it while nobody could see');

          // A tick on, so what follows is dated after the moment it ended.
          Meteor._sleepForMs(3);
          const newcomer = makeUser();
          takePart(newcomer);
          assert.deepEqual(rowsOf(newcomer), [shareable, shareable, shareable]);

          // None of the ways a standing row is judged again carries it across:
          // a second "Join", a second "Going", sharing switched off and on,
          // and the next change to the group.
          takePart(stranger);
          callAs(stranger, 'Profiles.setFriendActivitySharing', false);
          callAs(stranger, 'Profiles.setFriendActivitySharing', true);
          callAs(owner, 'Clubs.setPrivacy', clubId, { approveMembers: true });
          assert.deepEqual(rowsOf(stranger), [hidden, hidden, hidden]);
          assert.deepEqual(rowsOf(newcomer), [shareable, shareable, shareable], 'and an ordinary row stays one');
        });

        it('keeps the same promise when the anonymity ends by a tag removed', function () {
          callAs(member, 'clubs.addTag', clubId, 'recovery');
          takePart(stranger);
          callAs(owner, 'clubs.removeTag', clubId, 'recovery');
          assert.deepEqual(rowsOf(stranger), [hidden, hidden, hidden]);
          assert.deepEqual(rows(), [hidden, hidden, hidden]);
        });

        it('stamps a new join and a new RSVP private while the group is anonymous', function () {
          callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: true });
          share(stranger);
          callAs(stranger, 'profileClubs.add', clubId);
          callAs(stranger, 'eventSwipes.record', eventId, 'going', 'event');
          assert.equal(ProfileClubs.collection.findOne({ userId: stranger, clubId }).friendActivityVisibility, hidden);
          assert.equal(EventSwipes.collection.findOne({ userId: stranger, eventId }).friendActivityVisibility, hidden);
        });

        /**
         * A shared row goes to friends whole: who, and the _id of what. For a
         * private group that is the fact that it exists, that this person is
         * in it, and the id every method about it is called with — sent to
         * people who were never invited.
         */
        it('withdraws every row the moment the group turns private, and gives them back when it opens', function () {
          callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private' });
          assert.deepEqual(rows(), [hidden, hidden, hidden]);
          callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'public' });
          assert.deepEqual(rows(), [shareable, shareable, shareable]);
        });

        it('keeps the RSVPs to a private group’s meeting from friends even when the meeting was made public', function () {
          callAs(owner, 'Events.setPrivacy', eventId, { visibility: 'public' });
          callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private' });
          assert.deepEqual(rows(), [hidden, hidden, hidden], 'going says they are in the group');
        });

        it('stamps a new join and a new RSVP private while the group is private', function () {
          callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private' });
          share(stranger);
          callAs(stranger, 'profileClubs.add', clubId, {}, { inviteToken: club(clubId).inviteToken });
          callAs(stranger, 'eventSwipes.record', clubId, 'joined', 'club');
          callAs(stranger, 'eventSwipes.record', eventId, 'going', 'event');
          assert.equal(ProfileClubs.collection.findOne({ userId: stranger, clubId }).friendActivityVisibility, hidden);
          assert.equal(EventSwipes.collection.findOne({ userId: stranger, eventId: clubId }).friendActivityVisibility, hidden);
          assert.equal(EventSwipes.collection.findOne({ userId: stranger, eventId }).friendActivityVisibility, hidden);
        });

        it('treats a visibility it does not know as private', function () {
          Events.collection.update(eventId, { $set: { visibility: 'unlisted' } });
          callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
          assert.equal(EventSwipes.collection.findOne({ userId: member, eventId }).friendActivityVisibility, hidden);
        });
      });
    });

    describe('Events.setPrivacy', function () {
      it('is for whoever posted it, whoever runs its group, or an administrator', function () {
        const clubId = ownedClub();
        const poster = makeUser();
        const eventId = hostedEvent(clubId, { owner: accountNameOf(poster) });
        callAs(member, 'profileClubs.add', clubId);

        assert.equal(errorFrom(() => callAs(null, 'Events.setPrivacy', eventId, { visibility: 'private' })), 'not-logged-in');
        assert.equal(errorFrom(() => callAs(member, 'Events.setPrivacy', eventId, { visibility: 'private' })), 'not-authorized');
        assert.equal(errorFrom(() => callAs(stranger, 'Events.setPrivacy', eventId, { anonymous: true })), 'not-authorized');
        assert.notEqual(event(eventId).visibility, 'private');

        assert.equal(callAs(poster, 'Events.setPrivacy', eventId, { visibility: 'private' }).visibility, 'private');
        assert.equal(callAs(owner, 'Events.setPrivacy', eventId, { visibility: 'public' }).visibility, 'public');
        assert.isTrue(callAs(admin, 'Events.setPrivacy', eventId, { anonymous: true }).anonymous);
      });

      it('gives no say to somebody whose group is only linked to it', function () {
        const eventId = hostedEvent(ownedClub());
        const mine = makeClub({ owner: accountNameOf(stranger) });
        EventClubs.collection.insert({ clubId: mine, eventId, createdAt: new Date() });
        assert.equal(errorFrom(() => callAs(stranger, 'Events.setPrivacy', eventId, { visibility: 'private' })), 'not-authorized');
      });

      /**
       * A member may post for a private group. The event carries the group's
       * name, and putting that in front of everyone is for the person who
       * runs the group.
       */
      it('does not let whoever posted for a private group make the event public, unless they run the group', function () {
        const clubId = ownedClub({ visibility: 'private' });
        const poster = makeUser();
        const eventId = hostedEvent(clubId, { owner: accountNameOf(poster), visibility: 'private' });

        assert.equal(errorFrom(() => callAs(poster, 'Events.setPrivacy', eventId, { visibility: 'public' })), 'private-host');
        assert.equal(event(eventId).visibility, 'private');
        assert.isTrue(event(eventId).privacyInherited, 'a refusal decides nothing');

        // Everything that does not widen it is still theirs to change.
        assert.isTrue(callAs(poster, 'Events.setPrivacy', eventId, { anonymous: true }).anonymous);
        assert.equal(callAs(poster, 'Events.setPrivacy', eventId, { visibility: 'private' }).visibility, 'private');

        assert.equal(callAs(owner, 'Events.setPrivacy', eventId, { visibility: 'public' }).visibility, 'public');
        assert.isNull(
          errorFrom(() => callAs(poster, 'Events.setPrivacy', eventId, { visibility: 'public', anonymous: false })),
          'already public, by the owner’s hand: saying so again widens nothing',
        );

        callAs(owner, 'Events.setPrivacy', eventId, { visibility: 'private' });
        assert.equal(callAs(admin, 'Events.setPrivacy', eventId, { visibility: 'public' }).visibility, 'public');
      });

      it('lets whoever posted for a public group make their event public again', function () {
        const poster = makeUser();
        const eventId = hostedEvent(ownedClub(), { owner: accountNameOf(poster), visibility: 'private' });
        assert.equal(callAs(poster, 'Events.setPrivacy', eventId, { visibility: 'public' }).visibility, 'public');
      });

      it('stops the event following its group, and says how things stand when sent nothing', function () {
        const eventId = hostedEvent(ownedClub());
        assert.deepEqual(
          callAs(owner, 'Events.setPrivacy', eventId, {}),
          { visibility: 'public', anonymous: false, anonymousLocked: false },
        );
        assert.isTrue(event(eventId).privacyInherited, 'looking is not deciding');

        assert.deepEqual(
          callAs(owner, 'Events.setPrivacy', eventId, { anonymous: true }),
          { visibility: 'public', anonymous: true, anonymousLocked: false },
        );
        assert.include(event(eventId), { visibility: 'public', anonymous: true, privacyInherited: false });
      });

      /** The schema still allows values the product no longer writes. */
      it('reads any visibility it does not know as private', function () {
        const eventId = hostedEvent(ownedClub(), { visibility: 'unlisted' });
        assert.equal(callAs(owner, 'Events.setPrivacy', eventId, {}).visibility, 'private');
      });

      it('cannot take anonymity off a sensitive event, judged with the groups that host it', function () {
        const own = hostedEvent(ownedClub(), { categories: ['grief'] });
        assert.equal(errorFrom(() => callAs(owner, 'Events.setPrivacy', own, { anonymous: false })), 'anonymous-locked');

        // Sensitive only by a tag on the host, which no event ever copies.
        const byHost = hostedEvent(ownedClub({ tags: ['recovery'] }));
        assert.equal(errorFrom(() => callAs(owner, 'Events.setPrivacy', byHost, { anonymous: false })), 'anonymous-locked');
        assert.deepEqual(
          callAs(owner, 'Events.setPrivacy', byHost, { visibility: 'private' }),
          { visibility: 'private', anonymous: true, anonymousLocked: true },
        );
      });

      it('cannot take anonymity off an event while the group that hosts it is anonymous', function () {
        const clubId = ownedClub({ anonymous: true });
        const eventId = hostedEvent(clubId, { anonymous: true });
        assert.equal(errorFrom(() => callAs(owner, 'Events.setPrivacy', eventId, { anonymous: false })), 'anonymous-locked');

        callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: false });
        assert.isFalse(callAs(owner, 'Events.setPrivacy', eventId, { anonymous: false }).anonymous);
      });

      it('withdraws the RSVPs from friends the moment the event turns anonymous', function () {
        const eventId = hostedEvent(ownedClub());
        share(member);
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        const shown = () => EventSwipes.collection.findOne({ userId: member, eventId }).friendActivityVisibility;
        assert.equal(shown(), shareable);
        callAs(owner, 'Events.setPrivacy', eventId, { anonymous: true });
        assert.equal(shown(), hidden);
      });

      /** The group's rule, for the event's own switch: see 'and what friends are shown'. */
      it('keeps hidden whoever said Going while it was anonymous, after it is switched off again', function () {
        const eventId = hostedEvent(ownedClub());
        const shown = userId => EventSwipes.collection.findOne({ userId, eventId }).friendActivityVisibility;
        callAs(owner, 'Events.setPrivacy', eventId, { anonymous: true });
        share(member);
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');

        callAs(owner, 'Events.setPrivacy', eventId, { anonymous: false });
        assert.instanceOf(event(eventId).anonymousUntil, Date);
        assert.equal(shown(member), hidden);
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        assert.equal(shown(member), hidden, 'and saying it a second time is not a new RSVP');

        Meteor._sleepForMs(3);
        share(stranger);
        callAs(stranger, 'eventSwipes.record', eventId, 'going', 'event');
        callAs(owner, 'Events.setPrivacy', eventId, { visibility: 'public' });
        assert.equal(shown(stranger), shareable, 'an RSVP made afterwards is an ordinary one');
        assert.equal(shown(member), hidden);

        // Taking it back and saying it again IS a new RSVP, made in the open.
        callAs(member, 'eventSwipes.remove', eventId, 'rsvp_canceled');
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        assert.equal(shown(member), shareable);
      });

      it('leaves no mark on an event that was never anonymous', function () {
        const eventId = hostedEvent(ownedClub());
        callAs(owner, 'Events.setPrivacy', eventId, { visibility: 'private' });
        callAs(owner, 'Events.setPrivacy', eventId, { visibility: 'public', anonymous: false });
        assert.notProperty(event(eventId), 'anonymousUntil');
      });

      it('withdraws them the moment the event turns private, and gives them back when it opens', function () {
        const eventId = hostedEvent(ownedClub());
        share(member);
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        const shown = () => EventSwipes.collection.findOne({ userId: member, eventId }).friendActivityVisibility;
        callAs(owner, 'Events.setPrivacy', eventId, { visibility: 'private' });
        assert.equal(shown(), hidden);
        callAs(owner, 'Events.setPrivacy', eventId, { visibility: 'public' });
        assert.equal(shown(), shareable);
      });
    });

    describe('making a listing', function () {
      const clubForm = {
        name: 'Thursday Circle', description: 'We meet.', location: 'Kapaʻa', meetingTime: 'Thursdays 6pm',
      };
      const eventForm = clubId => ({
        eventID: club(clubId).clubID, title: 'This Thursday', date: new Date(Date.now() + DAY_MS), location: 'Kapaʻa',
      });

      it('makes a group public, named, and counted from zero when nothing is said', function () {
        const made = club(callAs(owner, 'Clubs.insert', clubForm));
        assert.include(made, { visibility: 'public', anonymous: false, approveMembers: false, memberCount: 0 });
        assert.notProperty(made, 'inviteToken', 'a public group has nothing for a link to open');
      });

      it('makes a group private with its invite link, anonymous, or ask-first, as its owner chose', function () {
        const made = club(callAs(owner, 'Clubs.insert', { ...clubForm, visibility: 'private', approveMembers: true }));
        assert.include(made, { visibility: 'private', anonymous: false, approveMembers: true });
        assert.isAtLeast(made.inviteToken.length, 40);

        const anonymous = club(callAs(owner, 'Clubs.insert', { ...clubForm, anonymous: true, approveMembers: true }));
        assert.include(anonymous, { anonymous: true, approveMembers: false });

        const sensitive = club(callAs(owner, 'Clubs.insert', { ...clubForm, categories: ['Recovery'], approveMembers: true }));
        assert.isFalse(sensitive.approveMembers, 'sensitive is anonymous, and anonymous never asks first');

        assert.isOk(errorFrom(() => callAs(owner, 'Clubs.insert', { ...clubForm, visibility: 'unlisted' })));
      });

      it('gives an event its host group’s privacy, and marks it as still following', function () {
        const clubId = ownedClub({ visibility: 'private', anonymous: true });
        const made = event(callAs(owner, 'Events.insert', eventForm(clubId)));
        assert.include(made, { visibility: 'private', anonymous: true, privacyInherited: true, goingCount: 0 });

        const open = event(callAs(owner, 'Events.insert', eventForm(ownedClub())));
        assert.include(open, { visibility: 'public', anonymous: false, privacyInherited: true });
      });

      it('lets the poster override it, and the half they did not mention still starts from the host', function () {
        const clubId = ownedClub({ visibility: 'private', anonymous: true });
        const publicOne = event(callAs(owner, 'Events.insert', { ...eventForm(clubId), visibility: 'public' }));
        assert.include(publicOne, { visibility: 'public', anonymous: true, privacyInherited: false });

        const named = event(callAs(owner, 'Events.insert', { ...eventForm(clubId), anonymous: false }));
        assert.include(named, { visibility: 'private', anonymous: false, privacyInherited: false });

        callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'public' });
        assert.equal(event(named._id).visibility, 'private', 'set by hand, so the group no longer reaches it');
      });

      it('makes an event with no host public, following nothing', function () {
        const made = event(callAs(owner, 'Events.insert', { ...eventForm(ownedClub()), eventID: 0 }));
        assert.include(made, { visibility: 'public', anonymous: false, privacyInherited: false });
      });

      /**
       * An event copies its host's name, and group numbers count up from one.
       * Posting against each number in turn would otherwise read out the name
       * of every private group there is.
       */
      it('lets only its own people post an event for a private group', function () {
        const clubId = ownedClub({ visibility: 'private', inviteToken: 'a-token-that-is-long-enough-to-look-real-0123' });
        assert.equal(errorFrom(() => callAs(stranger, 'Events.insert', eventForm(clubId))), 'not-a-member');
        assert.equal(Events.collection.find().count(), 0);

        callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: club(clubId).inviteToken });
        assert.isString(callAs(member, 'Events.insert', eventForm(clubId)));
        assert.isString(callAs(owner, 'Events.insert', eventForm(clubId)));
        assert.isString(callAs(admin, 'Events.insert', eventForm(clubId)));
      });

      /**
       * The guard above keeps strangers from reading a private group's name
       * off their own listings. This one keeps a member from printing it on
       * the public wall: "the owner can override" is the group's owner.
       */
      it('does not let a member post a private group’s event as public, and lets the person who runs it', function () {
        const clubId = ownedClub({ visibility: 'private', inviteToken: 'a-token-that-is-long-enough-to-look-real-4567' });
        callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: club(clubId).inviteToken });

        assert.equal(errorFrom(() => callAs(member, 'Events.insert', { ...eventForm(clubId), visibility: 'public' })), 'private-host');
        assert.equal(Events.collection.find().count(), 0, 'nothing was made');

        const theirs = event(callAs(member, 'Events.insert', { ...eventForm(clubId), anonymous: true }));
        assert.include(theirs, { visibility: 'private', anonymous: true }, 'the half they did not mention starts from the host');
        assert.equal(event(callAs(member, 'Events.insert', { ...eventForm(clubId), visibility: 'private' })).visibility, 'private');

        assert.equal(event(callAs(owner, 'Events.insert', { ...eventForm(clubId), visibility: 'public' })).visibility, 'public');
        assert.equal(event(callAs(admin, 'Events.insert', { ...eventForm(clubId), visibility: 'public' })).visibility, 'public');
      });

      it('lets anyone post a public event under a public group', function () {
        const made = event(callAs(stranger, 'Events.insert', { ...eventForm(ownedClub()), visibility: 'public' }));
        assert.equal(made.visibility, 'public');
      });
    });

    /**
     * A link row is not a label. The members of a hosting group are sent the
     * event even when it is private, and an RSVP is judged with every host.
     */
    describe('Clubs.organizeEvent', function () {
      const link = (clubId, eventId) => ({ clubID: club(clubId).clubID, eventID: eventId });
      const links = (clubId, eventId) => EventClubs.collection.find({ clubId, eventId }).count();

      it('does not let a stranger link their group to a private event, which would send it to them', function () {
        const eventId = hostedEvent(ownedClub({ visibility: 'private' }), { visibility: 'private' });
        const mine = makeClub({ owner: accountNameOf(stranger) });
        callAs(stranger, 'profileClubs.add', mine);

        assert.equal(errorFrom(() => callAs(stranger, 'Clubs.organizeEvent', link(mine, eventId))), 'not-authorized');
        assert.equal(links(mine, eventId), 0);
      });

      it('does not let a stranger link an anonymous group to somebody else’s event', function () {
        const eventId = hostedEvent(ownedClub());
        share(member);
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        const anonymous = makeClub({ owner: accountNameOf(stranger), anonymous: true });

        assert.equal(errorFrom(() => callAs(stranger, 'Clubs.organizeEvent', link(anonymous, eventId))), 'not-authorized');
        assert.equal(links(anonymous, eventId), 0);
        assert.isFalse(callAs(owner, 'Events.setPrivacy', eventId, {}).anonymousLocked, 'the event is still its owner’s to decide');
        assert.equal(EventSwipes.collection.findOne({ userId: member, eventId }).friendActivityVisibility, shareable);
      });

      /**
       * Even a public group and a public event. The group can turn anonymous,
       * or be tagged 'recovery' by any member, after the link is made, and
       * the event would follow it.
       */
      it('does not let the group’s side link to an event it has no say over, even when both are public', function () {
        const eventId = hostedEvent(ownedClub());
        const mine = makeClub({ owner: accountNameOf(stranger) });
        assert.equal(errorFrom(() => callAs(stranger, 'Clubs.organizeEvent', link(mine, eventId))), 'not-authorized');
        assert.equal(errorFrom(() => callAs(null, 'Clubs.organizeEvent', link(mine, eventId))), 'not-logged-in');
        assert.equal(links(mine, eventId), 0);
      });

      it('lets whoever posted the event, whoever runs its group, or an administrator give it a host', function () {
        const poster = makeUser();
        const eventId = hostedEvent(ownedClub(), { owner: accountNameOf(poster) });
        const [first, second, third] = [makeClub(), makeClub(), makeClub()];

        assert.isString(callAs(poster, 'Clubs.organizeEvent', link(first, eventId)));
        assert.isString(callAs(owner, 'Clubs.organizeEvent', link(second, eventId)));
        assert.isString(callAs(admin, 'Clubs.organizeEvent', link(third, eventId)));
        assert.equal(EventClubs.collection.find({ eventId }).count(), 3);

        const again = callAs(poster, 'Clubs.organizeEvent', link(first, eventId));
        assert.equal(links(first, eventId), 1, 'said twice, linked once');
        assert.equal(again, EventClubs.collection.findOne({ clubId: first, eventId })._id);
      });

      /** The same rule 'Events.insert' holds: a private group is named only
          by its own people, or its number would read out whether it exists
          and whether it is anonymous. */
      it('does not let an event be linked to a private group its poster is not in', function () {
        const privateClub = ownedClub({ visibility: 'private', anonymous: true, inviteToken: 'a-token-that-is-long-enough-to-look-real-8901' });
        const eventId = makeEvent({ owner: accountNameOf(stranger) });

        assert.equal(errorFrom(() => callAs(stranger, 'Clubs.organizeEvent', link(privateClub, eventId))), 'not-a-member');
        assert.equal(links(privateClub, eventId), 0);
        assert.isFalse(callAs(stranger, 'Events.setPrivacy', eventId, {}).anonymousLocked);

        callAs(stranger, 'profileClubs.add', privateClub, {}, { inviteToken: club(privateClub).inviteToken });
        assert.isString(callAs(stranger, 'Clubs.organizeEvent', link(privateClub, eventId)));
      });

      it('refuses an event that is not there', function () {
        assert.equal(errorFrom(() => callAs(admin, 'Clubs.organizeEvent', link(ownedClub(), 'no-such-event'))), 'event-not-found');
      });
    });

    /**
     * Holding a private listing's _id used to be enough to RSVP to it: a
     * former member holds it, and so does anyone a link was once shown to.
     */
    describe('swiping on a private listing', function () {
      let clubId;
      let eventId;

      beforeEach(function () {
        clubId = ownedClub({ visibility: 'private', inviteToken: 'a-token-that-is-long-enough-to-look-real-2345' });
        eventId = hostedEvent(clubId, { visibility: 'private' });
      });

      it('answers a stranger exactly as it answers for a listing that is not there, and counts nothing', function () {
        const thrownBy = fn => {
          try {
            fn();
            return {};
          } catch (error) {
            return error;
          }
        };
        const missing = thrownBy(() => callAs(stranger, 'eventSwipes.record', 'no-such-event', 'going', 'event'));
        const refused = thrownBy(() => callAs(stranger, 'eventSwipes.record', eventId, 'going', 'event'));
        assert.equal(refused.error, 'not-found');
        assert.deepEqual([refused.error, refused.reason], [missing.error, missing.reason], 'not an oracle for which ids are real');

        assert.equal(errorFrom(() => callAs(stranger, 'eventSwipes.record', eventId, 'passed', 'event')), 'not-found');
        assert.equal(errorFrom(() => callAs(stranger, 'eventSwipes.record', clubId, 'passed', 'club')), 'not-found');
        assert.equal(event(eventId).goingCount, 0);
        assert.equal(EventSwipes.collection.find({ userId: stranger }).count(), 0);
      });

      it('lets in the people the event is sent to: members of a group that hosts it, by either link', function () {
        callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: club(clubId).inviteToken });
        assert.isString(callAs(member, 'eventSwipes.record', eventId, 'going', 'event'));
        assert.isString(callAs(member, 'eventSwipes.record', clubId, 'joined', 'club'));

        const linked = makeClub();
        const guest = makeUser();
        callAs(guest, 'profileClubs.add', linked);
        assert.equal(errorFrom(() => callAs(guest, 'eventSwipes.record', eventId, 'going', 'event')), 'not-found');
        callAs(owner, 'Clubs.organizeEvent', { clubID: club(linked).clubID, eventID: eventId });
        assert.isString(callAs(guest, 'eventSwipes.record', eventId, 'going', 'event'));
        assert.equal(event(eventId).goingCount, 2);
      });

      it('lets in whoever runs it, who may never have joined their own group', function () {
        assert.isString(callAs(owner, 'eventSwipes.record', eventId, 'going', 'event'));
        assert.isString(callAs(admin, 'eventSwipes.record', eventId, 'going', 'event'));
        const poster = makeUser();
        const theirs = makeEvent({ owner: accountNameOf(poster), visibility: 'private', goingCount: 0 });
        assert.isString(callAs(poster, 'eventSwipes.record', theirs, 'going', 'event'));
      });

      it('still lets somebody who has left take back the RSVP they made', function () {
        callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: club(clubId).inviteToken });
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        callAs(member, 'profileClubs.remove', clubId);

        assert.equal(errorFrom(() => callAs(member, 'eventSwipes.record', eventId, 'going', 'event')), 'not-found');
        callAs(member, 'eventSwipes.remove', eventId, 'rsvp_canceled');
        assert.equal(event(eventId).goingCount, 0);
      });
    });

    describe('profileClubs.add', function () {
      const TOKEN = 'an-invite-token-long-enough-to-look-real-0123';

      it('joins a public group, and says so', function () {
        const clubId = ownedClub();
        const answer = callAs(member, 'profileClubs.add', clubId);
        assert.equal(answer.status, 'joined');
        assert.equal(answer.membershipId, ProfileClubs.collection.findOne({ userId: member, clubId })._id);
        assert.deepEqual(Object.keys(answer).sort(), ['membershipId', 'status']);
      });

      it('answers a second join with the membership that is already there', function () {
        const clubId = ownedClub();
        const first = callAs(member, 'profileClubs.add', clubId);
        assert.deepEqual(callAs(member, 'profileClubs.add', clubId), first);
        assert.equal(membershipsOf(member, clubId), 1);
        assert.equal(club(clubId).memberCount, 1);
      });

      describe('a private group', function () {
        let clubId;

        beforeEach(function () {
          clubId = ownedClub({ visibility: 'private', inviteToken: TOKEN });
        });

        it('turns away anyone without its link', function () {
          assert.equal(errorFrom(() => callAs(stranger, 'profileClubs.add', clubId)), 'invite-required');
          assert.equal(errorFrom(() => callAs(stranger, 'profileClubs.add', clubId, {}, {})), 'invite-required');
          assert.equal(errorFrom(() => callAs(stranger, 'profileClubs.add', clubId, {}, { inviteToken: '' })), 'invite-required');
          assert.equal(errorFrom(() => callAs(stranger, 'profileClubs.add', clubId, {}, { inviteToken: `${TOKEN}x` })), 'invite-required');
          assert.equal(errorFrom(() => callAs(stranger, 'profileClubs.add', club(clubId).clubID, {}, { inviteToken: 'guess' })), 'invite-required');
          assert.equal(membershipsOf(stranger, clubId), 0);
          assert.equal(club(clubId).memberCount, 0);
        });

        it('turns away the link to a different group', function () {
          const other = ownedClub({ visibility: 'private', inviteToken: `${TOKEN}-other` });
          assert.equal(errorFrom(() => callAs(stranger, 'profileClubs.add', clubId, {}, { inviteToken: club(other).inviteToken })), 'invite-required');
        });

        /** A private group made around the methods has no token at all, and
            "no token sent" must not be read as matching "no token stored". */
        it('does not mistake a missing token for a matching one', function () {
          const tokenless = ownedClub({ visibility: 'private' });
          assert.equal(errorFrom(() => callAs(stranger, 'profileClubs.add', tokenless)), 'invite-required');
          assert.equal(errorFrom(() => callAs(stranger, 'profileClubs.add', tokenless, {}, {})), 'invite-required');
        });

        it('lets in whoever holds the link', function () {
          const answer = callAs(stranger, 'profileClubs.add', clubId, {}, { inviteToken: TOKEN });
          assert.equal(answer.status, 'joined');
          assert.equal(membershipsOf(stranger, clubId), 1);
          assert.equal(club(clubId).memberCount, 1);
        });

        it('stops honouring a link the owner has replaced, and keeps whoever it already let in', function () {
          callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: TOKEN });
          const fresh = callAs(owner, 'clubs.rotateInvite', clubId);

          assert.equal(errorFrom(() => callAs(stranger, 'profileClubs.add', clubId, {}, { inviteToken: TOKEN })), 'invite-required');
          assert.equal(membershipsOf(stranger, clubId), 0);
          assert.equal(membershipsOf(member, clubId), 1, 'the link opened the door; it is not the membership');
          assert.equal(callAs(stranger, 'profileClubs.add', clubId, {}, { inviteToken: fresh }).status, 'joined');
        });

        it('never asks the person who runs it for the link to their own group', function () {
          assert.equal(callAs(owner, 'profileClubs.add', clubId).status, 'joined');
        });

        it('does not take a request in place of the link, even if it also asks first', function () {
          Clubs.collection.update(clubId, { $set: { approveMembers: true } });
          assert.equal(errorFrom(() => callAs(stranger, 'profileClubs.add', clubId)), 'invite-required');
          assert.equal(ClubJoinRequests.collection.find().count(), 0);
        });

        it('takes only a token in its options', function () {
          assert.isOk(errorFrom(() => callAs(stranger, 'profileClubs.add', clubId, {}, { inviteToken: TOKEN, asOwner: true })));
          assert.isOk(errorFrom(() => callAs(stranger, 'profileClubs.add', clubId, {}, { inviteToken: { $ne: '' } })));
          assert.equal(membershipsOf(stranger, clubId), 0);
        });
      });

      describe('a group that asks first', function () {
        let clubId;

        beforeEach(function () {
          clubId = ownedClub({ approveMembers: true, inviteToken: TOKEN });
        });

        it('takes a request instead of a member', function () {
          const answer = callAs(member, 'profileClubs.add', clubId);
          assert.equal(answer.status, 'requested');
          assert.equal(answer.requestId, requestOf(member, clubId)._id);
          assert.deepEqual(Object.keys(answer).sort(), ['requestId', 'status']);
          assert.include(requestOf(member, clubId), { status: 'pending' });
          assert.equal(membershipsOf(member, clubId), 0);
          assert.equal(club(clubId).memberCount, 0);
          assert.equal(RecommendationInteractions.collection.find({ userId: member }).count(), 0, 'asking is not joining');
        });

        it('keeps one request however often it is asked', function () {
          const first = callAs(member, 'profileClubs.add', clubId);
          assert.deepEqual(callAs(member, 'profileClubs.add', clubId), first);
          assert.equal(ClubJoinRequests.collection.find({ clubId }).count(), 1);
        });

        it('makes them a member once the owner says yes', function () {
          const { requestId } = callAs(member, 'profileClubs.add', clubId);
          assert.deepEqual(callAs(owner, 'clubs.respondToRequest', requestId, true), { status: 'approved' });

          assert.equal(membershipsOf(member, clubId), 1);
          assert.equal(club(clubId).memberCount, 1);
          assert.include(requestOf(member, clubId), { status: 'approved', respondedBy: owner });
          assert.deepEqual(
            RecommendationInteractions.collection.find({ userId: member, entityId: clubId }).map(row => row.action),
            ['joined_group'],
            'the recommender hears of it under the member’s name, once',
          );
          assert.equal(RecommendationInteractions.collection.find({ userId: owner }).count(), 0);
          assert.equal(callAs(member, 'profileClubs.add', clubId).status, 'joined');
        });

        /** The owner is the caller, and the row is the requester's. */
        it('judges the new member’s row by their own sharing choice, not the owner’s', function () {
          share(member);
          callAs(owner, 'clubs.respondToRequest', callAs(member, 'profileClubs.add', clubId).requestId, true);
          assert.equal(ProfileClubs.collection.findOne({ userId: member, clubId }).friendActivityVisibility, shareable);

          share(owner);
          callAs(owner, 'clubs.respondToRequest', callAs(stranger, 'profileClubs.add', clubId).requestId, true);
          assert.equal(ProfileClubs.collection.findOne({ userId: stranger, clubId }).friendActivityVisibility, hidden);
        });

        it('lets the link straight past the asking', function () {
          assert.equal(callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: TOKEN }).status, 'joined');
          assert.isUndefined(requestOf(member, clubId));
        });

        it('treats approving somebody who has since come in another way as nothing to do', function () {
          const { requestId } = callAs(member, 'profileClubs.add', clubId);
          callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: TOKEN });
          assert.equal(requestOf(member, clubId).status, 'approved', 'no longer waiting in the owner’s list');

          assert.isNull(errorFrom(() => callAs(owner, 'clubs.respondToRequest', requestId, true)));
          assert.isNull(errorFrom(() => callAs(owner, 'clubs.respondToRequest', requestId, false)));
          assert.equal(requestOf(member, clubId).status, 'approved', 'a late "no" does not reach a member');
          assert.equal(membershipsOf(member, clubId), 1);
          assert.equal(club(clubId).memberCount, 1);
        });

        it('holds a no for thirty days, and then lets them ask again', function () {
          const { requestId } = callAs(member, 'profileClubs.add', clubId);
          assert.deepEqual(callAs(owner, 'clubs.respondToRequest', requestId, false), { status: 'declined' });
          assert.equal(membershipsOf(member, clubId), 0);

          assert.equal(errorFrom(() => callAs(member, 'profileClubs.add', clubId)), 'request-declined');
          assert.equal(requestOf(member, clubId).status, 'declined');

          ClubJoinRequests.collection.update(requestId, {
            $set: { respondedAt: new Date(Date.now() - JOIN_REQUEST_COOLDOWN_MS + DAY_MS) },
          });
          assert.equal(errorFrom(() => callAs(member, 'profileClubs.add', clubId)), 'request-declined', 'day twenty-nine');

          ClubJoinRequests.collection.update(requestId, {
            $set: { respondedAt: new Date(Date.now() - JOIN_REQUEST_COOLDOWN_MS - DAY_MS) },
          });
          assert.deepEqual(callAs(member, 'profileClubs.add', clubId), { status: 'requested', requestId });
          const again = requestOf(member, clubId);
          assert.equal(again.status, 'pending');
          assert.notProperty(again, 'respondedAt');
          assert.notProperty(again, 'respondedBy');
        });

        it('tells a declined person how long, in words', function () {
          callAs(owner, 'clubs.respondToRequest', callAs(member, 'profileClubs.add', clubId).requestId, false);
          try {
            callAs(member, 'profileClubs.add', clubId);
            assert.fail('should have been refused');
          } catch (error) {
            assert.match(error.reason, /ask again in 30 days/);
          }
        });

        /** Leaving is not a way to wipe the owner's answer and ask again. */
        it('does not let "Leave" clear a no', function () {
          callAs(owner, 'clubs.respondToRequest', callAs(member, 'profileClubs.add', clubId).requestId, false);
          callAs(member, 'profileClubs.remove', clubId);
          assert.equal(errorFrom(() => callAs(member, 'profileClubs.add', clubId)), 'request-declined');
        });

        it('lets a person withdraw a request, and hands in an approval when they leave', function () {
          callAs(member, 'profileClubs.add', clubId);
          callAs(member, 'profileClubs.remove', clubId);
          assert.isUndefined(requestOf(member, clubId), 'withdrawn');

          callAs(owner, 'clubs.respondToRequest', callAs(member, 'profileClubs.add', clubId).requestId, true);
          callAs(member, 'profileClubs.remove', clubId);
          assert.equal(club(clubId).memberCount, 0);
          assert.equal(callAs(member, 'profileClubs.add', clubId).status, 'requested', 'coming back means asking again');
        });

        /**
         * A request is a name handed to the owner. Turned anonymous straight
         * in the database — the state a group reaches when a member tags it
         * 'recovery' — it must not go on collecting them.
         */
        it('asks nothing once the group is anonymous, whatever the flag still says', function () {
          Clubs.collection.update(clubId, { $set: { anonymous: true } });
          assert.equal(callAs(member, 'profileClubs.add', clubId).status, 'joined');

          const sensitive = ownedClub({ approveMembers: true, tags: ['sober'] });
          assert.equal(callAs(member, 'profileClubs.add', sensitive).status, 'joined');
          assert.equal(ClubJoinRequests.collection.find().count(), 0);
        });

        it('drops the requests it holds when a member’s tag makes it sensitive', function () {
          callAs(stranger, 'profileClubs.add', clubId);
          callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: TOKEN });
          callAs(member, 'clubs.addTag', clubId, 'recovery');
          assert.isUndefined(requestOf(stranger, clubId));
        });
      });
    });

    describe('clubs.respondToRequest', function () {
      let clubId;
      let requestId;

      beforeEach(function () {
        clubId = ownedClub();
        callAs(member, 'profileClubs.add', clubId);
        callAs(owner, 'Clubs.setPrivacy', clubId, { approveMembers: true });
        ({ requestId } = callAs(stranger, 'profileClubs.add', clubId));
      });

      it('is for the person who runs the group, or an administrator', function () {
        assert.equal(errorFrom(() => callAs(null, 'clubs.respondToRequest', requestId, true)), 'not-logged-in');
        assert.equal(errorFrom(() => callAs(member, 'clubs.respondToRequest', requestId, true)), 'not-authorized', 'a member');
        assert.equal(errorFrom(() => callAs(stranger, 'clubs.respondToRequest', requestId, true)), 'not-authorized', 'the requester');
        assert.equal(errorFrom(() => callAs(makeUser(), 'clubs.respondToRequest', requestId, false)), 'not-authorized', 'a passer-by');
        assert.equal(requestOf(stranger, clubId).status, 'pending');
        assert.equal(membershipsOf(stranger, clubId), 0);

        assert.deepEqual(callAs(admin, 'clubs.respondToRequest', requestId, true), { status: 'approved' });
        assert.equal(membershipsOf(stranger, clubId), 1);
        assert.equal(requestOf(stranger, clubId).respondedBy, admin);
      });

      it('takes a yes or a no and nothing else, about a request that exists', function () {
        assert.isOk(errorFrom(() => callAs(owner, 'clubs.respondToRequest', requestId, 'yes')));
        assert.isOk(errorFrom(() => callAs(owner, 'clubs.respondToRequest', requestId)));
        assert.equal(errorFrom(() => callAs(owner, 'clubs.respondToRequest', 'no-such-request', true)), 'request-not-found');
      });
    });

    describe('clubs.rotateInvite', function () {
      it('is for the person who runs the group, or an administrator', function () {
        const clubId = ownedClub({ visibility: 'private', inviteToken: 'the-first-token-long-enough-to-look-real-012' });
        callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: club(clubId).inviteToken });

        assert.equal(errorFrom(() => callAs(null, 'clubs.rotateInvite', clubId)), 'not-logged-in');
        assert.equal(errorFrom(() => callAs(member, 'clubs.rotateInvite', clubId)), 'not-authorized');
        assert.equal(errorFrom(() => callAs(stranger, 'clubs.rotateInvite', clubId)), 'not-authorized');
        assert.equal(club(clubId).inviteToken, 'the-first-token-long-enough-to-look-real-012');

        const byOwner = callAs(owner, 'clubs.rotateInvite', clubId);
        assert.equal(club(clubId).inviteToken, byOwner);
        const byAdmin = callAs(admin, 'clubs.rotateInvite', clubId);
        assert.equal(club(clubId).inviteToken, byAdmin);
        assert.notEqual(byAdmin, byOwner);
        assert.isAtLeast(byAdmin.length, 40);
      });
    });

    describe('clubs.inviteInfo', function () {
      const TOKEN = 'an-invite-token-long-enough-to-look-real-4567';

      it('tells the holder of a link the group’s name, its size, whether it is anonymous — and nothing more', function () {
        const clubId = ownedClub({
          visibility: 'private',
          inviteToken: TOKEN,
          contactInfo: 'call me',
          description: 'Where we meet and why.',
        });
        callAs(member, 'profileClubs.add', clubId, {}, { inviteToken: TOKEN });
        assert.deepEqual(
          callAs(stranger, 'clubs.inviteInfo', TOKEN),
          { clubId, name: club(clubId).name, anonymous: false, memberCount: 1 },
        );
      });

      it('says a sensitive group is anonymous, though its own flag is off', function () {
        ownedClub({ visibility: 'private', inviteToken: TOKEN, categories: ['support_group'], anonymous: false });
        assert.isTrue(callAs(stranger, 'clubs.inviteInfo', TOKEN).anonymous);
      });

      it('gives a wrong link, an old link and no link the same answer', function () {
        const clubId = ownedClub({ visibility: 'private', inviteToken: TOKEN });
        // Groups with no token at all, which an empty or missing guess must
        // not be allowed to match.
        ownedClub();
        ownedClub({ visibility: 'private' });

        assert.equal(errorFrom(() => callAs(stranger, 'clubs.inviteInfo', `${TOKEN}x`)), 'not-found');
        assert.equal(errorFrom(() => callAs(stranger, 'clubs.inviteInfo', '')), 'not-found');
        callAs(owner, 'clubs.rotateInvite', clubId);
        assert.equal(errorFrom(() => callAs(stranger, 'clubs.inviteInfo', TOKEN)), 'not-found');
      });

      it('takes a string, from somebody signed in', function () {
        ownedClub({ visibility: 'private', inviteToken: TOKEN });
        assert.equal(errorFrom(() => callAs(null, 'clubs.inviteInfo', TOKEN)), 'not-logged-in');
        assert.isOk(errorFrom(() => callAs(stranger, 'clubs.inviteInfo', { $ne: null })));
        assert.isOk(errorFrom(() => callAs(stranger, 'clubs.inviteInfo')));
      });

      /**
       * The audit trail keeps a method's short string arguments, because a
       * short string is usually an id. An invite token is a short string and
       * a way into a private group, and an operations log is read by people
       * who were never invited.
       */
      it('never leaves the token in the audit trail, from either method that takes one', function () {
        installAuditTrail();
        AuditLog.collection.remove({});
        const clubId = ownedClub({ visibility: 'private', inviteToken: TOKEN });
        callAs(stranger, 'clubs.inviteInfo', TOKEN);
        callAs(stranger, 'profileClubs.add', clubId, {}, { inviteToken: TOKEN });

        const entries = AuditLog.collection.find({ action: { $in: ['clubs.inviteInfo', 'profileClubs.add'] } }).fetch();
        assert.lengthOf(entries, 2, 'both calls are still on the record');
        entries.forEach(entry => assert.notInclude(JSON.stringify(entry), TOKEN, entry.action));
      });
    });

    describe('clubs.members', function () {
      it('shows the person who runs a group who is in it, and nobody else', function () {
        const clubId = ownedClub();
        callAs(member, 'profileClubs.add', clubId);

        assert.equal(errorFrom(() => callAs(null, 'clubs.members', clubId)), 'not-logged-in');
        assert.equal(errorFrom(() => callAs(member, 'clubs.members', clubId)), 'not-authorized');
        assert.equal(errorFrom(() => callAs(stranger, 'clubs.members', clubId)), 'not-authorized');

        const roster = callAs(owner, 'clubs.members', clubId);
        assert.lengthOf(roster, 1);
        assert.deepEqual(Object.keys(roster[0]).sort(), ['firstName', 'joinedAt', 'lastName', 'picture', 'userId']);
        assert.include(roster[0], { userId: member, lastName: 'Test' });
        assert.instanceOf(roster[0].joinedAt, Date);
        assert.lengthOf(callAs(admin, 'clubs.members', clubId), 1);
      });

      /**
       * What anonymous means here: not "hidden from the public" but "there
       * is no list". The owner's decision names the owner.
       */
      it('shows an anonymous group’s members to nobody — not its owner, not an administrator', function () {
        const clubId = ownedClub({ anonymous: true });
        callAs(member, 'profileClubs.add', clubId);
        assert.equal(errorFrom(() => callAs(owner, 'clubs.members', clubId)), 'anonymous-group');
        assert.equal(errorFrom(() => callAs(admin, 'clubs.members', clubId)), 'anonymous-group');
        assert.equal(errorFrom(() => callAs(stranger, 'clubs.members', clubId)), 'not-authorized');
      });

      it('treats a sensitive group the same, whatever its own flag says', function () {
        const byCategory = ownedClub({ categories: ['support_group'], anonymous: false });
        const byTag = ownedClub({ tags: ['lgbtq'] });
        [byCategory, byTag].forEach(clubId => {
          callAs(member, 'profileClubs.add', clubId);
          assert.equal(errorFrom(() => callAs(owner, 'clubs.members', clubId)), 'anonymous-group');
          assert.equal(errorFrom(() => callAs(admin, 'clubs.members', clubId)), 'anonymous-group');
        });
      });

      /**
       * Every switch goes both ways, and an anonymous group's members are
       * shown to nobody. The two meet here: off, read the list, on again.
       * The switch still moves; it does not reach back to the people who
       * joined because there was no list.
       */
      it('closes the list the moment the group turns anonymous, and never opens it on the people who joined while it was', function () {
        const clubId = ownedClub();
        callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: true });
        callAs(member, 'profileClubs.add', clubId);
        assert.equal(errorFrom(() => callAs(owner, 'clubs.members', clubId)), 'anonymous-group');

        callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: false });
        assert.instanceOf(club(clubId).anonymousUntil, Date);
        assert.deepEqual(callAs(owner, 'clubs.members', clubId), [], 'not to the owner');
        assert.deepEqual(callAs(admin, 'clubs.members', clubId), [], 'and not to an administrator');
        assert.equal(club(clubId).memberCount, 1, 'still counted');

        // After the promise ended, a join is an ordinary join.
        ProfileClubs.collection.insert({ userId: stranger, clubId, createdAt: new Date(club(clubId).anonymousUntil.getTime() + 1) });
        assert.deepEqual(callAs(owner, 'clubs.members', clubId).map(row => row.userId), [stranger]);

        // And doing it again moves the line forward, never back.
        const first = club(clubId).anonymousUntil;
        callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: true });
        callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: false });
        assert.isAtLeast(club(clubId).anonymousUntil.getTime(), first.getTime());
      });

      it('leaves a membership with no date off the list of a group that was once anonymous', function () {
        const clubId = ownedClub({ anonymousUntil: new Date(Date.now() - DAY_MS) });
        ProfileClubs.collection.insert({ userId: member, clubId });
        assert.deepEqual(callAs(owner, 'clubs.members', clubId), [], 'it cannot show that it came after');
      });

      it('lists everyone in a group that was never anonymous', function () {
        const clubId = ownedClub();
        callAs(member, 'profileClubs.add', clubId);
        callAs(owner, 'Clubs.setPrivacy', clubId, { visibility: 'private', approveMembers: true });
        assert.notProperty(club(clubId), 'anonymousUntil');
        assert.lengthOf(callAs(owner, 'clubs.members', clubId), 1);
      });

      /**
       * The other two ways out of anonymity. A group sensitive only by a tag
       * stops being so when its owner removes the tag, and one filed under a
       * sensitive category when an editor re-files it.
       */
      it('keeps the promise when anonymity ends by a tag removed or a group re-filed', function () {
        const byTag = ownedClub({ tags: ['recovery'] });
        callAs(member, 'profileClubs.add', byTag);
        callAs(owner, 'clubs.removeTag', byTag, 'recovery');
        assert.instanceOf(club(byTag).anonymousUntil, Date);
        assert.deepEqual(callAs(owner, 'clubs.members', byTag), []);

        const byCategory = ownedClub({ categories: ['support_group'] });
        callAs(member, 'profileClubs.add', byCategory);
        const { name, owner: ownerName, description, location, meetingTime } = club(byCategory);
        callAs(admin, 'Clubs.update', byCategory, { name, owner: ownerName, description, location, meetingTime, categories: ['Outdoors'] });
        assert.instanceOf(club(byCategory).anonymousUntil, Date);
        assert.deepEqual(callAs(owner, 'clubs.members', byCategory), []);
      });
    });

    /**
     * 'clubs.members' tells an administrator "not even you". The operations
     * log one page over used to read 'person@… profileClubs.add <the group's
     * id> ok', one line per member, and every administrator is sent it.
     */
    describe('the audit trail', function () {
      before(function () {
        installAuditTrail();
      });

      beforeEach(function () {
        AuditLog.collection.remove({});
      });

      const entriesNaming = id => AuditLog.collection.find().fetch().filter(entry => JSON.stringify(entry).includes(id));

      it('never says which group a person joined, left, tagged or asked to join', function () {
        const clubId = ownedClub({ anonymous: true });
        const asking = ownedClub({ approveMembers: true });
        callAs(member, 'profileClubs.add', clubId);
        callAs(member, 'eventSwipes.record', clubId, 'joined', 'club');
        callAs(member, 'clubs.addTag', clubId, 'thursdays');
        callAs(member, 'eventSwipes.remove', clubId, 'correction');
        callAs(member, 'profileClubs.remove', clubId);
        const { requestId } = callAs(stranger, 'profileClubs.add', asking);
        callAs(owner, 'clubs.respondToRequest', requestId, true);

        assert.deepEqual(entriesNaming(clubId), []);
        assert.deepEqual(entriesNaming(asking), []);
        assert.deepEqual(entriesNaming(requestId), []);
      });

      it('never says which event a person is going to', function () {
        const eventId = hostedEvent(ownedClub({ anonymous: true }));
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        callAs(member, 'eventSwipes.remove', eventId, 'rsvp_canceled');
        assert.deepEqual(entriesNaming(eventId), []);
      });

      it('still says who called what and how it ended, which is what probing looks like', function () {
        const clubId = ownedClub({ visibility: 'private' });
        errorFrom(() => callAs(stranger, 'profileClubs.add', clubId));
        const entry = AuditLog.collection.findOne({ action: 'profileClubs.add' });
        assert.include(entry, { actorId: stranger, outcome: 'error', errorCode: 'invite-required', summary: '<listing>' });
        assert.equal(entry.actorEmail, accountNameOf(stranger));
      });
    });

    /**
     * An anonymous listing shows a number and nothing else, so the number is
     * the feature. Each of these is a way a kept count goes wrong: counted
     * twice, not taken off, taken off twice, taken below nothing.
     */
    describe('the counts', function () {
      it('follows members in and out, once each', function () {
        const clubId = ownedClub();
        callAs(member, 'profileClubs.add', clubId);
        callAs(member, 'profileClubs.add', clubId);
        callAs(stranger, 'profileClubs.add', clubId);
        assert.equal(club(clubId).memberCount, 2);

        callAs(member, 'profileClubs.remove', clubId);
        callAs(member, 'profileClubs.remove', clubId);
        assert.equal(club(clubId).memberCount, 1);

        callAs(makeUser(), 'profileClubs.remove', clubId);
        assert.equal(club(clubId).memberCount, 1, 'somebody who was never in it leaving changes nothing');
      });

      it('counts a group that never had a count from its first join', function () {
        const clubId = makeClub();
        callAs(member, 'profileClubs.add', clubId);
        assert.equal(club(clubId).memberCount, 1);
      });

      it('takes a member off when they rewind the swipe that joined them', function () {
        const clubId = ownedClub();
        callAs(member, 'profileClubs.add', clubId);
        callAs(member, 'eventSwipes.record', clubId, 'joined', 'club');
        callAs(member, 'eventSwipes.remove', clubId, 'undo');
        assert.equal(club(clubId).memberCount, 0);
      });

      it('never goes below zero', function () {
        const clubId = ownedClub();
        ProfileClubs.collection.insert({ userId: member, clubId, createdAt: new Date() });
        callAs(member, 'profileClubs.remove', clubId);
        assert.strictEqual(club(clubId).memberCount, 0);

        const eventId = makeEvent({ goingCount: 0 });
        EventSwipes.collection.insert({ userId: member, eventId, decision: 'going', kind: 'event', createdAt: new Date() });
        callAs(member, 'eventSwipes.remove', eventId, 'rsvp_canceled');
        assert.strictEqual(event(eventId).goingCount, 0);
      });

      it('follows Going through every way of saying it and taking it back', function () {
        const eventId = makeEvent({ goingCount: 0 });
        const going = () => event(eventId).goingCount;

        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        assert.equal(going(), 1, 'said twice, counted once');

        callAs(stranger, 'eventSwipes.record', eventId, 'going', 'event');
        assert.equal(going(), 2);

        callAs(member, 'eventSwipes.record', eventId, 'passed', 'event');
        assert.equal(going(), 1, 'a left swipe over a standing RSVP');
        callAs(member, 'eventSwipes.record', eventId, 'passed', 'event');
        assert.equal(going(), 1, 'passing twice takes nothing more');

        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        assert.equal(going(), 2, 'and back again');

        callAs(member, 'eventSwipes.remove', eventId, 'undo');
        callAs(member, 'eventSwipes.remove', eventId, 'undo');
        assert.equal(going(), 1, 'undone once, however often it is pressed');

        callAs(stranger, 'eventSwipes.remove', eventId, 'rsvp_canceled');
        assert.equal(going(), 0);
      });

      it('is not moved by a pass, or by taking a pass back', function () {
        const eventId = makeEvent({ goingCount: 0 });
        callAs(stranger, 'eventSwipes.record', eventId, 'going', 'event');
        callAs(member, 'eventSwipes.record', eventId, 'passed', 'event');
        callAs(member, 'eventSwipes.remove', eventId, 'undo');
        callAs(member, 'eventSwipes.record', eventId, 'passed', 'event');
        callAs(member, 'eventSwipes.clearPassed');
        assert.equal(event(eventId).goingCount, 1);
      });

      it('leaves an event’s Going count alone when a group is joined or left', function () {
        const clubId = ownedClub();
        const eventId = hostedEvent(clubId);
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        callAs(member, 'profileClubs.add', clubId);
        callAs(member, 'eventSwipes.record', clubId, 'joined', 'club');
        callAs(member, 'profileClubs.remove', clubId);
        assert.equal(event(eventId).goingCount, 1);
        assert.equal(club(clubId).memberCount, 0);
      });

      it('does not publish who went when an anonymous group is removed', function () {
        // The meeting says nothing sensitive on its own; it was private to
        // friends only because its group was. Removing the group used to take
        // that reason away, and the next re-judging told everyone's friends.
        const clubId = ownedClub({ anonymous: true });
        const eventId = hostedEvent(clubId);
        share(member);
        callAs(member, 'profileClubs.add', clubId);
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        assert.equal(EventSwipes.collection.findOne({ userId: member, eventId }).friendActivityVisibility, hidden);

        callAs(admin, 'Clubs.remove', clubId);

        assert.isTrue(event(eventId).anonymous, 'the event carries what its group knew');
        assert.isFalse(event(eventId).privacyInherited, 'and no longer follows a group that is gone');
        syncFriendActivityPrivacy();
        assert.equal(EventSwipes.collection.findOne({ userId: member, eventId }).friendActivityVisibility, hidden);
      });

      it('keeps the promise to earlier guests when a once-anonymous group is removed', function () {
        const clubId = ownedClub({ anonymous: true });
        const eventId = hostedEvent(clubId);
        share(member);
        callAs(member, 'profileClubs.add', clubId);
        callAs(member, 'eventSwipes.record', eventId, 'going', 'event');
        callAs(owner, 'Clubs.setPrivacy', clubId, { anonymous: false });
        const until = club(clubId).anonymousUntil;
        assert.instanceOf(until, Date);

        callAs(admin, 'Clubs.remove', clubId);

        assert.equal(event(eventId).anonymousUntil.getTime(), until.getTime());
        syncFriendActivityPrivacy();
        assert.equal(EventSwipes.collection.findOne({ userId: member, eventId }).friendActivityVisibility, hidden);
      });

      it('takes a removed group’s requests with it, and leaves its events’ counts standing', function () {
        const clubId = ownedClub({ approveMembers: true });
        const eventId = hostedEvent(clubId);
        callAs(member, 'profileClubs.add', clubId);
        callAs(stranger, 'eventSwipes.record', eventId, 'going', 'event');

        callAs(admin, 'Clubs.remove', clubId);
        assert.equal(ClubJoinRequests.collection.find({ clubId }).count(), 0);
        assert.equal(event(eventId).goingCount, 1, 'the event outlives the group, and so do its RSVPs');

        callAs(admin, 'Events.remove', eventId);
        assert.equal(EventSwipes.collection.find({ eventId }).count(), 0);
      });
    });
  });
}
