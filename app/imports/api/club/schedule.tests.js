/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from './Club';
import {
  DAY_NAMES,
  WEEK_ORDINALS,
  clubOccurrenceWindows,
  clubOccurrences,
  durationMinutes,
  endTimeAfter,
  monthlyTextDays,
  normalizeSchedule,
  parseMeetingTime,
  scheduleLabel,
} from './schedule';
import { callAs, makeUser, resetAll } from '../../startup/server/testFixtures';

/**
 * A schedule that can say "first and third Thursday, 6 to 7:30".
 *
 * Most of this file is about one bug. 'monthly' was stored on eight groups
 * while the label, the calendar and the validator knew only weekly and every
 * other week, so a group that meets twice a month was drawn every week and
 * its members were sent to a room with nobody in it. Each part that took part
 * in that is pinned here: what is kept, what is written, what is read back
 * out of text, and which dates come out the other end.
 *
 * Every date below is built and read in local components, never as an ISO
 * string, so the file says the same thing in whatever time zone runs it.
 */
if (Meteor.isServer) {
  const weekly = { days: [4], time: '18:30', cadence: 'weekly' };

  describe('normalizeSchedule', function () {
    it('keeps a full monthly schedule, in the order the shape is written', function () {
      const clean = normalizeSchedule({ weeks: [3, 1], cadence: 'monthly', endTime: '19:30', time: '18:00', days: [4] });
      assert.deepEqual(clean, { days: [4], time: '18:00', endTime: '19:30', cadence: 'monthly', weeks: [1, 3] });
      assert.deepEqual(Object.keys(clean), ['days', 'time', 'endTime', 'cadence', 'weeks']);
    });

    it('dedupes and sorts the days, and is nothing without one', function () {
      assert.deepEqual(normalizeSchedule({ days: [5, '1', 1, 9, -1, 'x'], time: '07:00' }).days, [1, 5]);
      assert.isNull(normalizeSchedule({ days: [], time: '07:00' }));
      assert.isNull(normalizeSchedule({ days: [7, 'x'] }));
      assert.isNull(normalizeSchedule({ time: '07:00' }));
      assert.isNull(normalizeSchedule(null));
      assert.isNull(normalizeSchedule('Thursdays'));
    });

    it('gives an unreadable start the default it always had', function () {
      ['', '7pm', '24:00', '18:60', '1830', undefined, 1830].forEach(time => {
        assert.equal(normalizeSchedule({ days: [1], time }).time, '17:00', `${time}`);
      });
      assert.equal(normalizeSchedule({ days: [1], time: '00:00' }).time, '00:00');
      assert.equal(normalizeSchedule({ days: [1], time: '23:59' }).time, '23:59');
    });

    it('drops an end that is not later the same day, rather than guessing at it', function () {
      ['18:30', '09:00', '25:00', 'late', ''].forEach(endTime => {
        assert.notProperty(normalizeSchedule({ ...weekly, endTime }), 'endTime', endTime);
      });
      assert.equal(normalizeSchedule({ ...weekly, endTime: '18:31' }).endTime, '18:31');
    });

    it('knows three cadences, and calls anything else weekly', function () {
      ['weekly', 'biweekly', 'monthly'].forEach(cadence => assert.equal(normalizeSchedule({ ...weekly, cadence }).cadence, cadence));
      ['yearly', '', undefined, 'MONTHLY'].forEach(cadence => assert.equal(normalizeSchedule({ ...weekly, cadence }).cadence, 'weekly'));
    });

    it('keeps weeks only on a monthly schedule', function () {
      assert.notProperty(normalizeSchedule({ ...weekly, weeks: [1, 3] }), 'weeks');
      assert.notProperty(normalizeSchedule({ ...weekly, cadence: 'biweekly', weeks: [1, 3] }), 'weeks');
    });

    it('dedupes the weeks, drops what is not one, and keeps them in calendar order', function () {
      const clean = normalizeSchedule({ ...weekly, cadence: 'monthly', weeks: ['last', 3, '1', 3, 5, 0, 'first', null] });
      assert.deepEqual(clean.weeks, [1, 3, 'last']);
      assert.deepEqual(WEEK_ORDINALS.map(ordinal => ordinal.value), [1, 2, 3, 4, 'last']);
      assert.deepEqual(WEEK_ORDINALS.map(ordinal => ordinal.label), ['First', 'Second', 'Third', 'Fourth', 'Last']);
    });

    it('spells "week unknown" one way: no weeks key at all', function () {
      assert.notProperty(normalizeSchedule({ ...weekly, cadence: 'monthly', weeks: [] }), 'weeks');
      assert.notProperty(normalizeSchedule({ ...weekly, cadence: 'monthly', weeks: [7] }), 'weeks');
      assert.notProperty(normalizeSchedule({ ...weekly, cadence: 'monthly' }), 'weeks');
    });

    it('carries nothing it does not know', function () {
      assert.deepEqual(normalizeSchedule({ ...weekly, length: 90, $where: 'x' }), weekly);
    });
  });

  describe('scheduleLabel', function () {
    const LABELS = [
      [{ days: [4], time: '18:30', cadence: 'weekly' }, 'Thu · 6:30 PM'],
      [{ days: [1, 3], time: '16:00', endTime: '17:30', cadence: 'weekly' }, 'Mon & Wed · 4–5:30 PM'],
      [{ days: [1, 3, 5], time: '07:00', cadence: 'weekly' }, 'Mon, Wed & Fri · 7 AM'],
      [{ days: [3], time: '19:00', cadence: 'biweekly' }, 'Every other Wed · 7 PM'],
      [{ days: [4], time: '18:30', endTime: '20:00', cadence: 'monthly', weeks: [1, 3] }, 'First & third Thu · 6:30–8 PM'],
      [{ days: [5], time: '17:00', cadence: 'monthly', weeks: ['last'] }, 'Last Fri · 5 PM'],
      [{ days: [2], time: '09:00', cadence: 'monthly', weeks: [1, 2, 'last'] }, 'First, second & last Tue · 9 AM'],
      [{ days: [4], time: '18:30', cadence: 'monthly' }, 'Monthly · Thu · 6:30 PM'],
      [{ days: [4], time: '18:30', cadence: 'monthly', weeks: [] }, 'Monthly · Thu · 6:30 PM'],
      // Both halves of the day are written when the window crosses noon.
      [{ days: [6], time: '10:00', endTime: '12:00', cadence: 'weekly' }, 'Sat · 10 AM–12 PM'],
      [{ days: [6], time: '11:30', endTime: '13:00', cadence: 'weekly' }, 'Sat · 11:30 AM–1 PM'],
      [{ days: [0], time: '00:00', endTime: '00:45', cadence: 'weekly' }, 'Sun · 12–12:45 AM'],
      [{ days: [0], time: '12:00', cadence: 'weekly' }, 'Sun · 12 PM'],
    ];

    LABELS.forEach(([schedule, label]) => {
      it(`writes "${label}"`, function () {
        assert.equal(scheduleLabel(schedule), label);
      });
    });

    it('is empty for anything that is not a schedule, so callers can fall back to the text', function () {
      [null, undefined, {}, { days: [] }, { days: [9], time: '18:00' }].forEach(value => assert.equal(scheduleLabel(value), ''));
    });

    it('writes what normalizeSchedule would keep, not what was stored', function () {
      assert.equal(scheduleLabel({ days: [3, 1], time: 'soon', endTime: '09:00', cadence: 'weekly', weeks: [2] }), 'Mon & Wed · 5 PM');
    });
  });

  describe('parseMeetingTime', function () {
    const READS = [
      // As it always did.
      ['Every Monday at 4 PM', { days: [1], time: '16:00', cadence: 'weekly' }],
      ['Mondays 5pm', { days: [1], time: '17:00', cadence: 'weekly' }],
      ['Biweekly on Wednesdays at 7 PM', { days: [3], time: '19:00', cadence: 'biweekly' }],
      ['Tue, Thurs and Sat mornings', { days: [2, 4, 6], time: '17:00', cadence: 'weekly' }],
      // The labels this app wrote before ":00" was dropped are still stored as meeting text.
      ['Mon & Wed · 4:00 PM', { days: [1, 3], time: '16:00', cadence: 'weekly' }],
      ['Every other Wed · 7:00 PM', { days: [3], time: '19:00', cadence: 'biweekly' }],
      // Noon and midnight used to fall through to the 5 PM default.
      ['Mondays at noon', { days: [1], time: '12:00', cadence: 'weekly' }],
      ['Fridays at midnight', { days: [5], time: '00:00', cadence: 'weekly' }],
      ['Sundays, this afternoon', { days: [0], time: '17:00', cadence: 'weekly' }],
      // A window. "6-7:30 PM" used to be read as starting at 7:30.
      ['Thursdays 6-7:30 PM', { days: [4], time: '18:00', endTime: '19:30', cadence: 'weekly' }],
      ['Thursdays 6:00 pm – 7:30 pm', { days: [4], time: '18:00', endTime: '19:30', cadence: 'weekly' }],
      ['Thursdays 6 to 7:30pm', { days: [4], time: '18:00', endTime: '19:30', cadence: 'weekly' }],
      ['Saturdays 10am-12pm', { days: [6], time: '10:00', endTime: '12:00', cadence: 'weekly' }],
      ['Every Tuesday and Thursday 5:00 pm - 7:00 pm', { days: [2, 4], time: '17:00', endTime: '19:00', cadence: 'weekly' }],
      ['Mondays 9 a.m. until noon', { days: [1], time: '09:00', endTime: '12:00', cadence: 'weekly' }],
      // A start with no am or pm borrows the end's, unless only the other half of the day comes before it.
      ['Saturdays 11-1 pm', { days: [6], time: '11:00', endTime: '13:00', cadence: 'weekly' }],
      ['Saturdays 10 to noon', { days: [6], time: '10:00', endTime: '12:00', cadence: 'weekly' }],
      // An end that is not later the same day is dropped, not guessed.
      ['Fridays 9 pm - 1 am', { days: [5], time: '21:00', cadence: 'weekly' }],
      ['Fridays 10 to midnight', { days: [5], time: '22:00', cadence: 'weekly' }],
      ['Fridays 6pm-8', { days: [5], time: '18:00', cadence: 'weekly' }],
      // A week of the month before a weekday makes it monthly.
      ['first Thursday 6pm', { days: [4], time: '18:00', cadence: 'monthly', weeks: [1] }],
      ['1st Thursday 6pm', { days: [4], time: '18:00', cadence: 'monthly', weeks: [1] }],
      ['Second and fourth Tuesdays · 7 AM', { days: [2], time: '07:00', cadence: 'monthly', weeks: [2, 4] }],
      ['first & third Thu', { days: [4], time: '17:00', cadence: 'monthly', weeks: [1, 3] }],
      ['2nd/4th Wed 6:30pm', { days: [3], time: '18:30', cadence: 'monthly', weeks: [2, 4] }],
      ['the first and the third Monday at 9 a.m.', { days: [1], time: '09:00', cadence: 'monthly', weeks: [1, 3] }],
      ['Last Friday of the month, 5pm', { days: [5], time: '17:00', cadence: 'monthly', weeks: ['last'] }],
      ['Third Tuesday and Thursday, 4-5 pm', { days: [2, 4], time: '16:00', endTime: '17:00', cadence: 'monthly', weeks: [3] }],
      ['First Monday and first Wednesday at 8 am', { days: [1, 3], time: '08:00', cadence: 'monthly', weeks: [1] }],
      // What the ingestion publishes for a support group.
      ['Second Wednesday of the month, 6:00 pm–7:30 pm', { days: [3], time: '18:00', endTime: '19:30', cadence: 'monthly', weeks: [2] }],
      ['Last Saturday of the month, 11:00 am–12:30 pm', { days: [6], time: '11:00', endTime: '12:30', cadence: 'monthly', weeks: ['last'] }],
      ['Monday at 7:00 am; Friday at 7:00 am', { days: [1, 5], time: '07:00', cadence: 'weekly' }],
      // Monthly in so many words, and no week: monthly, week unknown.
      ['Monthly on Thursdays at 6pm', { days: [4], time: '18:00', cadence: 'monthly' }],
      ['Thursdays, every month', { days: [4], time: '17:00', cadence: 'monthly' }],
      ['Once a month on a Saturday, 10 am', { days: [6], time: '10:00', cadence: 'monthly' }],
      ['Twice a month on Thursdays', { days: [4], time: '17:00', cadence: 'monthly' }],
      ['Tuesdays, 3 times a month', { days: [2], time: '17:00', cadence: 'monthly' }],
      // Not "every other" WEEK.
      ['Every other month on Thursdays', { days: [4], time: '17:00', cadence: 'monthly' }],
      // What it costs is not how often it meets. "a month" and "per month" used to count.
      ['Thursdays 6pm, dues $5 a month', { days: [4], time: '18:00', cadence: 'weekly' }],
      ['Thursdays 6pm ($10 per month)', { days: [4], time: '18:00', cadence: 'weekly' }],
      // The word itself still counts anywhere beside a weekday: unknown costs a
      // calendar, and guessing weekly would send people to meetings that are not held.
      ['Thursdays 6pm, monthly potluck', { days: [4], time: '18:00', cadence: 'monthly' }],
      // A week on its own, not directly before a weekday, is not about one.
      ['First come, first served. Tuesdays 5pm', { days: [2], time: '17:00', cadence: 'weekly' }],
      ['Last updated in May. Tuesdays 5pm', { days: [2], time: '17:00', cadence: 'weekly' }],
      // A list of them is, and so is one followed by "week". Every one of these
      // was read as weekly — the monthly bug by another door. Which week is left
      // unknown, not attached: the first Thursday is not always in the first week.
      ['Thursdays, 1st and 3rd, 6pm', { days: [4], time: '18:00', cadence: 'monthly' }],
      ['Thursdays (1st & 3rd) 6pm', { days: [4], time: '18:00', cadence: 'monthly' }],
      ['1st and 3rd week Thursdays 6pm', { days: [4], time: '18:00', cadence: 'monthly' }],
      ['Every 2nd and 4th week on Tuesday 5pm', { days: [2], time: '17:00', cadence: 'monthly' }],
      ['Thursdays 6pm; 1st & 3rd weeks only', { days: [4], time: '18:00', cadence: 'monthly' }],
      ['Every third week, Tuesday', { days: [2], time: '17:00', cadence: 'monthly' }],
      // "Every second week" is a fortnight, not the second week of a month.
      ['Every second week, Tuesday', { days: [2], time: '17:00', cadence: 'biweekly' }],
      ['Every 2nd week on Tuesdays 5pm', { days: [2], time: '17:00', cadence: 'biweekly' }],
      // Numbers that are not a time of day.
      ['Room 12, ages 5-12, call 808-555-0100. Wednesdays', { days: [3], time: '17:00', cadence: 'weekly' }],
      ['4th Thursday, Room 2, 6-8pm', { days: [4], time: '18:00', endTime: '20:00', cadence: 'monthly', weeks: [4] }],
    ];

    READS.forEach(([text, schedule]) => {
      it(`reads "${text}"`, function () {
        assert.deepEqual(parseMeetingTime(text), schedule);
      });
    });

    it('is null without a weekday', function () {
      ['', null, undefined, 'Schedule to come', '5:30 PM', 'Varies', 'Monthly, dates on the website'].forEach(text => {
        assert.isNull(parseMeetingTime(text), `${text}`);
      });
    });

    /**
     * One schedule has one list of days, one list of weeks and one start.
     * Text that says more than that used to be squashed into it — every
     * weekday named anywhere, the first time met — and the register's
     * "Coffee Time first Saturday; Book Club fourth Wednesday" became every
     * Wednesday and every Saturday. It is refused now, and the text speaks.
     */
    const REFUSED = [
      ['two groups that disagree about the weeks', 'Coffee Time first Saturday; Book Club fourth Wednesday · 10 AM'],
      ['a weekly pattern beside a monthly one', 'Tuesdays, and the first Saturday'],
      ['different weeks for different days', 'First Thursday and third Tuesday at 6 pm'],
      ['one meeting on either of two days', 'Fourth Thursday or Friday at 6:00 PM; location varies · 6 PM'],
      ['either of two days, weekly', 'Monday or Tuesday evenings, 6 pm'],
      ['either of two weeks', 'First or second Thursday at 5pm'],
      ['a fifth week, which the shape cannot say', 'Fifth Friday at 6pm'],
      ['two different start times', 'Monday at 7:00 am; Friday at 6:30 pm'],
      ['three meetings, one at another time', 'Monday at 7:00 am; Friday at 7:00 am; Friday at 6:30 pm'],
    ];

    REFUSED.forEach(([why, text]) => {
      it(`refuses ${why}`, function () {
        assert.isNull(parseMeetingTime(text));
      });
    });

    it('does not refuse the same start written twice, or a start with an end', function () {
      assert.deepEqual(
        parseMeetingTime('Thursdays at 6:00 PM, 6-7 pm in the hall · 6 PM'),
        { days: [4], time: '18:00', endTime: '19:00', cadence: 'weekly' },
      );
    });

    // Two different starts are refused. Two different ends on one start used
    // to be settled by taking the first, and Friday closed an hour early.
    it('drops an end the text gives two of, and keeps the days and the start', function () {
      ['Thu 6-8pm, Fri 6-9pm', 'Thursday 6 PM - 8 PM, Friday 6 PM - 9 PM'].forEach(text => {
        assert.deepEqual(parseMeetingTime(text), { days: [4, 5], time: '18:00', cadence: 'weekly' }, text);
      });
      assert.deepEqual(
        parseMeetingTime('Thu 6-8pm, Fri 6-8pm'),
        { days: [4, 5], time: '18:00', endTime: '20:00', cadence: 'weekly' },
      );
    });

    it('can name the days of monthly text even where it cannot make a schedule of it', function () {
      assert.deepEqual(monthlyTextDays('Coffee Time first Saturday; Book Club fourth Wednesday · 10 AM'), [3, 6]);
      assert.deepEqual(monthlyTextDays('Fourth Thursday or Friday at 6:00 PM'), [4, 5]);
      assert.deepEqual(monthlyTextDays('Monthly on Thursdays'), [4]);
      assert.deepEqual(monthlyTextDays('First Thursday and first Thursday again'), [4], 'each day once');
      assert.isNull(monthlyTextDays('Monday at 7:00 am; Friday at 6:30 pm'));
      assert.isNull(monthlyTextDays('Thu · 6:30 PM'));
      assert.isNull(monthlyTextDays('Monthly, dates on the website'), 'no weekday, no schedule to be wrong about');
    });
  });

  /**
   * The edit form stores the label as the group's meeting text, and the
   * method re-derives the schedule from that text when it is sent none. A
   * label the parser reads back differently is a schedule that changes by
   * being saved.
   */
  describe('label → parse round trip', function () {
    const windows = [
      {}, { endTime: '23:59' },
      { time: '00:00' }, { time: '00:00', endTime: '00:30' }, { time: '00:15', endTime: '12:00' },
      { time: '07:00', endTime: '08:00' }, { time: '09:05', endTime: '11:50' }, { time: '11:00', endTime: '12:00' },
      { time: '11:30', endTime: '13:00' }, { time: '12:00', endTime: '13:00' }, { time: '12:30' },
      { time: '16:00', endTime: '17:30' }, { time: '23:00', endTime: '23:59' },
    ];
    const dayLists = [[0], [4], [1, 3], [2, 4, 6], [0, 1, 2, 3, 4, 5, 6]];
    const cadences = [
      { cadence: 'weekly' },
      { cadence: 'biweekly' },
      { cadence: 'monthly' },
      { cadence: 'monthly', weeks: [1] },
      { cadence: 'monthly', weeks: ['last'] },
      { cadence: 'monthly', weeks: [1, 3] },
      { cadence: 'monthly', weeks: [2, 4] },
      { cadence: 'monthly', weeks: [4, 'last'] },
      { cadence: 'monthly', weeks: [1, 2, 3, 4, 'last'] },
    ];

    cadences.forEach(cadence => {
      it(`holds for ${cadence.cadence}${cadence.weeks ? ` in weeks ${cadence.weeks.join(', ')}` : ''}`, function () {
        dayLists.forEach(days => windows.forEach(window => {
          const schedule = normalizeSchedule({ days, time: '18:30', ...window, ...cadence });
          const label = scheduleLabel(schedule);
          assert.deepEqual(parseMeetingTime(label), schedule, label);
        }));
      });
    });
  });

  describe('clubOccurrences', function () {
    const dates = list => list.map(date => [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-'));
    const monthly = (weeks, extra = {}) => ({ schedule: { days: [4], time: '18:30', cadence: 'monthly', weeks, ...extra } });

    // October 2026 has five Thursdays (1, 8, 15, 22, 29); November has four (5, 12, 19, 26).
    const OCTOBER = new Date(2026, 9, 1);

    it('puts "first and third Thursday" on two Thursdays a month, not every one', function () {
      assert.deepEqual(dates(clubOccurrences(monthly([1, 3]), 9, OCTOBER)), ['2026-10-1', '2026-10-15', '2026-11-5', '2026-11-19']);
    });

    it('tells the fourth from the last in a month with five, and meets once when they are the same day', function () {
      assert.deepEqual(dates(clubOccurrences(monthly([4]), 9, OCTOBER)), ['2026-10-22', '2026-11-26']);
      assert.deepEqual(dates(clubOccurrences(monthly(['last']), 9, OCTOBER)), ['2026-10-29', '2026-11-26']);
      assert.deepEqual(dates(clubOccurrences(monthly([4, 'last']), 9, OCTOBER)), ['2026-10-22', '2026-10-29', '2026-11-26']);
    });

    it('finds the last weekday of a 28-day February and of a leap one', function () {
      // February 2027 ends on Sunday the 28th; February 2028 has a fifth Tuesday, the 29th.
      const lastOf = day => ({ schedule: { days: [day], time: '09:00', cadence: 'monthly', weeks: ['last'] } });
      assert.deepEqual(dates(clubOccurrences(lastOf(0), 4, new Date(2027, 1, 1))), ['2027-2-28']);
      assert.deepEqual(dates(clubOccurrences(lastOf(1), 4, new Date(2027, 1, 1))), ['2027-2-22']);
      assert.deepEqual(dates(clubOccurrences(lastOf(2), 5, new Date(2028, 1, 1))), ['2028-2-29']);
      assert.deepEqual(dates(clubOccurrences({ schedule: { ...lastOf(2).schedule, weeks: [4] } }, 5, new Date(2028, 1, 1))), ['2028-2-22']);
    });

    it('carries on across a year boundary', function () {
      const lastFriday = { schedule: { days: [5], time: '17:00', cadence: 'monthly', weeks: ['last'] } };
      assert.deepEqual(dates(clubOccurrences(lastFriday, 20, new Date(2026, 11, 20))), ['2026-12-25', '2027-1-29', '2027-2-26', '2027-3-26', '2027-4-30']);
    });

    it('starts from now: a meeting later today counts, one earlier today does not', function () {
      // Thursday the 17th of September 2026 is the month's third.
      assert.equal(dates(clubOccurrences(monthly([1, 3]), 26, new Date(2026, 8, 17, 9, 0)))[0], '2026-9-17');
      assert.equal(dates(clubOccurrences(monthly([1, 3]), 26, new Date(2026, 8, 17, 19, 0)))[0], '2026-10-1');
    });

    it('stops where a weekly schedule asked for as many weeks would', function () {
      const from = new Date(2026, 9, 1, 12, 0);
      const horizon = new Date(2026, 9, 1 + 26 * 7, 12, 0);
      const all = clubOccurrences(monthly([1, 2, 3, 4, 'last']), 26, from);
      assert.isTrue(all.every(start => start >= from && start < horizon));
      assert.lengthOf(all, clubOccurrences({ schedule: { days: [4], time: '18:30', cadence: 'weekly' } }, 26, from).length);
    });

    it('meets on every day the schedule names', function () {
      const both = { schedule: { days: [2, 4], time: '16:00', cadence: 'monthly', weeks: [2] } };
      assert.deepEqual(dates(clubOccurrences(both, 9, OCTOBER)), ['2026-10-8', '2026-10-13', '2026-11-10', '2026-11-12']);
    });

    it('puts a monthly schedule that does not know its week on no date at all', function () {
      assert.deepEqual(clubOccurrences(monthly(undefined), 26, OCTOBER), []);
      assert.deepEqual(clubOccurrences(monthly([]), 26, OCTOBER), []);
      assert.deepEqual(clubOccurrences(monthly(['sometimes']), 26, OCTOBER), []);
    });

    it('has nothing to say without a schedule', function () {
      [{}, { schedule: null }, { schedule: { days: [] } }, null, undefined].forEach(club => assert.deepEqual(clubOccurrences(club, 4, OCTOBER), []));
    });

    it('still steps a weekly schedule a week at a time, one meeting per day per week', function () {
      const club = { schedule: { days: [1, 3], time: '16:00', cadence: 'weekly' } };
      assert.deepEqual(
        dates(clubOccurrences(club, 3, new Date(2026, 8, 17, 9, 0))),
        ['2026-9-21', '2026-9-23', '2026-9-28', '2026-9-30', '2026-10-5', '2026-10-7'],
      );
    });

    it('still keeps an every-other-week schedule on the same weeks whenever it is asked', function () {
      const club = { schedule: { days: [3], time: '19:00', cadence: 'biweekly' } };
      const early = clubOccurrences(club, 8, new Date(2026, 8, 17, 9, 0));
      const late = clubOccurrences(club, 8, new Date(2026, 8, 24, 9, 0));
      assert.lengthOf(early, 4);
      assert.deepEqual(dates(early), ['2026-9-30', '2026-10-14', '2026-10-28', '2026-11-11']);
      assert.deepEqual(dates(late), dates(early), 'asked a week later, the same Wednesdays');
    });

    /**
     * Hawaiʻi does not change its clocks, which is exactly why this has to be
     * tested rather than noticed: a calendar that steps by milliseconds is
     * right here all year and an hour out for half of it anywhere else. The
     * spans cross both of the mainland's 2026 changes (8 March, 1 November),
     * so in any zone that has them a drift would show as a wrong hour.
     */
    it('keeps the wall-clock time of every meeting, whatever the clocks do', function () {
      const schedules = [
        { days: [0, 3], time: '18:30', endTime: '20:00', cadence: 'weekly' },
        { days: [0], time: '18:30', endTime: '20:00', cadence: 'biweekly' },
        { days: [0, 3], time: '18:30', endTime: '20:00', cadence: 'monthly', weeks: [1, 2, 'last'] },
      ];
      schedules.forEach(schedule => {
        const meetings = clubOccurrenceWindows({ schedule }, 52, new Date(2026, 1, 1));
        assert.isAbove(meetings.length, 20, schedule.cadence);
        meetings.forEach(({ start, end }) => {
          assert.include(schedule.days, start.getDay());
          assert.deepEqual([start.getHours(), start.getMinutes()], [18, 30], `${start}`);
          assert.deepEqual([end.getHours(), end.getMinutes()], [20, 0], `${end}`);
          assert.deepEqual([end.getFullYear(), end.getMonth(), end.getDate()], [start.getFullYear(), start.getMonth(), start.getDate()]);
        });
      });
    });
  });

  describe('clubOccurrenceWindows', function () {
    const from = new Date(2026, 9, 1);

    it('gives every meeting its end, on the same day', function () {
      const club = { schedule: { days: [4], time: '18:00', endTime: '19:30', cadence: 'monthly', weeks: [1, 3] } };
      assert.deepEqual(clubOccurrenceWindows(club, 5, from), [
        { start: new Date(2026, 9, 1, 18, 0), end: new Date(2026, 9, 1, 19, 30) },
        { start: new Date(2026, 9, 15, 18, 0), end: new Date(2026, 9, 15, 19, 30) },
      ]);
    });

    it('says null, not an hour it made up, when the schedule has no end', function () {
      const club = { schedule: { days: [4], time: '18:00', cadence: 'weekly' } };
      assert.deepEqual(clubOccurrenceWindows(club, 2, from), [
        { start: new Date(2026, 9, 1, 18, 0), end: null },
        { start: new Date(2026, 9, 8, 18, 0), end: null },
      ]);
    });

    it('is where clubOccurrences gets its dates, for every cadence', function () {
      [
        { days: [1, 4], time: '07:15', endTime: '08:00', cadence: 'weekly' },
        { days: [3], time: '19:00', cadence: 'biweekly' },
        { days: [5], time: '17:00', endTime: '18:00', cadence: 'monthly', weeks: [2, 'last'] },
      ].forEach(schedule => {
        const starts = clubOccurrenceWindows({ schedule }, 12, from).map(meeting => meeting.start);
        assert.isNotEmpty(starts);
        assert.deepEqual(clubOccurrences({ schedule }, 12, from), starts);
        assert.deepEqual([...starts].sort((a, b) => a - b), starts, 'in order');
      });
    });
  });

  describe('durationMinutes and endTimeAfter', function () {
    it('reads a length off a schedule, and has none to read without an end', function () {
      assert.equal(durationMinutes({ days: [4], time: '18:00', endTime: '19:30' }), 90);
      assert.isNull(durationMinutes({ days: [4], time: '18:00' }));
      assert.isNull(durationMinutes({ days: [4], time: '18:00', endTime: '17:00' }));
      assert.isNull(durationMinutes(null));
    });

    it('turns a length back into the end that is stored', function () {
      assert.equal(endTimeAfter('18:00', 90), '19:30');
      assert.equal(endTimeAfter('09:05', '55'), '10:00');
      assert.equal(endTimeAfter('23:00', 59), '23:59');
      const schedule = { days: [4], time: '18:00', endTime: endTimeAfter('18:00', 90) };
      assert.equal(durationMinutes(schedule), 90);
    });

    it('has no end to give for a meeting that would run past midnight, or for no length at all', function () {
      assert.isNull(endTimeAfter('23:00', 60));
      assert.isNull(endTimeAfter('18:00', 0));
      assert.isNull(endTimeAfter('18:00', -30));
      assert.isNull(endTimeAfter('18:00', 'a while'));
      assert.isNull(endTimeAfter('6pm', 60));
    });
  });

  /**
   * The validator that lived in Methods.js knew two cadences and three keys.
   * A form that sent "first and third Thursday, 6 to 7:30" would have had it
   * stored as every Thursday at 6, and been told nothing.
   */
  describe('a schedule sent to the methods', function () {
    let user;
    let admin;

    const form = {
      name: 'Monthly Makers',
      description: 'We make things.',
      location: 'Kapaʻa',
      meetingTime: 'First & third Thu · 6–7:30 PM',
      schedule: { days: [4], time: '18:00', endTime: '19:30', cadence: 'monthly', weeks: [1, 3] },
    };
    // A call that sends no schedule has no such key. One sent as `undefined`
    // is not the same thing to check(): it never survives the wire, and the
    // method's own pattern refuses it.
    const { schedule: chosen, ...textOnly } = form;
    const stored = () => Clubs.collection.findOne({ name: form.name });

    beforeEach(function () {
      resetAll();
      user = makeUser();
      admin = makeUser({ admin: true });
    });

    it('stores the weeks and the end time a form sends', function () {
      callAs(user, 'Clubs.insert', form);
      assert.deepEqual(stored().schedule, { days: [4], time: '18:00', endTime: '19:30', cadence: 'monthly', weeks: [1, 3] });
    });

    it('stores only what the validator keeps', function () {
      callAs(user, 'Clubs.insert', {
        ...form,
        schedule: { days: ['4', 4, 9], time: '18:00', endTime: '17:00', cadence: 'weekly', weeks: [1, 3], length: 90 },
      });
      assert.deepEqual(stored().schedule, { days: [4], time: '18:00', cadence: 'weekly' });
    });

    it('reads the meeting text when it is sent no schedule, monthly included', function () {
      callAs(user, 'Clubs.insert', { ...textOnly, meetingTime: 'Last Friday of the month, 5-6:30 pm' });
      assert.deepEqual(stored().schedule, { days: [5], time: '17:00', endTime: '18:30', cadence: 'monthly', weeks: ['last'] });
    });

    it('stores no schedule for text one schedule cannot hold', function () {
      callAs(user, 'Clubs.insert', { ...textOnly, meetingTime: 'Coffee first Saturday; Book Club fourth Wednesday' });
      assert.notProperty(stored(), 'schedule');
    });

    it('keeps them through an administrator\'s edit, and re-derives from the label when sent none', function () {
      callAs(user, 'Clubs.insert', { ...form, schedule: { days: [1], time: '09:00', cadence: 'weekly' }, meetingTime: 'Mon · 9 AM' });
      const { _id, owner } = stored();
      const edit = { name: form.name, owner, description: form.description, location: form.location, meetingTime: form.meetingTime };

      callAs(admin, 'Clubs.update', _id, { ...edit, schedule: { ...chosen, weeks: ['last', 2] } });
      assert.deepEqual(stored().schedule, { ...chosen, weeks: [2, 'last'] });

      callAs(admin, 'Clubs.update', _id, edit);
      assert.deepEqual(stored().schedule, chosen);
    });
  });

  describe('DAY_NAMES', function () {
    it('is still Sunday first, which is what every stored day index means', function () {
      assert.lengthOf(DAY_NAMES, 7);
      assert.equal(DAY_NAMES[0], 'Sunday');
      assert.equal(DAY_NAMES[4], 'Thursday');
    });
  });
}
