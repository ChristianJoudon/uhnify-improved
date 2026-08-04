/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { callAs, makeClub, makeEvent, makeUser, resetAll } from './testFixtures';
import './Publications';

/**
 * What a stranger can see.
 *
 * Three of these publications answer to anyone at all — no account, no login —
 * because the directory is meant to be public. That makes their field list a
 * security boundary rather than a performance detail, and it was leaking: the
 * server stamps `owner` onto every club and event it creates, `owner` is an
 * account name, and an account name here resolves to an email address. Any
 * visitor could subscribe from a browser console and read the address of
 * everyone who had ever posted.
 *
 * Testing a publication means calling its handler the way the server does and
 * looking at the cursor it returns — there is no subscriber involved, which is
 * the point: this asserts what the SERVER would send, not what some client
 * happened to ask for.
 */
const publishAs = (userId, name) => {
  const handler = Meteor.server.publish_handlers[name];
  if (!handler) {
    throw new Error(`No such publication: ${name}`);
  }
  return handler.apply({ userId, ready: () => null, onStop: () => {} }, []);
};

const docsFrom = cursor => (cursor && typeof cursor.fetch === 'function' ? cursor.fetch() : []);

if (Meteor.isServer) {
  describe('public publications', function () {
    beforeEach(function () {
      resetAll();
      makeClub({ owner: 'someone@private.example' });
      makeEvent({ owner: 'someone@private.example' });
    });

    it('does not send club owners to a signed-out visitor', function () {
      const docs = docsFrom(publishAs(null, Clubs.userPublicationName));
      assert.isAbove(docs.length, 0, 'the directory is public and should still be sent');
      docs.forEach(doc => assert.isUndefined(doc.owner, 'owner is an email address'));
    });

    it('does not send event owners to a signed-out visitor', function () {
      const docs = docsFrom(publishAs(null, Events.userPublicationName));
      assert.isAbove(docs.length, 0);
      docs.forEach(doc => assert.isUndefined(doc.owner));
    });

    it('does not send owners through clubs.all either', function () {
      const docs = docsFrom(publishAs(null, 'clubs.all'));
      docs.forEach(doc => assert.isUndefined(doc.owner));
    });

    /**
     * The admin editor is the only screen that reads `owner`, and it subscribes
     * to this one. Withholding it here would break that form, so the boundary
     * has to be drawn per-publication rather than per-field.
     */
    it('still sends owners to an administrator', function () {
      const admin = makeUser({ admin: true });
      const docs = docsFrom(publishAs(admin, Clubs.adminPublicationName));
      assert.isAbove(docs.length, 0);
      assert.isDefined(docs[0].owner, 'the admin editor needs this field');
    });

    it('sends nothing to a non-administrator asking for the admin publication', function () {
      const plain = makeUser();
      assert.equal(docsFrom(publishAs(plain, Clubs.adminPublicationName)).length, 0);
    });
  });

  describe('Clubs.insert contact details', function () {
    beforeEach(function () {
      resetAll();
    });

    const base = {
      name: 'Contact Test',
      description: 'A group.',
      location: 'Līhuʻe',
      meetingTime: 'Mondays 5pm',
    };

    /**
     * Leaving the optional contact box empty used to publish the creator's
     * email on the card, because the default was their account name. Blank has
     * to mean blank — the card then draws no contact row at all.
     */
    it('leaves the contact blank when none was given', function () {
      const user = makeUser({ email: 'creator@test.example' });
      callAs(user, 'Clubs.insert', base);
      const club = Clubs.collection.findOne({ name: 'Contact Test' });
      assert.notInclude(club.contactInfo || '', 'creator@test.example');
      assert.isNotOk(club.contactInfo, 'blank means blank');
    });

    it('keeps a contact the organizer chose to publish', function () {
      const user = makeUser();
      callAs(user, 'Clubs.insert', { ...base, contactInfo: 'hello@theclub.example' });
      assert.equal(Clubs.collection.findOne({ name: 'Contact Test' }).contactInfo, 'hello@theclub.example');
    });
  });
}
