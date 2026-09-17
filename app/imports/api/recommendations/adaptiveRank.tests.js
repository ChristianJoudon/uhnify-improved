/* eslint-env mocha */
import { assert } from 'chai';
import { rankAdaptiveRecommendations } from './adaptiveRank';

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
        event('art', { categories: ['Arts & culture'] }),
        event('hike', { categories: ['Outdoor hiking'] }),
      ],
      profile: { interests: ['outdoor hiking'] },
      now: NOW,
    });

    assert.equal(result.items[0]._id, 'hike');
    assert.include(result.items[0].componentsUsed, 'content');
    assert.equal(result.items[0].selectedTier, 'content');
    assert.notInclude(result.items.find(item => item._id === 'art').componentsUsed, 'content');
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
