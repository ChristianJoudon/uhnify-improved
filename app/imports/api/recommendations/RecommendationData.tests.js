/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import {
  EventAttendances,
  EventRSVPs,
  RecommendationGraphEdges,
  RecommendationImpressions,
  RecommendationInteractions,
  UserItemStates,
  ensureBehaviourRetention,
} from './RecommendationData';

const DAY_SECONDS = 24 * 60 * 60;

const indexOn = async (entry, field) => (await entry.collection.rawCollection().indexes())
  .find(index => Object.keys(index.key).length === 1 && index.key[field] === 1);

/**
 * What is asserted is the index, not the deletion: the TTL monitor is
 * MongoDB's, and it runs once a minute.
 */
if (Meteor.isServer) {
  describe('behaviour retention', function () {
    this.timeout(10000);

    let original;

    beforeEach(function () {
      original = Meteor.settings.retention;
    });

    afterEach(async function () {
      Meteor.settings.retention = original;
      await ensureBehaviourRetention();
    });

    it('puts every behaviour collection on the configured schedule', async function () {
      Meteor.settings.retention = { behaviourDays: 548 };
      const { seconds, failed } = await ensureBehaviourRetention();

      assert.equal(seconds, 548 * DAY_SECONDS);
      assert.equal(failed, 0);
      const expected = [
        [RecommendationInteractions, 'createdAt'],
        [RecommendationImpressions, 'createdAt'],
        [UserItemStates, 'updatedAt'],
        [EventRSVPs, 'updatedAt'],
        [EventAttendances, 'updatedAt'],
        [RecommendationGraphEdges, 'createdAt'],
      ];
      const indexes = await Promise.all(expected.map(([entry, field]) => indexOn(entry, field)));
      indexes.forEach((index, position) => {
        assert.equal(index?.expireAfterSeconds, 548 * DAY_SECONDS, expected[position][0].name);
      });
    });

    /**
     * The graph holds behaviour and structure in one collection. An unfiltered
     * expiry would, eighteen months after launch, begin deleting the topic,
     * venue and host edges everything else hangs from.
     */
    it('expires only the graph edges that came from an interaction', async function () {
      await ensureBehaviourRetention();
      const edges = await indexOn(RecommendationGraphEdges, 'createdAt');
      assert.deepEqual(edges.partialFilterExpression, { sourceInteractionId: { $exists: true } });

      const interactions = await indexOn(RecommendationInteractions, 'createdAt');
      assert.notProperty(interactions, 'partialFilterExpression');
    });

    it('moves existing indexes when the setting changes', async function () {
      await ensureBehaviourRetention();
      Meteor.settings.retention = { behaviourDays: 90 };
      const { failed } = await ensureBehaviourRetention();

      assert.equal(failed, 0);
      assert.equal((await indexOn(UserItemStates, 'updatedAt')).expireAfterSeconds, 90 * DAY_SECONDS);
      const edges = await indexOn(RecommendationGraphEdges, 'createdAt');
      assert.equal(edges.expireAfterSeconds, 90 * DAY_SECONDS);
      assert.deepEqual(edges.partialFilterExpression, { sourceInteractionId: { $exists: true } });
    });
  });
}
