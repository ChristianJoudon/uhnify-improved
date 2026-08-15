/* eslint-env mocha */

import { assert } from 'chai';
import { ACTIVITY_KEYS } from '../../ui/utilities/topics';
import {
  INGESTION_REVIEW_TAXONOMY,
  INGESTION_TOPIC_KEYS,
  isValidReviewSelection,
  reviewSelectionLabels,
} from './IngestionReviewTaxonomy';

describe('IngestionReviewTaxonomy', function () {
  it('defines one non-empty, uniquely keyed subcategory list per existing topic', function () {
    assert.sameMembers(Object.keys(INGESTION_REVIEW_TAXONOMY), INGESTION_TOPIC_KEYS);
    const keys = INGESTION_TOPIC_KEYS.flatMap(topicKey => (
      INGESTION_REVIEW_TAXONOMY[topicKey].subcategories.map(option => option.key)
    ));
    assert.lengthOf(new Set(keys), keys.length);
    INGESTION_TOPIC_KEYS.forEach(topicKey => {
      assert.isNotEmpty(INGESTION_REVIEW_TAXONOMY[topicKey].label);
      assert.isNotEmpty(INGESTION_REVIEW_TAXONOMY[topicKey].subcategories);
    });
  });

  it('makes every supplied activity available as a future review subsection', function () {
    const registered = new Set(INGESTION_TOPIC_KEYS.flatMap(topicKey => (
      INGESTION_REVIEW_TAXONOMY[topicKey].subcategories.map(option => option.key)
    )));
    ACTIVITY_KEYS.forEach(key => assert.include([...registered], key));
  });

  it('accepts only a known topic and its own known subcategory', function () {
    const valid = { topicKey: 'community', subcategoryKey: 'senior_services' };
    assert.isTrue(isValidReviewSelection(valid));
    assert.deepEqual(reviewSelectionLabels(valid), {
      topic: 'Community & Causes',
      subcategory: 'Senior services',
    });
    assert.isFalse(isValidReviewSelection({ topicKey: 'community', subcategoryKey: 'live_music' }));
    assert.isFalse(isValidReviewSelection({ topicKey: 'unknown', subcategoryKey: 'senior_services' }));
    assert.isFalse(isValidReviewSelection(null));
  });
});
