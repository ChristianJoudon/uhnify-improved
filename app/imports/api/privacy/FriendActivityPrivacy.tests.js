/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../club/Club';
import { EventClubs } from '../events/EventClubs';
import { EventSwipes } from '../events/EventSwipes';
import { ProfileClubs } from '../profile/ProfileClubs';
import { Profiles } from '../profiles/Profiles';
import { callAs, errorFrom, makeClub, makeEvent, makeUser, resetAll } from '../../startup/server/testFixtures';
import {
  FRIEND_ACTIVITY_VISIBILITY,
  LISTING_PRIVACY_FIELDS,
  friendActivityVisibilityFor,
  friendActivityVisibilityOfRow,
  isAnonymousListing,
  isPrivateListing,
  isSensitiveListing,
  tookPartWhileAnonymous,
  withHostSignals,
} from './FriendActivityPrivacy';
import { syncFriendActivityPrivacy } from './friendActivitySync';

/**
 * What friends are never told, and what they are told only when asked to be.
 *
 * Two rules, both the owner's. Sharing with friends is off until a person
 * turns it on. And a sensitive listing — support and recovery, health, LGBTQ+,
 * faith — is not shared even then. Before this there was one private category
 * and no setting, so the default was that everybody's friends saw everything.
 *
 * The mistakes are not symmetrical and the tests are not either. A listing
 * wrongly kept private costs nothing, so the negatives below are a handful of
 * ordinary words that must stay ordinary. A listing wrongly shown cannot be
 * taken back, so every sensitive signal is pinned one by one, and every path
 * that could stamp a row 'shareable' is walked with a sensitive listing on it.
 */
const { shareable, private: hidden } = FRIEND_ACTIVITY_VISIBILITY;

const visibilityOfMembership = (userId, clubId) => ProfileClubs.collection.findOne({ userId, clubId }).friendActivityVisibility;
const visibilityOfSwipe = (userId, eventId) => EventSwipes.collection.findOne({ userId, eventId }).friendActivityVisibility;

