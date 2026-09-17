/* eslint-env mocha */
import { assert } from 'chai';
import { rankAdaptiveRecommendations, topicKeysForInterests } from './adaptiveRank';

const NOW = new Date('2026-08-08T12:00:00.000Z');

const event = (id, overrides = {}) => ({
  _id: id,
  title: `Event ${id}`,
  date: new Date('2026-08-15T12:00:00.000Z'),
  location: 'Lihue',
  ...overrides,
});

describe('adaptive recommendation ranking', function () {
  it('returns a finite baseline when every optional input is missing or null', function () {
    const result = rankAdaptiveRecommendations({
      candidates: [event('sparse', {
        categories: null,
        topicIds: null,
        description: null,
        hostName: null,
        geo: null,
      })],
      profile: null,
      preferences: null,
      interactions: null,
      graphEdges: null,
      models: null,
      embeddings: null,
      featureSnapshots: null,
      now: NOW,
    });

    assert.lengthOf(result.items, 1);
    assert.isFinite(result.items[0].recommendationScore);
    assert.deepEqual(result.items[0].componentsUsed, ['baseline']);
    assert.equal(result.selectedTier, 'baseline');
  });

  it('activates content only when both sides have usable topic evidence', function () {
    const result = rankAdaptiveRecommendations({
      candidates: [
        event('art', { topicIds: ['art'] }),
        event('hike', { topicIds: ['outdoors'] }),
      ],
      profile: { interests: ['Move & Explore'] },
      now: NOW,
    });

    assert.equal(result.items[0]._id, 'hike');
    assert.include(result.items[0].componentsUsed, 'content');
    assert.equal(result.items[0].selectedTier, 'content');
    assert.notInclude(result.items.find(item => item._id === 'art').componentsUsed, 'content');
  });

  /**
   * Settings stores the LABEL a person tapped; events carry the KEY. "Music &
   * Performance" used to match 'music' only because the label happens to
   * contain its key — "Move & Explore" never matched 'outdoors' at all.
   */
  describe('profile interests', function () {
    it('resolves a label to the key events are tagged with', function () {
      assert.deepEqual(
        topicKeysForInterests(['Music & Performance', 'Move & Explore', 'books', 'Knitting circles', null]),
        ['music', 'outdoors', 'books'],
      );
    });

    it('matches "Music & Performance" to an event tagged music, and says why as before', function () {
      const result = rankAdaptiveRecommendations({
        candidates: [event('gig', { topicIds: ['music'] }), event('market', { topicIds: ['food'] })],
        profile: { interests: ['Music & Performance'] },
        now: NOW,
      });

      assert.equal(result.items[0]._id, 'gig');
      assert.include(result.items[0].componentsUsed, 'content');
      assert.equal(result.items[0].reason, 'Matches your interests');
      assert.equal(result.capabilitySnapshot.explicitInterestCount, 1);
    });

    it('does not match a label’s ordinary words against a description', function () {
      const result = rankAdaptiveRecommendations({
        candidates: [event('talk', { topicIds: ['books'], description: 'Make time to create a reading habit.' })],
        profile: { interests: ['Make & Create'] },
        now: NOW,
      });

      assert.notInclude(result.items[0].componentsUsed, 'content');
      assert.notEqual(result.items[0].reason, 'Matches your interests');
    });
  });

  /**
   * A right swipe on an event means Going. An event the person is going to is
   * decided and is not dealt again; one they cancelled is undecided and is.
   */
  describe('Going', function () {
    const at = day => new Date(`2026-08-0${day}T00:00:00Z`);

    it('holds back an event the person is going to', function () {
      const result = rankAdaptiveRecommendations({
        candidates: [event('going'), event('undecided')],
        interactions: [{ entityId: 'going', action: 'rsvp_going', occurredAt: at(1) }],
        now: NOW,
      });
      assert.deepEqual(result.items.map(item => item._id), ['undecided']);
    });

    it('offers it again once the RSVP is cancelled, exactly as an undo would', function () {
      const result = rankAdaptiveRecommendations({
        candidates: [event('cancelled')],
        interactions: [
          { entityId: 'cancelled', action: 'rsvp_going', occurredAt: at(1) },
          { entityId: 'cancelled', action: 'rsvp_canceled', occurredAt: at(2) },
        ],
        now: NOW,
      });
      assert.lengthOf(result.items, 1);
    });

    it('returns it on request, the way includePassed returns a pass', function () {
      const result = rankAdaptiveRecommendations({
        candidates: [event('going')],
        interactions: [{ entityId: 'going', action: 'rsvp_going', occurredAt: at(1) }],
        filters: { includeGoing: true },
        now: NOW,
      });
      assert.lengthOf(result.items, 1);
    });

    it('reads an old "interested" on an event as the Going it was', function () {
      const interactions = [{ entityId: 'old', action: 'interested', occurredAt: at(1) }];
      assert.lengthOf(rankAdaptiveRecommendations({ candidates: [event('old')], interactions, now: NOW }).items, 0);

      // On a group the same old word was a join, and membership decides that.
      const group = { _id: 'old', name: 'A group the person has since left' };
      assert.lengthOf(
        rankAdaptiveRecommendations({ candidates: [group], kind: 'group', interactions, now: NOW }).items,
        1,
      );
    });

    it('lets the pass win when a left swipe cancels an RSVP in the same millisecond', function () {
      const interactions = [
        { entityId: 'swapped', action: 'passed', occurredAt: at(3) },
        { entityId: 'swapped', action: 'rsvp_canceled', occurredAt: at(3) },
      ];
      [interactions, [...interactions].reverse()].forEach(ordering => {
        const result = rankAdaptiveRecommendations({ candidates: [event('swapped')], interactions: ordering, now: NOW });
        assert.lengthOf(result.items, 0);
      });
    });

    it('stops treating a cancelled plan as evidence for the same card', function () {
      const edge = {
        fromType: 'user',
        fromId: 'user-1',
        toType: 'event',
        toId: 'cancelled',
        relation: 'rsvp_going',
        weight: 1,
      };
      const standing = rankAdaptiveRecommendations({
        candidates: [event('cancelled')],
        userId: 'user-1',
        graphEdges: [edge],
        filters: { includeGoing: true },
        now: NOW,
      });
      const ended = rankAdaptiveRecommendations({
        candidates: [event('cancelled')],
        userId: 'user-1',
        graphEdges: [{ ...edge, validTo: at(2) }],
        now: NOW,
      });

      assert.include(standing.items[0].componentsUsed, 'graph');
      assert.notInclude(ended.items[0].componentsUsed, 'graph');
    });
  });

  it('renormalizes away an unavailable component instead of treating it as zero', function () {
    const sparse = event('same', { categories: null, topicIds: null });
    const withoutProfile = rankAdaptiveRecommendations({ candidates: [sparse], now: NOW });
    const unmatchedProfile = rankAdaptiveRecommendations({
      candidates: [sparse],
      profile: { interests: ['astronomy'] },
      now: NOW,
    });

    assert.equal(
      unmatchedProfile.items[0].recommendationScore,
      withoutProfile.items[0].recommendationScore,
      'missing content evidence must not push the score down',
    );
  });

  it('activates a collaborative tier only with an active model and both embeddings', function () {
    const candidate = event('collaborative');
    const activeModel = {
      tier: 'collaborative',
      status: 'active',
      version: 'lightgcn_test',
      promotedAt: NOW,
    };
    const result = rankAdaptiveRecommendations({
      candidates: [candidate],
      userId: 'user-1',
      models: [activeModel],
      embeddings: [
        { entityType: 'user', entityId: 'user-1', modelVersion: 'lightgcn_test', embedding: [1, 0], validFrom: NOW },
        { entityType: 'event', entityId: candidate._id, modelVersion: 'lightgcn_test', embedding: [1, 0], validFrom: NOW },
      ],
      now: NOW,
    });

    assert.include(result.items[0].componentsUsed, 'collaborative');
    assert.equal(result.selectedTier, 'collaborative');

    const missingItemEmbedding = rankAdaptiveRecommendations({
      candidates: [candidate],
      userId: 'user-1',
      models: [activeModel],
      embeddings: [
        { entityType: 'user', entityId: 'user-1', modelVersion: 'lightgcn_test', embedding: [1, 0], validFrom: NOW },
      ],
      now: NOW,
    });
    assert.notInclude(missingItemEmbedding.items[0].componentsUsed, 'collaborative');
    assert.equal(missingItemEmbedding.selectedTier, 'baseline');
  });

  it('does not activate a draft model even if embeddings have been staged', function () {
    const candidate = event('draft');
    const result = rankAdaptiveRecommendations({
      candidates: [candidate],
      userId: 'user-1',
      models: [{ tier: 'collaborative', status: 'draft', version: 'draft_v1' }],
      embeddings: [
        { entityType: 'user', entityId: 'user-1', modelVersion: 'draft_v1', embedding: [1] },
        { entityType: 'event', entityId: candidate._id, modelVersion: 'draft_v1', embedding: [1] },
      ],
      now: NOW,
    });

    assert.deepEqual(result.items[0].componentsUsed, ['baseline']);
  });

  it('lets a correction restore an item that was previously passed', function () {
    const candidate = event('restored');
    const interactions = [
      { entityId: candidate._id, action: 'passed', occurredAt: new Date('2026-08-01T00:00:00Z') },
      { entityId: candidate._id, action: 'correction', occurredAt: new Date('2026-08-02T00:00:00Z') },
    ];
    const result = rankAdaptiveRecommendations({ candidates: [candidate], interactions, now: NOW });
    assert.lengthOf(result.items, 1);

    const stillPassed = rankAdaptiveRecommendations({
      candidates: [candidate],
      interactions: [...interactions].reverse(),
      now: new Date('2026-08-01T12:00:00Z'),
    });
    assert.lengthOf(stillPassed.items, 0);
  });

  it('stays finite even when configured component weights are all zero', function () {
    const result = rankAdaptiveRecommendations({
      candidates: [event('zero-weights')],
      weights: { baseline: 0, content: 0, graph: 0, collaborative: 0, heterogeneous: 0, temporal: 0 },
      now: NOW,
    });
    assert.isFinite(result.items[0].recommendationScore);
  });
});
