/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Profiles } from '../profiles/Profiles';
import {
  EventAttendances,
  EventRSVPs,
  RecommendationEmbeddings,
  RecommendationGraphEdges,
  RecommendationImpressions,
  RecommendationInteractions,
  RecommendationModelVersions,
  RecommendationPreferences,
  RecommendationRequests,
  UserItemStates,
} from './RecommendationData';
import { recordRecommendationInteraction } from './interactionRecorder';
import {
  callAs,
  errorFrom,
  makeClub,
  makeEvent,
  makeUser,
  resetAll,
  resetRecommendations,
} from '../../startup/server/testFixtures';

if (Meteor.isServer) {
  describe('recommendation methods', function () {
    this.timeout(10000);

    let userId;

    beforeEach(function () {
      resetAll();
      resetRecommendations();
      userId = makeUser();
    });

    it('always returns a baseline for a new user with a sparse event', function () {
      const eventId = makeEvent({
        description: '',
        categories: undefined,
        hostName: undefined,
      });
      const response = callAs(userId, 'recommendations.get', { kind: 'event', surface: 'test' });

      assert.equal(response.items[0]._id, eventId);
      assert.equal(response.selectedTier, 'baseline');
      assert.deepEqual(response.items[0].componentsUsed, ['baseline']);
      assert.isFinite(response.items[0].recommendationScore);
      assert.equal(RecommendationRequests.collection.find({ userId }).count(), 1);
    });

    it('requires a signed-in user', function () {
      assert.equal(errorFrom(() => callAs(null, 'recommendations.get', {})), 'not-logged-in');
    });

    it('does not return account-derived owner fields', function () {
      makeEvent({ owner: 'private-owner@example.com' });
      const response = callAs(userId, 'recommendations.get', { kind: 'event' });
      assert.notProperty(response.items[0], 'owner');
    });

    // Unordered on purpose: two writes can share a millisecond, and what each
    // test cares about in sequence it reads from the state row instead.
    const actionsFor = entityId => RecommendationInteractions.collection
      .find({ userId, entityId })
      .map(interaction => interaction.action);

    it('keeps one current swipe while preserving every decision in history', function () {
      const eventId = makeEvent();
      callAs(userId, 'eventSwipes.record', eventId, 'passed');
      assert.equal(UserItemStates.collection.findOne({ userId, entityId: eventId }).interestState, 'passed');

      callAs(userId, 'eventSwipes.remove', eventId);
      assert.sameMembers(actionsFor(eventId), ['passed', 'undo']);
      assert.equal(UserItemStates.collection.findOne({ userId, entityId: eventId }).interestState, 'neutral');
    });

    /**
     * The owner's decision, end to end: a right swipe on an event is an RSVP.
     * It is logged as one, kept as one, takes the event out of the deck, and
     * "Not going" undoes all three.
     */
    it('records a right swipe on an event as Going, and "Not going" as the cancellation', function () {
      const eventId = makeEvent();
      const otherId = makeEvent();
      const idsOn = surface => callAs(userId, 'recommendations.get', { kind: 'event', surface })
        .items.map(item => item._id);
      const dealt = () => idsOn('swipe_deck');

      callAs(userId, 'eventSwipes.record', eventId, 'going');
      assert.deepEqual(actionsFor(eventId), ['rsvp_going']);
      assert.equal(EventRSVPs.collection.findOne({ userId, eventId }).status, 'going');
      assert.equal(UserItemStates.collection.findOne({ userId, entityId: eventId }).rsvpStatus, 'going');
      assert.deepEqual(dealt(), [otherId], 'an event the person is going to is not dealt again');
      // The wall re-sorts on every swipe and puts a card without a position
      // last, so dropping it here moved it out from under the person's thumb.
      assert.sameMembers(
        idsOn('discover_feed'),
        [eventId, otherId],
        'the wall keeps ranking an event the person is going to',
      );

      callAs(userId, 'eventSwipes.remove', eventId, 'rsvp_canceled');
      assert.sameMembers(actionsFor(eventId), ['rsvp_going', 'rsvp_canceled']);
      assert.equal(EventRSVPs.collection.findOne({ userId, eventId }).status, 'canceled');
      assert.equal(UserItemStates.collection.findOne({ userId, entityId: eventId }).rsvpStatus, 'canceled');
      assert.sameMembers(dealt(), [eventId, otherId], 'a cancelled plan may be offered again');
    });

    it('clears an earlier pass when the person says they are going after all', function () {
      const eventId = makeEvent();
      recordRecommendationInteraction({ userId, entityType: 'event', entityId: eventId, action: 'passed' });
      recordRecommendationInteraction({ userId, entityType: 'event', entityId: eventId, action: 'rsvp_going' });

      const state = UserItemStates.collection.findOne({ userId, entityId: eventId });
      assert.equal(state.rsvpStatus, 'going');
      assert.equal(state.interestState, 'neutral', 'a state row must not say passed and going at once');
    });

    it('ends the graph edge of a cancelled plan, and of a group that was left', function () {
      const eventId = makeEvent();
      const clubId = makeClub();
      const openEdges = (toId, relation) => RecommendationGraphEdges.collection
        .find({ fromId: userId, toId, relation, validTo: { $exists: false } }).count();

      recordRecommendationInteraction({ userId, entityType: 'event', entityId: eventId, action: 'rsvp_going' });
      recordRecommendationInteraction({ userId, entityType: 'group', entityId: clubId, action: 'joined_group' });
      assert.equal(openEdges(eventId, 'rsvp_going'), 1);
      assert.equal(openEdges(clubId, 'joined_group'), 1);

      recordRecommendationInteraction({ userId, entityType: 'event', entityId: eventId, action: 'rsvp_canceled' });
      recordRecommendationInteraction({ userId, entityType: 'group', entityId: clubId, action: 'left_group' });
      assert.equal(openEdges(eventId, 'rsvp_going'), 0);
      assert.equal(openEdges(clubId, 'joined_group'), 0);
      // Ended, not erased: the history is still there for anything that wants it.
      assert.equal(RecommendationGraphEdges.collection.find({ fromId: userId, toId: eventId }).count(), 1);
    });

    it('refuses to add to a retired action', function () {
      const eventId = makeEvent();
      ['interested', 'saved', 'unsaved'].forEach(action => {
        assert.equal(errorFrom(() => recordRecommendationInteraction({
          userId, entityType: 'event', entityId: eventId, action,
        })), 'retired-action');
      });
      assert.equal(RecommendationInteractions.collection.find({ userId }).count(), 0);
    });

    /**
     * The log is what models are trained on and what the RSVP and attendance
     * collections are written from. A browser may report what only a browser
     * can see; it may not award itself an attendance.
     */
    describe('who may record what', function () {
      const fromClient = (action, entityType, entityId) => errorFrom(() => callAs(
        userId,
        'recommendationInteractions.record',
        { entityType, entityId, action, clientEventId: `client:${action}` },
      ));

      it('refuses a client call for anything the server records itself', function () {
        const eventId = makeEvent();
        const clubId = makeClub();

        assert.equal(fromClient('attendance_verified', 'event', eventId), 'not-authorized');
        assert.equal(fromClient('rsvp_going', 'event', eventId), 'not-authorized');
        assert.equal(fromClient('joined_group', 'group', clubId), 'not-authorized');
        assert.equal(fromClient('made_up', 'event', eventId), 'invalid-action');

        assert.equal(RecommendationInteractions.collection.find({ userId }).count(), 0);
        assert.equal(EventRSVPs.collection.find({ userId }).count(), 0);
        assert.equal(EventAttendances.collection.find({ userId }).count(), 0);
      });

      it('still accepts what only the browser can know', function () {
        const eventId = makeEvent();
        ['opened', 'flipped', 'calendar_added'].forEach(action => {
          assert.isNull(fromClient(action, 'event', eventId));
        });
        assert.equal(RecommendationInteractions.collection.find({ userId, source: 'user' }).count(), 3);
      });

      it('records the same actions when server code reports them', function () {
        const eventId = makeEvent();
        const clubId = makeClub();
        recordRecommendationInteraction({
          userId,
          entityType: 'event',
          entityId: eventId,
          action: 'attendance_verified',
          context: { verificationSource: 'door-list' },
        });
        recordRecommendationInteraction({ userId, entityType: 'event', entityId: eventId, action: 'rsvp_going' });
        recordRecommendationInteraction({ userId, entityType: 'group', entityId: clubId, action: 'joined_group' });

        assert.sameMembers(actionsFor(eventId), ['attendance_verified', 'rsvp_going']);
        assert.deepEqual(actionsFor(clubId), ['joined_group']);
        assert.equal(EventAttendances.collection.findOne({ userId, eventId }).status, 'verified');
        assert.equal(EventRSVPs.collection.findOne({ userId, eventId }).status, 'going');
      });
    });

    /**
     * Two switches, read when the call is made. The tests flip the live
     * settings object and put it back, which is also the assertion that
     * nothing captured the values at load.
     */
    describe('kill switch', function () {
      let original;

      beforeEach(function () {
        original = Meteor.settings.recommendations;
      });

      afterEach(function () {
        Meteor.settings.recommendations = original;
      });

      it('ranks adaptively when the setting is absent', function () {
        delete Meteor.settings.recommendations;
        makeEvent({ topicIds: ['music'] });
        Profiles.collection.update({ userId }, { $set: { interests: ['Music & Performance'] } });

        const response = callAs(userId, 'recommendations.get', { kind: 'event' });
        assert.isFalse(response.fallbackUsed);
        assert.include(response.items[0].componentsUsed, 'content');
      });

      it('serves the baseline, and says so, when recommendations are disabled', function () {
        Meteor.settings.recommendations = { ...original, enabled: false };
        const eventId = makeEvent({ topicIds: ['music'] });
        Profiles.collection.update({ userId }, { $set: { interests: ['Music & Performance'] } });

        const response = callAs(userId, 'recommendations.get', { kind: 'event', surface: 'test' });
        assert.equal(response.items[0]._id, eventId);
        assert.isTrue(response.fallbackUsed);
        assert.equal(response.fallbackReason, 'disabled');
        assert.equal(response.modelVersion, 'baseline_v1');
        assert.deepEqual(response.items[0].componentsUsed, ['baseline']);

        const logged = RecommendationRequests.collection.findOne(response.requestId);
        assert.isTrue(logged.fallbackUsed);
        assert.equal(logged.errorCode, 'disabled');
      });

      it('writes no behaviour with recordInteractions off, and still keeps the RSVP', function () {
        Meteor.settings.recommendations = { ...original, recordInteractions: false };
        const eventId = makeEvent();

        const recorded = recordRecommendationInteraction({
          userId, entityType: 'event', entityId: eventId, action: 'rsvp_going', source: 'legacy',
        });
        assert.isNull(recorded);
        assert.equal(RecommendationInteractions.collection.find({}).count(), 0);
        assert.equal(UserItemStates.collection.find({}).count(), 0);
        assert.equal(RecommendationGraphEdges.collection.find({}).count(), 0);
        // A person's plans are product data, not telemetry.
        assert.equal(EventRSVPs.collection.findOne({ userId, eventId }).status, 'going');

        recordRecommendationInteraction({ userId, entityType: 'event', entityId: eventId, action: 'rsvp_canceled' });
        assert.equal(EventRSVPs.collection.findOne({ userId, eventId }).status, 'canceled');

        const response = callAs(userId, 'recommendations.get', { kind: 'event' });
        assert.isNull(response.requestId, 'no request row means the pages send no impressions either');
        assert.lengthOf(response.items, 1);
        assert.equal(RecommendationRequests.collection.find({}).count(), 0);
      });

      // Left open, the edge of a plan cancelled during a pause outlived the
      // pause, and a direct weight-1 edge is the strongest evidence the ranker
      // has: the event somebody had said "Not going" to went first.
      it('still ends the edge of a plan cancelled while recording is off', function () {
        const eventId = makeEvent();
        recordRecommendationInteraction({ userId, entityType: 'event', entityId: eventId, action: 'rsvp_going' });
        Meteor.settings.recommendations = { ...original, recordInteractions: false };

        recordRecommendationInteraction({ userId, entityType: 'event', entityId: eventId, action: 'rsvp_canceled' });
        const edges = RecommendationGraphEdges.collection.find({ fromId: userId, toId: eventId }).fetch();
        assert.lengthOf(edges, 1, 'an edge is closed, never added');
        assert.instanceOf(edges[0].validTo, Date);
        assert.deepEqual(actionsFor(eventId), ['rsvp_going'], 'and nothing new is logged about the person');
        assert.equal(EventRSVPs.collection.findOne({ userId, eventId }).status, 'canceled');
      });
    });

    it('expires a logged request on the behaviour retention schedule', function () {
      const original = Meteor.settings.retention;
      Meteor.settings.retention = { behaviourDays: 30 };
      try {
        makeEvent();
        const response = callAs(userId, 'recommendations.get', { kind: 'event' });
        const { expiresAt, requestedAt } = RecommendationRequests.collection.findOne(response.requestId);
        const days = (expiresAt.getTime() - requestedAt.getTime()) / (24 * 60 * 60 * 1000);
        assert.closeTo(days, 30, 0.01);
      } finally {
        Meteor.settings.retention = original;
      }
    });

    it('records a visible impression once when the client retries it', function () {
      const eventId = makeEvent();
      const response = callAs(userId, 'recommendations.get', { kind: 'event', surface: 'test-deck' });
      const payload = {
        entityType: 'event',
        entityId: eventId,
        action: 'impression',
        clientEventId: 'same-impression-retry',
        requestId: response.requestId,
        position: 0,
        displaySize: 'featured',
      };
      const first = callAs(userId, 'recommendationInteractions.record', payload);
      const second = callAs(userId, 'recommendationInteractions.record', payload);

      assert.equal(second, first);
      assert.equal(RecommendationInteractions.collection.find({ clientEventId: payload.clientEventId }).count(), 1);
      assert.equal(RecommendationImpressions.collection.find({ clientEventId: payload.clientEventId }).count(), 1);
    });

    it('rejects an impression without a request or card position', function () {
      const eventId = makeEvent();
      assert.equal(errorFrom(() => callAs(userId, 'recommendationInteractions.record', {
        entityType: 'event',
        entityId: eventId,
        action: 'impression',
        clientEventId: 'missing-request',
        position: 0,
      })), 'invalid-request');

      const response = callAs(userId, 'recommendations.get', { kind: 'event' });
      assert.equal(errorFrom(() => callAs(userId, 'recommendationInteractions.record', {
        entityType: 'event',
        entityId: eventId,
        action: 'impression',
        clientEventId: 'missing-position',
        requestId: response.requestId,
      })), 'invalid-position');
    });

    it('uses null as clear for optional preferences and ignores unknown keys', function () {
      callAs(userId, 'recommendationPreferences.update', {
        topicIds: ['outdoors'],
        travelRadiusMiles: 12,
      });
      callAs(userId, 'recommendationPreferences.update', {
        topicIds: null,
        madeUpField: null,
      });
      const preferences = RecommendationPreferences.collection.findOne({ userId });

      assert.notProperty(preferences, 'topicIds');
      assert.equal(preferences.travelRadiusMiles, 12);
      assert.notProperty(preferences, 'madeUpField');
    });

    it('activates collaborative scoring only after an active model and embeddings exist', function () {
      const eventId = makeEvent();
      const createdAt = new Date();
      RecommendationModelVersions.collection.insert({
        modelName: 'Test collaborative model',
        version: 'test_collaborative_v1',
        tier: 'collaborative',
        status: 'active',
        createdAt,
        promotedAt: createdAt,
      });
      RecommendationEmbeddings.collection.insert({
        entityType: 'user',
        entityId: userId,
        modelVersion: 'test_collaborative_v1',
        embedding: [1, 0],
        dimension: 2,
        validFrom: createdAt,
        createdAt,
      });
      RecommendationEmbeddings.collection.insert({
        entityType: 'event',
        entityId: eventId,
        modelVersion: 'test_collaborative_v1',
        embedding: [1, 0],
        dimension: 2,
        validFrom: createdAt,
        createdAt,
      });

      const response = callAs(userId, 'recommendations.get', { kind: 'event' });
      assert.equal(response.selectedTier, 'collaborative');
      assert.include(response.items[0].componentsUsed, 'collaborative');
    });
  });
}
