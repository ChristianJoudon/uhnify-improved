/**
 * Dates, times and weekly rules the way people type them.
 *
 * Half of Kauaʻi's calendars are not calendars: they are a church's front
 * page ("Sunday 9/20: 9:30 a.m. Annual Picnic"), a blog post ("runs April 7
 * through May 12, 2026"), a table of paddling races ("Feb 21", the year in
 * the heading), a market directory ("every Tuesday, 2 pm to dusk"). This
 * reads those. It never guesses a date that is not written: a missing year
 * is inferred the way a reader infers it — the nearest one that is not long
 * past — and everything else comes back undefined.
 *
 * All dates are Kauaʻi calendar dates (UTC−10, no daylight saving), as
 * 'YYYY-MM-DD'; all clocks are 'HH:MM' on that day.
 */
const DAY_MS = 86_400_000;
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DAY = '(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?';
const YEAR = '((?:19|20)\\d{2})';
const DASH = '\\s*(?:-|–|—|to|through|thru|until)(?:\\s*[-–—])?\\s*';

/** `spans`: the stretches of the match that are the dates themselves, when the match also runs over a time ("1/7/2026 - 3:30pm to 12/31/2026"). */
export type DateHit = {
  date: string; endDate?: string; index: number; length: number; spans?: Array<[number, number]>;
  /**
   * When the text names a weekday beside the date: 'agrees'; 'corrected' when
   * the year had to be inferred and the neighbouring year is the one where
   * that weekday falls on that date; 'disagrees' when the page contradicts
   * itself ("Saturday, October 18" in a year where the 18th is a Sunday).
   */
  weekday?: 'agrees' | 'corrected' | 'disagrees';
};
export type Clock = { start?: string; end?: string };
export type WeeklyRule = { weekdays: number[]; ordinals?: number[] };
export type DateOptions = {
  today?: string;
  yearHint?: number;
  /** Read "today", "tomorrow", "this Saturday" against `today` — for a post with a publication date, never for a standing page. */
  relative?: boolean;
};

export const kauaiToday = (now = Date.now()): string => new Date(now - 10 * 3_600_000).toISOString().slice(0, 10);

const pad = (value: number): string => String(value).padStart(2, '0');

const monthIndex = (name: string): number => MONTH_NAMES.findIndex(month => month.startsWith(name.toLowerCase().replace('.', '').slice(0, 3)));

const valid = (year: number, month: number, day: number): string | undefined => {
  if (month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return undefined;
  return `${year}-${pad(month + 1)}-${pad(day)}`;
};

/** The year a reader would assume for "Sep 18": this one, unless that is long past. */
const inferYear = (month: number, day: number, options: DateOptions): number => {
  if (options.yearHint) return options.yearHint;
  const today = options.today ?? kauaiToday();
  const year = Number(today.slice(0, 4));
  const candidate = Date.UTC(year, month, day);
  return candidate < Date.parse(`${today}T00:00:00Z`) - 60 * DAY_MS ? year + 1 : year;
};

const fullYear = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const year = Number(raw);
  return raw.length === 2 ? 2000 + year : year;
};

type Found = { date: string | undefined; endDate?: string | undefined; spans?: Array<[number, number]>; inferred?: boolean };
type Pattern = { expression: RegExp; read: (match: RegExpExecArray, options: DateOptions) => Found[] };

