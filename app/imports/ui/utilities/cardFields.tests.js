/* eslint-env mocha */
import { assert } from 'chai';
import { clubMeetingLine } from './cardFields';

describe('club meeting card line', function () {
  it('uses the compact structured schedule for one repeating time', function () {
    assert.equal(clubMeetingLine({
      meetingTime: 'Monday at 7:00 am',
      schedule: { days: [1], time: '07:00', cadence: 'weekly' },
    }), 'Mon · 7:00 AM');
  });

  it('preserves every source label when a group has several meeting times', function () {
    const complete = 'Monday at 7:00 am; Friday at 7:00 am; Friday at 6:30 pm';
    assert.equal(clubMeetingLine({
      meetingTime: complete,
      schedule: { days: [1, 5], time: '07:00', cadence: 'weekly' },
    }), complete);
  });
});
