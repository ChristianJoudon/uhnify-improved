/**
 * Club meeting schedules.
 *
 * A schedule is
 *   { days: [0-6…], time: 'HH:mm', endTime?: 'HH:mm', cadence: 'weekly' | 'biweekly' | 'monthly', weeks?: [1|2|3|4|'last', …] }
 *
 * `time` is when a meeting starts and `endTime` when it ends, the same day and
 * strictly later. How long it runs is never stored: a form may ask for a length
 * instead of an end, and what it keeps is the end (endTimeAfter), so the two can
 * never disagree.
 *
 * `weeks` says WHICH weeks of the month and means something only when the
 * cadence is 'monthly': "first and third Thursday" is days [4], weeks [1, 3].
 * 'last' is the final such weekday of the month, which in a month with four of
 * them is also the fourth. A monthly schedule with no weeks is "monthly, week
 * unknown". It is labelled "Monthly" and put on no calendar at all, because a
 * wrong date is worse than no date.
 *
 * That last rule is the reason this file changed. 'monthly' was already being
 * stored — the register's importer wrote it on eight groups — while everything
 * here knew only weekly and every-other-week, so the calendar sent members to
 * "first and third Thursday" every Thursday, and three weeks in four there was
 * nobody in the room. The shape had nowhere to say which week; the words
 * survived only in the meeting text.
 *
 * Loaded on both client and server: the methods and the startup migrations
 * read meeting text through the parser, the forms build and label schedules,
 * and the calendars expand them into dates. So nothing here may use a regular
 * expression feature an older Safari refuses to compile (lookbehind), which
 * would take the whole bundle down with it.
 */

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The weeks of a month a meeting can fall in, in the order they are always kept and written. */
export const WEEK_ORDINALS = [
  { value: 1, label: 'First' },
  { value: 2, label: 'Second' },
  { value: 3, label: 'Third' },
  { value: 4, label: 'Fourth' },
  { value: 'last', label: 'Last' },
];

const CADENCES = ['weekly', 'biweekly', 'monthly'];

// What a schedule with no readable start is given. It always was; a stored
// schedule with a blank time has been drawn at 5 PM since there were schedules.
const DEFAULT_TIME = '17:00';

const DAY_MS = 24 * 60 * 60 * 1000;

