/* eslint-env mocha */
import { assert } from 'chai';
import {
  dateForKey,
  dateKeyFor,
  eventsByDate,
  monthCellsFor,
  shiftedDateKey,
  sortAgendaEvents,
} from './CountFirstCalendarModel';

describe('CountFirstCalendarModel', function () {
  it('builds only the complete weeks needed to display a month', function () {
    const compact = monthCellsFor(new Date(2026, 1, 1));
    assert.lengthOf(compact, 28);
    assert.equal(compact[0].key, '2026-02-01');
    assert.equal(compact[compact.length - 1].key, '2026-02-28');

    const sixWeeks = monthCellsFor(new Date(2026, 7, 1));
    assert.lengthOf(sixWeeks, 42);
    assert.equal(sixWeeks[0].key, '2026-07-26');
    assert.equal(sixWeeks[sixWeeks.length - 1].key, '2026-09-05');
  });

  it('counts valid events by the local day shown in the calendar', function () {
    const grouped = eventsByDate([
      { _id: 'one', date: new Date(2026, 7, 15, 8, 30) },
      { _id: 'two', date: new Date(2026, 7, 15, 18, 0) },
      { _id: 'invalid', date: 'not-a-date' },
    ]);
    assert.deepEqual(grouped['2026-08-15'].map(event => event._id), ['one', 'two']);
    assert.notProperty(grouped, 'null');
  });

  it('sorts a selected day without changing the source array', function () {
    const events = [
      { _id: 'late', title: 'Alpha', date: new Date(2026, 7, 15, 18, 0) },
      { _id: 'early', title: 'Zulu', date: new Date(2026, 7, 15, 8, 0) },
    ];
    assert.deepEqual(sortAgendaEvents(events, 'soonest').map(event => event._id), ['early', 'late']);
    assert.deepEqual(sortAgendaEvents(events, 'latest').map(event => event._id), ['late', 'early']);
    assert.deepEqual(sortAgendaEvents(events, 'title').map(event => event._id), ['late', 'early']);
    assert.deepEqual(events.map(event => event._id), ['late', 'early']);
  });

  it('moves keyboard dates across week and month boundaries', function () {
    assert.equal(shiftedDateKey('2026-08-31', 1), '2026-09-01');
    assert.equal(dateKeyFor(dateForKey('2026-02-28')), '2026-02-28');
    assert.isNull(dateForKey('2026-02-30'));
  });
});
