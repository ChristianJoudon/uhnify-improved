/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from './Club';
import { Events } from '../events/Events';
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
}