const CLOCK_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes past midnight for an 'HH:mm' that names a real time of day; null for anything else. */
const minutesOf = clock => {
  const match = CLOCK_SHAPE.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

const clockOf = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * A clean schedule, or null when there is none to keep.
 *
 * The one validator. The methods run every submitted schedule through it, and
 * the label and the calendar read a stored one through it as well — the field
 * is a blackbox, so whatever an older version or a hand in the database left
 * there is what arrives. A private copy of this lived in Methods.js and knew
 * two cadences and three keys; it would have stored a form's "first and third,
 * 6 to 7:30" as weekly at 6 with no end, and said nothing.
 *
 * Nothing here throws. A schedule is an optional nicety beside the meeting
 * text, so a part that makes no sense is dropped and the rest is kept: days
 * outside 0–6 go, and with none left there is no schedule; an unreadable start
 * becomes the default; an end that is not after the start is dropped rather
 * than guessed at; an unknown cadence is weekly; weeks are kept only for a
 * monthly schedule, deduped and in calendar order. Keys it does not know are
 * not carried over.
 */
export const normalizeSchedule = input => {
  if (!input || !Array.isArray(input.days)) {
    return null;
  }
  const days = [...new Set(input.days.map(day => Number.parseInt(day, 10)).filter(day => day >= 0 && day <= 6))]
    .sort((a, b) => a - b);
  if (days.length === 0) {
    return null;
  }
  const time = minutesOf(input.time) === null ? DEFAULT_TIME : input.time;
  const end = minutesOf(input.endTime);
  const cadence = CADENCES.includes(input.cadence) ? input.cadence : 'weekly';
  // A form may send the numbers as text; they are the same weeks.
  const asked = cadence === 'monthly' && Array.isArray(input.weeks) ? input.weeks.map(week => `${week}`.toLowerCase()) : [];
  const weeks = WEEK_ORDINALS.map(ordinal => ordinal.value).filter(value => asked.includes(`${value}`));
  return {
    days,
    time,
    ...(end !== null && end > minutesOf(time) ? { endTime: input.endTime } : {}),
    cadence,
    // Left off rather than stored empty, so "week unknown" has one spelling.
    ...(weeks.length > 0 ? { weeks } : {}),
  };
};

/** How long a meeting runs, in minutes; null when the schedule gives no end. */
export const durationMinutes = input => {
  const schedule = normalizeSchedule(input);
  return schedule && schedule.endTime ? minutesOf(schedule.endTime) - minutesOf(schedule.time) : null;
};

/**
 * The end time of a meeting that starts at `time` and runs for `minutes`.
 *
 * The other half of durationMinutes, for a form that asks how long instead of
 * until when. Null when it would not end on the day it started — the shape has
 * no way to say "past midnight", and an end before its start is exactly what
 * normalizeSchedule throws away.
 */
export const endTimeAfter = (time, minutes) => {
  const start = minutesOf(time);
  const length = Number.parseInt(minutes, 10);
  if (start === null || !(length > 0) || start + length >= 24 * 60) {
    return null;
  }
  return clockOf(start + length);
};

/* ------------------------------------------------------------------ */
/* Reading meeting text                                                */
/* ------------------------------------------------------------------ */

const WEEK_WORDS = {
  first: 1,
  '1st': 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
  // Read so that it can be refused. The shape has no fifth week, and a "fifth
  // Friday" read as plain "Friday" would put a meeting on every one of them.
  fifth: 5,
  '5th': 5,
  last: 'last',
};

// Longest spelling first inside each, so "thursdays" is not read as "thu" and
// then refused for the "rsdays" left over. The three-letter forms are how
// scheduleLabel writes a day; without them, reading back our own text loses
// the schedule.
const DAY_WORDS = [
  'sun(?:days?)?',
  'mon(?:days?)?',
  'tue(?:sdays?|s)?',
  'wed(?:nesdays?|s)?',
  'thu(?:rsdays?|rs?)?',
  'fri(?:days?)?',
  'sat(?:urdays?)?',
];

const tokenPattern = () => new RegExp(`\\b(?:(${Object.keys(WEEK_WORDS).join('|')})|(${DAY_WORDS.join('|')}))\\b`, 'g');

// What may sit between two weeks, or two weekdays, that belong to one list:
// "first and third", "1st & 3rd", "2nd/4th", "the first and the third",
// "Tue, Thu". An "or" is kept apart because it is not a list at all.
const LIST_GAP = /^\s*(?:,\s*and|,|&|\+|\/|and)?\s*(?:the\s+)?$/;
const OR_GAP = /^\s*,?\s*or\s+(?:the\s+)?$/;
// What may sit between a week and the weekday it describes: "first Thursday",
// and the register's "first-Thursday pattern".
const ATTACH_GAP = /^[\s-]+$/;

// A loose week that is followed by the word is about weeks: "2nd and 4th week".
const WEEK_AFTER = /^\s*weeks?\b/;
// ...unless it is "every second week", which is a fortnight and not the second
// week of any month.
const EVERY_BEFORE = /\bevery\s+$/;

// Said in so many words, with no week given. "Every other month" is here so
// that "every other" below does not read it as every other WEEK.
//
// Only ways of saying how OFTEN. This also took a bare "a month" and "per
// month", which is how people write what it costs: "Thursdays 6pm, dues $5 a
// month" became monthly with the week unknown, and a weekly group lost its
// calendar to its own price list. The word "monthly" still counts wherever it
// stands beside a weekday. "Thursdays 6pm, monthly potluck" may well be a
// weekly group, and no rule that tells that from "Thursdays 6pm, monthly
// meeting" is safe to guess with; unknown costs the calendar, and guessing
// weekly would send people to three meetings in four that do not exist.
const SAYS_MONTHLY = /\b(?:bi-?|semi-?)?monthly\b|\b(?:every|each|once a|once per|twice a|(?:\d+|two|three) times a|every other)\s+month\b|\bof the month\b/;
// "every other" is how scheduleLabel writes it; "biweekly" is how the legacy
// seed data does.
const SAYS_FORTNIGHTLY = /\bbi-?weekly\b|\bevery other\b|\bfortnightly\b|\bevery (?:two|2|second|2nd) weeks?\b/;

const NAMED_TIMES = { noon: 12 * 60, midnight: 0 };

const CLOCK = '(\\d{1,2})(?!\\d)(?::([0-5]\\d)(?!\\d))?';
const MERIDIEM = '\\s*([ap])\\.?m\\b\\.?';
const NAMED = `\\b(${Object.keys(NAMED_TIMES).join('|')})\\b`;
const RANGE = '\\s*(?:-|–|—|\\bto\\b|\\buntil\\b|\\btill?\\b|\\bthrough\\b)\\s*';

/**
 * A time, optionally running to a second one: "6 pm", "noon", "6:00 pm – 7:30
 * pm", "6-7:30 PM", "10am-12pm", "6 to 7:30pm".
 *
 * The first number may go without its am or pm, because that is how people
 * write a window; the second may not. A bare number on its own is therefore
 * matched here and thrown away by readSpan — that is what walks the scan past
 * "Room 12", "ages 5-12", "1st" and a phone number without taking any of them
 * for a time of day.
 */
const spanPattern = () => new RegExp(`(?:\\b${CLOCK}(?:${MERIDIEM})?|${NAMED})(?:${RANGE}(?:\\b${CLOCK}${MERIDIEM}|${NAMED}))?`, 'g');

const pointOf = (hour, minute, meridiem) => {
  const hours = Number.parseInt(hour, 10);
  if (!(hours >= 1 && hours <= 12)) {
    return null;
  }
  return ((hours % 12) + (meridiem === 'p' ? 12 : 0)) * 60 + Number.parseInt(minute || '0', 10);
};

/** One match of spanPattern as { time, endTime? }, or null when it was not a time of day after all. */
const readSpan = ([, hour, minute, meridiem, named, endHour, endMinute, endMeridiem, endNamed]) => {
  let end = null;
  if (endNamed) {
    end = NAMED_TIMES[endNamed];
  } else if (endHour) {
    end = pointOf(endHour, endMinute, endMeridiem);
  }

  let start;
  if (named) {
    start = NAMED_TIMES[named];
  } else if (meridiem) {
    start = pointOf(hour, minute, meridiem);
  } else if (end === null) {
    return null;
  } else {
    // "6-7:30 PM": the start borrows the end's half of the day. When that
    // would put it at or after the end — "11-1 pm", "10 to noon" — it is the
    // other half that was meant. When neither fits ("10 to midnight") the
    // start keeps the borrowed half and the end is dropped below, like any
    // other end that is not later the same day. A window ending at noon or
    // midnight is lent 'pm': "10 to midnight" is an evening.
    const lent = endMeridiem || 'p';
    const either = [lent, lent === 'p' ? 'a' : 'p'].map(half => pointOf(hour, minute, half));
    start = either.find(point => point !== null && point < end);
    if (start === undefined) {
      [start] = either;
    }
  }
  if (start === null) {
    return null;
  }
  return { time: clockOf(start), ...(end !== null && end > start ? { endTime: clockOf(end) } : {}) };
};

/**
 * Everything the meeting text says about a schedule, including whether one
 * schedule can hold it. Null when it names no weekday, which is the one thing
 * a schedule cannot be without.
 *
 * The weekdays and the weeks are read as GROUPS: a run of weeks ("first and
 * third") directly before a run of weekdays ("Tuesdays and Thursdays") is one
 * group, and a weekday with no week before it is a group with no weeks.
 *
 * A week that is not directly before a weekday is LOOSE. One on its own is not
 * about a meeting — "first come, first served", "last updated" — and is
 * ignored. A list of them is ("Thursdays, 1st and 3rd", "Thursdays (1st &
 * 3rd)"), and so is one followed by the word ("every 2nd and 4th week on
 * Tuesday", "Thursdays 6pm; 1st & 3rd weeks only"). Every one of those was
 * read as plain weekly, which is the monthly bug again by another door. They
 * make the text monthly and leave the week unknown rather than attach it:
 * "Saturdays, 1st and 2nd grade" is a list of weeks after a weekday too, and
 * the first Thursday is not always in the first week.
 *
 * `refused` is how text that describes more than one schedule can hold keeps
 * from being squashed into one. This used to take every weekday named anywhere
 * and the first time it met, so "Coffee Time first Saturday; Book Club fourth
 * Wednesday" became every Wednesday and every Saturday. It is refused when:
 *   - two groups disagree about the weeks — the line above, or "Tuesdays, and
 *     the first Saturday". One schedule has one list of weeks for all its days.
 *     Groups that agree are one pattern and their days are simply combined.
 *   - an "or" joins weekdays or weeks — "fourth Thursday or Friday". That is
 *     one meeting on a day nobody can compute, not two meetings.
 *   - it names a fifth week, which the shape cannot say.
 *   - it gives two different start times — "Monday at 7 am; Friday at 6:30
 *     pm". The same start written twice is fine, and so is a start with an end.
 */
const readMeetingText = text => {
  const lower = `${text || ''}`.toLowerCase();
  const tokens = [...lower.matchAll(tokenPattern())].map(match => ({
    kind: match[1] ? 'week' : 'day',
    value: match[1] ? WEEK_WORDS[match[1]] : DAY_NAMES.findIndex(name => name.toLowerCase().startsWith(match[2].slice(0, 3))),
    start: match.index,
    end: match.index + match[0].length,
  }));

  const groups = [];
  const weekRuns = [];
  let previous = null;
  let alternatives = false;
  tokens.forEach(token => {
    const gap = lower.slice(previous ? previous.end : 0, token.start);
    const either = Boolean(previous) && previous.kind === token.kind && OR_GAP.test(gap);
    const listed = either || (Boolean(previous) && previous.kind === token.kind && LIST_GAP.test(gap));
    alternatives = alternatives || either;
    if (token.kind === 'week' && listed) {
      const run = weekRuns[weekRuns.length - 1];
      run.values.push(token.value);
      run.end = token.end;
    } else if (token.kind === 'week') {
      weekRuns.push({ values: [token.value], start: token.start, end: token.end, loose: true });
    } else if (listed) {
      groups[groups.length - 1].days.push(token.value);
    } else {
      const run = Boolean(previous) && previous.kind === 'week' && ATTACH_GAP.test(gap) ? weekRuns[weekRuns.length - 1] : null;
      if (run) {
        run.loose = false;
      }
      groups.push({ weeks: run ? run.values : [], days: [token.value] });
    }
    previous = token;
  });
  if (groups.length === 0) {
    return null;
  }

  const aboutWeeks = run => run.values.length > 1 || (
    WEEK_AFTER.test(lower.slice(run.end)) && !(run.values[0] === 2 && EVERY_BEFORE.test(lower.slice(0, run.start)))
  );
  const looseWeeks = weekRuns.some(run => run.loose && aboutWeeks(run));
  const spans = [...lower.matchAll(spanPattern())].map(readSpan).filter(Boolean);
  // Two windows that start together and end apart — "Thu 6-8pm, Fri 6-9pm" —
  // have no one end. The first was taken, and Friday closed an hour early on
  // the card and the calendar. The days and the start are still right, so only
  // the end goes: dropped, not guessed.
  const ends = new Set(spans.map(span => span.endTime).filter(Boolean));
  const weekLists = new Set(groups.map(group => [...new Set(group.weeks)].sort().join()));
  const weeks = groups[0].weeks;
  return {
    days: groups.flatMap(group => group.days),
    weeks,
    time: spans.length > 0 ? spans[0].time : DEFAULT_TIME,
    endTime: ends.size === 1 ? [...ends][0] : undefined,
    monthly: groups.some(group => group.weeks.length > 0) || looseWeeks || SAYS_MONTHLY.test(lower),
    fortnightly: SAYS_FORTNIGHTLY.test(lower),
    refused: alternatives
      || weekLists.size > 1
      || groups.some(group => group.weeks.includes(5))
      || new Set(spans.map(span => span.time)).size > 1,
  };
};

/**
 * Best-effort parse of freeform meeting text into a schedule, or null.
 *
 * Null means "let the text speak": either it names no weekday, or it says more
 * than one schedule can hold (readMeetingText lists the ways). The card prints
 * the text where there is no schedule, and the calendar stays empty, which
 * beats a calendar that is confidently wrong.
 *
 * What it reads: weekdays by name or three letters; "noon" and "midnight" —
 * "Mondays at noon" used to fall through to the 5 PM default; a window in any
 * of the usual spellings, where "6-7:30 PM" used to be read as STARTING at
 * 7:30; a week of the month before a weekday, which makes it monthly; "monthly"
 * or "every month" with no week, or weeks it cannot pin to a weekday, which
 * makes it monthly with the week unknown; and "biweekly" / "every other" as
 * before, with "every second week" beside them. It must also read every label
 * scheduleLabel writes back into the schedule that wrote it, because the edit
 * form stores the label as the meeting text and the method may re-derive from
 * it. The tests hold that round trip for every cadence.
 */
export const parseMeetingTime = text => {
  const read = readMeetingText(text);
  if (!read || read.refused) {
    return null;
  }
  let cadence = 'weekly';
  if (read.monthly) {
    cadence = 'monthly';
  } else if (read.fortnightly) {
    cadence = 'biweekly';
  }
  return normalizeSchedule({ days: read.days, time: read.time, endTime: read.endTime, cadence, weeks: read.weeks });
};

/**
 * The weekdays named by text that puts its meetings in particular weeks of the
 * month, or says "monthly" — whether or not parseMeetingTime could make a
 * schedule of it. Null for text that is not monthly, or names no weekday.
 *
 * For the startup migration: a weekly schedule stored beside text like this was
 * derived by the old parser, which could not see the difference, and is wrong
 * even where the new one can only refuse. This answered yes or no, and the
 * migration deleted on a yes; but the old parser stored every weekday the text
 * names, so a schedule on other days was not its work, and the days are what
 * tell the two apart.
 */
export const monthlyTextDays = text => {
  const read = readMeetingText(text);
  return read && read.monthly ? [...new Set(read.days)].sort((a, b) => a - b) : null;
};

/* ------------------------------------------------------------------ */
/* Writing a schedule                                                  */
/* ------------------------------------------------------------------ */

/** "a", "a & b", "a, b & c". */
const listOf = parts => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}` : parts.join(''));

const clockParts = minutes => {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return {
    // ":00" is dropped, the way the event cards write a time (cardFields).
    text: `${hour % 12 === 0 ? 12 : hour % 12}${minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`}`,
    half: hour >= 12 ? 'PM' : 'AM',
  };
};

