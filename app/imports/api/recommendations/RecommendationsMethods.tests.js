/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import {
  RecommendationEmbeddings,
  RecommendationImpressions,
  RecommendationInteractions,
  RecommendationModelVersions,
  RecommendationPreferences,
  RecommendationRequests,
  UserItemStates,
} from './RecommendationData';
import {
  callAs,
  errorFrom,
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

    it('keeps one current swipe while preserving every decision in history', function () {
      const eventId = makeEvent();
      callAs(userId, 'eventSwipes.record', eventId, 'interested');
      callAs(userId, 'eventSwipes.record', eventId, 'passed');

      assert.equal(RecommendationInteractions.collection.find({ userId, entityId: eventId }).count(), 2);
      assert.equal(UserItemStates.collection.findOne({ userId, entityId: eventId }).interestState, 'passed');

      callAs(userId, 'eventSwipes.remove', eventId);
      assert.equal(RecommendationInteractions.collection.find({ userId, entityId: eventId }).count(), 3);
      assert.equal(UserItemStates.collection.findOne({ userId, entityId: eventId }).interestState, 'neutral');
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
