/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../club/Club';
import { Events } from '../events/Events';
import { ImportTombstones } from './ImportTombstones';
import { callAs, makeClub, makeEvent, makeUser, resetAll } from '../../startup/server/testFixtures';

/**
 * The register sync must not undo what an administrator did in the app: a
 * removal leaves a tombstone it honours, an edit leaves a stamp it respects.
 */
if (Meteor.isServer) {
  describe('imported listings and the app’s decisions', function () {
    let admin;
    beforeEach(function () {
      resetAll();
      ImportTombstones.collection.remove({});
      admin = makeUser({ admin: true });
    });

    it('remembers an imported group or event an administrator removed', function () {
      const clubId = makeClub({ owner: 'register', importedFrom: 'register', sourceId: 'org_1' });
      const eventId = makeEvent({ owner: 'register', importedFrom: 'register', sourceId: 'evt_1@2026-10-01' });
      callAs(admin, 'Clubs.remove', clubId);
      callAs(admin, 'Events.remove', eventId);
      const stones = ImportTombstones.collection.find({}).fetch();
      assert.sameMembers(stones.map(s => s.sourceId), ['org_1', 'evt_1@2026-10-01']);
      assert.sameMembers(stones.map(s => s.kind), ['club', 'event']);
      assert.equal(stones[0].removedBy, admin);
    });

    it('leaves no tombstone for something made in the app', function () {
      callAs(admin, 'Events.remove', makeEvent({ owner: 'someone@test.example' }));
      assert.equal(ImportTombstones.collection.find({}).count(), 0);
    });

    it('stamps an imported record an administrator corrects, and only those', function () {
      const imported = makeClub({ owner: 'register', importedFrom: 'register', sourceId: 'org_2' });
      const homemade = makeClub({ owner: 'someone@test.example' });
      const edit = id => callAs(admin, 'Clubs.update', id, {
        name: 'Corrected', owner: Clubs.collection.findOne(id).owner, description: 'Fixed.', location: 'Kapaʻa', meetingTime: 'Thursdays at 6 PM',
      });
      edit(imported);
      edit(homemade);
      assert.instanceOf(Clubs.collection.findOne(imported).curatedAt, Date);
      assert.notProperty(Clubs.collection.findOne(homemade), 'curatedAt');

      const importedEvent = makeEvent({ owner: 'register', importedFrom: 'register', sourceId: 'evt_2', eventID: 0 });
      callAs(admin, 'Events.update', importedEvent, { eventID: 0, title: 'Corrected', date: new Date(Date.now() + 864e5), location: 'Hanalei' });
      assert.instanceOf(Events.collection.findOne(importedEvent).curatedAt, Date);
    });
  });
}
