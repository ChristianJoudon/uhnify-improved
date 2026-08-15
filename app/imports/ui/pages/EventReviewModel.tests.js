/* eslint-env mocha */

import { assert } from 'chai';
import {
  buildReviewUnits,
  candidateWithinReviewWindow,
  currentResearchFor,
  duplicateLevelForUnit,
  effectiveReviewFields,
  effectiveClassificationForUnit,
  projectionSummaryForUnit,
  pendingReviewQueueSummary,
  previewCandidateIdsForUnit,
  previewRequestBasisFor,
} from './EventReviewModel';

const eventCandidate = ({
  id,
  start,
  title = 'Kūpuna Lunch',
  location = 'Līhuʻe Center',
  parentSourceItemKey,
  seriesKey,
} = {}) => ({
  _id: id,
  sourceId: 'SRC-TEST',
  entityHint: 'event',
  reviewStatus: 'PENDING',
  parentSourceItemKey,
  recurringSeriesKey: seriesKey,
  normalizedFields: { title, location, localStart: start },
});

describe('EventReviewModel', function () {
  const reference = new Date('2026-08-09T12:00:00-10:00');

  it('shows only future candidates through the end of the two-calendar-month window', function () {
    assert.isTrue(candidateWithinReviewWindow(eventCandidate({
      id: 'inside',
      start: '2026-10-09T09:00:00-10:00',
    }), reference));
    assert.isFalse(candidateWithinReviewWindow(eventCandidate({
      id: 'outside',
      start: '2026-10-10T09:00:00-10:00',
    }), reference));
    assert.isFalse(candidateWithinReviewWindow(eventCandidate({
      id: 'past',
      start: '2026-08-09T08:00:00-10:00',
    }), reference));
  });

  it('collapses repeated source/title/location/time occurrences into one editorial unit', function () {
    const first = eventCandidate({ id: 'one', start: '2026-08-10T09:00:00-10:00' });
    const second = eventCandidate({ id: 'two', start: '2026-08-11T09:00:00-10:00' });
    const differentTime = eventCandidate({ id: 'three', start: '2026-08-12T10:00:00-10:00' });
    const { units, outsideWindow } = buildReviewUnits([second, differentTime, first], {}, reference);
    assert.equal(outsideWindow, 0);
    assert.lengthOf(units, 2);
    assert.deepEqual(units[0].candidates.map(candidate => candidate._id), ['one', 'two']);
    assert.deepEqual(units[1].candidates.map(candidate => candidate._id), ['three']);
  });

  it('keeps parent-linked review-card counts stable before and after previews arrive', function () {
    const first = eventCandidate({
      id: 'one',
      start: '2026-08-10T09:00:00-10:00',
      parentSourceItemKey: 'group:community-meal',
    });
    const second = eventCandidate({
      id: 'two',
      start: '2026-08-11T12:00:00-10:00',
      parentSourceItemKey: 'group:community-meal',
    });
    const previews = {
      one: { seriesKey: 'series:server-parent-key' },
      two: { seriesKey: 'series:server-parent-key' },
    };

    assert.equal(buildReviewUnits([first, second], {}, reference).units.length, 1);
    assert.equal(buildReviewUnits([first, second], previews, reference).units.length, 1);
    assert.equal(
      pendingReviewQueueSummary([first, second], reference, previews).actionableReviewUnits,
      1,
    );
  });

  it('separates actionable review cards from the retained pending backlog', function () {
    const first = eventCandidate({ id: 'one', start: '2026-08-10T09:00:00-10:00' });
    const second = eventCandidate({ id: 'two', start: '2026-08-11T09:00:00-10:00' });
    const outside = eventCandidate({ id: 'outside', start: '2026-11-01T09:00:00-10:00' });
    const cleared = eventCandidate({ id: 'cleared', start: '2026-08-12T10:00:00-10:00' });
    cleared.reviewStatus = 'REJECTED';

    assert.deepEqual(pendingReviewQueueSummary([
      first,
      second,
      outside,
      cleared,
    ], reference), {
      actionableReviewUnits: 1,
      inWindowPendingCandidates: 2,
      outsideWindowPendingCandidates: 1,
      totalPendingCandidates: 3,
    });
  });

  it('uses server preview duplicate and classification results for the whole series card', function () {
    const first = eventCandidate({ id: 'one', start: '2026-08-10T09:00:00-10:00', seriesKey: 'series:v1:a' });
    const second = eventCandidate({ id: 'two', start: '2026-08-11T09:00:00-10:00', seriesKey: 'series:v1:a' });
    const { units } = buildReviewUnits([first, second], {}, reference);
    const previews = {
      one: {
        duplicateLevel: 'NONE',
        effectiveClassification: { topicKey: 'community', subcategoryKey: 'senior_services' },
      },
      two: { duplicateLevel: 'REVIEW' },
    };
    assert.equal(duplicateLevelForUnit(units[0], previews), 'REVIEW');
    assert.deepEqual(effectiveClassificationForUnit(units[0], previews), {
      topicKey: 'community',
      subcategoryKey: 'senior_services',
    });
  });

  it('samples the first, middle, and last occurrence for bounded preview work', function () {
    const candidates = Array.from({ length: 61 }, (_, index) => eventCandidate({
      id: `${index}`,
      start: `2026-08-${String(10 + (index % 20)).padStart(2, '0')}T09:00:00-10:00`,
      seriesKey: 'series:v1:daily',
    }));
    assert.deepEqual(previewCandidateIdsForUnit({ candidates }), ['0', '30', '60']);
  });

  it('uses projected recurrence counts and dates for a single template card', function () {
    const template = eventCandidate({ id: 'template', start: null });
    template.normalizedFields.recurrenceLabel = 'Every Tuesday at 1:30 PM';
    const summary = projectionSummaryForUnit({ candidates: [template] }, {
      template: {
        projectedOccurrenceCount: 9,
        projectedFirstDate: '2026-08-11T13:30:00-10:00',
        projectedLastDate: '2026-10-06T13:30:00-10:00',
      },
    });
    assert.equal(summary.projectedRecordCount, 9);
    assert.equal(summary.projectedFirstDate.toISOString(), '2026-08-11T23:30:00.000Z');
    assert.equal(summary.projectedLastDate.toISOString(), '2026-10-06T23:30:00.000Z');
  });

  it('keeps a recurrence-template projection unknown until server preview arrives', function () {
    const template = eventCandidate({ id: 'template', start: null });
    template.normalizedFields.recurrenceLabel = 'Third Thursday monthly';
    assert.deepEqual(projectionSummaryForUnit({ candidates: [template] }), {
      projectedRecordCount: null,
      projectedFirstDate: null,
      projectedLastDate: null,
    });
  });

  it('reports a duplicate result from the available bounded series sample', function () {
    const candidates = Array.from({ length: 6 }, (_, index) => eventCandidate({
      id: `${index}`,
      start: `2026-08-${String(10 + index).padStart(2, '0')}T09:00:00-10:00`,
      seriesKey: 'series:v1:weekly',
    }));
    assert.equal(duplicateLevelForUnit({ candidates }, {
      0: { duplicateLevel: 'NONE' },
      3: { duplicateLevel: 'NONE' },
      5: { duplicateLevel: 'NONE' },
    }), 'NONE');
  });

  it('uses saved editorial corrections without changing the source fields', function () {
    const candidate = eventCandidate({
      id: 'corrected',
      start: '2026-08-10T09:00:00-10:00',
      title: 'Source title',
      location: '',
    });
    candidate.editorialOverrides = {
      title: 'Reviewed title',
      location: 'Līhuʻe Civic Center',
      schedule: {
        kind: 'ONE_TIME',
        localStart: '2026-08-12T10:30',
        localEnd: '2026-08-12T12:00',
      },
    };
    assert.include(effectiveReviewFields(candidate), {
      title: 'Reviewed title',
      location: 'Līhuʻe Civic Center',
      localStart: '2026-08-12T10:30',
      localEnd: '2026-08-12T12:00',
    });
    assert.equal(candidate.normalizedFields.title, 'Source title');
    assert.equal(candidate.normalizedFields.localStart, '2026-08-10T09:00:00-10:00');
  });

  it('treats null override values as reverting to the captured source facts', function () {
    const candidate = eventCandidate({
      id: 'cleared',
      start: '2026-08-10T09:00:00-10:00',
      location: 'Source venue',
    });
    candidate.summary = { location: 'Summary venue' };
    candidate.editorialOverrides = { location: null, schedule: null };
    assert.equal(effectiveReviewFields(candidate).location, 'Source venue');
    assert.equal(effectiveReviewFields(candidate).localStart, '2026-08-10T09:00:00-10:00');
  });

  it('hides research when newer source evidence or editorial changes make its basis stale', function () {
    const current = {
      observationId: 'observation-new',
      editorialRevision: 2,
      research: {
        status: 'SUCCEEDED',
        basis: { observationId: 'observation-new', editorialRevision: 2 },
      },
    };
    assert.equal(currentResearchFor(current), current.research);
    assert.isNull(currentResearchFor({
      ...current,
      observationId: 'observation-newer',
    }));
    assert.isNull(currentResearchFor({
      ...current,
      editorialRevision: 3,
    }));
  });

  it('refreshes preview work when the source observation or editorial basis changes', function () {
    const candidate = {
      _id: 'candidate-one',
      observationId: 'observation-one',
      editorialRevision: 1,
      validationState: 'INVALID',
      editorialEditToken: 'token-one',
    };
    const initial = previewRequestBasisFor(candidate);
    assert.notEqual(previewRequestBasisFor({
      ...candidate,
      observationId: 'observation-two',
    }), initial);
    assert.notEqual(previewRequestBasisFor({
      ...candidate,
      editorialRevision: 2,
      editorialEditToken: 'token-two',
    }), initial);
  });
});