/** "6:30 PM", "4–5:30 PM", "10 AM–12 PM": am or pm is written once when both ends share it. */
const windowLabel = schedule => {
  const start = clockParts(minutesOf(schedule.time));
  if (!schedule.endTime) {
    return `${start.text} ${start.half}`;
  }
  const end = clockParts(minutesOf(schedule.endTime));
  return start.half === end.half ? `${start.text}–${end.text} ${end.half}` : `${start.text} ${start.half}–${end.text} ${end.half}`;
};

/**
 * Human label for a schedule:
 *   "Thu · 6:30 PM"                   weekly
 *   "Mon & Wed · 4–5:30 PM"           with an end
 *   "Every other Wed · 7 PM"          biweekly
 *   "First & third Thu · 6:30–8 PM"   monthly
 *   "Last Fri · 5 PM"
 *   "Monthly · Thu · 6:30 PM"         monthly, week unknown
 *
 * Empty for anything that is not a schedule, so every caller can write
 * `scheduleLabel(club.schedule) || club.meetingTime`. It used to drop the
 * cadence it did not know, so a monthly group read as a weekly one here too.
 */
export const scheduleLabel = input => {
  const schedule = normalizeSchedule(input);
  if (!schedule) {
    return '';
  }
  const days = listOf(schedule.days.map(day => DAY_NAMES[day].slice(0, 3)));
  const when = `${days} · ${windowLabel(schedule)}`;
  if (schedule.cadence === 'biweekly') {
    return `Every other ${when}`;
  }
  if (schedule.cadence === 'monthly' && !schedule.weeks) {
    return `Monthly · ${when}`;
  }
  if (schedule.cadence === 'monthly') {
    const weeks = listOf(schedule.weeks.map(week => WEEK_ORDINALS.find(ordinal => ordinal.value === week).label.toLowerCase()));
    return `${weeks.charAt(0).toUpperCase()}${weeks.slice(1)} ${when}`;
  }
  return when;
};