const PATTERNS: Pattern[] = [
  // 2026-10-08
  { expression: /\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g,
    read: match => [{ date: valid(Number(match[1]), Number(match[2]) - 1, Number(match[3])) }] },
  // July 17 – August 2, 2026 · Feb 26 – Mar 14
  { expression: new RegExp(`\\b${MONTH}\\s+${DAY}${DASH}${MONTH}\\s+${DAY}(?:,?\\s+${YEAR})?`, 'gi'),
    read: (match, options) => {
      const [startMonth, endMonth] = [monthIndex(match[1]!), monthIndex(match[3]!)];
      const endYear = fullYear(match[5]) ?? inferYear(endMonth, Number(match[4]), options);
      const startYear = startMonth > endMonth ? endYear - 1 : endYear;
      return [{ date: valid(startYear, startMonth, Number(match[2])), endDate: valid(endYear, endMonth, Number(match[4])), inferred: !match[5] && !options.yearHint }];
    } },
  // October 8–11, 2026 · Jan 8 – 31
  { expression: new RegExp(`\\b${MONTH}\\s+${DAY}${DASH}${DAY}(?!\\s*(?::\\d|[ap]\\.?m))(?:,?\\s+${YEAR})?`, 'gi'),
    read: (match, options) => {
      const month = monthIndex(match[1]!);
      const year = fullYear(match[4]) ?? inferYear(month, Number(match[2]), options);
      return [{ date: valid(year, month, Number(match[2])), endDate: valid(year, month, Number(match[3])), inferred: !match[4] && !options.yearHint }];
    } },
  // September 13th & 20th · Sept 13, 20 and 27 (each its own date)
  { expression: new RegExp(`\\b${MONTH}\\s+${DAY}((?:\\s*(?:,|&|and)\\s*${DAY}(?!\\s*(?::\\d|[ap]\\.?m|\\d|(?:[-–—]|to)\\s*\\d)))+)(?:,?\\s+${YEAR})?`, 'gi'),
    read: (match, options) => {
      const month = monthIndex(match[1]!);
      const days = [Number(match[2]), ...[...match[3]!.matchAll(/\d{1,2}/g)].map(found => Number(found[0]))];
      const year = fullYear(match[5]) ?? inferYear(month, days[0]!, options);
      return days.map(day => ({ date: valid(year, month, day), inferred: !match[5] && !options.yearHint }));
    } },
  // Sunday, August 30, 2026 · Aug. 30 · September 27th
  { expression: new RegExp(`\\b${MONTH}\\s+${DAY}(?!\\s*(?::\\d|[ap]\\.?m\\b))(?:,?\\s+${YEAR})?`, 'gi'),
    read: (match, options) => {
      const month = monthIndex(match[1]!);
      const day = Number(match[2]);
      return [{ date: valid(fullYear(match[3]) ?? inferYear(month, day, options), month, day), inferred: !match[3] && !options.yearHint }];
    } },
  // 26 Sep 2026 · 26 September
  { expression: new RegExp(`\\b${DAY}\\s+${MONTH}(?:,?\\s+${YEAR})?`, 'gi'),
    read: (match, options) => {
      const month = monthIndex(match[2]!);
      const day = Number(match[1]);
      return [{ date: valid(fullYear(match[3]) ?? inferYear(month, day, options), month, day), inferred: !match[3] && !options.yearHint }];
    } },
  // 01/07/2026 - 3:30pm to 12/31/2026 - 6:00pm: a run, the way a Drupal date field prints one
  { expression: /(?<![\d/.-])(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})(?:\s*[-–—,]?\s*\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)?\s*(?:to|through|thru|until|[-–—])\s*(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})/gi,
    read: match => {
      const first = `${match[1]}/${match[2]}/${match[3]}`;
      const second = `${match[4]}/${match[5]}/${match[6]}`;
      const secondAt = match[0].lastIndexOf(second);
      return [{
        date: valid(Number(match[3]), Number(match[1]) - 1, Number(match[2])),
        endDate: valid(Number(match[6]), Number(match[4]) - 1, Number(match[5])),
        spans: [[match.index, first.length], [match.index + secondAt, second.length]],
      }];
    } },
  // 9/20/2026 · 9-18-2026 · 9/20 (only with a month and day that can be one)
  { expression: /(?<![\d/.-])(\d{1,2})([/-])(\d{1,2})(?:\2((?:19|20)?\d{2}))?(?![\d/]|\s*(?:am|pm|a\.m|p\.m))/gi,
    read: (match, options) => {
      const month = Number(match[1]) - 1;
      const day = Number(match[3]);
      if (match[2] === '-' && !match[4]) return [];
      return [{ date: valid(fullYear(match[4]) ?? inferYear(month, day, options), month, day), inferred: !match[4] && !options.yearHint }];
    } },
];

/**
 * Every date written in the text, in reading order. Longer forms win over
 * the shorter forms inside them ("July 17 – August 2, 2026" is one range,
 * not two dates and a year).
 */
