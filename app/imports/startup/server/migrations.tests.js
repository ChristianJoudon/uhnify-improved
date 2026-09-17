/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { makeClub, makeEvent, makeUser, resetAll } from './testFixtures';
import { dropRedundantCreatedBy, renameInterestedSwipes } from './migrations';

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
}
