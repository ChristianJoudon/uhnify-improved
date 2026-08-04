/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../club/Club';
import { Events } from '../events/Events';
import { Counters } from './Counters';
import { callAs, makeUser, resetAll } from '../../startup/server/testFixtures';

/**
 * Group numbers.
 *
 * `eventID` on an event is its host group's NUMBER, not its `_id`, and deleting
 * a group deliberately leaves its events alone. That combination makes a reused
 * number an actual data fault rather than an aesthetic one: the next group
 * created inherits the previous holder's listings.
 */
if (Meteor.isServer) {
  describe('group numbering', function () {
    let user;

    const base = {
      name: 'Numbered',
      description: 'A group.',
      location: 'Līhuʻe',
      meetingTime: 'Mondays 5pm',
    };

    beforeEach(function () {
      resetAll();
      Counters.collection.remove({});
      user = makeUser();
    });

    it('hands out a different number every time', function () {
      const ids = [1, 2, 3].map(n => {
        callAs(user, 'Clubs.insert', { ...base, name: `Numbered ${n}` });
        return Clubs.collection.findOne({ name: `Numbered ${n}` }).clubID;
      });
      assert.equal(new Set(ids).size, 3, 'every group needs its own number');
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'and they should climb');
    });

    /**
     * The failure this exists to stop. Max-plus-one gave the deleted group's
     * number straight back, and the orphaned event — which names its host by
     * number — then belonged to a group that never held it.
     */
    it('does not reuse the number of a deleted group', function () {
      const admin = makeUser({ admin: true });
      callAs(user, 'Clubs.insert', { ...base, name: 'First' });
      const first = Clubs.collection.findOne({ name: 'First' });

      // An event that names the group by number, as every event does.
      Events.collection.insert({
        eventID: first.clubID,
        title: 'Belongs to First',
        date: new Date(Date.now() + 86400000),
        location: 'Līhuʻe',
        createdBy: 'test',
      });

      callAs(admin, 'Clubs.remove', first._id);
      callAs(user, 'Clubs.insert', { ...base, name: 'Second' });
      const second = Clubs.collection.findOne({ name: 'Second' });

      assert.notEqual(second.clubID, first.clubID, 'the new group must not inherit the old number');
      const stranded = Events.collection.findOne({ title: 'Belongs to First' });
      assert.notEqual(
        stranded.eventID,
        second.clubID,
        'and so must not adopt the previous holder’s events',
      );
    });

    /**
     * The counter is created on first use against a database that already has
     * groups in it, so it has to start above them rather than from one.
     */
    it('starts above the numbers already in use', function () {
      Clubs.collection.insert({ ...base, clubID: 5000, owner: 'seed', name: 'Pre-existing' });
      callAs(user, 'Clubs.insert', { ...base, name: 'After' });
      assert.isAbove(Clubs.collection.findOne({ name: 'After' }).clubID, 5000);
    });
  });
}
