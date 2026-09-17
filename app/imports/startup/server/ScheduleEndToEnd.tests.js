import { Meteor } from 'meteor/meteor';
import { assert } from 'chai';
import { Clubs } from '../../api/club/Club';
import {
  clubOccurrenceWindows,
  clubOccurrences,
  normalizeSchedule,
  parseMeetingTime,
  scheduleLabel,
} from '../../api/club/schedule';
import { scheduleFrom, initialEnd } from '../../ui/components/form/SchedulePickerModel';
import { clubMeetingLine } from '../../ui/utilities/cardFields';
import { deriveMonthlyWeeks } from './migrations';
import { callAs, makeUser, resetAll } from './testFixtures';

/* eslint-env mocha */

/**
 * One schedule, walked the whole way: out of the "When you meet" card, through
 * 'Clubs.insert', into the database, onto the card as a label, onto the
 * calendar as dated windows, and back through the parser from its own label.
 *
 * Each step has tests of its own beside the code. None of them holds two steps
 * together, and the seams are where a key goes missing: a method that checks
 * a pattern the form no longer sends, a schema that strips what the validator
 * kept, a label the parser reads back as something else.
 */
if (Meteor.isServer) {
  describe('a schedule, from the form to the calendar and back', function () {
    const payload = { days: [4], time: '18:30', endTime: '20:00', cadence: 'monthly', weeks: [1, 3] };
    let user;

    const startAGroup = schedule => {
      callAs(user, 'Clubs.insert', {
        name: 'First And Third',
        description: 'We meet twice a month.',
        location: 'Kapaʻa',
        // What AddClub sends: the text IS the schedule's own label.
        meetingTime: scheduleLabel(schedule),
        schedule,
      });
      return Clubs.collection.findOne({ name: 'First And Third' });
    };

    beforeEach(function () {
      resetAll();
      user = makeUser();
    });

    it('is what the picker emits for those choices', function () {
      const end = { ...initialEnd({}), mode: 'at', at: '20:00' };
      assert.deepEqual(scheduleFrom({ days: [4], time: '18:30', cadence: 'monthly', weeks: [1, 3] }, end), payload);
    });

    it('is stored intact, key for key', function () {
      const club = startAGroup(payload);
      assert.deepEqual(club.schedule, payload);
      assert.equal(club.meetingTime, 'First & third Thu · 6:30–8 PM');
    });

    it('reads on the card as its label', function () {
      const club = startAGroup(payload);
      assert.equal(scheduleLabel(club.schedule), 'First & third Thu · 6:30–8 PM');
      assert.equal(clubMeetingLine(club), 'First & third Thu · 6:30–8 PM');
    });

    it('lands on the first and third Thursdays only, each with its end', function () {
      const club = startAGroup(payload);
      // Half a year from a fixed morning, so a five-Thursday month is in it:
      // October 2026 has the 1st, 8th, 15th, 22nd and 29th.
      const from = new Date(2026, 8, 17, 9, 0);
      const windows = clubOccurrenceWindows(club, 26, from);

      assert.isAbove(windows.length, 10);
      windows.forEach(({ start, end }) => {
        assert.equal(start.getDay(), 4, `${start} is a Thursday`);
        const nth = Math.ceil(start.getDate() / 7);
        assert.include([1, 3], nth, `${start} is the first or the third`);
        assert.equal(start.getHours(), 18);
        assert.equal(start.getMinutes(), 30);
        assert.equal(end.getFullYear(), start.getFullYear());
        assert.equal(end.getMonth(), start.getMonth());
        assert.equal(end.getDate(), start.getDate());
        assert.equal(end.getHours(), 20);
        assert.equal(end.getMinutes(), 0);
      });
      // Every one of them, not merely no wrong one: two a month, in order.
      const october = windows.filter(({ start }) => start.getFullYear() === 2026 && start.getMonth() === 9);
      assert.deepEqual(october.map(({ start }) => start.getDate()), [1, 15]);
      // The 17th of September 2026 is itself the third Thursday, and 9 AM is
      // before 6:30 PM.
      assert.equal(windows[0].start.getDate(), 17);
      assert.deepEqual(clubOccurrences(club, 26, from), windows.map(({ start }) => start));
    });

    it('reads back from its own label as the schedule that wrote it', function () {
      const club = startAGroup(payload);
      assert.deepEqual(parseMeetingTime(club.meetingTime), payload);
      assert.deepEqual(parseMeetingTime(scheduleLabel(club.schedule)), normalizeSchedule(club.schedule));
    });

    it('is left alone by the boot migration, and by an administrator saving the page untouched', function () {
      const club = startAGroup(payload);
      assert.deepEqual(deriveMonthlyWeeks(), { weeks: 0, unknown: 0, cleared: 0 });

      // EditClubAdmin sends no schedule: the method reads the label again.
      const admin = makeUser({ admin: true });
      callAs(admin, 'Clubs.update', club._id, {
        name: club.name,
        owner: club.owner,
        description: club.description,
        location: club.location,
        meetingTime: club.meetingTime,
      });
      assert.deepEqual(Clubs.collection.findOne(club._id).schedule, payload);
    });

    it('holds for the last week, which is a word among numbers', function () {
      const last = { days: [5], time: '17:00', cadence: 'monthly', weeks: [2, 'last'] };
      const club = startAGroup(last);
      assert.deepEqual(club.schedule, last);
      assert.deepEqual(parseMeetingTime(club.meetingTime), last);
      const windows = clubOccurrenceWindows(club, 8, new Date(2026, 9, 1, 9, 0));
      // October 2026: Fridays on the 2nd, 9th, 16th, 23rd and 30th.
      assert.deepEqual(
        windows.filter(({ start }) => start.getMonth() === 9).map(({ start }) => start.getDate()),
        [9, 30],
      );
      windows.forEach(({ end }) => assert.isNull(end));
    });
  });
}
