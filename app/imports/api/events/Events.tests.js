/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Events } from './Events';
import { EventClubs } from './EventClubs';
import { EventSwipes } from './EventSwipes';
import { ProfileClubs } from '../profile/ProfileClubs';
import { Clubs } from '../club/Club';
import { IMAGE_DATA_URL_MAX, TEXT_LIMITS } from '../listing/limits';
import { callAs, errorFrom, makeClub, makeEvent, makeUser, resetAll } from '../../startup/server/testFixtures';

/**
 * Removing things, and what removing them leaves behind.
 *
 * Every delete in this app is a hard delete across several collections with no
 * transaction, so "what is still pointing at the thing that is gone" is not a
 * detail — it is the whole correctness question. These tests exist because two
 * of those cascades were incomplete: a deleted event kept every saved-and-passed
 * row anyone had ever written about it, and a deleted group kept the swipes on
 * the group itself. Orphans of that kind are invisible until a count is wrong.
 */
if (Meteor.isServer) {
  /**
   * The contact email is the one thing about an event that is printed for
   * strangers on the organizer's say-so, so the server owns its shape: what is
   * stored is exactly what the card will show, and blank means the card shows
   * nothing — not '', which would be a value with nothing in it.
   */
  describe('event contact email', function () {
    let user;
    let admin;
    let hostClubID;

    beforeEach(function () {
      resetAll();
      user = makeUser();
      admin = makeUser({ admin: true });
      hostClubID = Clubs.collection.findOne(makeClub()).clubID;
    });

    const listing = overrides => ({
      eventID: hostClubID,
      title: 'Contact Test',
      date: new Date(Date.now() + 86400000),
      location: 'Līhuʻe',
      ...overrides,
    });

    it('stores the address trimmed and lowercased', function () {
      const id = callAs(user, 'Events.insert', listing({ email: '  Hello@TheClub.Example ' }));
      assert.equal(Events.collection.findOne(id).email, 'hello@theclub.example');
    });

    it('stores no field at all when the box was left blank', function () {
      assert.notProperty(Events.collection.findOne(callAs(user, 'Events.insert', listing({ email: '   ' }))), 'email');
      assert.notProperty(Events.collection.findOne(callAs(user, 'Events.insert', listing())), 'email');
    });

    it('never fills it in from the poster’s account', function () {
      const event = Events.collection.findOne(callAs(user, 'Events.insert', listing()));
      assert.notProperty(event, 'email');
      assert.notProperty(event, 'createdBy', 'the account email used to be written here, and published');
    });

    it('rejects an address that does not look like one, and stores nothing', function () {
      ['not an address', 'two@@signs.example', 'no-dot@example', 'a space@here.example', `${'a'.repeat(250)}@x.io`]
        .forEach(email => {
          assert.equal(errorFrom(() => callAs(user, 'Events.insert', listing({ email }))), 'invalid-email', email);
        });
      assert.equal(Events.collection.find().count(), 0);
    });

    it('can be changed, and cleared, by an administrator', function () {
      const id = callAs(user, 'Events.insert', listing({ email: 'old@theclub.example' }));
      callAs(admin, 'Events.update', id, listing({ email: ' New@TheClub.Example ' }));
      assert.equal(Events.collection.findOne(id).email, 'new@theclub.example');
      callAs(admin, 'Events.update', id, listing({ email: '' }));
      assert.notProperty(Events.collection.findOne(id), 'email', 'clearing the box takes the address down');
    });

    it('keeps the old address when the new one is rejected', function () {
      const id = callAs(user, 'Events.insert', listing({ email: 'old@theclub.example' }));
      assert.equal(errorFrom(() => callAs(admin, 'Events.update', id, listing({ email: 'nope' }))), 'invalid-email');
      assert.equal(Events.collection.findOne(id).email, 'old@theclub.example');
    });
  });

  /**
   * How much an event may say, and what its photo may be.
   *
   * Every event is sent to every visitor, so a field with no ceiling is a
   * cost everyone pays. The old page capped the name at 80 and the method
   * capped nothing; the image check accepted 2.8 MB of any content whose
   * string began the right way, including a plain-http link to anywhere,
   * which is a tracking pixel for every visitor who opens the card.
   */
  describe('what an event may say', function () {
    let user;
    let admin;
    let hostClubID;

    const jpeg = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString('base64')}`;

    beforeEach(function () {
      resetAll();
      user = makeUser();
      admin = makeUser({ admin: true });
      hostClubID = Clubs.collection.findOne(makeClub()).clubID;
    });

    const listing = overrides => ({
      eventID: hostClubID,
      title: 'Bounded',
      date: new Date(Date.now() + 86400000),
      location: 'Līhuʻe',
      ...overrides,
    });

    it('refuses a name one character over the limit and keeps one exactly at it', function () {
      const title = 't'.repeat(TEXT_LIMITS.title);
      assert.equal(errorFrom(() => callAs(user, 'Events.insert', listing({ title: `${title}t` }))), 'too-long');
      assert.equal(Events.collection.find().count(), 0, 'nothing is stored from a refused listing');
      const id = callAs(user, 'Events.insert', listing({ title }));
      assert.equal(Events.collection.findOne(id).title, title);
    });

    it('refuses a name that is only whitespace, and stores the rest trimmed', function () {
      assert.equal(errorFrom(() => callAs(user, 'Events.insert', listing({ title: ' \n ' }))), 'required');
      const id = callAs(user, 'Events.insert', listing({ title: '  Spaced  ', location: ' Kapaʻa ', description: ' Bring a chair. ' }));
      const made = Events.collection.findOne(id);
      assert.equal(made.title, 'Spaced');
      assert.equal(made.location, 'Kapaʻa');
      assert.equal(made.description, 'Bring a chair.');
    });

    it('holds an administrator’s edit to the same limits', function () {
      const id = callAs(user, 'Events.insert', listing({ description: 'Short.' }));
      assert.equal(errorFrom(() => callAs(admin, 'Events.update', id, listing({ description: 'd'.repeat(TEXT_LIMITS.description + 1) }))), 'too-long');
      assert.equal(Events.collection.findOne(id).description, 'Short.', 'a refused edit changes nothing');
    });

    it('takes a real photo and draws the stock one when there is none', function () {
      assert.equal(Events.collection.findOne(callAs(user, 'Events.insert', listing({ image: jpeg }))).image, jpeg);
      assert.equal(Events.collection.findOne(callAs(user, 'Events.insert', listing({ image: '' }))).image, '/images/codingWorkshop.png');
    });

    it('refuses a link, a mislabelled file and a photo past the size ceiling', function () {
      assert.equal(errorFrom(() => callAs(user, 'Events.insert', listing({ image: 'http://elsewhere.example/pixel.gif' }))), 'invalid-image');
      assert.equal(errorFrom(() => callAs(user, 'Events.insert', listing({ image: 'data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUg==' }))), 'invalid-image', 'PNG bytes under a JPEG label');
      assert.equal(errorFrom(() => callAs(user, 'Events.insert', listing({ image: `data:text/html;base64,${Buffer.from('<script>1</script>').toString('base64')}` }))), 'invalid-image');
      assert.equal(errorFrom(() => callAs(user, 'Events.insert', listing({ image: jpeg.padEnd(IMAGE_DATA_URL_MAX + 1, 'A') }))), 'image-too-large');
      assert.equal(Events.collection.find().count(), 0);
    });
  });

  describe('removal cascades', function () {
    let admin;
    let member;

    beforeEach(function () {
      resetAll();
      admin = makeUser({ admin: true });
      member = makeUser();
    });

    describe('Events.remove', function () {
      it('needs an administrator', function () {
        const eventId = makeEvent();
        assert.equal(errorFrom(() => callAs(member, 'Events.remove', eventId)), 'not-authorized');
        assert.equal(errorFrom(() => callAs(null, 'Events.remove', eventId)), 'not-logged-in');
        assert.equal(Events.collection.find().count(), 1, 'nothing should have been removed');
      });

      it('takes the saved-and-passed rows with it', function () {
        const eventId = makeEvent();
        callAs(member, 'eventSwipes.record', eventId, 'interested');
        assert.equal(EventSwipes.collection.find({ eventId }).count(), 1);

        callAs(admin, 'Events.remove', eventId);

        assert.equal(Events.collection.find({ _id: eventId }).count(), 0);
        assert.equal(
          EventSwipes.collection.find({ eventId }).count(),
          0,
          'a swipe on a deleted event still counts towards someone’s saved list',
        );
      });

      it('takes its group links with it', function () {
        const eventId = makeEvent();
        const clubId = makeClub();
        EventClubs.collection.insert({ clubId, eventId, userId: member, createdAt: new Date() });

        callAs(admin, 'Events.remove', eventId);
        assert.equal(EventClubs.collection.find({ eventId }).count(), 0);
      });
    });

    describe('Clubs.remove', function () {
      it('takes memberships, links and swipes on the group itself', function () {
        const clubId = makeClub();
        callAs(member, 'profileClubs.add', clubId);
        callAs(member, 'eventSwipes.record', clubId, 'interested', 'club');
        EventClubs.collection.insert({ clubId, eventId: makeEvent(), userId: member, createdAt: new Date() });

        callAs(admin, 'Clubs.remove', clubId);

        assert.equal(Clubs.collection.find({ _id: clubId }).count(), 0);
        assert.equal(ProfileClubs.collection.find({ clubId }).count(), 0, 'membership of a deleted group');
        assert.equal(EventClubs.collection.find({ clubId }).count(), 0, 'link from a deleted group');
        assert.equal(EventSwipes.collection.find({ eventId: clubId }).count(), 0, 'swipe on a deleted group');
      });

      /**
       * The deliberate non-cascade, pinned so nobody "fixes" it into a delete.
       *
       * An event outlives the group that listed it: it may be linked to others,
       * and the wall reads it on its own terms. Deleting a group must remove the
       * LINK, never the listing.
       */
      it('does not delete the group’s events', function () {
        const clubId = makeClub();
        const eventId = makeEvent();
        EventClubs.collection.insert({ clubId, eventId, userId: member, createdAt: new Date() });

        callAs(admin, 'Clubs.remove', clubId);

        assert.equal(Events.collection.find({ _id: eventId }).count(), 1, 'the event itself must survive');
        assert.equal(EventClubs.collection.find({ clubId }).count(), 0, 'but not the link to a group that is gone');
      });
    });

    describe('eventSwipes.record', function () {
      it('refuses a signed-out caller', function () {
        assert.equal(errorFrom(() => callAs(null, 'eventSwipes.record', makeEvent(), 'interested')), 'not-logged-in');
      });

      it('refuses a decision it does not recognise', function () {
        assert.equal(
          errorFrom(() => callAs(member, 'eventSwipes.record', makeEvent(), 'maybe')),
          'invalid-decision',
        );
      });

      it('refuses a listing that does not exist', function () {
        assert.equal(errorFrom(() => callAs(member, 'eventSwipes.record', 'no-such-id', 'interested')), 'not-found');
      });

      it('records one row per person per listing, not one per swipe', function () {
        const eventId = makeEvent();
        callAs(member, 'eventSwipes.record', eventId, 'interested');
        callAs(member, 'eventSwipes.record', eventId, 'passed');
        assert.equal(EventSwipes.collection.find({ userId: member, eventId }).count(), 1);
        assert.equal(EventSwipes.collection.findOne({ userId: member, eventId }).decision, 'passed');
      });
    });
  });
}