/* ------------------------------------------------------------------ */
/* Putting a schedule on a calendar                                    */
/* ------------------------------------------------------------------ */

// Fixed anchor (a Sunday) so biweekly cadence keeps the same phase on every page load.
const BIWEEKLY_EPOCH = Date.UTC(2024, 0, 7);

/** The day of the month of the nth `day` of a month; every month has four of every weekday. */
const nthWeekday = (year, month, day, nth) => 1 + ((day - new Date(year, month, 1).getDay() + 7) % 7) + (nth - 1) * 7;

/** The day of the month of the final `day` of a month, whether that is its fourth or its fifth. */
const lastWeekday = (year, month, day) => {
  const end = new Date(year, month + 1, 0);
  return end.getDate() - ((end.getDay() - day + 7) % 7);
};

/**
 * Every date from `from` up to `weeks` weeks later that falls in one of the
 * schedule's weeks of its month. None at all when the weeks are unknown.
 *
 * Counted per calendar month rather than by stepping from a first date,
 * because the gap between two first Thursdays is four weeks or five and only
 * the month knows which. 'last' and 4 are the same day in a month with four
 * such weekdays, so a schedule that names both meets once that month.
 */
const monthlyStarts = (schedule, weeks, from, at) => {
  if (!schedule.weeks) {
    return [];
  }
  const horizon = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate() + weeks * 7,
    from.getHours(),
    from.getMinutes(),
    from.getSeconds(),
    from.getMilliseconds(),
  );
  const months = [];
  for (let first = new Date(from.getFullYear(), from.getMonth(), 1); first < horizon; first = new Date(first.getFullYear(), first.getMonth() + 1, 1)) {
    months.push(first);
  }
  const starts = new Map();
  months.forEach(first => schedule.days.forEach(day => schedule.weeks.forEach(week => {
    const year = first.getFullYear();
    const month = first.getMonth();
    const start = at(year, month, week === 'last' ? lastWeekday(year, month, day) : nthWeekday(year, month, day, week));
    if (start >= from && start < horizon) {
      starts.set(start.getTime(), start);
    }
  })));
  return [...starts.values()];
};