export const findDates = (text: string, options: DateOptions = {}): DateHit[] => {
  const hits: DateHit[] = [];
  const taken: Array<[number, number]> = [];
  for (const { expression, read } of PATTERNS) {
    expression.lastIndex = 0;
    for (let match = expression.exec(text); match; match = expression.exec(text)) {
      const [from, to] = [match.index, match.index + match[0].length];
      if (taken.some(([start, end]) => from < end && to > start)) continue;
      const found = read(match, options).filter((hit): hit is Found & { date: string } => Boolean(hit.date));
      if (!found.length) continue;
      taken.push([from, to]);
      // "Saturday, " just before the date is the page checking our arithmetic.
      const named = NAMED_WEEKDAY.exec(text.slice(Math.max(0, from - 16), from));
      const stated = named ? WEEKDAY_NAMES.findIndex(name => name.startsWith(named[1]!.toLowerCase().slice(0, 3))) : -1;
      found.forEach((hit, position) => {
        let { date, endDate } = hit;
        let weekday: DateHit['weekday'];
        if (stated >= 0 && position === 0) {
          const falls = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
          if (falls(date) === stated) weekday = 'agrees';
          else {
            // A year nobody wrote is a guess; the weekday somebody wrote is not.
            const shifted = hit.inferred ? [1, -1].map(delta => `${Number(date.slice(0, 4)) + delta}${date.slice(4)}`)
              .find(candidate => valid(Number(candidate.slice(0, 4)), Number(candidate.slice(5, 7)) - 1, Number(candidate.slice(8))) && falls(candidate) === stated) : undefined;
            if (shifted) {
              const delta = Number(shifted.slice(0, 4)) - Number(date.slice(0, 4));
              if (endDate) endDate = `${Number(endDate.slice(0, 4)) + delta}${endDate.slice(4)}`;
              date = shifted;
              weekday = 'corrected';
            } else weekday = 'disagrees';
          }
        }
        hits.push({
          date,
          ...(endDate && endDate >= date ? { endDate } : {}),
          ...(hit.spans ? { spans: hit.spans } : {}),
          ...(weekday ? { weekday } : {}),
          index: from,
          length: to - from,
        });
      });
    }
  }
  if (options.relative) {
    const today = options.today ?? kauaiToday();
    const at = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
    const todayIs = new Date(`${today}T00:00:00Z`).getUTCDay();
    for (const match of text.matchAll(/\b(today|tonight|this\s+(?:morning|afternoon|evening)|tomorrow)\b|\b(this|this\s+coming|coming|next)\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/gi)) {
      const [from, to] = [match.index ?? 0, (match.index ?? 0) + match[0].length];
      if (taken.some(([start, end]) => from < end && to > start)) continue;
      let date: string;
      if (match[1]) date = at(/tomorrow/i.test(match[1]) ? 1 : 0);
      else {
        const target = WEEKDAY_NAMES.findIndex(name => name.startsWith(match[3]!.toLowerCase()));
        const ahead = (target - todayIs + 7) % 7;
        // "next Friday" said on a Monday is the Friday of the week after this one.
        date = at(/next/i.test(match[2]!) ? ahead + (7 - todayIs > ahead ? 7 : 0) : ahead);
      }
      hits.push({ date, index: from, length: to - from });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
};

const NAMED_WEEKDAY = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s*(?:the\s+)?$/i;

// One time of day: "5:30 pm", "6.30pm", "9 a.m.", "10a", "7:30p", "noon".
// A lone letter counts only when it hugs the number ("10a"), never "5 a day".
const TIME_TOKEN = '(?:\\d{1,2}(?:[:.]\\d{2})?\\s*[ap]\\.?\\s*m\\b\\.?|\\d{1,2}(?:[:.]\\d{2})?[ap](?![a-z0-9])|noon|midnight)';
const BARE_TOKEN = '\\d{1,2}(?:[:.]\\d{2})?';

const pad2 = (hour: number, minute: number): string | undefined => (hour > 23 || minute > 59 ? undefined : `${pad(hour)}:${pad(minute)}`);

/** One token to 'HH:MM'; a bare number takes the meridiem it is lent. */
const readTime = (token: string, lent?: 'a' | 'p'): string | undefined => {
  if (/noon/i.test(token)) return '12:00';
  if (/midnight/i.test(token)) return '00:00';
  const match = /(\d{1,2})(?:[:.](\d{2}))?\s*([ap])?/i.exec(token);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = (match[3]?.toLowerCase() ?? lent) as 'a' | 'p' | undefined;
  if (!meridiem) return pad2(hour, minute);
  if (hour < 1 || hour > 12) return undefined;
  return pad2((hour % 12) + (meridiem === 'p' ? 12 : 0), minute);
};

export type ClockOptions = {
  /** The text is known to be a time (a "Time:" line, a schedule's row header): "6-8" and "6:30-8:30" may be read. */
  bare?: boolean;
};

/** The meridiem a community event's bare hour most likely has: 8–11 is morning, 12–7 afternoon and evening. */
const likely = (hour: number): 'a' | 'p' => (hour >= 8 && hour <= 11 ? 'a' : 'p');

/**
 * The time of day in the text: "5:30 pm - 10:00 pm", "3-6 PM", "9 a.m.-noon",
 * "8:30-10:30am", "10a-2p", "6.30pm", "at 6 pm", "17:30". A start without
 * its own am/pm borrows the end's, unless that would put it after the end
 * ("9-12pm" is 9 in the morning). "Doors 6 pm, show 7 pm" starts at seven:
 * the show is the event. "All day" is an answer too — no clock, on purpose.
 */
export const findClock = (text: string, options: ClockOptions = {}): Clock & { allDay?: boolean } => {
  if (/\ball[\s-]day\b/i.test(text) && !new RegExp(TIME_TOKEN, 'i').test(text)) return { allDay: true };
  const show = new RegExp(`\\b(?:show|music|concert|performance|program|curtain|event)\\s*(?:time|starts?|begins?)?\\s*(?:at|@|:|-)?\\s*(${TIME_TOKEN})`, 'i').exec(text);
  if (show && /\bdoors?\b/i.test(text)) {
    const start = readTime(show[1]!);
    if (start) return { start };
  }
  const range = new RegExp(`(${TIME_TOKEN}|\\b${BARE_TOKEN})${DASH}(${TIME_TOKEN})`, 'i').exec(text);
  if (range) {
    const end = readTime(range[2]!);
    const own = /[ap]|noon|midnight/i.test(range[1]!);
    let start = own ? readTime(range[1]!) : undefined;
    if (!own && end) {
      const borrowed = readTime(range[1]!, end >= '12:00' ? 'p' : 'a');
      start = borrowed && borrowed <= end ? borrowed : readTime(range[1]!, 'a');
    }
    if (start && end) return { start, ...(end > start ? { end } : {}) };
  }
  const single = new RegExp(TIME_TOKEN, 'i').exec(text);
  if (single) {
    const start = readTime(single[0]);
    if (start) return { start };
  }
  if (options.bare) {
    // No am or pm anywhere, in text that is known to be a time: "6-8", "6:30 - 8:30".
    const bare = new RegExp(`(?<![\\d/$])\\b(${BARE_TOKEN})${DASH}(${BARE_TOKEN})\\b(?![/\\d])`).exec(text);
    if (bare) {
      const startHour = Number(/\d{1,2}/.exec(bare[1]!)?.[0]);
      const endHour = Number(/\d{1,2}/.exec(bare[2]!)?.[0]);
      if (startHour >= 1 && startHour <= 12 && endHour >= 1 && endHour <= 12) {
        const meridiem = likely(startHour);
        const start = readTime(bare[1]!, meridiem);
        const end = readTime(bare[2]!, endHour < startHour || (endHour === 12 && meridiem === 'a') ? 'p' : meridiem);
        if (start && end && end > start) return { start, end };
      }
    }
  }
  const military = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b(?!\s*[ap]\.?m)/i.exec(text);
  if (military) return { start: `${pad(Number(military[1]))}:${military[2]}` };
  return {};
};

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(?:1st|first)\b/i, 1], [/\b(?:2nd|second)\b/i, 2], [/\b(?:3rd|third)\b/i, 3], [/\b(?:4th|fourth)\b/i, 4], [/\blast\b/i, -1],
];

