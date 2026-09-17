import { WEEK_ORDINALS, durationMinutes, endTimeAfter, normalizeSchedule, scheduleLabel } from '../../../api/club/schedule';

/**
 * What the "When you meet" card knows that a schedule does not.
 *
 * A schedule stores when a meeting ends and never how long it runs (see
 * api/club/schedule.js). People say it both ways — "till eight", "about an
 * hour and a half" — so the card asks either. Which way somebody answered, the
 * end they have half typed and the length they picked are the card's own
 * business: they are held here as an `end`,
 *   { mode: 'none' | 'at' | 'lasts', at: 'HH:mm' | '', length: minutes | null }
 * and the only thing that ever leaves the card is an `endTime`.
 *
 * Kept out of the component so the arithmetic can be tested without a browser.
 */

/** What an untouched time input shows; the same 5 PM a schedule with no readable start is given. */
export const DEFAULT_START = '17:00';

/** The lengths offered as one tap. Anything else is reached through "Ends at". */
export const QUICK_LENGTHS = [30, 60, 90, 120, 180];

// What "Ends at" and "Lasts" open on when there is nothing to carry over. An
// empty time input is three fields to fill on a desktop and a blank wheel on a
// phone; an hour is right more often than anything else, it is on show in the
// line below the moment it is chosen, and "No end" is one tap away.
const OPENING_LENGTH = 60;

/** Minutes from `time` to `endTime`, or null when the validator would not keep that end. */
const lengthBetween = (time, endTime) => durationMinutes({ days: [0], time, endTime });

/** "30 min", "1 hr", "1½ hr", "1 hr 15 min". */
export const lengthLabel = minutes => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${rest} min`;
  }
  if (rest === 0) {
    return `${hours} hr`;
  }
  return rest === 30 ? `${hours}½ hr` : `${hours} hr ${rest} min`;
};

/** The same length for someone listening, who would otherwise hear "one one-half h r". */
export const lengthSpoken = minutes => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [
    hours > 0 ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '',
    rest > 0 ? `${rest} minutes` : '',
  ].filter(Boolean).join(' ');
};

/**
 * The lengths to put on show. A meeting that already runs for something else —
 * 6 to 7:15, typed under "Ends at" — gets a pill of its own, because a row with
 * nothing lit beside a line that says "6–7:15 PM" reads as a form that forgot.
 */
export const lengthChoices = length => (length && !QUICK_LENGTHS.includes(length)
  ? [...QUICK_LENGTHS, length].sort((a, b) => a - b)
  : QUICK_LENGTHS);

/** The card's end for a schedule as it arrives. A stored end is an end time, so that is how it is shown. */
export const initialEnd = value => ({ mode: value.endTime ? 'at' : 'none', at: value.endTime || '', length: null });

/**
 * The `endTime` to send for a start and the card's end, or null for none.
 *
 * It asks the schedule's own validator rather than comparing clocks here, so
 * the card and the server cannot come to disagree about which ends count: one
 * that is not later the same day is simply not sent.
 */
export const endTimeFor = (time, end) => {
  if (end.mode === 'at') {
    return lengthBetween(time, end.at) === null ? null : end.at;
  }
  return end.mode === 'lasts' ? endTimeAfter(time, end.length) : null;
};

/** Why an end that was asked for is not being sent; empty when there is nothing to say. */
export const endHint = (time, end) => {
  if (endTimeFor(time, end)) {
    return '';
  }
  if (end.mode === 'at' && end.at) {
    return 'Ends after it starts';
  }
  return end.mode === 'lasts' && end.length ? 'That runs past midnight' : '';
};

/**
 * The card's end after somebody picks "Ends at", "Lasts" or "No end".
 *
 * The end in force is carried across, so flipping between the two ways of
 * saying it changes the question and not the answer: 6 to 7:30 becomes 1½ hr
 * and back. It is written into BOTH fields on every change, "No end" included.
 * Only the field being opened used to be, so the other went stale: 6:30,
 * "Ends at" 7:30, "Lasts" 2 hr, "No end", "Ends at" came back showing 7:30,
 * an end that had not been in force for three taps.
 *
 * With nothing in force each mode returns to what it last held, and failing
 * that opens on an hour. A remembered end time counts only while it is still
 * after the start. One the start has since moved past would open the input
 * with "Ends after it starts" already under it — told off before typing
 * anything — so it is let go and the hour is offered instead.
 */
export const withEndMode = (time, end, mode) => {
  const standing = endTimeFor(time, end);
  const held = standing ? { at: standing, length: lengthBetween(time, standing) } : {};
  if (mode === 'at') {
    const remembered = lengthBetween(time, end.at) === null ? '' : end.at;
    return { ...end, ...held, mode, at: standing || remembered || endTimeAfter(time, OPENING_LENGTH) || '' };
  }
  if (mode === 'lasts') {
    return { ...end, ...held, mode, length: held.length || end.length || OPENING_LENGTH };
  }
  return { ...end, ...held, mode };
};

/** A list of weeks with one switched, kept in the order the month has them. */
export const toggleWeek = (weeks, week) => WEEK_ORDINALS
  .map(ordinal => ordinal.value)
  .filter(value => (value === week ? !weeks.includes(value) : weeks.includes(value)));

/**
 * The weeks a cadence starts with. Choosing "Once a month" with none to go back
 * to picks the first: a monthly schedule with no week is put on no calendar at
 * all, and nobody should land in that state by tapping a segment.
 *
 * Except on a listing that ARRIVED not knowing its week. There the first is not
 * a starting point, it is a claim: an admin who looked at "Every week" and came
 * back found First lit, the hint gone, and the meeting text rewritten to "First
 * Thu" for a group whose listing only ever said monthly. Until somebody picks
 * a week, going back to monthly goes back to not knowing.
 */
export const weeksFor = (cadence, remembered, arrivedUnknown = false) => {
  if (cadence !== 'monthly') {
    return [];
  }
  if (remembered.length > 0) {
    return remembered;
  }
  return arrivedUnknown ? [] : [1];
};

/** Monthly, and nothing says which week. */
export const weekUnknown = value => value.cadence === 'monthly' && !(value.weeks || []).length;

/**
 * What the card hands back: the stored shape and nothing else. No length, no
 * mode; `endTime` only when there is one to keep; `weeks` only for a monthly
 * schedule and never empty, which is how "week unknown" is spelled. The days
 * may be empty — the form is still being filled in — and that is the one way
 * this differs from what normalizeSchedule would return.
 */
export const scheduleFrom = ({ days, time, cadence, weeks }, end) => {
  const endTime = endTimeFor(time, end);
  return {
    days,
    time,
    ...(endTime ? { endTime } : {}),
    cadence,
    ...(cadence === 'monthly' && weeks.length > 0 ? { weeks } : {}),
  };
};

/**
 * The schedule's label as the tail of "Meets …". A weekday keeps its capital
 * in the middle of a sentence; "Every other", "First" and "Monthly" do not.
 */
export const echoLabel = value => {
  const schedule = normalizeSchedule(value);
  const label = scheduleLabel(schedule);
  return schedule && schedule.cadence !== 'weekly' ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
};
