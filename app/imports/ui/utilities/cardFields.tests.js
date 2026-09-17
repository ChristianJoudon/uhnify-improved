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
    }), 'Mon · 7 AM');
  });

  // The card is where the monthly bug was read by the most people: the label
  // dropped the cadence, so "first and third Thursday" said "Thu".
  it('says which weeks a monthly group meets, and until when', function () {
    assert.equal(clubMeetingLine({
      meetingTime: 'First and third Thursdays · 6:30 PM',
      schedule: { days: [4], time: '18:30', endTime: '20:00', cadence: 'monthly', weeks: [1, 3] },
    }), 'First & third Thu · 6:30–8 PM');
  });

  // A schedule that says "monthly" and not which week knows less than the
  // text beside it, and its label printed a 5 PM nobody wrote.
  it('lets the text speak when the schedule does not know which week', function () {
    const unknown = { days: [4], time: '17:00', cadence: 'monthly' };
    assert.equal(
      clubMeetingLine({ meetingTime: 'Thursday - first and third of the month', schedule: unknown }),
      'Thursday - first and third of the month',
    );
    assert.equal(
      clubMeetingLine({ meetingTime: 'Every other month on Thursday', schedule: { ...unknown, weeks: [] } }),
      'Every other month on Thursday',
    );
    // With no text there is only the label, and the form's text is the label anyway.
    assert.equal(clubMeetingLine({ schedule: unknown }), 'Monthly · Thu · 5 PM');
    assert.equal(clubMeetingLine({ meetingTime: 'Monthly · Thu · 5 PM', schedule: unknown }), 'Monthly · Thu · 5 PM');
  });

  it('preserves every source label when a group has several meeting times', function () {
    const complete = 'Monday at 7:00 am; Friday at 7:00 am; Friday at 6:30 pm';
    assert.equal(clubMeetingLine({
      meetingTime: complete,
      schedule: { days: [1, 5], time: '07:00', cadence: 'weekly' },
    }), complete);
  });
});
