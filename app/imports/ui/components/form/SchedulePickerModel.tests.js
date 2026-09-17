/* eslint-env mocha */
import { assert } from 'chai';
import { normalizeSchedule, scheduleLabel } from '../../../api/club/schedule';
import {
  DEFAULT_START,
  QUICK_LENGTHS,
  echoLabel,
  endHint,
  endTimeFor,
  initialEnd,
  lengthChoices,
  lengthLabel,
  lengthSpoken,
  scheduleFrom,
  toggleWeek,
  weekUnknown,
  weeksFor,
  withEndMode,
} from './SchedulePickerModel';

/**
 * The "When you meet" card asks for an end either as a time or as a length and
 * stores only the time. These hold the arithmetic between the two, and that
 * nothing but the stored shape ever leaves the card.
 */
describe('SchedulePickerModel', function () {
  const NO_END = { mode: 'none', at: '', length: null };

  describe('the end that is sent', function () {
    it('is nothing by default', function () {
      assert.deepEqual(initialEnd({ days: [], time: DEFAULT_START, cadence: 'weekly' }), NO_END);
      assert.isNull(endTimeFor('18:30', NO_END));
    });

    it('is the typed time when that is later the same day', function () {
      assert.equal(endTimeFor('18:30', { mode: 'at', at: '20:00', length: null }), '20:00');
    });

    it('is not sent when it is not after the start, and says why', function () {
      ['18:30', '18:00', '00:15'].forEach(at => {
        const end = { mode: 'at', at, length: null };
        assert.isNull(endTimeFor('18:30', end), at);
        assert.equal(endHint('18:30', end), 'Ends after it starts', at);
      });
    });

    it('says nothing about an end that has not been typed yet', function () {
      const end = { mode: 'at', at: '', length: null };
      assert.isNull(endTimeFor('18:30', end));
      assert.equal(endHint('18:30', end), '');
    });

    it('is the start plus the length', function () {
      assert.equal(endTimeFor('18:30', { mode: 'lasts', at: '', length: 90 }), '20:00');
      assert.equal(endTimeFor('09:45', { mode: 'lasts', at: '', length: 30 }), '10:15');
    });

    it('moves with the start while the length holds', function () {
      const end = { mode: 'lasts', at: '', length: 90 };
      assert.equal(scheduleFrom({ days: [4], time: '18:30', cadence: 'weekly', weeks: [] }, end).endTime, '20:00');
      assert.equal(scheduleFrom({ days: [4], time: '10:00', cadence: 'weekly', weeks: [] }, end).endTime, '11:30');
    });

    it('stays put when it was typed, and is dropped once the start passes it', function () {
      const end = { mode: 'at', at: '20:00', length: null };
      assert.equal(scheduleFrom({ days: [4], time: '19:00', cadence: 'weekly', weeks: [] }, end).endTime, '20:00');
      assert.notProperty(scheduleFrom({ days: [4], time: '20:30', cadence: 'weekly', weeks: [] }, end), 'endTime');
    });

    it('is not sent when the length runs past midnight, and says why', function () {
      const end = { mode: 'lasts', at: '', length: 180 };
      assert.isNull(endTimeFor('22:00', end));
      assert.equal(endHint('22:00', end), 'That runs past midnight');
      assert.equal(endHint('20:00', end), '');
    });

    it('opens a stored end as the time it is', function () {
      assert.deepEqual(
        initialEnd({ days: [4], time: '18:30', endTime: '20:00', cadence: 'weekly' }),
        { mode: 'at', at: '20:00', length: null },
      );
    });
  });

  describe('changing how the end is asked for', function () {
    it('opens on an hour when there is nothing to carry over', function () {
      assert.deepEqual(withEndMode('18:30', NO_END, 'at'), { mode: 'at', at: '19:30', length: null });
      assert.deepEqual(withEndMode('18:30', NO_END, 'lasts'), { mode: 'lasts', at: '', length: 60 });
    });

    it('opens blank when an hour would run past midnight', function () {
      assert.equal(withEndMode('23:30', NO_END, 'at').at, '');
    });

    it('carries the end in force across, in both directions', function () {
      const typed = { mode: 'at', at: '20:00', length: null };
      const asLength = withEndMode('18:30', typed, 'lasts');
      assert.equal(asLength.length, 90);
      assert.equal(endTimeFor('18:30', asLength), '20:00');

      const picked = { mode: 'lasts', at: '', length: 120 };
      const asTime = withEndMode('18:30', picked, 'at');
      assert.equal(asTime.at, '20:30');
      assert.equal(endTimeFor('18:30', asTime), '20:30');
    });

    it('forgets nothing under "No end"', function () {
      const typed = { mode: 'at', at: '20:00', length: null };
      const none = withEndMode('18:30', typed, 'none');
      assert.isNull(endTimeFor('18:30', none));
      assert.equal(withEndMode('18:30', none, 'at').at, '20:00');

      const picked = { mode: 'lasts', at: '', length: 120 };
      assert.equal(withEndMode('18:30', withEndMode('18:30', picked, 'none'), 'lasts').length, 120);
    });

    it('does not carry an end that was never good', function () {
      const wrong = { mode: 'at', at: '17:00', length: null };
      assert.equal(withEndMode('18:30', wrong, 'lasts').length, 60);
    });

    // Only the field being opened used to be brought up to date, so the other
    // held whatever it last showed. The test above returns to the mode it came
    // from and could not see that.
    it('comes back from "No end" to the end last in force, whichever way it was last said', function () {
      const typed = withEndMode('18:30', NO_END, 'at');
      assert.equal(typed.at, '19:30');
      const picked = { ...withEndMode('18:30', typed, 'lasts'), length: 120 };
      assert.equal(endTimeFor('18:30', picked), '20:30');

      const none = withEndMode('18:30', picked, 'none');
      assert.isNull(endTimeFor('18:30', none));
      assert.equal(withEndMode('18:30', none, 'at').at, '20:30', 'not the 7:30 typed three taps ago');
      assert.equal(withEndMode('18:30', none, 'lasts').length, 120);

      // And the other way about: a time typed after a length was picked.
      const retyped = { ...withEndMode('18:30', picked, 'at'), at: '19:00' };
      assert.equal(withEndMode('18:30', withEndMode('18:30', retyped, 'none'), 'lasts').length, 30);
    });

    it('does not open "Ends at" on a time the start has since moved past', function () {
      const stale = { mode: 'none', at: '19:30', length: 60 };
      const opened = withEndMode('20:00', stale, 'at');
      assert.equal(opened.at, '21:00');
      assert.equal(endHint('20:00', opened), '', 'nobody is told off before they have typed anything');
      // One that is still after the start is still what it opens on.
      assert.equal(withEndMode('19:00', stale, 'at').at, '19:30');
      // And with no room left in the day for an hour, it opens blank.
      assert.equal(withEndMode('23:30', stale, 'at').at, '');
    });
  });

  describe('lengths', function () {
    it('writes the quick choices the way they are said', function () {
      assert.deepEqual(QUICK_LENGTHS.map(lengthLabel), ['30 min', '1 hr', '1½ hr', '2 hr', '3 hr']);
      assert.deepEqual(QUICK_LENGTHS.map(lengthSpoken), ['30 minutes', '1 hour', '1 hour 30 minutes', '2 hours', '3 hours']);
    });

    it('writes any other length too', function () {
      assert.equal(lengthLabel(75), '1 hr 15 min');
      assert.equal(lengthLabel(45), '45 min');
      assert.equal(lengthLabel(150), '2½ hr');
      assert.equal(lengthSpoken(75), '1 hour 15 minutes');
    });

    it('gives a length that is not a quick choice a pill of its own, in order', function () {
      assert.deepEqual(lengthChoices(null), QUICK_LENGTHS);
      assert.deepEqual(lengthChoices(90), QUICK_LENGTHS);
      assert.deepEqual(lengthChoices(75), [30, 60, 75, 90, 120, 180]);
    });
  });

  describe('weeks of the month', function () {
    it('picks the first when monthly is chosen with none to go back to', function () {
      assert.deepEqual(weeksFor('monthly', []), [1]);
    });

    it('goes back to the weeks that were picked before', function () {
      assert.deepEqual(weeksFor('monthly', [1, 3]), [1, 3]);
      assert.deepEqual(weeksFor('monthly', [1, 3], true), [1, 3]);
    });

    // A listing that only ever said "monthly". First is a guess there, and it
    // was written into the meeting text as though somebody had said it.
    it('picks nothing for a listing that arrived not knowing its week', function () {
      assert.deepEqual(weeksFor('monthly', [], true), []);
      assert.notProperty(scheduleFrom({ days: [4], time: '18:30', cadence: 'monthly', weeks: weeksFor('monthly', [], true) }, NO_END), 'weeks');
      assert.deepEqual(weeksFor('weekly', [], true), []);
    });

    it('has none for the other cadences', function () {
      assert.deepEqual(weeksFor('weekly', [1, 3]), []);
      assert.deepEqual(weeksFor('biweekly', [1, 3]), []);
    });

    it('switches one week and keeps the month in order', function () {
      assert.deepEqual(toggleWeek([3], 1), [1, 3]);
      assert.deepEqual(toggleWeek([1, 3], 'last'), [1, 3, 'last']);
      assert.deepEqual(toggleWeek(['last', 1], 2), [1, 2, 'last']);
      assert.deepEqual(toggleWeek([1, 3], 1), [3]);
      assert.deepEqual(toggleWeek([1], 1), []);
    });

    it('knows a monthly schedule that does not say which week', function () {
      assert.isTrue(weekUnknown({ days: [4], time: '18:30', cadence: 'monthly' }));
      assert.isTrue(weekUnknown({ days: [4], time: '18:30', cadence: 'monthly', weeks: [] }));
      assert.isFalse(weekUnknown({ days: [4], time: '18:30', cadence: 'monthly', weeks: [1] }));
      assert.isFalse(weekUnknown({ days: [4], time: '18:30', cadence: 'weekly' }));
    });
  });

  describe('what leaves the card', function () {
    it('is the stored shape and nothing else', function () {
      const sent = scheduleFrom(
        { days: [4], time: '18:30', cadence: 'monthly', weeks: [1, 3] },
        { mode: 'lasts', at: '19:00', length: 90 },
      );
      assert.deepEqual(sent, { days: [4], time: '18:30', endTime: '20:00', cadence: 'monthly', weeks: [1, 3] });
      assert.deepEqual(Object.keys(sent), ['days', 'time', 'endTime', 'cadence', 'weeks']);
    });

    it('carries weeks only for a monthly schedule, and never an empty list', function () {
      assert.notProperty(scheduleFrom({ days: [4], time: '18:30', cadence: 'weekly', weeks: [1] }, NO_END), 'weeks');
      assert.notProperty(scheduleFrom({ days: [4], time: '18:30', cadence: 'monthly', weeks: [] }, NO_END), 'weeks');
    });

    it('holds the rest of the form while no day is picked', function () {
      assert.deepEqual(
        scheduleFrom({ days: [], time: '18:30', cadence: 'biweekly', weeks: [] }, NO_END),
        { days: [], time: '18:30', cadence: 'biweekly' },
      );
    });

    // The server runs whatever arrives through normalizeSchedule. If the card
    // and the validator ever disagreed, the line under the card would promise
    // one schedule and the group's page would show another.
    it('is exactly what the validator keeps', function () {
      const ends = [
        NO_END,
        { mode: 'at', at: '20:00', length: null },
        { mode: 'at', at: '06:00', length: null },
        { mode: 'lasts', at: '', length: 90 },
        { mode: 'lasts', at: '', length: 180 },
      ];
      ['weekly', 'biweekly', 'monthly'].forEach(cadence => [[], [1, 3], [2, 'last']].forEach(weeks => ['07:00', '18:30', '22:15'].forEach(time => {
        ends.forEach(end => {
          const sent = scheduleFrom({ days: [1, 4], time, cadence, weeks }, end);
          assert.deepEqual(sent, normalizeSchedule(sent), JSON.stringify(sent));
        });
      })));
    });
  });

  describe('the line under the card', function () {
    it('reads as the end of a sentence', function () {
      assert.equal(
        echoLabel({ days: [4], time: '18:30', endTime: '20:00', cadence: 'monthly', weeks: [1, 3] }),
        'first & third Thu · 6:30–8 PM',
      );
      assert.equal(echoLabel({ days: [5], time: '17:00', cadence: 'monthly', weeks: ['last'] }), 'last Fri · 5 PM');
      assert.equal(echoLabel({ days: [3], time: '19:00', cadence: 'biweekly' }), 'every other Wed · 7 PM');
      assert.equal(echoLabel({ days: [4], time: '18:30', cadence: 'monthly' }), 'monthly · Thu · 6:30 PM');
    });

    it('leaves a weekday its capital', function () {
      assert.equal(echoLabel({ days: [1, 3], time: '16:00', endTime: '17:30', cadence: 'weekly' }), 'Mon & Wed · 4–5:30 PM');
    });

    it('differs from the stored label by that one letter', function () {
      const value = { days: [4], time: '18:30', endTime: '20:00', cadence: 'monthly', weeks: [1, 3] };
      assert.equal(echoLabel(value).toLowerCase(), scheduleLabel(value).toLowerCase());
    });

    it('is empty until a day is picked', function () {
      assert.equal(echoLabel({ days: [], time: '17:00', cadence: 'weekly' }), '');
    });
  });
});
