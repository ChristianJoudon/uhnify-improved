/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Events } from '../../api/events/Events';
import { makeEvent, resetAll } from './testFixtures';
import { dropRedundantCreatedBy } from './migrations';

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
}
