/* eslint-env mocha */
/* eslint-disable no-console */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { AuditLog } from '../../api/audit/AuditLog';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import { ListingPhotos } from '../../api/photos/ListingPhotos';
import { savePhoto } from '../../api/photos/photoStore';
import { IMAGE_DATA_URL_MAX } from '../../api/listing/limits';
import { makeClub, makeEvent, makeUser, resetAll } from './testFixtures';
import { PARTICIPATION_ACTIONS, PARTICIPATION_SUMMARY } from './auditTrail';
import {
  backfillListingCounts,
  dropRedundantCreatedBy,
  movePhotosOutOfDocuments,
  redactParticipationAudit,
  renameInterestedSwipes,
} from './migrations';

/**
 * The migration runs on every boot against whatever the database holds, so
 * the cases that matter are the three kinds of record it will meet: the
 * imported register, an event the app made, and an event whose `createdBy`
 * an administrator once edited by hand.
 */
if (Meteor.isServer) {
  describe('dropRedundantCreatedBy', function () {
    beforeEach(function () {
      resetAll();
    });

    it('clears an imported record whatever its createdBy says', function () {
      const id = makeEvent({ importedFrom: 'Register', owner: 'admin@foo.com', createdBy: 'register' });
      assert.equal(dropRedundantCreatedBy(), 1);
      assert.notProperty(Events.collection.findOne(id), 'createdBy');
    });

    it('clears a createdBy that only repeats the owner', function () {
      const id = makeEvent({ owner: 'someone@private.example', createdBy: 'someone@private.example' });
      assert.equal(dropRedundantCreatedBy(), 1);
      const event = Events.collection.findOne(id);
      assert.notProperty(event, 'createdBy');
      assert.equal(event.owner, 'someone@private.example', 'the server-only copy stays');
    });

    it('keeps a createdBy that says something the owner does not', function () {
      const id = makeEvent({ owner: 'admin@foo.com', createdBy: 'The Garden Club' });
      assert.equal(dropRedundantCreatedBy(), 0);
      assert.equal(Events.collection.findOne(id).createdBy, 'The Garden Club');
    });

    it('is a no-op the second time, and on a record that never had the field', function () {
      makeEvent({ owner: 'someone@private.example', createdBy: 'someone@private.example' });
      makeEvent();
      assert.equal(dropRedundantCreatedBy(), 1);
      assert.equal(dropRedundantCreatedBy(), 0);
      assert.equal(Events.collection.find({ createdBy: { $exists: true } }).count(), 0);
    });
  });

  /**
   * The rows this meets were written under a schema that no longer exists, so
   * the fixture has to go around the current one to make them: 'interested' is
   * exactly the value the schema now refuses. The migration itself gets no such
   * favour — it runs through collection2 like any other write, which is what
   * proves the values it leaves behind are ones the app can go on updating.
   */
  describe('renameInterestedSwipes', function () {
    let person;

    const storedSwipe = fields => EventSwipes.collection.insert(
      { userId: person, createdAt: new Date(), ...fields },
      { bypassCollection2: true },
    );

    beforeEach(function () {
      resetAll();
      person = makeUser();
    });

    it('calls a right swipe on an event going', function () {
      const id = storedSwipe({ eventId: makeEvent(), decision: 'interested', kind: 'event' });
      assert.deepEqual(renameInterestedSwipes(), { going: 1, joined: 0 });
      assert.equal(EventSwipes.collection.findOne(id).decision, 'going');
    });

    it('treats a swipe from before groups could be swiped as the event swipe it was', function () {
      const id = storedSwipe({ eventId: makeEvent(), decision: 'interested' });
      assert.deepEqual(renameInterestedSwipes(), { going: 1, joined: 0 });
      assert.equal(EventSwipes.collection.findOne(id).decision, 'going');
    });

    it('calls a right swipe on a group joined', function () {
      const id = storedSwipe({ eventId: makeClub(), decision: 'interested', kind: 'club' });
      assert.deepEqual(renameInterestedSwipes(), { going: 0, joined: 1 });
      const swipe = EventSwipes.collection.findOne(id);
      assert.equal(swipe.decision, 'joined');
      assert.equal(swipe.kind, 'club', 'the kind is what decided the name, and is left as it was');
    });

    it('leaves a pass alone, whatever it was on', function () {
      const onEvent = storedSwipe({ eventId: makeEvent(), decision: 'passed', kind: 'event' });
      const onGroup = storedSwipe({ eventId: makeClub(), decision: 'passed', kind: 'club' });
      assert.deepEqual(renameInterestedSwipes(), { going: 0, joined: 0 });
      assert.equal(EventSwipes.collection.findOne(onEvent).decision, 'passed');
      assert.equal(EventSwipes.collection.findOne(onGroup).decision, 'passed');
    });

    it('is a no-op the second time, and leaves nothing under the old name', function () {
      storedSwipe({ eventId: makeEvent(), decision: 'interested', kind: 'event' });
      storedSwipe({ eventId: makeEvent(), decision: 'interested' });
      storedSwipe({ eventId: makeClub(), decision: 'interested', kind: 'club' });
      assert.deepEqual(renameInterestedSwipes(), { going: 2, joined: 1 });
      assert.deepEqual(renameInterestedSwipes(), { going: 0, joined: 0 });
      assert.equal(EventSwipes.collection.find({ decision: 'interested' }).count(), 0);
    });
  });

  /**
   * The rows here are written straight into the collections, around the
   * methods, because that is the situation the migration exists for: the
   * seed, an import and every record older than the fields were never counted
   * by anything.
   */
  describe('backfillListingCounts', function () {
    const join = (userId, clubId) => ProfileClubs.collection.insert({ userId, clubId, createdAt: new Date() });
    const swipe = (userId, eventId, decision, kind = 'event') => EventSwipes.collection.insert({
      userId, eventId, decision, kind, createdAt: new Date(),
    });

    beforeEach(function () {
      resetAll();
    });

    it('counts members from the memberships, and gives an empty group a zero', function () {
      const busy = makeClub();
      const empty = makeClub();
      join('a', busy);
      join('b', busy);
      assert.deepEqual(backfillListingCounts(), { clubs: 2, events: 0 });
      assert.equal(Clubs.collection.findOne(busy).memberCount, 2);
      assert.strictEqual(Clubs.collection.findOne(empty).memberCount, 0);
    });

    it('counts going from the swipes that say going, and nothing else', function () {
      const eventId = makeEvent();
      const clubId = makeClub({ memberCount: 0 });
      swipe('a', eventId, 'going');
      swipe('b', eventId, 'going');
      swipe('c', eventId, 'passed');
      // A join is a swipe too, and lives in the same collection under the
      // group's id. It is not an RSVP to anything.
      swipe('a', clubId, 'joined', 'club');
      assert.deepEqual(backfillListingCounts(), { clubs: 0, events: 1 });
      assert.equal(Events.collection.findOne(eventId).goingCount, 2);
    });

    it('corrects a count that has drifted, in either direction', function () {
      const clubId = makeClub({ memberCount: 9 });
      const eventId = makeEvent({ goingCount: 0 });
      join('a', clubId);
      swipe('a', eventId, 'going');
      assert.deepEqual(backfillListingCounts(), { clubs: 1, events: 1 });
      assert.equal(Clubs.collection.findOne(clubId).memberCount, 1);
      assert.equal(Events.collection.findOne(eventId).goingCount, 1);
    });

    it('writes nothing the second time, and nothing to a count that was right', function () {
      const clubId = makeClub({ memberCount: 1 });
      join('a', clubId);
      makeEvent();
      assert.deepEqual(backfillListingCounts(), { clubs: 0, events: 1 });
      assert.deepEqual(backfillListingCounts(), { clubs: 0, events: 0 });
    });
  });

  /**
   * The rows this meets were stored by older versions of the app, under older
   * checks, so the fixtures write them the way those versions did: straight
   * onto the document. Some are photos the app would accept today and some
   * are not, and the second kind is the one the migration must not harm.
   */
  describe('movePhotosOutOfDocuments', function () {
    const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
    const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)]);
    const jpeg = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;
    const png = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    const NOTHING = { clubs: 0, events: 0, profiles: 0, left: 0, failed: 0 };

    const bytesFor = (kind, ownerId) => Buffer.from(ListingPhotos.collection.findOne({ kind, ownerId }).data, 'base64');

    beforeEach(function () {
      resetAll();
      ListingPhotos.collection.remove({});
    });

    it('moves a group’s, an event’s and a profile’s photo, and leaves each its path', function () {
      const clubId = makeClub({ image: jpeg });
      const eventId = makeEvent({ image: png });
      const userId = makeUser();
      Profiles.collection.update({ userId }, { $set: { picture: jpeg } });
      const profileId = Profiles.collection.findOne({ userId })._id;

      assert.deepEqual(movePhotosOutOfDocuments(), { ...NOTHING, clubs: 1, events: 1, profiles: 1 });

      assert.match(Clubs.collection.findOne(clubId).image, new RegExp(`^/photo/club/${clubId}\\?v=\\d+$`));
      assert.match(Events.collection.findOne(eventId).image, new RegExp(`^/photo/event/${eventId}\\?v=\\d+$`));
      assert.match(Profiles.collection.findOne(profileId).picture, new RegExp(`^/photo/profile/${profileId}\\?v=\\d+$`));
      assert.isTrue(bytesFor('club', clubId).equals(JPEG_BYTES));
      assert.isTrue(bytesFor('event', eventId).equals(PNG_BYTES));
      assert.isTrue(bytesFor('profile', profileId).equals(JPEG_BYTES));
      assert.equal(ListingPhotos.collection.findOne({ kind: 'event', ownerId: eventId }).contentType, 'image/png');
    });

    it('touches nothing but the photo', function () {
      const updatedAt = new Date('2026-01-02T03:04:05Z');
      const eventId = makeEvent({ image: jpeg, updatedAt, owner: 'someone@private.example', title: 'Kept' });
      const { image, ...before } = Events.collection.findOne(eventId);
      movePhotosOutOfDocuments();
      const { image: path, ...after } = Events.collection.findOne(eventId);
      assert.deepEqual(after, before, 'updatedAt included: nobody edited this');
      assert.notEqual(path, image);
    });

    it('leaves alone what was never an upload', function () {
      const stock = makeEvent({ image: '/images/codingWorkshop.png' });
      const linked = makeClub({ image: 'https://example.org/logo.png' });
      const bare = makeClub();
      assert.deepEqual(movePhotosOutOfDocuments(), NOTHING);
      assert.equal(Events.collection.findOne(stock).image, '/images/codingWorkshop.png');
      assert.equal(Clubs.collection.findOne(linked).image, 'https://example.org/logo.png');
      assert.notProperty(Clubs.collection.findOne(bare), 'image');
      assert.equal(ListingPhotos.collection.find().count(), 0);
    });

    it('does nothing the second time', function () {
      const eventId = makeEvent({ image: jpeg });
      assert.deepEqual(movePhotosOutOfDocuments(), { ...NOTHING, events: 1 });
      const moved = Events.collection.findOne(eventId).image;
      const row = ListingPhotos.collection.findOne({ kind: 'event', ownerId: eventId });

      assert.deepEqual(movePhotosOutOfDocuments(), NOTHING);
      assert.equal(Events.collection.findOne(eventId).image, moved, 'same path, so nobody’s cache is thrown away');
      assert.deepEqual(ListingPhotos.collection.findOne({ kind: 'event', ownerId: eventId }), row);
    });

    /**
     * For years the only check was that the string began 'data:image/', so
     * this is what is really out there: a GIF, a label its bytes contradict,
     * a photo from when the ceiling was four times what it is. Each still
     * draws for the person who uploaded it. Moving it is refused; destroying
     * it is not the alternative.
     */
    it('leaves a photo it cannot move exactly as it was, and counts it', function () {
      const gif = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
      const mislabelled = `data:image/jpeg;base64,${PNG_BYTES.toString('base64')}`;
      const oversize = jpeg.padEnd(IMAGE_DATA_URL_MAX + 1, 'A');
      const gifEvent = makeEvent({ image: gif });
      const mislabelledClub = makeClub({ image: mislabelled });
      const oversizeEvent = makeEvent({ image: oversize });
      const good = makeEvent({ image: jpeg });

      assert.deepEqual(movePhotosOutOfDocuments(), { ...NOTHING, events: 1, left: 3 });

      assert.equal(Events.collection.findOne(gifEvent).image, gif);
      assert.equal(Clubs.collection.findOne(mislabelledClub).image, mislabelled);
      assert.equal(Events.collection.findOne(oversizeEvent).image, oversize);
      assert.equal(ListingPhotos.collection.find().count(), 1, 'only the good one was stored');
      assert.isTrue(bytesFor('event', good).equals(JPEG_BYTES), 'and a bad row beside it did not stop it');

      // Still there, still counted, on every boot until its owner replaces it.
      assert.deepEqual(movePhotosOutOfDocuments(), { ...NOTHING, left: 3 });
    });

    it('leaves a document whose _id no photo can be kept under', function () {
      Events.collection.insert({ _id: 'made-by-hand', eventID: 0, title: 'Odd', date: new Date(), location: 'Līhuʻe', image: jpeg });
      assert.deepEqual(movePhotosOutOfDocuments(), { ...NOTHING, left: 1 });
      assert.equal(Events.collection.findOne('made-by-hand').image, jpeg);
    });

    it('finishes a move that was cut short after the photo was stored', function () {
      const eventId = makeEvent({ image: jpeg });
      savePhoto({ kind: 'event', ownerId: eventId, dataUrl: jpeg });
      assert.deepEqual(movePhotosOutOfDocuments(), { ...NOTHING, events: 1 });
      assert.equal(ListingPhotos.collection.find().count(), 1);
      assert.match(Events.collection.findOne(eventId).image, /^\/photo\/event\//);
    });

    /**
     * The catch used to take every failure for a refused photo. A write the
     * database turned down was then reported, on every boot, as one more
     * picture that "could not be moved", with no record named and the real
     * error thrown away.
     */
    describe('when something goes wrong', function () {
      let said;
      const original = { warn: console.warn, error: console.error, update: Events.collection.update };

      beforeEach(function () {
        said = { warn: [], error: [] };
        console.warn = (...words) => said.warn.push(words.join(' '));
        console.error = (...words) => said.error.push(words.join(' '));
      });

      afterEach(function () {
        console.warn = original.warn;
        console.error = original.error;
        Events.collection.update = original.update;
      });

      it('names each photo the store refused, with the store’s reason, and calls it nothing worse', function () {
        const gifEvent = makeEvent({ image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' });
        const oversizeClub = makeClub({ image: jpeg.padEnd(IMAGE_DATA_URL_MAX + 1, 'A') });

        assert.deepEqual(movePhotosOutOfDocuments(), { ...NOTHING, left: 2 });

        assert.lengthOf(said.warn, 2);
        assert.isOk(said.warn.find(line => line.includes('events') && line.includes(gifEvent) && line.includes('invalid-image')));
        assert.isOk(said.warn.find(line => line.includes('clubs') && line.includes(oversizeClub) && line.includes('image-too-large')));
        assert.notInclude(said.warn.join(' '), 'base64', 'the photo itself is not what gets logged');
        assert.deepEqual(said.error, []);
      });

      it('reports a write that failed as the error it is, leaves the row untouched, and carries on', function () {
        const eventId = makeEvent({ image: jpeg });
        const clubId = makeClub({ image: png });
        Events.collection.update = () => {
          throw new Error('the database said no');
        };

        assert.deepEqual(movePhotosOutOfDocuments(), { ...NOTHING, clubs: 1, failed: 1 });

        assert.equal(Events.collection.findOne(eventId).image, jpeg, 'exactly as it was');
        assert.match(Clubs.collection.findOne(clubId).image, /^\/photo\/club\//, 'one bad write did not stop the rest');
        assert.lengthOf(said.error, 1);
        assert.include(said.error[0], 'events');
        assert.include(said.error[0], eventId);
        assert.include(said.error[0], 'the database said no');
        assert.deepEqual(said.warn, [], 'and it is not passed off as a bad photo');

        // Nothing was lost by it: the next boot finishes the move.
        Events.collection.update = original.update;
        assert.deepEqual(movePhotosOutOfDocuments(), { ...NOTHING, events: 1 });
      });
    });
  });

  /**
   * The trail used to write down which listing every join, RSVP and tag was
   * about, beside who did it. New entries do not; these are the old ones.
   */
  describe('redactParticipationAudit', function () {
    const entry = (action, summary) => AuditLog.collection.insert({
      at: new Date('2026-09-01T00:00:00Z'), actorId: 'someone', actorEmail: 'someone@test.example', action, outcome: 'ok', summary, ms: 3,
    });

    beforeEach(function () {
      AuditLog.collection.remove({});
    });

    it('takes the listing out of every entry that says who takes part in what, and keeps the rest of it', function () {
      const ids = PARTICIPATION_ACTIONS.map(action => entry(action, 'aGroupOrEventId1, {}, {inviteToken}'));

      assert.equal(redactParticipationAudit(), PARTICIPATION_ACTIONS.length);

      ids.forEach((id, index) => {
        const { summary, ...rest } = AuditLog.collection.findOne(id);
        assert.equal(summary, PARTICIPATION_SUMMARY);
        assert.deepEqual(rest, {
          _id: id,
          at: new Date('2026-09-01T00:00:00Z'),
          actorId: 'someone',
          actorEmail: 'someone@test.example',
          action: PARTICIPATION_ACTIONS[index],
          outcome: 'ok',
          ms: 3,
        });
      });
    });

    it('leaves every other entry as it was written', function () {
      const kept = entry('Clubs.setPrivacy', 'aGroupId1, {visibility}');
      assert.equal(redactParticipationAudit(), 0);
      assert.equal(AuditLog.collection.findOne(kept).summary, 'aGroupId1, {visibility}');
    });

    it('writes nothing the second time', function () {
      entry('profileClubs.add', 'aGroupId1, {}, {}');
      assert.equal(redactParticipationAudit(), 1);
      assert.equal(redactParticipationAudit(), 0);
    });

    it('covers the methods that say so today', function () {
      assert.includeMembers([...PARTICIPATION_ACTIONS], [
        'profileClubs.add', 'profileClubs.remove', 'eventSwipes.record', 'eventSwipes.remove',
      ]);
    });
  });
}
