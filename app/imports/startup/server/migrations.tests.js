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
  assignAnonymousNames,
  backfillListingCounts,
  deriveMonthlyWeeks,
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
   * Everybody who was here before made-up names were. What matters at a boot
   * is that it names each of them once, that a second boot changes nobody,
   * and that nothing it says could tie a name to an account.
   */
  describe('assignAnonymousNames', function () {
    this.timeout(15000);

    const nameOf = userId => Profiles.collection.findOne({ userId }).anonymousName;

    beforeEach(function () {
      resetAll();
    });

    it('names every profile that belongs to an account, each differently', function () {
      const people = [makeUser(), makeUser(), makeUser()];
      assert.deepEqual(assignAnonymousNames(), { named: 3, failed: 0 });
      const names = people.map(nameOf);
      names.forEach(name => assert.match(name, /\S \S/));
      assert.lengthOf(new Set(names), 3);
    });

    it('leaves a profile no account holds yet, and names it once somebody does', function () {
      const seeded = Profiles.collection.insert({ email: 'seeded@test.example', firstName: 'Seeded', interests: [] });
      assert.deepEqual(assignAnonymousNames(), { named: 0, failed: 0 });
      assert.notProperty(Profiles.collection.findOne(seeded), 'anonymousName');

      Profiles.collection.update(seeded, { $set: { userId: 'anAccountId12345x' } });
      assert.deepEqual(assignAnonymousNames(), { named: 1, failed: 0 });
    });

    it('changes nobody the second time', function () {
      const people = [makeUser(), makeUser()];
      assignAnonymousNames();
      const names = people.map(nameOf);
      assert.deepEqual(assignAnonymousNames(), { named: 0, failed: 0 });
      assert.deepEqual(people.map(nameOf), names);

      // Nor when only some were here before.
      const late = makeUser();
      assert.deepEqual(assignAnonymousNames(), { named: 1, failed: 0 });
      assert.deepEqual(people.map(nameOf), names);
      assert.notInclude(names, nameOf(late));
    });

    it('says nothing at all, so no log can hold a name — not even when a write fails', function () {
      const people = [makeUser(), makeUser()];
      const said = [];
      const original = { log: console.log, warn: console.warn, error: console.error, update: Profiles.collection.update };
      const listen = level => {
        console[level] = (...words) => said.push(words.join(' '));
      };
      let counts;
      try {
        ['log', 'warn', 'error'].forEach(listen);
        Profiles.collection.update = (selector, ...rest) => {
          if (selector._id === Profiles.collection.findOne({ userId: people[0] })._id) {
            throw new Error('the database said no');
          }
          return original.update.call(Profiles.collection, selector, ...rest);
        };
        counts = assignAnonymousNames();
      } finally {
        Profiles.collection.update = original.update;
        ['log', 'warn', 'error'].forEach(level => {
          console[level] = original[level];
        });
      }

      assert.deepEqual(counts, { named: 1, failed: 1 }, 'one bad write did not stop the rest');
      assert.deepEqual(said, []);
      // Nothing was lost by it: the next boot names them.
      assert.deepEqual(assignAnonymousNames(), { named: 1, failed: 0 });
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

  /**
   * The register stored 'monthly' with nowhere to say which week, and the
   * calendar drew every week. The strings below are the register's own,
   * character for character: this migration is only as good as its reading of
   * exactly these.
   */
  describe('deriveMonthlyWeeks', function () {
    const NOTHING = { weeks: 0, unknown: 0, cleared: 0 };
    const scheduleOf = id => Clubs.collection.findOne(id).schedule;
    const monthlyClub = (meetingTime, days, time, extra = {}) => makeClub({ meetingTime, schedule: { days, time, cadence: 'monthly', ...extra } });

    beforeEach(function () {
      resetAll();
    });

    it('recovers the weeks of every monthly group in the register', function () {
      const register = [
        ['First and third Thursdays · 6:30 PM', [4], '18:30', [1, 3]],
        ['Second and fourth Wednesdays · 6:30 PM', [3], '18:30', [2, 4]],
        ['Second and fourth Tuesdays · 7 AM', [2], '07:00', [2, 4]],
        ['First Sunday of every month · 3 PM', [0], '15:00', [1]],
        ['Published first-Thursday pattern · 10 AM', [4], '10:00', [1]],
        ['First and third Thursdays; month-end Pau Hana also held · 12 PM', [4], '12:00', [1, 3]],
        ['Usually fourth Wednesday · 5:30 PM', [3], '17:30', [4]],
        ['First Thursday of every month · 12 PM', [4], '12:00', [1]],
      ].map(([meetingTime, days, time, weeks]) => ({ id: monthlyClub(meetingTime, days, time), days, time, weeks }));

      assert.deepEqual(deriveMonthlyWeeks(), { ...NOTHING, weeks: register.length });

      register.forEach(({ id, days, time, weeks }) => {
        assert.deepEqual(scheduleOf(id), { days, time, cadence: 'monthly', weeks });
      });
    });

    it('takes the end time from the text too, when the text agrees about the start', function () {
      const agrees = monthlyClub('Second Wednesday of the month, 6:00 pm–7:30 pm', [3], '18:00');
      const differs = monthlyClub('Second Wednesday of the month, 6:00 pm–7:30 pm', [3], '17:00');
      const hasOne = monthlyClub('Second Wednesday of the month, 6:00 pm–7:30 pm', [3], '18:00', { endTime: '20:00' });

      assert.deepEqual(deriveMonthlyWeeks(), { ...NOTHING, weeks: 3 });

      assert.deepEqual(scheduleOf(agrees), { days: [3], time: '18:00', endTime: '19:30', cadence: 'monthly', weeks: [2] });
      assert.deepEqual(scheduleOf(differs), { days: [3], time: '17:00', cadence: 'monthly', weeks: [2] }, 'a window is not moved onto another start');
      assert.deepEqual(scheduleOf(hasOne), { days: [3], time: '18:00', endTime: '20:00', cadence: 'monthly', weeks: [2] }, 'a stored end is kept');
    });

    it('learns nothing from text that names other days, no week, or nothing at all', function () {
      const ids = [
        monthlyClub('First and third Thursdays · 6:30 PM', [2], '18:30'),
        monthlyClub('First and third Thursdays · 6:30 PM', [2, 4], '18:30'),
        monthlyClub('Monthly on Thursdays at 6pm', [4], '18:00'),
        monthlyClub('Varies', [4], '18:00'),
        monthlyClub('Fourth Thursday or Friday at 6:00 PM', [4, 5], '18:00'),
      ];
      const before = ids.map(scheduleOf);
      assert.deepEqual(deriveMonthlyWeeks(), NOTHING);
      assert.deepEqual(ids.map(scheduleOf), before);
    });

    /**
     * The second way in. A group that arrived with text and no schedule had
     * one derived by the old parser, which stored anything monthly as weekly.
     */
    it('puts right a weekly schedule the old parser made from monthly text', function () {
      const old = (meetingTime, days, time) => makeClub({ meetingTime, schedule: { days, time, cadence: 'weekly' } });
      const ingested = old('Second Wednesday of the month, 6:00 pm–7:30 pm', [3], '18:00');
      const unknown = old('Monthly on Thursdays at 6pm', [4], '18:00');
      const coffee = old('Coffee Time first Saturday; Book Club fourth Wednesday · 10 AM', [3, 6], '10:00');
      const either = old('Fourth Thursday or Friday at 6:00 PM; location varies · 6 PM', [4, 5], '18:00');

      assert.deepEqual(deriveMonthlyWeeks(), { weeks: 1, unknown: 1, cleared: 2 });

      assert.deepEqual(scheduleOf(ingested), { days: [3], time: '18:00', endTime: '19:30', cadence: 'monthly', weeks: [2] });
      assert.deepEqual(scheduleOf(unknown), { days: [4], time: '18:00', cadence: 'monthly' });
      [coffee, either].forEach(id => {
        const club = Clubs.collection.findOne(id);
        assert.notProperty(club, 'schedule', 'no one schedule says this, so the text speaks');
        assert.isOk(club.meetingTime);
      });
    });

    /**
     * Clearing is the one destructive thing this does, and it used to ask
     * less than the branches that only add: that the text be monthly, and
     * nothing about the days. The old parser stored EVERY weekday the text
     * names, so a schedule on other days is somebody else's work.
     */
    it('clears nothing whose days are not the days the text names', function () {
      const text = 'Coffee first Saturday; Book Club fourth Wednesday';
      const kept = [[2], [3], [3, 5, 6]].map(days => ({ days, time: '10:00', cadence: 'weekly' }));
      const ids = kept.map(schedule => makeClub({ meetingTime: text, schedule }));

      assert.deepEqual(deriveMonthlyWeeks(), NOTHING);
      assert.deepEqual(ids.map(scheduleOf), kept);
    });

    it('never touches a schedule somebody chose', function () {
      const chosen = [
        // What the forms store: the schedule's own label as the text.
        { meetingTime: 'Thu · 6:30 PM', schedule: { days: [4], time: '18:30', cadence: 'weekly' } },
        { meetingTime: 'Every other Wed · 7 PM', schedule: { days: [3], time: '19:00', cadence: 'biweekly' } },
        { meetingTime: 'Monthly · Thu · 6:30 PM', schedule: { days: [4], time: '18:30', cadence: 'monthly' } },
        { meetingTime: 'First & third Thu · 6:30 PM', schedule: { days: [4], time: '18:30', cadence: 'monthly', weeks: [1, 3] } },
        // Weeks already there are not second-guessed, whatever the text says.
        { meetingTime: 'Second Thursday · 6:30 PM', schedule: { days: [4], time: '18:30', cadence: 'monthly', weeks: ['last'] } },
        { meetingTime: 'Biweekly, first Wednesday onward · 7 PM', schedule: { days: [3], time: '19:00', cadence: 'biweekly' } },
        // Refused by the parser, but not for being monthly: these weekly dates are true ones.
        { meetingTime: 'Monday at 7:00 am; Friday at 7:00 am; Friday at 6:30 pm', schedule: { days: [1, 5], time: '07:00', cadence: 'weekly' } },
        { meetingTime: 'Varies', schedule: { days: [1], time: '09:00', cadence: 'weekly' } },
      ].map(club => ({ id: makeClub(club), schedule: club.schedule }));

      assert.deepEqual(deriveMonthlyWeeks(), NOTHING);
      chosen.forEach(({ id, schedule }) => assert.deepEqual(scheduleOf(id), schedule));
    });

    it('writes nothing the second time, and leaves updatedAt meaning somebody edited it', function () {
      const edited = new Date('2026-08-01T00:00:00Z');
      const id = makeClub({ meetingTime: 'First and third Thursdays · 6:30 PM', schedule: { days: [4], time: '18:30', cadence: 'monthly' }, updatedAt: edited });
      makeClub({ meetingTime: 'Coffee Time first Saturday; Book Club fourth Wednesday · 10 AM', schedule: { days: [3, 6], time: '10:00', cadence: 'weekly' } });
      makeClub({ meetingTime: 'Schedule to come' });

      assert.deepEqual(deriveMonthlyWeeks(), { ...NOTHING, weeks: 1, cleared: 1 });
      assert.deepEqual(deriveMonthlyWeeks(), NOTHING);
      assert.deepEqual(scheduleOf(id).weeks, [1, 3]);
      assert.equal(Clubs.collection.findOne(id).updatedAt.getTime(), edited.getTime());
    });
  });
}
