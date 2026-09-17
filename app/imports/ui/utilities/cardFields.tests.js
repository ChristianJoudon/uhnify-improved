/* eslint-env mocha */
import { assert } from 'chai';
import { EVENT_FIELDS, clubMeetingLine, readFields } from './cardFields';

/**
 * The mail row is the one place a listing's contact email is shown, so what
 * it reads is what the organizer agreed to publish — and nothing else on the
 * record (not the poster's account) may stand in for it.
 */
describe('event card contact rows', function () {
  const event = { title: 'Pau Hana', date: new Date(2026, 8, 20, 18), location: 'Līhuʻe', phone: '808-555-0100' };

  it('draws a mail row when the organizer published an address', function () {
    const rows = readFields({ ...event, email: 'hello@theclub.example' }, EVENT_FIELDS);
    const mail = rows.find(row => row.key === 'email');
    assert.isOk(mail, 'an address the organizer gave is meant to be seen');
    assert.equal(mail.value, 'hello@theclub.example');
    assert.equal(mail.icon, 'mail');
    assert.equal(rows.findIndex(row => row.key === 'phone') + 1, rows.indexOf(mail), 'the two ways to reach someone sit together');
  });

  it('draws none when the listing has no address', function () {
    assert.notInclude(readFields(event, EVENT_FIELDS).map(row => row.key), 'email');
    assert.notInclude(readFields({ ...event, owner: 'poster@private.example' }, EVENT_FIELDS).map(row => row.key), 'email');
  });
});

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