if (Meteor.isServer) {
  describe('isSensitiveListing', function () {
    const SENSITIVE_CATEGORIES = [
      'support_group', 'support', 'recovery', 'addiction_recovery', 'grief', 'bereavement',
      'mental_health', 'health', 'healthcare', 'community_health', 'lgbtq',
      'spirituality', 'faith', 'religion', 'religious', 'church', 'worship', 'ministry',
    ];

    SENSITIVE_CATEGORIES.forEach(category => {
      it(`treats the category '${category}' as sensitive`, function () {
        assert.isTrue(isSensitiveListing({ categories: ['community', category] }));
      });
    });

    it('reads a category however it was typed', function () {
      ['Mental Health', 'mental-health', '  FAITH ', 'LGBTQ+', 'Support Group', 'Addiction  Recovery'].forEach(category => {
        assert.isTrue(isSensitiveListing({ categories: [category] }), category);
      });
    });

    // The register files the memory cafe under this one and nothing else that
    // would mark it, so it is here by name.
    it("treats the register's 'health_wellness' as health", function () {
      assert.isTrue(isSensitiveListing({ categories: ['community', 'health_wellness', 'social'] }));
    });

    // A group's categories come from a free-text box, so they are read for
    // words exactly as its tags are.
    it('finds a sensitive word inside a category somebody typed', function () {
      assert.isTrue(isSensitiveListing({ categories: ['Recovery meetings'] }));
      assert.isTrue(isSensitiveListing({ categories: 'community, grief' }), 'and in the comma-separated form');
    });

    it('treats a topic marked sensitiveParticipation as sensitive', function () {
      assert.isTrue(isSensitiveListing({ categories: ['community'], topicIds: ['support'] }));
      assert.isFalse(isSensitiveListing({ categories: ['community'], topicIds: ['wellness'] }));
      assert.isFalse(isSensitiveListing({ topicIds: ['constructor'] }), 'a key that is not a topic is not one');
    });

    it('treats anything carrying a support subtype as sensitive', function () {
      assert.isTrue(isSensitiveListing({ categories: ['community'], supportSubtype: 'general_support' }));
    });

    const SENSITIVE_TAGS = [
      'recovery', 'sober', 'sobriety', 'aa', 'na', 'al-anon', 'alanon', 'grief', 'lgbtq', 'queer', 'trans',
      'gay', 'lesbian', 'church', 'bible', 'prayer', 'worship', 'therapy', 'cancer', 'hiv',
    ];

    SENSITIVE_TAGS.forEach(word => {
      it(`treats a tag containing '${word}' as sensitive`, function () {
        assert.isTrue(isSensitiveListing({ categories: ['community'], tags: ['hiking', `${word} meetup`] }));
      });
    });

    /**
     * Whole-word matching means the word beside a listed one is a different
     * word. Everything after the first row is a form the first list missed:
     * the adjective where it had the noun, the plural where it had the
     * singular, and names people give these groups that it had in no form.
     */
    it('reads a tag however it was typed', function () {
      [
        'AA', 'Al-Anon Family Group', 'LGBTQ+ student club', 'Sunday Bible study', 'HIV/AIDS outreach',
        'Spiritual', 'Christian fellowship', 'Catholic youth', 'Island churches', 'Temple volunteers',
        'mental', 'Counseling', 'rehab', '12-step', '12 Step', 'Twelve-Step meeting',
        'Kauaʻi Pride', 'Bisexual', 'nonbinary', 'Non-binary',
      ].forEach(tag => {
        assert.isTrue(isSensitiveListing({ tags: [tag] }), tag);
      });
    });

    it('leaves ordinary categories alone', function () {
      ['wellness', 'yoga', 'community', 'fitness', 'family', 'sound_bath', 'seniors'].forEach(category => {
        assert.isFalse(isSensitiveListing({ categories: [category] }), category);
      });
    });

    /**
     * Whole words, not substrings. 'na' and 'aa' are two letters that sit
     * inside half the language, and a directory that hid every national park
     * and every bazaar would be fixing privacy by breaking the feature.
     */
    it('matches a sensitive word only as a whole word', function () {
      [
        'national parks', 'banana bread', 'bazaar', 'transport', 'translation', 'healthy eating',
        'gazebo', 'supporters club', 'churchill downs', 'nature walks',
      ].forEach(tag => {
        assert.isFalse(isSensitiveListing({ categories: ['community'], tags: [tag] }), tag);
      });
    });

    it('is not tripped by a listing with nothing on it', function () {
      assert.isFalse(isSensitiveListing({}));
      assert.isFalse(isSensitiveListing({ categories: [], tags: [], topicIds: [] }));
    });

    it('treats a listing that cannot be found as sensitive', function () {
      assert.isTrue(isSensitiveListing(undefined));
      assert.isTrue(isSensitiveListing(null));
    });
  });

  describe('friendActivityVisibilityFor', function () {
    const ordinary = { categories: ['community'] };
    const sensitive = { categories: ['support_group'] };

    it('is shareable for an ordinary listing when its owner shares', function () {
      assert.equal(friendActivityVisibilityFor(ordinary, { sharing: true }), shareable);
    });

    it('is private for a sensitive listing even when its owner shares', function () {
      assert.equal(friendActivityVisibilityFor(sensitive, { sharing: true }), hidden);
    });

    it('is private when the owner does not share', function () {
      assert.equal(friendActivityVisibilityFor(ordinary, { sharing: false }), hidden);
    });

    /**
     * The old signature took the listing alone, so a call site that was never
     * updated — or one written next year from memory — passes no preference at
     * all. That has to come out private, not shareable.
     */
    it('fails closed when the preference is missing or is not exactly true', function () {
      assert.equal(friendActivityVisibilityFor(ordinary), hidden);
      assert.equal(friendActivityVisibilityFor(ordinary, null), hidden);
      assert.equal(friendActivityVisibilityFor(ordinary, {}), hidden);
      [undefined, null, 1, 'true', 'yes', {}].forEach(sharing => {
        assert.equal(friendActivityVisibilityFor(ordinary, { sharing }), hidden, `${sharing}`);
      });
    });

    it('fails closed when the listing is missing', function () {
      assert.equal(friendActivityVisibilityFor(undefined, { sharing: true }), hidden);
      assert.equal(friendActivityVisibilityFor(null, { sharing: true }), hidden);
    });

    /**
     * A friend is somebody. A group that shows its own organizer no names
     * cannot go on showing them to each member's friends, however willing the
     * member is to share.
     */
    it('is private for an anonymous listing even when its owner shares', function () {
      assert.equal(friendActivityVisibilityFor({ ...ordinary, anonymous: true }, { sharing: true }), hidden);
      assert.equal(friendActivityVisibilityFor({ ...ordinary, anonymous: false }, { sharing: true }), shareable);
    });

    /**
     * A shared row is sent to friends whole, with the listing's _id on it. For
     * a private listing that tells people who were never invited that it
     * exists, who is in it, and the id its methods are called with.
     */
    it('is private for a private listing even when its owner shares', function () {
      assert.equal(friendActivityVisibilityFor({ ...ordinary, visibility: 'private' }, { sharing: true }), hidden);
      assert.equal(friendActivityVisibilityFor({ ...ordinary, visibility: 'public' }, { sharing: true }), shareable);
    });
  });

  /**
   * A listing that stopped being anonymous is an ordinary listing again, and
   * judged alone it says 'shareable' about everyone in it — the people who
   * joined because nobody could see them with the rest. The row's own date is
   * the other half of the question.
   */
  describe('friendActivityVisibilityOfRow', function () {
    const ended = new Date('2026-09-01T12:00:00Z');
    const onceAnonymous = { categories: ['community'], anonymousUntil: ended };
    const before = { createdAt: new Date(ended.getTime() - 1) };
    const after = { createdAt: new Date(ended.getTime() + 1) };

    it('keeps hidden a row made before the anonymity ended, however willing its owner is to share', function () {
      assert.isTrue(tookPartWhileAnonymous(onceAnonymous, before));
      assert.equal(friendActivityVisibilityOfRow(onceAnonymous, before, { sharing: true }), hidden);
    });

    it('counts the very moment it ended as before, and a row with no date as unable to show it came after', function () {
      [{ createdAt: ended }, {}, undefined].forEach(row => {
        assert.isTrue(tookPartWhileAnonymous(onceAnonymous, row));
        assert.equal(friendActivityVisibilityOfRow(onceAnonymous, row, { sharing: true }), hidden);
      });
    });

    it('judges a row made afterwards as any other, by the listing and the person’s choice', function () {
      assert.isFalse(tookPartWhileAnonymous(onceAnonymous, after));
      assert.equal(friendActivityVisibilityOfRow(onceAnonymous, after, { sharing: true }), shareable);
      assert.equal(friendActivityVisibilityOfRow(onceAnonymous, after, { sharing: false }), hidden);
      assert.equal(friendActivityVisibilityOfRow({ ...onceAnonymous, anonymous: true }, after, { sharing: true }), hidden);
    });

    it('changes nothing for a listing that was never anonymous', function () {
      const ordinary = { categories: ['community'] };
      [before, after, {}].forEach(row => {
        assert.isFalse(tookPartWhileAnonymous(ordinary, row));
        assert.equal(friendActivityVisibilityOfRow(ordinary, row, { sharing: true }), shareable);
      });
      assert.equal(friendActivityVisibilityOfRow(undefined, after, { sharing: true }), hidden, 'and a missing one still fails closed');
    });
  });

  /**
   * Private is read the way the publications read it, and for an event it
   * rests on the hosts as anonymity does.
   */
  describe('isPrivateListing', function () {
    const ordinary = { categories: ['community'] };

    it('is false for a listing with no visibility, or a public one', function () {
      assert.isFalse(isPrivateListing(ordinary));
      assert.isFalse(isPrivateListing({ ...ordinary, visibility: 'public' }));
    });

    it('is true for private, and for any value it has never heard of', function () {
      ['private', 'members', 'unlisted', 'Public', 'something-new', '', null, 1, true].forEach(visibility => {
        assert.isTrue(isPrivateListing({ ...ordinary, visibility }), `${visibility}`);
      });
    });

    it('is true for an event when any one group that hosts it is private, however public the event', function () {
      const event = { categories: ['outdoors'], visibility: 'public' };
      assert.isTrue(isPrivateListing(withHostSignals(event, [ordinary, { ...ordinary, visibility: 'private' }])));
      assert.isTrue(isPrivateListing(withHostSignals({ ...event, visibility: 'private' }, [ordinary])), 'and by its own');
      assert.isFalse(isPrivateListing(withHostSignals(event, [ordinary, { ...ordinary, visibility: 'public' }])));
      assert.isFalse(isPrivateListing(withHostSignals(ordinary, [])));
    });

    it('treats a listing that cannot be found as private', function () {
      assert.isTrue(isPrivateListing(undefined));
      assert.isTrue(isPrivateListing(null));
    });

    it('is carried by the projection every judge loads listings with', function () {
      assert.equal(LISTING_PRIVACY_FIELDS.visibility, 1);
    });
  });

  /**
   * Anonymous has three sources and one question. Each source is pinned by
   * itself, because the way this breaks is a reader that checks the field and
   * forgets the other two — and the two it forgets are the recovery meeting
   * and the recovery meeting's Thursday session.
   */
  describe('isAnonymousListing', function () {
    const ordinary = { categories: ['community'], tags: ['hiking'] };

    it('is true when the owner said so', function () {
      assert.isTrue(isAnonymousListing({ ...ordinary, anonymous: true }));
    });

    it('is true for a sensitive listing whatever its own flag says, including off', function () {
      assert.isTrue(isAnonymousListing({ categories: ['support_group'] }));
      assert.isTrue(isAnonymousListing({ categories: ['support_group'], anonymous: false }));
      assert.isTrue(isAnonymousListing({ ...ordinary, tags: ['sober'], anonymous: false }));
    });

    it('is true for an event when any one group that hosts it is anonymous', function () {
      const event = { categories: ['outdoors'], anonymous: false };
      assert.isTrue(isAnonymousListing(withHostSignals(event, [ordinary, { ...ordinary, anonymous: true }])));
      assert.isTrue(isAnonymousListing(withHostSignals(event, [{ categories: ['lgbtq'] }])), 'a sensitive host');
    });

    it('is false for an ordinary listing with ordinary hosts', function () {
      assert.isFalse(isAnonymousListing(ordinary));
      assert.isFalse(isAnonymousListing({ ...ordinary, anonymous: false }));
      assert.isFalse(isAnonymousListing(withHostSignals(ordinary, [ordinary, { ...ordinary, anonymous: false }])));
    });

    it('takes only a real true as the flag', function () {
      ['true', 'yes', 1, {}].forEach(anonymous => {
        assert.isFalse(isAnonymousListing({ ...ordinary, anonymous }), `${anonymous}`);
      });
    });

    it('treats a listing that cannot be found as anonymous', function () {
      assert.isTrue(isAnonymousListing(undefined));
      assert.isTrue(isAnonymousListing(null));
    });

    /**
     * Every judge of a listing projects to LISTING_PRIVACY_FIELDS. A flag that
     * is not in that list is never loaded, reads as absent, and an anonymous
     * group is then shared with friends by a query that looked correct.
     */
    it('is carried by the projection every judge loads listings with', function () {
      assert.equal(LISTING_PRIVACY_FIELDS.anonymous, 1);
    });
  });

  describe('withHostSignals', function () {
    const ordinaryEvent = { categories: ['outdoors'], topicIds: ['outdoors'] };

    it('makes an ordinary event sensitive by any one host, whichever signal the host carries', function () {
      [
        { categories: ['lgbtq'] },
        { categories: ['outdoors'], tags: ['sober'] },
        { topicIds: ['support'] },
        { supportSubtype: 'general_support' },
      ].forEach(host => {
        assert.isTrue(
          isSensitiveListing(withHostSignals(ordinaryEvent, [{ categories: ['community'] }, host])),
          JSON.stringify(host),
        );
      });
    });

    it('leaves an ordinary event ordinary when it has no host, or only ordinary ones', function () {
      assert.isFalse(isSensitiveListing(withHostSignals(ordinaryEvent)));
      assert.isFalse(isSensitiveListing(withHostSignals(ordinaryEvent, [])));
      assert.isFalse(isSensitiveListing(withHostSignals(ordinaryEvent, [{ categories: ['community'], tags: ['hiking'] }])));
    });

    it('keeps what the event says about itself', function () {
      assert.isTrue(isSensitiveListing(withHostSignals({ categories: ['grief'] }, [{ categories: ['community'] }])));
      assert.isTrue(isSensitiveListing(withHostSignals({ supportSubtype: 'general_support' }, [])));
    });

    it('keeps a missing event missing, so it still fails closed', function () {
      assert.isUndefined(withHostSignals(undefined, [{ categories: ['community'] }]));
      assert.equal(
        friendActivityVisibilityFor(withHostSignals(undefined, [{ categories: ['community'] }]), { sharing: true }),
        hidden,
      );
    });
  });

  /**
   * Going to a group's meeting says what belonging to the group says. The event
   * record usually does not: 'Events.insert' copies the host's categories once
   * and nothing else, so a group that is sensitive by a tag hands its events
   * nothing at all. An RSVP judged against the event alone told an opted-in
   * person's friends they were going to the Thursday meeting.
   */
  describe('an RSVP to an event that a sensitive group hosts', function () {
    let sharer;

    beforeEach(function () {
      resetAll();
      sharer = makeUser();
      callAs(sharer, 'Profiles.setFriendActivitySharing', true);
    });

    it('is private when the host is sensitive only by a tag, which no event inherits', function () {
      const hostId = makeClub({ categories: ['outdoors'], tags: ['sober'] });
      const eventId = makeEvent({ categories: ['outdoors'] });
      EventClubs.collection.insert({ clubId: hostId, eventId, createdAt: new Date() });

      callAs(sharer, 'eventSwipes.record', eventId, 'going');

      assert.equal(visibilityOfSwipe(sharer, eventId), hidden);
    });

    it('is private for an event made the ordinary way, through Events.insert', function () {
      const host = Clubs.collection.findOne(makeClub({ categories: ['outdoors'], tags: ['Recovery hikes'] }));
      const eventId = callAs(makeUser(), 'Events.insert', {
        eventID: host.clubID,
        title: 'Thursday meeting',
        date: new Date(Date.now() + 24 * 60 * 60 * 1000),
        location: 'Līhuʻe',
      });

      callAs(sharer, 'eventSwipes.record', eventId, 'going');

      assert.equal(visibilityOfSwipe(sharer, eventId), hidden);
    });

    it('is private when the host is named only by the older eventID number', function () {
      const host = Clubs.collection.findOne(makeClub({ categories: ['faith'] }));
      const eventId = makeEvent({ eventID: host.clubID, categories: ['community'] });

      callAs(sharer, 'eventSwipes.record', eventId, 'going');

      assert.equal(visibilityOfSwipe(sharer, eventId), hidden);
    });

    it('is private when any one of several hosts is sensitive', function () {
      const eventId = makeEvent({ categories: ['community'] });
      [makeClub({ categories: ['community'] }), makeClub({ categories: ['mental_health'] })].forEach(clubId => {
        EventClubs.collection.insert({ clubId, eventId, createdAt: new Date() });
      });

      callAs(sharer, 'eventSwipes.record', eventId, 'going');

      assert.equal(visibilityOfSwipe(sharer, eventId), hidden);
    });

    it('is still shareable when every host is ordinary', function () {
      const host = Clubs.collection.findOne(makeClub({ categories: ['outdoors'], tags: ['hiking'] }));
      const eventId = makeEvent({ eventID: host.clubID, categories: ['outdoors'] });
      EventClubs.collection.insert({ clubId: host._id, eventId, createdAt: new Date() });

      callAs(sharer, 'eventSwipes.record', eventId, 'going');

      assert.equal(visibilityOfSwipe(sharer, eventId), shareable);
    });

    it('is hidden as soon as a sensitive group is linked to an event people are already going to', function () {
      const host = Clubs.collection.findOne(makeClub({ categories: ['lgbtq'] }));
      const eventId = makeEvent({ categories: ['community'] });
      callAs(sharer, 'eventSwipes.record', eventId, 'going');
      assert.equal(visibilityOfSwipe(sharer, eventId), shareable);

      // By an administrator: giving an event a host is for the people who may
      // set its privacy, because this is what it does.
      callAs(makeUser({ admin: true }), 'Clubs.organizeEvent', { clubID: host.clubID, eventID: eventId });

      assert.equal(visibilityOfSwipe(sharer, eventId), hidden);
    });
  });

  describe('Profiles.setFriendActivitySharing', function () {
    let user;
    let clubId;
    let sensitiveClubId;
    let eventId;
    let sensitiveEventId;

    beforeEach(function () {
      resetAll();
      user = makeUser();
      clubId = makeClub({ categories: ['community'] });
      sensitiveClubId = makeClub({ categories: ['lgbtq', 'community'] });
      eventId = makeEvent({ categories: ['music'] });
      sensitiveEventId = makeEvent({ categories: ['community'], topicIds: ['support'] });
    });

    const joinEverything = userId => {
      callAs(userId, 'profileClubs.add', clubId);
      callAs(userId, 'profileClubs.add', sensitiveClubId);
      callAs(userId, 'eventSwipes.record', clubId, 'joined', 'club');
      callAs(userId, 'eventSwipes.record', eventId, 'going');
      callAs(userId, 'eventSwipes.record', sensitiveEventId, 'going');
    };

    const shareableCount = userId => ProfileClubs.collection.find({ userId, friendActivityVisibility: shareable }).count()
      + EventSwipes.collection.find({ userId, friendActivityVisibility: shareable }).count();

    it('refuses a signed-out caller', function () {
      assert.equal(errorFrom(() => callAs(null, 'Profiles.setFriendActivitySharing', true)), 'not-logged-in');
    });

    it('takes a yes or a no and nothing else', function () {
      ['true', 1, null, undefined, {}].forEach(value => {
        assert.match(errorFrom(() => callAs(user, 'Profiles.setFriendActivitySharing', value)), /Match error|Expected boolean/i);
      });
      assert.isUndefined(Profiles.collection.findOne({ userId: user }).friendActivitySharing);
    });

    it('returns and stores the new value, on the caller’s own profile only', function () {
      const other = makeUser();

      assert.isTrue(callAs(user, 'Profiles.setFriendActivitySharing', true));
      assert.isTrue(Profiles.collection.findOne({ userId: user }).friendActivitySharing);
      assert.isUndefined(Profiles.collection.findOne({ userId: other }).friendActivitySharing);

      assert.isFalse(callAs(user, 'Profiles.setFriendActivitySharing', false));
      assert.isFalse(Profiles.collection.findOne({ userId: user }).friendActivitySharing);
    });

    it('stamps everything private for a person who has never turned sharing on', function () {
      joinEverything(user);
      assert.equal(shareableCount(user), 0);
    });

    it('turning it on shares what was already there, except the sensitive', function () {
      joinEverything(user);
      callAs(user, 'Profiles.setFriendActivitySharing', true);

      assert.equal(visibilityOfMembership(user, clubId), shareable);
      assert.equal(visibilityOfSwipe(user, clubId), shareable);
      assert.equal(visibilityOfSwipe(user, eventId), shareable);
      assert.equal(visibilityOfMembership(user, sensitiveClubId), hidden);
      assert.equal(visibilityOfSwipe(user, sensitiveEventId), hidden);
    });

    it('stamps new rows by the same rule once it is on', function () {
      callAs(user, 'Profiles.setFriendActivitySharing', true);
      joinEverything(user);

      assert.equal(visibilityOfMembership(user, clubId), shareable);
      assert.equal(visibilityOfSwipe(user, eventId), shareable);
      assert.equal(visibilityOfMembership(user, sensitiveClubId), hidden);
      assert.equal(visibilityOfSwipe(user, sensitiveEventId), hidden);
    });

    it('turning it off makes every row private in the same call', function () {
      callAs(user, 'Profiles.setFriendActivitySharing', true);
      joinEverything(user);
      assert.isAbove(shareableCount(user), 0);

      callAs(user, 'Profiles.setFriendActivitySharing', false);
      assert.equal(shareableCount(user), 0);
    });

    // Off must not depend on finding the listing: a row whose group has since
    // been deleted out from under it is hidden like any other.
    it('turning it off hides a row whose listing has gone', function () {
      callAs(user, 'Profiles.setFriendActivitySharing', true);
      callAs(user, 'profileClubs.add', clubId);
      Clubs.collection.remove(clubId);

      callAs(user, 'Profiles.setFriendActivitySharing', false);
      assert.equal(visibilityOfMembership(user, clubId), hidden);
    });

    it('touches nobody else’s rows, either way', function () {
      const sharer = makeUser();
      const keeper = makeUser();
      callAs(sharer, 'Profiles.setFriendActivitySharing', true);
      joinEverything(sharer);
      joinEverything(keeper);
      const sharedBefore = shareableCount(sharer);

      callAs(user, 'Profiles.setFriendActivitySharing', true);
      callAs(user, 'Profiles.setFriendActivitySharing', false);

      assert.equal(shareableCount(sharer), sharedBefore);
      assert.equal(shareableCount(keeper), 0);
    });

    it('never makes a sensitive row shareable, however many times it is flipped', function () {
      joinEverything(user);
      [true, false, true, true].forEach(enabled => {
        callAs(user, 'Profiles.setFriendActivitySharing', enabled);
        assert.equal(visibilityOfMembership(user, sensitiveClubId), hidden);
        assert.equal(visibilityOfSwipe(user, sensitiveEventId), hidden);
      });
    });
  });

  /**
   * An edit is made by an administrator and lands on rows that belong to other
   * people. Everywhere else the preference that counts is the caller's, and
   * carrying that habit over here would let an administrator who shares their
   * own activity publish every member's. So the administrator in these tests
   * does share, and it must make no difference.
   */
  describe('friend-activity visibility when a listing changes', function () {
    let admin;
    let sharer;
    let keeper;
    let clubId;

    const edit = (id, changes) => {
      const club = Clubs.collection.findOne(id);
      callAs(admin, 'Clubs.update', id, {
        clubID: club.clubID,
        name: club.name,
        owner: club.owner,
        description: club.description,
        location: club.location,
        meetingTime: club.meetingTime,
        contactInfo: club.contactInfo || '',
        categories: club.categories,
        tags: club.tags || [],
        ...changes,
      });
    };

    beforeEach(function () {
      resetAll();
      admin = makeUser({ admin: true });
      sharer = makeUser();
      keeper = makeUser();
      callAs(admin, 'Profiles.setFriendActivitySharing', true);
      callAs(sharer, 'Profiles.setFriendActivitySharing', true);
      clubId = makeClub({ categories: ['community'] });
      callAs(sharer, 'profileClubs.add', clubId);
      callAs(keeper, 'profileClubs.add', clubId);
    });

    it('goes by each member’s own choice, not the editor’s', function () {
      edit(clubId, { name: 'Renamed' });

      assert.equal(visibilityOfMembership(sharer, clubId), shareable);
      assert.equal(visibilityOfMembership(keeper, clubId), hidden);
    });

    /**
     * This used to give the sharers' rows back. But whoever was in the group
     * while it was filed under 'faith' was in a faith group, and re-filing it
     * is not their consent to have that told: see tookPartWhileAnonymous. What
     * comes back is the group, for the people who join from here on.
     */
    it('hides every membership when the group becomes sensitive, and when it stops shows only the sharers who join afterwards', function () {
      // One more account than the rest of these, and each is a password hashed.
      this.timeout(10000);
      edit(clubId, { categories: ['faith'] });
      assert.equal(visibilityOfMembership(sharer, clubId), hidden);
      assert.equal(visibilityOfMembership(keeper, clubId), hidden);

      edit(clubId, { categories: ['community'] });
      assert.equal(visibilityOfMembership(sharer, clubId), hidden, 'they were in it while it was sensitive');
      assert.equal(visibilityOfMembership(keeper, clubId), hidden);

      // A tick on, so the join is dated after the moment the group stopped.
      Meteor._sleepForMs(3);
      const newcomer = makeUser();
      callAs(newcomer, 'Profiles.setFriendActivitySharing', true);
      callAs(newcomer, 'profileClubs.add', clubId);
      edit(clubId, { name: 'Renamed' });
      assert.equal(visibilityOfMembership(newcomer, clubId), shareable, 'an ordinary join, and it survives being judged again');
      assert.equal(visibilityOfMembership(sharer, clubId), hidden);
    });

    it('hides memberships as soon as a member adds a sensitive tag', function () {
      callAs(keeper, 'clubs.addTag', clubId, 'Sober living');

      assert.equal(visibilityOfMembership(sharer, clubId), hidden);
    });

    /**
     * An event keeps the categories its host had on the day it was made. So
     * when the group is re-filed, the events it already has say nothing new,
     * and the RSVPs to them were left showing until the next restart.
     */
    it('hides RSVPs to the group’s events when the group is re-filed as sensitive, by either link', function () {
      this.timeout(10000);
      const linkedEventId = makeEvent({ categories: ['community'] });
      EventClubs.collection.insert({ clubId, eventId: linkedEventId, createdAt: new Date() });
      const numberedEventId = makeEvent({ eventID: Clubs.collection.findOne(clubId).clubID, categories: ['community'] });
      const unrelatedEventId = makeEvent({ categories: ['community'] });
      [linkedEventId, numberedEventId, unrelatedEventId].forEach(eventId => {
        callAs(sharer, 'eventSwipes.record', eventId, 'going');
        callAs(keeper, 'eventSwipes.record', eventId, 'going');
        assert.equal(visibilityOfSwipe(sharer, eventId), shareable);
      });

      edit(clubId, { categories: ['lgbtq'] });
      assert.equal(visibilityOfSwipe(sharer, linkedEventId), hidden);
      assert.equal(visibilityOfSwipe(sharer, numberedEventId), hidden);
      assert.equal(visibilityOfSwipe(sharer, unrelatedEventId), shareable, 'an event the group does not host is not its business');

      // Re-filed back, and the RSVPs from before stay where they were: going
      // to its meetings said what being in it said.
      edit(clubId, { categories: ['community'] });
      assert.equal(visibilityOfSwipe(sharer, linkedEventId), hidden);
      assert.equal(visibilityOfSwipe(sharer, numberedEventId), hidden);
      assert.equal(visibilityOfSwipe(sharer, unrelatedEventId), shareable);

      Meteor._sleepForMs(3);
      const newcomer = makeUser();
      callAs(newcomer, 'Profiles.setFriendActivitySharing', true);
      [linkedEventId, numberedEventId].forEach(eventId => callAs(newcomer, 'eventSwipes.record', eventId, 'going'));
      edit(clubId, { name: 'Renamed' });
      assert.equal(visibilityOfSwipe(newcomer, linkedEventId), shareable, 'an RSVP made afterwards is an ordinary one');
      assert.equal(visibilityOfSwipe(newcomer, numberedEventId), shareable);
      assert.equal(visibilityOfSwipe(keeper, linkedEventId), hidden, 'and only for the people who share');
    });

    it('hides RSVPs to the group’s events as soon as a member adds a sensitive tag', function () {
      const eventId = makeEvent({ categories: ['community'] });
      EventClubs.collection.insert({ clubId, eventId, createdAt: new Date() });
      callAs(sharer, 'eventSwipes.record', eventId, 'going');
      assert.equal(visibilityOfSwipe(sharer, eventId), shareable);

      callAs(keeper, 'clubs.addTag', clubId, 'AA');

      assert.equal(visibilityOfSwipe(sharer, eventId), hidden);
    });

    it('judges an event’s RSVPs again when the event is edited onto a sensitive host', function () {
      const hostClub = Clubs.collection.findOne(makeClub({ categories: ['support_group'] }));
      const eventId = makeEvent({ owner: 'someone@test.example', categories: ['community'] });
      callAs(sharer, 'eventSwipes.record', eventId, 'going');
      assert.equal(visibilityOfSwipe(sharer, eventId), shareable);

      callAs(admin, 'Events.update', eventId, {
        eventID: hostClub.clubID,
        title: 'Edited',
        date: new Date(Date.now() + 24 * 60 * 60 * 1000),
        location: 'Līhuʻe',
      });

      assert.equal(visibilityOfSwipe(sharer, eventId), hidden);
    });
  });

  describe('syncFriendActivityPrivacy', function () {
    beforeEach(function () {
      resetAll();
    });

    /**
     * The rows as the last build left them: 'shareable' on nearly everything,
     * and nobody ever asked. The first boot with the setting in place has to
     * take all of that back.
     */
    it('turns every existing row private on the first boot, because nobody has opted in', function () {
      const user = makeUser();
      const clubId = makeClub({ categories: ['community'] });
      const eventId = makeEvent({ categories: ['music'] });
      ProfileClubs.collection.insert({ userId: user, clubId, friendActivityVisibility: shareable });
      EventSwipes.collection.insert({ userId: user, eventId, decision: 'going', friendActivityVisibility: shareable });

      assert.equal(syncFriendActivityPrivacy(), 2);
      assert.equal(visibilityOfMembership(user, clubId), hidden);
      assert.equal(visibilityOfSwipe(user, eventId), hidden);
    });

    it('settles each row by its owner’s choice and its own listing, and then writes nothing', function () {
      const sharer = makeUser();
      const keeper = makeUser();
      Profiles.collection.update({ userId: sharer }, { $set: { friendActivitySharing: true } });
      const clubId = makeClub({ categories: ['community'] });
      const sensitiveClubId = makeClub({ categories: ['mental_health'] });
      const eventId = makeEvent({ categories: ['music'] });
      [sharer, keeper].forEach(userId => {
        ProfileClubs.collection.insert({ userId, clubId });
        ProfileClubs.collection.insert({ userId, clubId: sensitiveClubId, friendActivityVisibility: shareable });
        EventSwipes.collection.insert({ userId, eventId, decision: 'going' });
        EventSwipes.collection.insert({ userId, eventId: clubId, kind: 'club', decision: 'joined' });
      });
      ProfileClubs.collection.insert({ userId: sharer, clubId: 'a-group-that-is-gone', friendActivityVisibility: shareable });

      syncFriendActivityPrivacy();

      assert.equal(visibilityOfMembership(sharer, clubId), shareable);
      assert.equal(visibilityOfSwipe(sharer, eventId), shareable);
      assert.equal(visibilityOfSwipe(sharer, clubId), shareable, 'a swipe on a group is judged against the group');
      assert.equal(visibilityOfMembership(sharer, sensitiveClubId), hidden);
      assert.equal(visibilityOfMembership(sharer, 'a-group-that-is-gone'), hidden);
      assert.equal(ProfileClubs.collection.find({ userId: keeper, friendActivityVisibility: shareable }).count(), 0);
      assert.equal(EventSwipes.collection.find({ userId: keeper, friendActivityVisibility: shareable }).count(), 0);

      assert.equal(syncFriendActivityPrivacy(), 0, 'a settled database is left alone');
    });

    /**
     * Rows from before an RSVP was judged with its hosts: stamped 'shareable'
     * against an event record that says nothing, for a group that says plenty.
     */
    it('judges an RSVP with the groups that host the event', function () {
      const sharer = makeUser();
      Profiles.collection.update({ userId: sharer }, { $set: { friendActivitySharing: true } });
      const sensitiveHost = Clubs.collection.findOne(makeClub({ categories: ['outdoors'], tags: ['grief'] }));
      const ordinaryHostId = makeClub({ categories: ['outdoors'] });
      const linkedEventId = makeEvent({ categories: ['outdoors'] });
      const numberedEventId = makeEvent({ eventID: sensitiveHost.clubID, categories: ['outdoors'] });
      const ordinaryEventId = makeEvent({ categories: ['outdoors'] });
      EventClubs.collection.insert({ clubId: sensitiveHost._id, eventId: linkedEventId });
      EventClubs.collection.insert({ clubId: ordinaryHostId, eventId: ordinaryEventId });
      [linkedEventId, numberedEventId, ordinaryEventId].forEach(eventId => {
        EventSwipes.collection.insert({ userId: sharer, eventId, decision: 'going', friendActivityVisibility: shareable });
      });

      assert.equal(syncFriendActivityPrivacy(), 2);

      assert.equal(visibilityOfSwipe(sharer, linkedEventId), hidden);
      assert.equal(visibilityOfSwipe(sharer, numberedEventId), hidden);
      assert.equal(visibilityOfSwipe(sharer, ordinaryEventId), shareable);
    });
  });
}