const weeklyStarts = (schedule, weeks, from, at) => {
  const stepDays = schedule.cadence === 'biweekly' ? 14 : 7;
  const starts = [];
  schedule.days.forEach(day => {
    // Date-component stepping (not raw ms) keeps the wall-clock time stable across DST.
    const offset = (day - from.getDay() + 7) % 7;
    let first = at(from.getFullYear(), from.getMonth(), from.getDate() + offset);
    if (first < from) {
      first = at(first.getFullYear(), first.getMonth(), first.getDate() + 7);
    }
    if (schedule.cadence === 'biweekly') {
      const weekIndex = Math.floor((first.getTime() - BIWEEKLY_EPOCH) / (7 * DAY_MS));
      if (((weekIndex % 2) + 2) % 2 === 1) {
        first = at(first.getFullYear(), first.getMonth(), first.getDate() + 7);
      }
    }
    const total = Math.ceil((weeks * 7) / stepDays);
    for (let i = 0; i < total; i++) {
      starts.push(at(first.getFullYear(), first.getMonth(), first.getDate() + i * stepDays));
    }
  });
  return starts;
};

/**
 * Expand a club's schedule into its meetings for the next `weeks` weeks, each
 * as { start, end }. `end` is null when the schedule gives no end time — a
 * calendar can draw that; it cannot un-draw an hour somebody made up.
 *
 * Both ends are built from date components on the meeting's own day, so the
 * wall-clock times hold wherever the clocks change. Hawaiʻi's never do, but
 * nothing here may lean on that.
 */
export const clubOccurrenceWindows = (club, weeks = 10, from = new Date()) => {
  const schedule = normalizeSchedule(club?.schedule);
  if (!schedule) {
    return [];
  }
  const onDay = minutes => (year, month, date) => new Date(year, month, date, Math.floor(minutes / 60), minutes % 60, 0, 0);
  const startAt = onDay(minutesOf(schedule.time));
  const endAt = schedule.endTime ? onDay(minutesOf(schedule.endTime)) : null;
  const starts = schedule.cadence === 'monthly'
    ? monthlyStarts(schedule, weeks, from, startAt)
    : weeklyStarts(schedule, weeks, from, startAt);
  return starts
    .sort((a, b) => a.getTime() - b.getTime())
    .map(start => ({ start, end: endAt ? endAt(start.getFullYear(), start.getMonth(), start.getDate()) : null }));
};

/** The same meetings as clubOccurrenceWindows, as the Date each one starts. */
export const clubOccurrences = (club, weeks = 10, from = new Date()) => clubOccurrenceWindows(club, weeks, from).map(meeting => meeting.start);
