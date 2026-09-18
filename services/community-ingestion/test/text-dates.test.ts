import assert from 'node:assert/strict';
import test from 'node:test';
import { findClock, findDates, findWeeklyRule, formatDate, occurrences } from '../src/text-dates.js';

const TODAY = { today: '2026-09-17' };
const dates = (text: string, options = TODAY) => findDates(text, options).map(hit => (hit.endDate ? `${hit.date}..${hit.endDate}` : hit.date));

test('dates as publishers on Kauaʻi actually write them', () => {
  assert.deepEqual(dates('Sunday, August 30, 2026, 3-6 PM, Waikomo Courtyard'), ['2026-08-30']);
  assert.deepEqual(dates('06:00 PM - 08:30 PM on Sat, 26 Sep 2026'), ['2026-09-26']);
  assert.deepEqual(dates('Saturday, October 17: National Wildlife Refuge Week'), ['2026-10-17']);
  assert.deepEqual(dates('Sept. 27th'), ['2026-09-27']);
  assert.deepEqual(dates('Sunday 9/20: 9:30 a.m. Annual Church Picnic @ Lydgate Beach Park'), ['2026-09-20']);
  assert.deepEqual(dates('9/6 @ 9:30 am.'), ['2026-09-06']);
  assert.deepEqual(dates('date: 9-18-2026'), ['2026-09-18']);
  assert.deepEqual(dates('Start Date : 2026-08-11'), ['2026-08-11']);
  assert.deepEqual(dates('Nov 12, 2026'), ['2026-11-12']);
});

test('a missing year is the nearest one that is not long past', () => {
  assert.deepEqual(dates('Jan 3'), ['2027-01-03'], 'January read in September is next January');
  assert.deepEqual(dates('Sep 12'), ['2026-09-12'], 'five days ago is this year, not eleven months ahead');
  assert.deepEqual(dates('Feb 21', { today: '2026-09-17', yearHint: 2026 } as never), ['2026-02-21'], 'a heading that names the year wins');
});

test('ranges and lists of days', () => {
  assert.deepEqual(dates('Fall Forest Camp October 8–11, 2026'), ['2026-10-08..2026-10-11']);
  assert.deepEqual(dates('Come from Away (Jan 8 – 31, 2027)'), ['2027-01-08..2027-01-31']);
  assert.deepEqual(dates('The Cemetery Club Feb 26 – Mar 14, 2027'), ['2027-02-26..2027-03-14']);
  assert.deepEqual(dates('runs April 7 through May 12, 2027'), ['2027-04-07..2027-05-12']);
  assert.deepEqual(dates('What Does It Mean to Be an Episcopalian — September 13th & 20th'), ['2026-09-13', '2026-09-20']);
  assert.deepEqual(dates('9/13, 9/20 @ 9:00 am.'), ['2026-09-13', '2026-09-20']);
  assert.deepEqual(dates('Friday, July 17, 2027, Saturday, July 18, 2027 starts at 7:30 pm'), ['2027-07-17', '2027-07-18']);
});

test('what is not a date is not read as one', () => {
  assert.deepEqual(dates('Open 24/7, call 808-245-1234, 9-12pm, $5-10'), []);
  assert.deepEqual(dates('October 3, 9 AM at the pavilion'), ['2026-10-03'], 'the 9 is an hour, not a second day');
  assert.deepEqual(dates('February 30, 2027'), [], 'a day the month does not have');
  assert.deepEqual(dates('Date & Time: Sunday, November 29, 3-6 PM'), ['2026-11-29'], 'the 3 begins a time range, not a second day');
  assert.deepEqual(dates('Saturday, June 20, 3 to 9 PM', { today: '2026-05-01' }), ['2026-06-20']);
  assert.deepEqual(dates('01/07/2026 - 3:30pm to 12/31/2026 - 6:00pm'), ['2026-01-07..2026-12-31'], 'one run, not two dates');
});

test('times of day', () => {
  assert.deepEqual(findClock('5:30 pm - 10:00 pm'), { start: '17:30', end: '22:00' });
  assert.deepEqual(findClock('3-6 PM, Waikomo Courtyard'), { start: '15:00', end: '18:00' });
  assert.deepEqual(findClock('Tue 9 a.m.-noon'), { start: '09:00', end: '12:00' });
  assert.deepEqual(findClock('Beach Clean Up 9-12pm'), { start: '09:00', end: '12:00' });
  assert.deepEqual(findClock('8:30-10:30am'), { start: '08:30', end: '10:30' });
  assert.deepEqual(findClock('10:00 AM to 3:00 PM at Lydgate Pavilion'), { start: '10:00', end: '15:00' });
  assert.deepEqual(findClock('Welcome Mass at 6 pm'), { start: '18:00' });
  assert.deepEqual(findClock('4 p.m. to dusk'), { start: '16:00' });
  assert.deepEqual(findClock('starts 17:30 sharp'), { start: '17:30' });
  assert.deepEqual(findClock('no time here, 2026'), {});
});

test('weekly and monthly rules, only where the text says it repeats', () => {
  assert.deepEqual(findWeeklyRule('Every Friday'), { weekdays: [5] });
  assert.deepEqual(findWeeklyRule('Tuesdays and Saturdays'), { weekdays: [2, 6] });
  assert.deepEqual(findWeeklyRule('Mon/Thu 5:00 pm hula'), { weekdays: [1, 4] });
  assert.deepEqual(findWeeklyRule('Every 1st Friday of the Month'), { weekdays: [5], ordinals: [1] });
  assert.deepEqual(findWeeklyRule('1st and 3rd Saturdays'), { weekdays: [6], ordinals: [1, 3] });
  assert.deepEqual(findWeeklyRule('fourth Saturday of each month 9am-noon'), { weekdays: [6], ordinals: [4] });
  assert.deepEqual(findWeeklyRule('Live music nightly'), { weekdays: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(findWeeklyRule('Saturday, October 3, 2026'), undefined);
  assert.equal(findWeeklyRule('Friday 4th'), undefined, 'the fourth of the month, not the fourth Friday');
  assert.deepEqual(findWeeklyRule('3rd Saturday of every month'), { weekdays: [6], ordinals: [3] });
  assert.equal(findWeeklyRule('Sunset yoga with friends'), undefined);
});

test('a rule lands on the right days', () => {
  assert.deepEqual(occurrences({ weekdays: [5] }, '2026-09-17', 14), ['2026-09-18', '2026-09-25', '2026-10-01'].slice(0, 2));
  assert.deepEqual(occurrences({ weekdays: [5], ordinals: [1] }, '2026-09-17', 60), ['2026-10-02', '2026-11-06']);
  assert.deepEqual(occurrences({ weekdays: [0], ordinals: [-1] }, '2026-09-17', 45), ['2026-09-27', '2026-10-25']);
});

test('dates format into endpoint templates', () => {
  assert.equal(formatDate('2026-09-08', 'M-D-YYYY'), '9-8-2026');
  assert.equal(formatDate('2026-09-08', 'YYYY/MM'), '2026/09');
  assert.equal(formatDate('2026-09-08', 'YYYY-MM-DD'), '2026-09-08');
});
