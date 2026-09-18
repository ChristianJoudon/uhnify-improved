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
const DASH = '\\s*(?:-|–|—|to|through|thru|until)\\s*';

export type DateHit = { date: string; endDate?: string; index: number; length: number };
export type Clock = { start?: string; end?: string };
export type WeeklyRule = { weekdays: number[]; ordinals?: number[] };
export type DateOptions = { today?: string; yearHint?: number };

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

type Found = { date: string | undefined; endDate?: string | undefined };
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
      return [{ date: valid(startYear, startMonth, Number(match[2])), endDate: valid(endYear, endMonth, Number(match[4])) }];
    } },
  // October 8–11, 2026 · Jan 8 – 31
  { expression: new RegExp(`\\b${MONTH}\\s+${DAY}${DASH}${DAY}(?!\\s*(?::\\d|[ap]\\.?m))(?:,?\\s+${YEAR})?`, 'gi'),
    read: (match, options) => {
      const month = monthIndex(match[1]!);
      const year = fullYear(match[4]) ?? inferYear(month, Number(match[2]), options);
      return [{ date: valid(year, month, Number(match[2])), endDate: valid(year, month, Number(match[3])) }];
    } },
  // September 13th & 20th · Sept 13, 20 and 27 (each its own date)
  { expression: new RegExp(`\\b${MONTH}\\s+${DAY}((?:\\s*(?:,|&|and)\\s*${DAY}(?!\\s*(?::\\d|[ap]\\.?m|\\d|[-–—]\\s*\\d)))+)(?:,?\\s+${YEAR})?`, 'gi'),
    read: (match, options) => {
      const month = monthIndex(match[1]!);
      const days = [Number(match[2]), ...[...match[3]!.matchAll(/\d{1,2}/g)].map(found => Number(found[0]))];
      const year = fullYear(match[5]) ?? inferYear(month, days[0]!, options);
      return days.map(day => ({ date: valid(year, month, day) }));
    } },
  // Sunday, August 30, 2026 · Aug. 30 · September 27th
  { expression: new RegExp(`\\b${MONTH}\\s+${DAY}(?!\\s*(?::\\d|[ap]\\.?m\\b))(?:,?\\s+${YEAR})?`, 'gi'),
    read: (match, options) => {
      const month = monthIndex(match[1]!);
      const day = Number(match[2]);
      return [{ date: valid(fullYear(match[3]) ?? inferYear(month, day, options), month, day) }];
    } },
  // 26 Sep 2026 · 26 September
  { expression: new RegExp(`\\b${DAY}\\s+${MONTH}(?:,?\\s+${YEAR})?`, 'gi'),
    read: (match, options) => {
      const month = monthIndex(match[2]!);
      const day = Number(match[1]);
      return [{ date: valid(fullYear(match[3]) ?? inferYear(month, day, options), month, day) }];
    } },
  // 9/20/2026 · 9-18-2026 · 9/20 (only with a month and day that can be one)
  { expression: /(?<![\d/.-])(\d{1,2})([/-])(\d{1,2})(?:\2((?:19|20)?\d{2}))?(?![\d/]|\s*(?:am|pm|a\.m|p\.m))/gi,
    read: (match, options) => {
      const month = Number(match[1]) - 1;
      const day = Number(match[3]);
      if (match[2] === '-' && !match[4]) return [];
      return [{ date: valid(fullYear(match[4]) ?? inferYear(month, day, options), month, day) }];
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
      const found = read(match, options).filter((hit): hit is { date: string; endDate?: string | undefined } => Boolean(hit.date));
      if (!found.length) continue;
      taken.push([from, to]);
      found.forEach(hit => hits.push({
        date: hit.date,
        ...(hit.endDate && hit.endDate >= hit.date ? { endDate: hit.endDate } : {}),
        index: from,
        length: to - from,
      }));
    }
  }
  return hits.sort((a, b) => a.index - b.index);
};

const TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?\\s*m\\.?|(noon|midnight)';
const TIME_BARE = '(\\d{1,2})(?::(\\d{2}))?';

const clock = (hour: number, minute: number, meridiem: string | undefined): string | undefined => {
  if (hour > 23 || minute > 59) return undefined;
  let hours = hour;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hours = (hour % 12) + (/p/i.test(meridiem) ? 12 : 0);
  }
  return `${pad(hours)}:${pad(minute)}`;
};

const named = (word: string | undefined): string | undefined => (
  !word ? undefined : /noon/i.test(word) ? '12:00' : '00:00'
);

/**
 * The time of day in the text: "5:30 pm - 10:00 pm", "3-6 PM", "9 a.m.-noon",
 * "8:30-10:30am", "at 6 pm", "17:30". A start without its own am/pm borrows
 * the end's, unless that would put it after the end ("9-12pm" is 9 in the
 * morning).
 */
export const findClock = (text: string): Clock => {
  const range = new RegExp(`(?:${TIME}|\\b${TIME_BARE})${DASH}(?:${TIME})`, 'i').exec(text);
  if (range) {
    const end = named(range[10]) ?? clock(Number(range[7]), Number(range[8] ?? 0), range[9]);
    let start = named(range[4]) ?? (range[1] ? clock(Number(range[1]), Number(range[2] ?? 0), range[3]) : undefined);
    if (!start && range[5] && end) {
      const borrowed = clock(Number(range[5]), Number(range[6] ?? 0), range[9] ?? (end >= '12:00' ? 'p' : 'a'));
      const morning = clock(Number(range[5]), Number(range[6] ?? 0), 'a');
      start = borrowed && borrowed <= end ? borrowed : morning;
    }
    if (start && end) return { start, ...(end > start ? { end } : {}) };
  }
  const single = new RegExp(TIME, 'i').exec(text);
  if (single) {
    const start = named(single[4]) ?? clock(Number(single[1]), Number(single[2] ?? 0), single[3]);
    if (start) return { start };
  }
  const military = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b(?!\s*[ap]\.?m)/i.exec(text);
  return military ? { start: `${pad(Number(military[1]))}:${military[2]}` } : {};
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
export const findWeeklyRule = (text: string): WeeklyRule | undefined => {
  if (/\b(?:daily|nightly|every\s*day|every\s+night|7 days a week)\b/i.test(text)) return { weekdays: [0, 1, 2, 3, 4, 5, 6] };
  const tokens = [...text.matchAll(WEEKDAY_TOKEN)];
  if (!tokens.length) return undefined;
  const weekdays = [...new Set(tokens.map(token => WEEKDAY_NAMES.findIndex(name => name.startsWith(token[1]!.toLowerCase().slice(0, 3)))))]
    .filter(day => day >= 0).sort((a, b) => a - b);
  const ordinals = ORDINALS.filter(([expression]) => expression.test(text)).map(([, ordinal]) => ordinal);
  const monthly = ordinals.length > 0 && /\b(?:month|monthly)\b|\bof\s+(?:the|each|every)\b/i.test(text);
  const plural = tokens.some(token => Boolean(token[2]));
  const listed = tokens.length > 1 && /[/&]|\band\b|,/.test(text);
  const says = /\b(?:every|each|weekly|recurring|ongoing)\b/i.test(text);
  if (!(plural || listed || says || monthly || ordinals.length)) return undefined;
  return { weekdays, ...(ordinals.length ? { ordinals } : {}) };
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
