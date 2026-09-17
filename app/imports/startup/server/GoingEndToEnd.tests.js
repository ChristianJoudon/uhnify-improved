/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { EventSwipes } from '../../api/events/EventSwipes';
import { EventRSVPs, RecommendationInteractions } from '../../api/recommendations/RecommendationData';
import { callAs, makeEvent, makeUser, resetAll, resetRecommendations } from './testFixtures';
import { friendActivityPublication } from './Publications';

const docsFrom = cursor => (cursor && typeof cursor.fetch === 'function' ? cursor.fetch() : []);

if (Meteor.isServer) {
  /**
   * One gesture, followed through every layer that hears about it.
   *
   * Going was built in four pieces — the swipe, the recommender's record of
   * it, the privacy rules, and the publication a friend reads — and each piece
   * is tested where it lives. None of those tests would notice two of them
   * agreeing on a different word. This one says "going" once, as the deck
   * does, and then asks every layer what it heard.
   */
  describe('Going, end to end', function () {
    this.timeout(10000);

    let swiper;
    let friend;
    let eventId;
    let sensitiveEventId;

    const sentFrom = (node, args = []) => docsFrom(node.find(...args)).flatMap(doc => [
      doc,
      ...(node.children || []).flatMap(child => sentFrom(child, [doc, ...args])),
    ]);
    const eventsShownTo = userId => sentFrom(friendActivityPublication(userId))
      .filter(doc => doc.eventId)
      .map(doc => doc.eventId);
    const actionsFor = entityId => RecommendationInteractions.collection
      .find({ userId: swiper, entityId }, { sort: { createdAt: 1 } })
      .map(row => row.action);

    beforeEach(function () {
      resetAll();
      resetRecommendations();
      swiper = makeUser();
      friend = makeUser();
      callAs(friend, 'friends.accept', callAs(swiper, 'friends.request', friend));
      eventId = makeEvent({ categories: ['music'] });
      sensitiveEventId = makeEvent({ categories: ['recovery'] });
    });

    it('carries a right swipe to the recommender and, only with consent, to a friend', function () {
      callAs(swiper, 'eventSwipes.record', eventId, 'going', 'event');
      callAs(swiper, 'eventSwipes.record', sensitiveEventId, 'going', 'event');

      assert.equal(EventSwipes.collection.findOne({ userId: swiper, eventId }).decision, 'going');
      assert.deepEqual(actionsFor(eventId), ['rsvp_going']);
      assert.equal(EventRSVPs.collection.findOne({ userId: swiper, eventId }).status, 'going');
      assert.deepEqual(eventsShownTo(friend), [], 'nothing is shown until the person says it may be');

      callAs(swiper, 'Profiles.setFriendActivitySharing', true);
      assert.deepEqual(eventsShownTo(friend), [eventId], 'the ordinary event, and never the sensitive one');

      callAs(swiper, 'eventSwipes.remove', eventId, 'rsvp_canceled');
      assert.isUndefined(EventSwipes.collection.findOne({ userId: swiper, eventId }));
      assert.deepEqual(actionsFor(eventId), ['rsvp_going', 'rsvp_canceled']);
      assert.equal(EventRSVPs.collection.findOne({ userId: swiper, eventId }).status, 'canceled');
      assert.deepEqual(eventsShownTo(friend), [], 'a plan taken back is no longer shown');
    });

    it('shows a friend a Going said after opting in, and still not a sensitive one', function () {
      callAs(swiper, 'Profiles.setFriendActivitySharing', true);
      callAs(swiper, 'eventSwipes.record', eventId, 'going', 'event');
      callAs(swiper, 'eventSwipes.record', sensitiveEventId, 'going', 'event');

      assert.deepEqual(eventsShownTo(friend), [eventId]);
      assert.equal(EventRSVPs.collection.findOne({ userId: swiper, eventId: sensitiveEventId }).status, 'going');
    });
  });
}
