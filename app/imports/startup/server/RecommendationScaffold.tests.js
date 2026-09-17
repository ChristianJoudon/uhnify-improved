/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { FRIEND_ACTIVITY_VISIBILITY } from '../../api/privacy/FriendActivityPrivacy';
import {
  RecommendationEntities,
  RecommendationGraphEdges,
} from '../../api/recommendations/RecommendationData';
import {
  makeEvent,
  makeClub,
  resetAll,
  resetRecommendations,
} from './testFixtures';
import { ensureRecommendationScaffold } from './RecommendationScaffold';

if (Meteor.isServer) {
  describe('support recommendation projection', function () {
    beforeEach(function () {
      resetAll();
      resetRecommendations();
    });

    it('replaces the legacy wellness topic id and generated edge', function () {
      const now = new Date();
      const wellnessId = RecommendationEntities.collection.insert({
        entityType: 'topic',
        sourceId: 'topic:wellness',
        name: 'Plants & Home',
        createdAt: now,
        updatedAt: now,
      });
      const eventId = makeEvent({ categories: ['support_group'], topicIds: ['wellness'] });
      RecommendationGraphEdges.collection.insert({
        edgeKey: `event:${eventId}:has_topic:${wellnessId}`,
        fromType: 'event',
        fromId: eventId,
        toType: 'topic',
        toId: wellnessId,
        relation: 'has_topic',
        privacyEligibility: 'public',
        createdAt: now,
        updatedAt: now,
      });

      ensureRecommendationScaffold();

      assert.deepEqual(Events.collection.findOne(eventId).topicIds, ['support']);
      const supportId = RecommendationEntities.collection.findOne({ sourceId: 'topic:support' })._id;
      const edges = RecommendationGraphEdges.collection.find({
        fromType: 'event', fromId: eventId, relation: 'has_topic',
      }).fetch();
      assert.deepEqual(edges.map(edge => edge.toId), [supportId]);
    });

    it('preserves an explicit multi-topic assignment', function () {
      const eventId = makeEvent({ categories: ['support_group'], topicIds: ['wellness', 'custom'] });
      ensureRecommendationScaffold();
      assert.deepEqual(Events.collection.findOne(eventId).topicIds, ['wellness', 'custom']);
    });

    it('moves the confirmed Lululemon yoga series out of the legacy outdoors topic', function () {
      const eventId = makeEvent({
        title: 'Lululemon Sunday Sweat',
        categories: ['fitness', 'wellness', 'free'],
        topicIds: ['outdoors'],
      });

      ensureRecommendationScaffold();

      assert.deepEqual(Events.collection.findOne(eventId).topicIds, ['wellness']);
      const wellnessId = RecommendationEntities.collection.findOne({ sourceId: 'topic:wellness' })._id;
      const edges = RecommendationGraphEdges.collection.find({
        fromType: 'event', fromId: eventId, relation: 'has_topic',
      }).fetch();
      assert.deepEqual(edges.map(edge => edge.toId), [wellnessId]);
    });

    it('preserves a future editorial topic for the confirmed Lululemon series', function () {
      const eventId = makeEvent({
        title: 'Lululemon Sunday Sweat',
        categories: ['fitness', 'wellness', 'free'],
        topicIds: ['community'],
      });

      ensureRecommendationScaffold();

      assert.deepEqual(Events.collection.findOne(eventId).topicIds, ['community']);
    });

    it('backfills friend-activity visibility from the current listing category', function () {
      const supportClubId = makeClub({ categories: ['support_group'] });
      const ordinaryClubId = makeClub({ categories: ['community'] });
      const supportEventId = makeEvent({ categories: ['support_group'] });
      ProfileClubs.collection.insert({
        userId: 'privacy-test',
        clubId: supportClubId,
        friendActivityVisibility: FRIEND_ACTIVITY_VISIBILITY.shareable,
      });
      ProfileClubs.collection.insert({
        userId: 'privacy-test',
        clubId: ordinaryClubId,
        friendActivityVisibility: FRIEND_ACTIVITY_VISIBILITY.private,
      });
      EventSwipes.collection.insert({
        userId: 'privacy-test',
        eventId: supportEventId,
        decision: 'interested',
        friendActivityVisibility: FRIEND_ACTIVITY_VISIBILITY.shareable,
      });

      ensureRecommendationScaffold();

      assert.equal(
        ProfileClubs.collection.findOne({ clubId: supportClubId }).friendActivityVisibility,
        FRIEND_ACTIVITY_VISIBILITY.private,
      );
      assert.equal(
        ProfileClubs.collection.findOne({ clubId: ordinaryClubId }).friendActivityVisibility,
        FRIEND_ACTIVITY_VISIBILITY.shareable,
      );
      assert.equal(
        EventSwipes.collection.findOne({ eventId: supportEventId }).friendActivityVisibility,
        FRIEND_ACTIVITY_VISIBILITY.private,
      );
      assert.deepEqual(Clubs.collection.findOne(supportClubId).categories, ['support_group']);
    });
  });
}
