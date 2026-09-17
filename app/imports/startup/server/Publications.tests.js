/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventClubs } from '../../api/events/EventClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import { callAs, makeClub, makeEvent, makeUser, resetAll } from './testFixtures';
import {
  friendClubActivitySelector,
  friendEventActivitySelector,
} from './Publications';

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
      // `createdBy` is what an older record still carries: the same address,
      // written a second time — and for a long while the copy not withheld.
      makeEvent({ owner: 'someone@private.example', createdBy: 'someone@private.example' });
    });

    it('does not send club owners to a signed-out visitor', function () {
      const docs = docsFrom(publishAs(null, Clubs.userPublicationName));
      assert.isAbove(docs.length, 0, 'the directory is public and should still be sent');
      docs.forEach(doc => assert.isUndefined(doc.owner, 'owner is an email address'));
    });

    it('does not send event owners to a signed-out visitor, under either name', function () {
      const docs = docsFrom(publishAs(null, Events.userPublicationName));
      assert.isAbove(docs.length, 0);
      docs.forEach(doc => {
        assert.isUndefined(doc.owner);
        assert.isUndefined(doc.createdBy, 'the same address under another key');
      });
    });

    it('does not send owners through clubs.all either', function () {
      const docs = docsFrom(publishAs(null, 'clubs.all'));
      docs.forEach(doc => assert.isUndefined(doc.owner));
    });

    it('keeps staged ingestion records out of public publications', function () {
      const draftClubId = makeClub({ publicationStatus: 'draft' });
      const draftEventId = makeEvent({ publicationStatus: 'draft' });

      const publicClubIds = docsFrom(publishAs(null, Clubs.userPublicationName)).map(doc => doc._id);
      const publicEventIds = docsFrom(publishAs(null, Events.userPublicationName)).map(doc => doc._id);
      const adminClubIds = docsFrom(publishAs(makeUser({ admin: true }), Clubs.adminPublicationName))
        .map(doc => doc._id);

      assert.notInclude(publicClubIds, draftClubId);
      assert.notInclude(publicEventIds, draftEventId);
      assert.include(adminClubIds, draftClubId, 'administrators can recover a staged projection');
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

    it('still sends who posted an event to an administrator', function () {
      const admin = makeUser({ admin: true });
      const docs = docsFrom(publishAs(admin, Events.adminPublicationName));
      assert.isAbove(docs.length, 0);
      assert.equal(docs[0].owner, 'someone@private.example', 'the admin editor prints who posted it');
    });

    it('sends nothing to a non-administrator asking for the admin publication', function () {
      const plain = makeUser();
      assert.equal(docsFrom(publishAs(plain, Clubs.adminPublicationName)).length, 0);
    });

    it('does not publish profile interests through the people directory', function () {
      const viewer = makeUser();
      Profiles.collection.update({}, { $set: { interests: ['Support Groups'] } }, { multi: true });
      const docs = docsFrom(publishAs(viewer, 'Profiles.publication.directory'));
      assert.isAbove(docs.length, 0);
      docs.forEach(doc => assert.isUndefined(doc.interests));
    });

    it('excludes support joins and saves from friend-activity selectors', function () {
      const friendId = makeUser();
      const ordinaryClubId = makeClub({ categories: ['community'] });
      const supportClubId = makeClub({ categories: ['support_group'] });
      const ordinaryEventId = makeEvent({ categories: ['community'] });
      const supportEventId = makeEvent({ categories: ['support_group'] });
      callAs(friendId, 'profileClubs.add', ordinaryClubId);
      callAs(friendId, 'profileClubs.add', supportClubId);
      callAs(friendId, 'eventSwipes.record', ordinaryEventId, 'interested');
      callAs(friendId, 'eventSwipes.record', supportEventId, 'interested');
      callAs(friendId, 'eventSwipes.record', supportClubId, 'interested', 'club');

      assert.deepEqual(
        ProfileClubs.collection.find(friendClubActivitySelector(friendId)).map(row => row.clubId),
        [ordinaryClubId],
      );
      assert.deepEqual(
        EventSwipes.collection.find(friendEventActivitySelector(friendId)).map(row => row.eventId),
        [ordinaryEventId],
      );
    });

    it('removes an existing membership from a live selector when its group becomes sensitive', function () {
      const admin = makeUser({ admin: true });
      const friendId = makeUser();
      const clubId = makeClub({ categories: ['community'] });
      callAs(friendId, 'profileClubs.add', clubId);
      const selector = friendClubActivitySelector(friendId);
      assert.deepEqual(ProfileClubs.collection.find(selector).map(row => row.clubId), [clubId]);

      const club = Clubs.collection.findOne(clubId);
      callAs(admin, 'Clubs.update', clubId, {
        clubID: club.clubID,
        name: club.name,
        owner: club.owner,
        description: club.description,
        location: club.location,
        meetingTime: club.meetingTime,
        contactInfo: club.contactInfo || '',
        categories: ['support_group'],
        tags: club.tags || [],
      });

      assert.deepEqual(ProfileClubs.collection.find(selector).fetch(), []);
    });
  });

  /**
   * The member publications answer to any account, and sign-up is open, so
   * "members only" is no boundary at all. They used to send whole documents:
   * join a group, and the address of whoever founded it — and of whoever
   * posted each of its events — arrived with the listing.
   */
  describe('member publications', function () {
    let member;

    beforeEach(function () {
      resetAll();
      member = makeUser();
      const clubId = makeClub({ owner: 'founder@private.example' });
      callAs(member, 'profileClubs.add', clubId);
      makeEvent({
        eventID: Clubs.collection.findOne(clubId).clubID,
        owner: 'poster@private.example',
        createdBy: 'poster@private.example',
      });
    });

    it('does not send who founded a joined group', function () {
      const docs = docsFrom(publishAs(member, ProfileClubs.userPublicationName));
      assert.isAbove(docs.length, 0, 'the joined group itself should still be sent');
      docs.forEach(doc => assert.isUndefined(doc.owner));
    });

    it('does not send who posted a joined group’s events', function () {
      const docs = docsFrom(publishAs(member, EventClubs.userPublicationName));
      assert.isAbove(docs.length, 0, 'the group’s event itself should still be sent');
      docs.forEach(doc => {
        assert.isUndefined(doc.owner);
        assert.isUndefined(doc.createdBy);
      });
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
