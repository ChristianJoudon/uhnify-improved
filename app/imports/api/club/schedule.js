/**
 * Club meeting schedules. A schedule is { days: [0-6], time: 'HH:mm', cadence: 'weekly'|'biweekly' }.
 * Loaded on both client and server: the server migration parses legacy meetingTime strings,
 * and calendars expand schedules into concrete occurrences.
 */

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Best-effort parse of freeform meeting text ("Every Tuesday and Thursday 5:00 pm - 7:00 pm"). */
export const parseMeetingTime = text => {
  if (!text) {
    return null;
  }
  const lower = `${text}`.toLowerCase();
  const days = [];
  DAY_NAMES.forEach((dayName, dayIndex) => {
    if (lower.includes(dayName.toLowerCase())) {
      days.push(dayIndex);
    }
  });
  if (days.length === 0) {
    return null;
  }
  let time = '17:00';
  const match = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (match) {
    let hour = Number.parseInt(match[1], 10) % 12;
    if (match[3] === 'pm') {
      hour += 12;
    }
    time = `${String(hour).padStart(2, '0')}:${match[2] || '00'}`;
  }
  return { days, time, cadence: lower.includes('biweekly') ? 'biweekly' : 'weekly' };
};

/** Human label for a schedule: "Mon & Wed · 4:00 PM". */
export const scheduleLabel = schedule => {
  if (!schedule || !schedule.days || schedule.days.length === 0) {
    return '';
  }
  const dayPart = schedule.days.map(day => DAY_NAMES[day].slice(0, 3)).join(' & ');
  const [hourText, minute] = (schedule.time || '17:00').split(':');
  const hour = Number.parseInt(hourText, 10);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  const prefix = schedule.cadence === 'biweekly' ? 'Every other ' : '';
  return `${prefix}${dayPart} · ${displayHour}:${minute} ${suffix}`;
};

// Fixed anchor (a Sunday) so biweekly cadence keeps the same phase on every page load.
const BIWEEKLY_EPOCH = Date.UTC(2024, 0, 7);

/** Expand a club's schedule into concrete Date occurrences for the next `weeks` weeks. */
export const clubOccurrences = (club, weeks = 10, from = new Date()) => {
  const schedule = club.schedule;
  if (!schedule || !schedule.days || schedule.days.length === 0) {
    return [];
  }
  const [hourText, minuteText] = (schedule.time || '17:00').split(':');
  const parsedHour = Number.parseInt(hourText, 10);
  const hour = Number.isNaN(parsedHour) ? 17 : parsedHour;
  const parsedMinute = Number.parseInt(minuteText, 10);
  const minute = Number.isNaN(parsedMinute) ? 0 : parsedMinute;
  const stepDays = schedule.cadence === 'biweekly' ? 14 : 7;
  const occurrences = [];
  schedule.days.forEach(day => {
    // Date-component stepping (not raw ms) keeps the wall-clock time stable across DST.
    const offset = (day - from.getDay() + 7) % 7;
    let occurrence = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hour, minute, 0, 0);
    if (occurrence < from) {
      occurrence = new Date(occurrence.getFullYear(), occurrence.getMonth(), occurrence.getDate() + 7, hour, minute, 0, 0);
    }
    if (schedule.cadence === 'biweekly') {
      const weekIndex = Math.floor((occurrence.getTime() - BIWEEKLY_EPOCH) / (7 * DAY_MS));
      if (((weekIndex % 2) + 2) % 2 === 1) {
        occurrence = new Date(occurrence.getFullYear(), occurrence.getMonth(), occurrence.getDate() + 7, hour, minute, 0, 0);
      }
    }
    const total = Math.ceil((weeks * 7) / stepDays);
    for (let i = 0; i < total; i++) {
      occurrences.push(new Date(occurrence.getFullYear(), occurrence.getMonth(), occurrence.getDate() + i * stepDays, hour, minute, 0, 0));
    }
  });
  return occurrences.sort((a, b) => a.getTime() - b.getTime());
};
