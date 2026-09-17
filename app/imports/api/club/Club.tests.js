/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from './Club';
import { Events } from '../events/Events';
import { LIST_MAX_ENTRIES, TEXT_LIMITS } from '../listing/limits';
import { callAs, errorFrom, makeUser, resetAll } from '../../startup/server/testFixtures';

/**
 * When a listing was made, and when it last changed.
 *
 * The audit trail answers who changed what, but it is a separate collection and
 * capped — the documents themselves still could not say how old they were. On a
 * directory of local events that is the difference between "this group meets
 * Mondays" and "this group met Mondays, two years ago".
 */
if (Meteor.isServer) {
  describe('listing timestamps', function () {
    let user;
    let admin;

    const club = {
      name: 'Stamped',
      description: 'A group.',
      location: 'Līhuʻe',
      meetingTime: 'Mondays 5pm',
    };

    beforeEach(function () {
      resetAll();
      user = makeUser();
      admin = makeUser({ admin: true });
    });

    it('stamps a new group with both times', function () {
      callAs(user, 'Clubs.insert', club);
      const made = Clubs.collection.findOne({ name: 'Stamped' });
      assert.instanceOf(made.createdAt, Date);
      assert.instanceOf(made.updatedAt, Date);
    });

    it('moves updatedAt on an edit and leaves createdAt alone', function () {
      callAs(user, 'Clubs.insert', club);
      const made = Clubs.collection.findOne({ name: 'Stamped' });

      callAs(admin, 'Clubs.update', made._id, {
        name: 'Stamped and edited',
        owner: 'someone',
        description: 'Changed.',
        location: 'Līhuʻe',
        meetingTime: 'Tuesdays 6pm',
      });

      const after = Clubs.collection.findOne(made._id);
      assert.equal(
        after.createdAt.getTime(),
        made.createdAt.getTime(),
        'when it was made does not change when it is edited',
      );
      assert.isAtLeast(after.updatedAt.getTime(), made.updatedAt.getTime());
    });

    it('stamps a new event too', function () {
      callAs(user, 'Clubs.insert', club);
      const host = Clubs.collection.findOne({ name: 'Stamped' });
      callAs(user, 'Events.insert', {
        eventID: host.clubID,
        title: 'Stamped event',
        date: new Date(Date.now() + 86400000).toISOString(),
        location: 'Līhuʻe',
      });
      const made = Events.collection.findOne({ title: 'Stamped event' });
      assert.instanceOf(made.createdAt, Date);
      assert.instanceOf(made.updatedAt, Date);
    });

    it('inherits the host group category for a locally created support meeting', function () {
      callAs(user, 'Clubs.insert', { ...club, categories: 'support_group' });
      const host = Clubs.collection.findOne({ name: 'Stamped' });
      callAs(user, 'Events.insert', {
        eventID: host.clubID,
        title: 'Peer meeting',
        date: new Date(Date.now() + 86400000).toISOString(),
        location: 'Līhuʻe',
      });

      const made = Events.collection.findOne({ title: 'Peer meeting' });
      assert.deepEqual(made.categories, ['support_group']);
      assert.equal(made.hostName, 'Stamped');
    });

    it('preserves imported event categories when an administrator changes its host', function () {
      callAs(user, 'Clubs.insert', { ...club, categories: 'support_group' });
      const host = Clubs.collection.findOne({ name: 'Stamped' });
      const importedId = Events.collection.insert({
        eventID: 0,
        title: 'Imported event',
        description: 'Source-owned categories.',
        date: new Date(Date.now() + 86400000),
        location: 'Kapaʻa',
        createdBy: 'register',
        importedFrom: 'Register',
        categories: ['arts_culture'],
      });

      callAs(admin, 'Events.update', importedId, {
        eventID: host.clubID,
        title: 'Imported event',
        description: 'Source-owned categories.',
        date: new Date(Date.now() + 86400000).toISOString(),
        location: 'Kapaʻa',
      });

      assert.deepEqual(Events.collection.findOne(importedId).categories, ['arts_culture']);
    });

    /**
     * The seeded register predates these fields, which is why both are
     * optional. A required timestamp would have rejected every imported
     * record — and backfilling a guessed date would be worse than an absent
     * one, because a guess reads as fact.
     */
    it('accepts a record that has no timestamps at all', function () {
      const id = Clubs.collection.insert({
        clubID: 99001, name: 'From the register', owner: 'register',
        description: 'Imported.', location: 'Līhuʻe', meetingTime: 'Varies',
      });
      assert.isOk(Clubs.collection.findOne(id), 'imported records must still validate');
    });

    it('still refuses an edit from a non-administrator', function () {
      callAs(user, 'Clubs.insert', club);
      const made = Clubs.collection.findOne({ name: 'Stamped' });
      assert.equal(errorFrom(() => callAs(user, 'Clubs.update', made._id, {
        name: 'Hijacked', owner: 'x', description: 'x', location: 'x', meetingTime: 'x',
      })), 'not-authorized');
    });
  });

  /**
   * How much a group may say about itself, and what it may show.
   *
   * The Start a group page capped its name box at 70 characters and the method
   * behind it capped nothing, so the cap was a courtesy to people using the
   * form and no obstacle to anyone else. The limits now live on the server,
   * and these pin the edges: one character over is refused, exactly at it is
   * stored.
   */
  describe('what a group may say', function () {
    let user;
    let admin;

    const club = {
      name: 'Bounded',
      description: 'A group.',
      location: 'Līhuʻe',
      meetingTime: 'Mondays 5pm',
    };
    const jpeg = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString('base64')}`;

    beforeEach(function () {
      resetAll();
      user = makeUser();
      admin = makeUser({ admin: true });
    });

    it('refuses a name one character over the limit and keeps one exactly at it', function () {
      const name = 'n'.repeat(TEXT_LIMITS.name);
      assert.equal(errorFrom(() => callAs(user, 'Clubs.insert', { ...club, name: `${name}n` })), 'too-long');
      assert.equal(Clubs.collection.find().count(), 0, 'nothing is stored from a refused listing');
      callAs(user, 'Clubs.insert', { ...club, name });
      assert.equal(Clubs.collection.findOne().name, name);
    });

    it('refuses a description past its own, larger, ceiling', function () {
      assert.equal(errorFrom(() => callAs(user, 'Clubs.insert', { ...club, description: 'd'.repeat(TEXT_LIMITS.description + 1) })), 'too-long');
    });

    it('refuses a name that is only whitespace', function () {
      assert.equal(errorFrom(() => callAs(user, 'Clubs.insert', { ...club, name: '   ' })), 'required');
    });

    it('stores what was written without the surrounding whitespace', function () {
      callAs(user, 'Clubs.insert', { ...club, name: '  Trimmed  ', location: ' Kapaʻa ', contactInfo: ' hello@theclub.example ' });
      const made = Clubs.collection.findOne();
      assert.equal(made.name, 'Trimmed');
      assert.equal(made.location, 'Kapaʻa');
      assert.equal(made.contactInfo, 'hello@theclub.example');
    });

    it('holds an administrator’s edit to the same limits', function () {
      callAs(user, 'Clubs.insert', club);
      const made = Clubs.collection.findOne();
      const edit = { name: 'Bounded', owner: made.owner, description: 'A group.', location: 'Līhuʻe', meetingTime: 'Mondays 5pm' };
      assert.equal(errorFrom(() => callAs(admin, 'Clubs.update', made._id, { ...edit, location: 'l'.repeat(TEXT_LIMITS.location + 1) })), 'too-long');
      assert.equal(Clubs.collection.findOne(made._id).location, 'Līhuʻe', 'a refused edit changes nothing');
    });

    /**
     * Categories come from a chip input and the seed, neither of which makes
     * a long one, so this ceiling is for a direct call: each label is cut to
     * its limit and the list to its count, as tags already were, instead of
     * the lot being sent to every visitor with the card. Both shapes the
     * method accepts — a list, and one comma-separated string — are held.
     */
    it('cuts a category to its ceiling and the list to its count', function () {
      const long = 'c'.repeat(TEXT_LIMITS.category + 1);
      const many = Array.from({ length: LIST_MAX_ENTRIES + 5 }, (_, i) => `category ${i}`);
      callAs(user, 'Clubs.insert', { ...club, categories: [long, ...many] });
      const made = Clubs.collection.findOne();
      assert.equal(made.categories[0], 'c'.repeat(TEXT_LIMITS.category));
      assert.lengthOf(made.categories, LIST_MAX_ENTRIES);

      callAs(admin, 'Clubs.update', made._id, {
        name: 'Bounded', owner: made.owner, description: 'A group.', location: 'Līhuʻe', meetingTime: 'Mondays 5pm',
        categories: [long, ...many].join(', '),
      });
      const edited = Clubs.collection.findOne(made._id);
      assert.equal(edited.categories[0], 'c'.repeat(TEXT_LIMITS.category));
      assert.lengthOf(edited.categories, LIST_MAX_ENTRIES);
    });

    it('takes a real photo, no photo, and nothing else', function () {
      callAs(user, 'Clubs.insert', { ...club, image: jpeg });
      assert.equal(Clubs.collection.findOne().image, jpeg);
      callAs(user, 'Clubs.insert', { ...club, name: 'Unillustrated', image: '' });
      // The form sends '' for "no photo"; collection2 strips an empty string
      // on the way in, so none is stored as no field, which is what the card
      // reads as "draw it from the topic".
      assert.notProperty(Clubs.collection.findOne({ name: 'Unillustrated' }), 'image');
      assert.equal(errorFrom(() => callAs(user, 'Clubs.insert', { ...club, image: 'http://elsewhere.example/pixel.gif' })), 'invalid-image');
      assert.equal(errorFrom(() => callAs(user, 'Clubs.insert', { ...club, image: 'data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUg==' })), 'invalid-image', 'PNG bytes under a JPEG label');
      assert.equal(Clubs.collection.find().count(), 2);
    });
  });
}
