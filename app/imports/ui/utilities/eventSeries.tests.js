/* eslint-env mocha */
import { assert } from 'chai';
import {
  collapseEventListings,
  eventListingCount,
  eventListingKey,
} from './eventSeries';

describe('recurring event browse listings', function () {
  it('counts one recurring series while retaining independent events', function () {
    const events = [
      { _id: 'meeting-1', seriesId: 'support-hui-ohana', date: new Date('2026-08-10T17:00:00Z') },
      { _id: 'meeting-2', seriesId: 'support-hui-ohana', date: new Date('2026-08-11T17:00:00Z') },
      { _id: 'concert', date: new Date('2026-08-12T05:00:00Z') },
    ];

    assert.equal(eventListingCount(events), 2);
    assert.deepEqual(collapseEventListings(events).map(event => event._id), ['meeting-1', 'concert']);
  });

  it('keeps the first occurrence supplied so callers control the representative', function () {
    const later = { _id: 'later', seriesId: 'weekly', date: new Date('2026-08-18T05:00:00Z') };
    const sooner = { _id: 'sooner', seriesId: 'weekly', date: new Date('2026-08-11T05:00:00Z') };

    assert.equal(collapseEventListings([sooner, later])[0]._id, 'sooner');
    assert.equal(collapseEventListings([later, sooner])[0]._id, 'later');
  });

  it('never merges unrelated records without a series id', function () {
    const first = { _id: 'a', title: 'Same title' };
    const second = { _id: 'b', title: 'Same title' };

    assert.notEqual(eventListingKey(first), eventListingKey(second));
    assert.equal(eventListingCount([first, second]), 2);
  });
});