const WEEKDAY_TOKEN = /\b(sun|mon|tue(?:s)?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?(s)?\b\.?/gi;

/**
 * "Every Tuesday", "Tuesdays and Saturdays", "Mon/Thu", "1st and 3rd
 * Saturdays", "2nd Sunday of each month", "nightly". Only when the text says
 * it repeats — a plural weekday, "every", "each", "weekly", an ordinal, or a
 * slash/ampersand list — so that "Saturday, October 3" is a date and not a
 * rule.
 */
export const findWeeklyRule = (input: string): WeeklyRule | undefined => {
  let text = input;
  if (/\b(?:daily|nightly|every\s*day|every\s+night|7 days a week)\b/i.test(text)) return { weekdays: [0, 1, 2, 3, 4, 5, 6] };
  // "Saturday, October 3 through Monday, October 5" names two dates, not a rule.
  // (A plural — "Mondays, Sept 14 – Oct 26" — is a rule with bounds, and stays.)
  text = text.replace(new RegExp(`\\b(?:sun|mon|tue(?:s)?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?\\.?,?\\s+(?=(?:${MONTH}\\s+\\d|\\d{1,2}[/.-]\\d))`, 'gi'), '');
  const tokens = [...text.matchAll(WEEKDAY_TOKEN)];
  if (!tokens.length) return undefined;
  const weekdays = [...new Set(tokens.map(token => WEEKDAY_NAMES.findIndex(name => name.startsWith(token[1]!.toLowerCase().slice(0, 3)))))]
    .filter(day => day >= 0).sort((a, b) => a - b);
  // "Saturday 19th" is the nineteenth, not the nineteenth Saturday; only an
  // ordinal that comes BEFORE its weekday ("3rd Saturday") counts.
  const beforeWeekday = text.replace(new RegExp(`(${WEEKDAY_TOKEN.source})\\s*,?\\s+\\d{1,2}(?:st|nd|rd|th)\\b`, 'gi'), '$1');
  const ordinals = ORDINALS.filter(([expression]) => expression.test(beforeWeekday)).map(([, ordinal]) => ordinal);
  const monthly = ordinals.length > 0 && /\b(?:month|monthly)\b|\bof\s+(?:the|each|every)\b/i.test(text);
  if (beforeWeekday !== text && !ordinals.length && tokens.length === 1 && !/\b(?:every|each|weekly)\b/i.test(text)) return undefined;
  const plural = tokens.some(token => Boolean(token[2]));
  const listed = tokens.length > 1 && /[/&]|\band\b|,/.test(text);
  const says = /\b(?:every|each|weekly|recurring|ongoing)\b/i.test(text);
  if (!(plural || listed || says || monthly || ordinals.length)) return undefined;
  return { weekdays, ...(ordinals.length ? { ordinals } : {}) };
};

export type Series = { rule: WeeklyRule; from?: string; until?: string };

/**
 * A rule and how long it runs: "Saturdays in October", "every Friday through
 * December 18", "Mondays, Sept 14 – Oct 26", "Tuesdays starting Oct 6". The
 * bounds are why "through December 18" is the last Friday of a series and
 * not an event on December 18.
 */
export const findSeries = (text: string, options: DateOptions = {}): Series | undefined => {
  const rule = findWeeklyRule(text);
  if (!rule) return undefined;
  const hits = findDates(text, options);
  const after = (pattern: RegExp): string | undefined => {
    const match = pattern.exec(text);
    if (!match) return undefined;
    const from = match.index + match[0].length;
    return hits.find(hit => hit.index >= from && hit.index <= from + 12)?.date;
  };
  let from = after(/\b(?:starting|beginning|begins|starts|from|resumes)\s+(?:on\s+)?/i);
  let until = after(/\b(?:through|thru|until|till|til|ending|ends)\s+(?:on\s+)?/i);
  const ranged = hits.find(hit => hit.endDate);
  if (ranged && !from && !until) { from = ranged.date; until = ranged.endDate; }
  const months = new RegExp(`\\b(?:in|during|throughout|for|all)\\s+${MONTH}(?:\\s*(?:,|and|&|through|thru|-|–|to)\\s*${MONTH})?(?:,?\\s+${YEAR})?(?!\\s*\\d)`, 'i').exec(text);
  if (months && !from && !until) {
    const first = monthIndex(months[1]!);
    const last = months[2] ? monthIndex(months[2]) : first;
    const year = fullYear(months[3]) ?? inferYear(first, 28, options);
    const lastYear = last < first ? year + 1 : year;
    from = valid(year, first, 1);
    until = new Date(Date.UTC(lastYear, last + 1, 0)).toISOString().slice(0, 10);
  }
  return { rule, ...(from ? { from } : {}), ...(until ? { until } : {}) };
};

/** The dates a series lands on between today and the horizon, inside its own bounds. */
export const seriesDates = (series: Series, today: string, horizonDays: number): string[] => {
  const start = series.from && series.from > today ? series.from : today;
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + horizonDays * DAY_MS).toISOString().slice(0, 10);
  const end = series.until && series.until < horizon ? series.until : horizon;
  if (end < start) return [];
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
  return occurrences(series.rule, start, days);
};

/** The dates a rule lands on, from `from` for `days` days. */
export const occurrences = (rule: WeeklyRule, from: string, days: number): string[] => {
  const start = Date.parse(`${from}T00:00:00Z`);
  const dates: string[] = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const date = new Date(start + offset * DAY_MS);
    if (!rule.weekdays.includes(date.getUTCDay())) continue;
    if (rule.ordinals?.length) {
      const nth = Math.ceil(date.getUTCDate() / 7);
      const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      const last = date.getUTCDate() + 7 > daysInMonth;
      if (!rule.ordinals.some(ordinal => (ordinal === -1 ? last : ordinal === nth))) continue;
    }
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
};

/** A date as 'M-D-YYYY', 'YYYY/MM' and so on — for endpoint templates. */
export const formatDate = (date: string, format: string): string => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return format
    .replace(/YYYY/g, String(year))
    .replace(/MM/g, pad(month))
    .replace(/DD/g, pad(day))
    .replace(/M/g, String(month))
    .replace(/D/g, String(day));
};
