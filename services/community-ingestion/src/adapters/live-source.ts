import { load } from 'cheerio';
import type {
  ExtractResult,
  ExtractedItem,
  FetchArtifactInput,
  PlannedRequest,
  SourceAdapter,
  SourceDefinition,
} from '../contracts.js';
import { sha256 } from '../hash.js';

import { mappedHtmlEvents, mappedJsonEvents, rssEvents } from './mapped.js';
import {
  isRecoveryMeeting,
  ACCESS_SECRET,
  DAY_MS,
  EMAIL,
  GENERIC_LOCATION_HINT,
  HAWAII_OFFSET,
  LOCATION_SUFFIX,
  NAMED_LOCATION,
  PHONE,
  RELATIONAL_LOCATION,
  WEB_URL,
  WEEKDAY,
  asString,
  cleanLocationHint,
  contextText,
  eventItem,
  hawaiiDateTime,
  inWindow,
  isRecord,
  itemKey,
  labelsFrom,
  locationHintFrom,
  locationText,
  safeVisibleText,
  textOnly,
  uniqueLabels,
  usableEnd,
} from './shared.js';
import type { JsonRecord } from './shared.js';

export { SAFE_REVIEW_CONTEXT_VERSION } from './shared.js';

const tribeEvents = (document: unknown, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  const events = isRecord(document) && Array.isArray(document.events)
    ? document.events
    : Array.isArray(document) ? document : [];
  return events.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const title = textOnly(value.title, 300);
    const start = hawaiiDateTime(value.start_date ?? value.startDate ?? value.date);
    if (!title || !start || !inWindow(start, source)) return [];
    const url = asString(value.url ?? value.link) || sourceUrl;
    const end = hawaiiDateTime(value.end_date ?? value.endDate);
    const location = locationText(value.venue ?? value.location);
    const description = safeVisibleText(value.description ?? value.excerpt, 2_000);
    const categories = uniqueLabels(
      value.categories,
      value.category,
      value.tags,
      value.event_cats,
      value.taxonomies,
    );
    const context = contextText([
      value.organizer,
      value.organizers,
      value.venue,
    ], [title, description, location]);
    return [eventItem({
      id: asString(value.id) || url,
      title,
      start,
      ...(end ? { end } : {}),
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(categories.length ? { categories } : {}),
      ...(context ? { context } : {}),
      sourceUrl: url,
      ...(asString(value.timezone) ? { timeZone: asString(value.timezone) } : {}),
      ...(asString(value.status) ? { status: asString(value.status) } : {}),
      raw: value,
      locator: `$.events[${index}]`,
    })];
  });
};

const clockFromNumber = (value: unknown): string => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 2359) return '00:00';
  return `${String(Math.floor(number / 100)).padStart(2, '0')}:${String(number % 100).padStart(2, '0')}`;
};

/**
 * A timestamp the way a JSON API wrote it, as a Kauaʻi instant.
 *
 * Three shapes turn up: an ISO string with a real offset or Z; a number of
 * epoch milliseconds (Squarespace); and — from AlohaCalendar and CitySpark —
 * a wall-clock time with a "Z" stapled on that never meant UTC ("13:00Z" for
 * a 1 PM jam session). The register says which publishers do that
 * (`timestampsAreLocal`), and for them the Z is dropped and the clock read
 * as Pacific/Honolulu.
 */
const apiDateTime = (value: unknown, timestampsAreLocal: boolean): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 1e11 ? value : value * 1000;
    return onKauaiClock(new Date(millis).toISOString());
  }
  const raw = asString(value);
  if (!raw) return undefined;
  if (timestampsAreLocal) {
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?Z?$/.exec(raw);
    if (match) return hawaiiDateTime(`${match[1]} ${match[2]}`);
  }
  return onKauaiClock(hawaiiDateTime(raw));
};

/** The same instant, written with Kauaʻi's offset, so a card reads 7 PM and not 05:00Z. */
const onKauaiClock = (iso: string | undefined): string | undefined => {
  if (!iso || !/Z$/.test(iso)) return iso;
  const shifted = new Date(Date.parse(iso) - 10 * 3_600_000);
  return `${shifted.toISOString().slice(0, 19)}${HAWAII_OFFSET}`;
};

const RECORD_ARRAY_KEYS = ['events', 'Value', 'upcoming', 'items', 'results', 'data'];

/**
 * Event records from a JSON API in the common shape — one array of objects,
 * each with a title and a start — rather than Coconut Wireless's own. The
 * array is found under `eventSelector` when that names a key, else under
 * the first of the usual names. Field names cover the APIs the register
 * actually reads (AlohaCalendar, CitySpark, Squarespace); a record without
 * a title or a start inside the window is skipped, never guessed.
 */
const jsonRecordEvents = (document: unknown, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  const config = source.adapterConfig as { eventSelector?: string; timestampsAreLocal?: boolean };
  const local = config.timestampsAreLocal === true;
  const records = ((): unknown[] => {
    if (Array.isArray(document)) return document;
    if (!isRecord(document)) return [];
    const named = config.eventSelector && Array.isArray(document[config.eventSelector])
      ? document[config.eventSelector] : undefined;
    if (Array.isArray(named)) return named;
    const key = RECORD_ARRAY_KEYS.find(candidate => Array.isArray(document[candidate]));
    return key ? (document[key] as unknown[]) : [];
  })();
  return records.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const title = textOnly(value.title ?? value.name ?? value.Name, 300);
    const start = apiDateTime(value.startDate ?? value.start_date ?? value.DateStart ?? value.start, local);
    if (!title || !start || !inWindow(start, source)) return [];
    const end = apiDateTime(value.endDate ?? value.end_date ?? value.DateEnd ?? value.end, local);
    const place = isRecord(value.location) ? value.location : isRecord(value.venue) ? value.venue : undefined;
    const location = (place && locationText(place))
      || [value.Venue, value.Address, value.CityState, place?.addressTitle, place?.addressLine1, place?.addressLine2]
        .map(asString).filter(Boolean).join(', ')
      || undefined;
    const description = safeVisibleText(value.description ?? value.Description ?? value.shortDesc ?? value.Summary ?? value.excerpt, 2_000);
    const categories = uniqueLabels(value.categories, value.category, value.tags, value.Labels);
    const url = asString(value.url ?? value.fullUrl ?? value.link ?? value.PrimaryUrl ?? value.ticketUrl) || sourceUrl;
    const context = contextText([value.organizer, value.Sponsor, place], [title, description, location]);
    return [eventItem({
      id: asString(value.id ?? value.Id ?? value.PId ?? value.slug) || url,
      title,
      start,
      ...(end ? { end } : {}),
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(categories.length ? { categories } : {}),
      ...(context ? { context } : {}),
      sourceUrl: url,
      raw: value,
      locator: `$[${index}]`,
    })];
  });
};

const staticJsonEvents = (document: unknown, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  const own = coconutWirelessEvents(document, source, sourceUrl);
  return own.length ? own : jsonRecordEvents(document, source, sourceUrl);
};

const coconutWirelessEvents = (document: unknown, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  if (!isRecord(document)) return [];
  return Object.entries(document).flatMap(([key, value]) => {
    if (!isRecord(value) || asString(value.category)?.toLowerCase() !== 'events') return [];
    const title = textOnly(value.name, 300);
    const when = isRecord(value.when) ? value.when : {};
    const dates = Array.isArray(when.uday) ? when.uday : [];
    if (!title) return [];
    return dates.flatMap((rawDay, index) => {
      const day = Number(rawDay);
      if (!Number.isInteger(day)) return [];
      const date = new Date(day * DAY_MS).toISOString().slice(0, 10);
      const start = hawaiiDateTime(`${date} ${clockFromNumber(when.start)}`);
      if (!start || !inWindow(start, source)) return [];
      const end = when.end === undefined
        ? undefined
        : hawaiiDateTime(`${date} ${clockFromNumber(when.end)}`);
      const where = isRecord(value.where) ? value.where : {};
      const itemSource = asString(value.web) || sourceUrl;
      const location = locationText(where);
      const description = safeVisibleText(value.note ?? value.description ?? value.excerpt, 2_000);
      const categories = uniqueLabels(
        value.type,
        value.topic,
        value.topics,
        value.tag,
        value.tags,
        value.kine,
        value.categories,
      );
      const context = contextText([
        where,
        value.host,
        value.organizer,
      ], [title, description, location]);
      return [eventItem({
        id: `${key}@${date}`,
        title,
        start,
        ...(end ? { end } : {}),
        ...(location ? { location } : {}),
        ...(description ? { description } : {}),
        ...(categories.length ? { categories } : {}),
        ...(context ? { context } : {}),
        sourceUrl: itemSource,
        raw: value,
        locator: `$.${key}.when.uday[${index}]`,
      })];
    });
  });
};

const unfoldIcs = (text: string): string[] => text.replace(/\r\n/g, '\n')
  .replace(/\n[ \t]/g, '')
  .split('\n');

const icsValue = (raw: string): string => raw
  .replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

const parseIcsDate = (raw: string): string | undefined => {
  if (/^\d{8}$/.test(raw)) {
    return hawaiiDateTime(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
  }
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return hawaiiDateTime(raw);
  const [, year, month, day, hour, minute, second, zulu] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${zulu ? 'Z' : HAWAII_OFFSET}`;
};

const HST_MS = 10 * 3_600_000;

/** "1SU", "-1FR", "MO" → { ordinal, weekday }. */
const byDayRule = (value: string): { ordinal: number | undefined; weekday: number } | undefined => {
  const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(value.trim());
  if (!match) return undefined;
  return { ordinal: match[1] ? Number(match[1]) : undefined, weekday: WEEKDAY.get(match[2]!)! };
};

/**
 * The occurrences of a recurring VEVENT inside the polling window.
 *
 * All of the calendar arithmetic — which weekday, which day of the month,
 * the nth Sunday — is done on Kauaʻi's wall clock, not on UTC. A 7 PM
 * kanikapila is already tomorrow in UTC, and a rule tested against the UTC
 * weekday put every evening series a day early. MONTHLY rules honour an
 * ordinal BYDAY ("1SU", "-1FR") and BYMONTHDAY; before, they repeated on
 * DTSTART's day of the month whatever the rule said, so a first-Sunday
 * service landed on a Monday. `skip` holds the instants a calendar has
 * taken out (EXDATE) or replaced (a RECURRENCE-ID override).
 */
const expandIcs = (
  start: string,
  rule: string | undefined,
  source: SourceDefinition,
  skip: Set<number> = new Set(),
): string[] => {
  if (!rule) return inWindow(start, source) && !skip.has(Date.parse(start)) ? [start] : [];
  const parts = Object.fromEntries(rule.split(';').map(part => {
    const [name = '', value = ''] = part.split('=', 2);
    return [name, value];
  }));
  const frequency = parts.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(frequency ?? '')) return inWindow(start, source) ? [start] : [];
  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const count = Math.min(source.polling.maxItems, Number(parts.COUNT) || Number.POSITIVE_INFINITY);
  const until = parts.UNTIL ? Date.parse(parseIcsDate(parts.UNTIL) ?? '') : Number.POSITIVE_INFINITY;
  const byDay = (parts.BYDAY || '').split(',').map(byDayRule).filter((value): value is NonNullable<ReturnType<typeof byDayRule>> => Boolean(value));
  const byMonthDay = (parts.BYMONTHDAY || '').split(',').map(Number).filter(value => Number.isInteger(value) && value !== 0);
  const originInstant = Date.parse(start);
  // The wall clock, held in a Date's UTC fields so that getUTCDay() is Kauaʻi's weekday.
  const origin = new Date(originInstant - HST_MS);
  const floor = Date.now() - source.polling.lookBackDays * DAY_MS;
  const ceiling = Math.min(Date.now() + source.polling.lookAheadDays * DAY_MS, until);
  const originWeek = Math.floor((origin.getTime() - origin.getUTCDay() * DAY_MS) / (7 * DAY_MS));
  const occurrences: string[] = [];
  let generated = 0;
  for (const probe = new Date(origin); probe.getTime() + HST_MS <= ceiling && generated < count; probe.setUTCDate(probe.getUTCDate() + 1)) {
    const days = Math.round((probe.getTime() - origin.getTime()) / DAY_MS);
    const months = (probe.getUTCFullYear() - origin.getUTCFullYear()) * 12 + probe.getUTCMonth() - origin.getUTCMonth();
    const dayOfMonth = probe.getUTCDate();
    const daysInMonth = new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 1, 0)).getUTCDate();
    const nth = Math.ceil(dayOfMonth / 7);
    const nthFromEnd = -Math.ceil((daysInMonth - dayOfMonth + 1) / 7);
    const weekdayMatches = byDay.some(each => each.weekday === probe.getUTCDay()
      && (each.ordinal === undefined || each.ordinal === nth || each.ordinal === nthFromEnd));
    let match = false;
    if (frequency === 'DAILY') match = days % interval === 0;
    if (frequency === 'WEEKLY') {
      const week = Math.floor((probe.getTime() - probe.getUTCDay() * DAY_MS) / (7 * DAY_MS));
      match = (week - originWeek) % interval === 0
        && (byDay.length ? byDay.some(each => each.weekday === probe.getUTCDay()) : probe.getUTCDay() === origin.getUTCDay());
    }
    if (frequency === 'MONTHLY') {
      match = months >= 0 && months % interval === 0 && (
        byDay.length ? weekdayMatches
          : byMonthDay.length ? byMonthDay.some(day => day === dayOfMonth || day === dayOfMonth - daysInMonth - 1)
            : dayOfMonth === origin.getUTCDate());
    }
    if (frequency === 'YEARLY') {
      match = months >= 0 && months % (12 * interval) === 0 && dayOfMonth === origin.getUTCDate();
    }
    if (!match) continue;
    generated += 1;
    const instant = probe.getTime() + HST_MS;
    if (instant >= floor && !skip.has(instant)) occurrences.push(new Date(instant).toISOString());
    if (occurrences.length >= source.polling.maxItems) break;
  }
  return occurrences;
};

const icsEvents = (text: string, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  const blocks = unfoldIcs(text).join('\n').split('BEGIN:VEVENT').slice(1)
    .map(block => block.split('END:VEVENT')[0] ?? '');
  const valuesOf = (block: string, name: string): string[] => block.split('\n')
    .filter(line => new RegExp(`^${name}(?:;|:)`, 'i').test(line))
    .flatMap(line => line.slice(line.indexOf(':') + 1).split(','))
    .map(value => value.trim()).filter(Boolean);
  const uidOf = (block: string): string => valuesOf(block, 'UID')[0] ?? '';
  // An edited occurrence is a second VEVENT with the same UID and a
  // RECURRENCE-ID: it replaces the series' occurrence at that instant.
  const replaced = new Map<string, Set<number>>();
  for (const block of blocks) {
    for (const value of valuesOf(block, 'RECURRENCE-ID')) {
      const instant = Date.parse(parseIcsDate(value) ?? '');
      if (Number.isNaN(instant)) continue;
      const uid = uidOf(block);
      replaced.set(uid, (replaced.get(uid) ?? new Set()).add(instant));
    }
  }
  return blocks.flatMap((block, blockIndex) => {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const key = line.slice(0, colon).split(';')[0]?.toUpperCase();
      if (key && !fields.has(key)) fields.set(key, icsValue(line.slice(colon + 1)));
    }
    const skip = new Set<number>(fields.has('RECURRENCE-ID') ? [] : replaced.get(fields.get('UID') ?? '') ?? []);
    valuesOf(block, 'EXDATE').forEach(value => {
      const instant = Date.parse(parseIcsDate(value) ?? '');
      if (!Number.isNaN(instant)) skip.add(instant);
    });
    const title = textOnly(fields.get('SUMMARY'), 300);
    const baseStart = parseIcsDate(fields.get('DTSTART') ?? '');
    if (!title || !baseStart) return [];
    const starts = expandIcs(baseStart, fields.get('RRULE'), source, skip);
    const baseEnd = parseIcsDate(fields.get('DTEND') ?? '');
    const duration = baseEnd ? Date.parse(baseEnd) - Date.parse(baseStart) : undefined;
    const location = safeVisibleText(fields.get('LOCATION'), 500);
    const description = safeVisibleText(fields.get('DESCRIPTION'), 2_000);
    const categories = uniqueLabels(
      ...(fields.get('CATEGORIES') ?? '').split(',').map(value => value.trim()).filter(Boolean),
    );
    const context = contextText([
      fields.get('COMMENT'),
    ], [title, description, location]);
    return starts.map((start, occurrenceIndex) => eventItem({
      id: `${fields.get('UID') || itemKey(title, baseStart)}@${start.slice(0, 10)}`,
      title,
      start,
      ...(duration !== undefined
        ? { end: duration > 0 ? new Date(Date.parse(start) + duration).toISOString() : start }
        : {}),
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(categories.length ? { categories } : {}),
      ...(context ? { context } : {}),
      sourceUrl: fields.get('URL') || sourceUrl,
      ...(fields.get('STATUS') ? { status: fields.get('STATUS') } : {}),
      raw: Object.fromEntries(fields),
      locator: `VEVENT[${blockIndex}].occurrence[${occurrenceIndex}]`,
    }));
  });
};

const jsonLdNodes = (value: unknown): JsonRecord[] => {
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes);
  if (!isRecord(value)) return [];
  return [value, ...Object.values(value).flatMap(jsonLdNodes)];
};

const jsonLdEvents = (html: string, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  const $ = load(html);
  const nodes: JsonRecord[] = [];
  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      nodes.push(...jsonLdNodes(JSON.parse($(element).text())));
    } catch {
      // A malformed block is ignored; other blocks on the same official page
      // remain independently reviewable.
    }
  });
  return nodes.flatMap((node, index) => {
    const kinds = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (!kinds.some(kind => typeof kind === 'string' && /event/i.test(kind))) return [];
    const title = textOnly(node.name ?? node.headline, 300);
    const start = hawaiiDateTime(node.startDate);
    if (!title || !start || !inWindow(start, source)) return [];
    const rawUrl = asString(node.url ?? node['@id']);
    let url = sourceUrl;
    if (rawUrl) {
      try {
        url = new URL(rawUrl, sourceUrl).toString();
      } catch {
        // Invalid publisher links do not replace the official page URL.
      }
    }
    const end = hawaiiDateTime(node.endDate);
    const location = locationText(node.location);
    const description = safeVisibleText(node.description ?? node.abstract, 2_000);
    const categories = uniqueLabels(
      node.keywords,
      node.eventType,
      node.about,
      node.category,
    );
    const context = contextText([
      node.organizer,
      node.performer,
      node.audience,
      node.location,
    ], [title, description, location]);
    return [eventItem({
      ...(asString(node['@id'] ?? node.url) ? { id: asString(node['@id'] ?? node.url) } : {}),
      title,
      start,
      ...(end ? { end } : {}),
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(categories.length ? { categories } : {}),
      ...(context ? { context } : {}),
      sourceUrl: url,
      ...(asString(node.eventStatus) ? { status: asString(node.eventStatus) } : {}),
      ...(asString(node.eventAttendanceMode) ? { attendanceMode: asString(node.eventAttendanceMode) } : {}),
      raw: node,
      locator: `$jsonld[${index}]`,
    })];
  });
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * "Sep 18" as a date, given no year: the nearest one that is not far in the
 * past. A calendar sorted from today forward runs over New Year, so "Jan 3"
 * read in December is next year, while "Sep 12" read on the 17th is this
 * year's — a listing only a few days gone, not one eleven months ahead.
 */
const dateFromMonthDay = (text: string, now = new Date(Date.now() - 10 * 3_600_000)): string | undefined => {
  const match = /([A-Za-z]{3,9})\.?\s+(\d{1,2})\b/.exec(text);
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase());
  if (month === -1) return undefined;
  const day = Number(match[2]);
  const year = now.getUTCFullYear();
  const candidate = Date.UTC(year, month, day);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const resolved = candidate < today - 60 * DAY_MS ? year + 1 : year;
  return `${resolved}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** "05:30 PM" → "17:30"; anything else → undefined. */
const clockFromText = (text: string | undefined): string | undefined => {
  const match = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text ?? '');
  if (!match) return undefined;
  let hours = Number(match[1]) % 12;
  if (/pm/i.test(match[3]!)) hours += 12;
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
};

/**
 * Hawaiʻi Public Radio's community calendar, filtered to Kauaʻi — a
 * Brightspot page with no schema.org, no <time>, and dates written "Sep 18"
 * with the year left to the reader. Each event is a <ps-promo
 * class="PromoEvent">: the date line, a title with its own page, the venue,
 * the price, and a time line that is either a single "06:00 PM - 08:30 PM on
 * Sat, 26 Sep 2026" or a recurrence sentence. A recurrence is filed once,
 * on the listed date, with the sentence kept as context; expanding "every
 * month on Friday through Oct 17" is a guess the review queue should not
 * inherit.
 */
const hprCalendarEvents = (html: string, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  const $ = load(html);
  const items: ExtractedItem[] = [];
  $('.PromoEvent').each((index, element) => {
    const root = $(element);
    const title = textOnly(root.find('.PromoEvent-title').first().text(), 300);
    const dateText = root.find('.PromoEvent-date-date').first().contents().first().text();
    const timeText = textOnly(root.find('.PromoEvent-time').first().text(), 300);
    // "on Sat, 26 Sep 2026" carries the year; the date line does not.
    const dated = /\bon\s+\w+,\s+(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/.exec(timeText ?? '');
    const day = dated
      ? `${dated[3]}-${String(MONTHS.indexOf(dated[2]!.slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${dated[1]!.padStart(2, '0')}`
      : dateFromMonthDay(dateText);
    const start = day ? hawaiiDateTime(`${day} ${clockFromText(timeText) ?? '00:00'}`) : undefined;
    if (!title || !start || !inWindow(start, source)) return;
    const endClock = clockFromText((timeText ?? '').split(/\s[-–]\s/)[1]);
    const href = root.find('.PromoEvent-title a[href]').first().attr('href');
    const url = href ? new URL(href, sourceUrl).toString() : sourceUrl;
    const location = safeVisibleText(root.find('.PromoEvent-venue').first().text(), 500);
    const description = safeVisibleText(root.find('.PromoEvent-description').first().text(), 2_000);
    const categories = uniqueLabels(
      root.find('.PromoEvent-categories-item').map((_categoryIndex, node) => $(node).text()).get()
        .filter(label => !/^Community Calendar:/i.test(label.trim())),
    );
    const recurring = root.find('.PromoEvent-time[data-recurring]').length > 0;
    const price = safeVisibleText(root.find('.PromoEvent-price').first().text(), 40);
    const context = contextText([
      recurring ? timeText : undefined,
      price ? `Price: ${price}` : undefined,
    ], [title, description, location]);
    items.push(eventItem({
      id: `${url}#${day}`,
      title,
      start,
      ...(endClock && day ? { end: hawaiiDateTime(`${day} ${endClock}`) } : {}),
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(categories.length ? { categories } : {}),
      ...(context ? { context } : {}),
      sourceUrl: url,
      raw: { url, title, date: dateText, time: timeText, location, recurring },
      locator: `PromoEvent[${index}]`,
    }));
  });
  return items;
};

/** Parsers for one publisher's own markup, chosen by the register's parserId. */
const HTML_PARSERS: Record<string, (html: string, source: SourceDefinition, sourceUrl: string) => ExtractedItem[]> = {
  'hpr-calendar-html': hprCalendarEvents,
};

const visibleHtmlEvents = (html: string, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  const own = HTML_PARSERS[source.parser.parserId];
  if (own) return own(html, source, sourceUrl);
  const $ = load(html);
  const items: ExtractedItem[] = [];
  const seen = new Set<string>();
  $('article, [class*="event-item"], [class*="event-card"], li[class*="event"]').each((index, element) => {
    if (items.length >= source.polling.maxItems) return;
    const root = $(element);
    const time = root.find('time[datetime]').first().attr('datetime');
    const start = hawaiiDateTime(time);
    const title = textOnly(root.find('h1,h2,h3,h4,[class*="title"]').first().text(), 300);
    if (!start || !title || !inWindow(start, source)) return;
    const href = root.find('a[href]').first().attr('href');
    const url = href ? new URL(href, sourceUrl).toString() : sourceUrl;
    const key = itemKey(url, title, start);
    if (seen.has(key)) return;
    seen.add(key);
    const location = safeVisibleText(
      root.find('[itemprop="location"], address, [class*="location"], [class*="venue"], [class*="where"]')
        .first().text(),
      500,
    );
    const explicitDescription = root
      .find('[itemprop="description"], [class*="description"], [class*="summary"], [class*="excerpt"]')
      .first().text();
    const paragraphText = root.find('p').slice(0, 3).map((_paragraphIndex, paragraph) => (
      $(paragraph).text()
    )).get();
    const description = safeVisibleText(uniqueLabels(explicitDescription, paragraphText).join(' '), 2_000);
    const categoryNodeText = root
      .find('[itemprop="eventType"], [rel="tag"], [class*="category"], [class*="tag"], [class*="badge"]')
      .slice(0, 8)
      .map((_categoryIndex, node) => $(node).text())
      .get();
    const categories = uniqueLabels(
      root.attr('data-category'),
      root.attr('data-categories'),
      categoryNodeText,
    );
    const context = contextText([
      root.find('[itemprop="organizer"], [class*="organizer"], [class*="host"], [class*="series"]')
        .slice(0, 4)
        .map((_contextIndex, node) => $(node).text())
        .get(),
      location,
    ], [title, description, location]);
    items.push(eventItem({
      id: key,
      title,
      start,
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(categories.length ? { categories } : {}),
      ...(context ? { context } : {}),
      sourceUrl: url,
      raw: {
        url,
        title,
        startDate: start,
        ...(location ? { location } : {}),
        ...(description ? { description } : {}),
        ...(categories.length ? { categories } : {}),
        ...(context ? { context } : {}),
      },
      locator: `html:event[${index}]`,
    }));
  });
  return items;
};

const monitorItems = (text: string, sourceUrl: string): ExtractedItem[] => {
  const $ = load(text, { xmlMode: /^\s*<\?xml|<urlset/i.test(text) });
  const records: Array<{ url: string; title: string; updated?: string }> = [];
  $('url').each((_index, element) => {
    const url = $(element).find('loc').first().text().trim();
    if (url) {
      const updated = $(element).find('lastmod').first().text().trim();
      records.push({
        url,
        title: decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || url)
          .replace(/[-_]+/g, ' '),
        ...(updated ? { updated } : {}),
      });
    }
  });
  $('a[href$=".pdf"], a[href*=".pdf?"]').each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const url = new URL(href, sourceUrl).toString();
    records.push({ url, title: textOnly($(element).text(), 300) || new URL(url).pathname.split('/').pop() || url });
  });
  return records.slice(0, 100).map((record, index) => eventItem({
    id: record.url,
    title: record.title,
    sourceUrl: record.url,
    raw: { url: record.url, title: record.title, ...(record.updated ? { modifiedAt: record.updated } : {}) },
    locator: `monitor[${index}]`,
  }));
};

type CompositePage = { url: string; mediaType: string; text: string };

/** "9/18/2026 1:00:00 PM", which is how OpenCities writes a Kauaʻi wall-clock time. */
const openCitiesDateTime = (value: unknown): string | undefined => {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(asString(value) ?? '');
  if (!match) return undefined;
  const [, month, day, year, hour = '0', minute = '00', second = '00', meridiem] = match;
  let hours = Number(hour) % 12;
  if (/pm/i.test(meridiem ?? '')) hours += 12;
  return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}T${String(hours).padStart(2, '0')}:${minute}:${second}`;
};

/**
 * One county calendar item and its detail, as fetchOpenCities wrote them:
 * { item: { Id, CalendarId, Name, DateTime, … }, calendar: label, detail:
 * { Title, Description, Link, Address: { Venue, Street, Suburb, Formatted },
 * IsCancelled } | null }. The detail's Link is the item's own page and is the
 * source URL; without a detail, the calendar page is.
 */
const openCitiesEvents = (document: unknown, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  if (!isRecord(document) || !isRecord(document.item)) return [];
  const item = document.item;
  const detail = isRecord(document.detail) ? (isRecord(document.detail.data) ? document.detail.data : document.detail) : {};
  const address = isRecord(detail.Address) ? detail.Address : {};
  const title = asString(detail.Title) ?? asString(item.Name);
  const start = openCitiesDateTime(item.DateTime);
  if (!title || !inWindow(start, source)) return [];
  const cancelled = detail.IsCancelled === true || /^cancel+ed\b/i.test(title);
  const location = asString(address.Formatted)
    ?? [address.Venue, address.Street, address.Suburb].map(asString).filter(Boolean).join(', ');
  const calendar = asString(document.calendar);
  return [eventItem({
    id: asString(item.Id),
    title: title.replace(/^cancel+ed\s*[-–:]\s*/i, ''),
    start,
    location: location || undefined,
    description: asString(detail.Description),
    sourceUrl: asString(detail.Link) ?? sourceUrl.split('#')[0]!,
    status: cancelled ? 'cancelled' : undefined,
    categories: calendar ? [calendar] : undefined,
    context: calendar ? `County of Kauaʻi · ${calendar}` : 'County of Kauaʻi',
    raw: document,
    locator: '$.item',
  })];
};

const decodePages = (input: FetchArtifactInput): CompositePage[] => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  if (input.mediaType === 'application/vnd.matchbook.source-pages+json') {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !Array.isArray(parsed.pages)) throw new Error('Composite source artifact omitted pages');
    return parsed.pages.flatMap(page => {
      if (!isRecord(page)) return [];
      const url = asString(page.url);
      const mediaType = asString(page.mediaType);
      const body = asString(page.text);
      return url && mediaType && body !== undefined ? [{ url, mediaType, text: body }] : [];
    });
  }
  return [{ url: input.sourceUrl, mediaType: input.mediaType, text }];
};

export class LiveSourceAdapter implements SourceAdapter {
  readonly kind: SourceDefinition['adapterKind'];

  constructor(kind: SourceDefinition['adapterKind']) {
    if (['MANUAL_CLIP', 'SYNTHETIC_FIXTURE'].includes(kind)) {
      throw new Error(`Live source adapter does not handle ${kind}`);
    }
    this.kind = kind;
  }

  async planRequests(source: SourceDefinition): Promise<PlannedRequest[]> {
    return source.endpoints.map(endpoint => ({
      method: endpoint.method,
      url: endpoint.urlTemplate,
      ...(endpoint.headers ? { headers: endpoint.headers } : {}),
      ...(typeof endpoint.bodyTemplate === 'string' ? { body: endpoint.bodyTemplate } : {}),
    }));
  }

  async extract(input: FetchArtifactInput, source: SourceDefinition): Promise<ExtractResult> {
    const pages = decodePages(input);
    let items: ExtractedItem[] = [];
    const warnings: Array<{ code: string; message: string }> = [];
    for (const page of pages) {
      try {
        if (['TRIBE_REST', 'WP_FILTERED_TRIBE'].includes(this.kind)) {
          items.push(...tribeEvents(JSON.parse(page.text), source, page.url));
        } else if (this.kind === 'STATIC_JSON') {
          items.push(...((source.adapterConfig as { records?: unknown }).records
            ? mappedJsonEvents(page.text, source, page.url)
            : staticJsonEvents(JSON.parse(page.text), source, page.url)));
        } else if (this.kind === 'RSS_ATOM') {
          items.push(...rssEvents(page.text, source, page.url));
        } else if (this.kind === 'ICS') {
          const exclude = (source.adapterConfig as { exclude?: string }).exclude;
          const pattern = exclude ? new RegExp(exclude, 'i') : undefined;
          items.push(...icsEvents(page.text, source, page.url)
            .filter(item => !pattern || !pattern.test(`${item.normalizedFields.title ?? ''}`)));
        } else if (this.kind === 'COUNTY_OPENCITIES') {
          items.push(...openCitiesEvents(JSON.parse(page.text), source, page.url));
        } else if (this.kind === 'SOURCE_HTML' && (source.adapterConfig as { selectors?: unknown }).selectors) {
          items.push(...mappedHtmlEvents(page.text, source, page.url));
        } else if (['JSON_LD_HTML', 'SOURCE_HTML'].includes(this.kind)) {
          const structured = jsonLdEvents(page.text, source, page.url);
          items.push(...(structured.length ? structured : visibleHtmlEvents(page.text, source, page.url)));
          if (!structured.length && !items.length) items.push(...monitorItems(page.text, page.url));
        } else if (this.kind === 'PDF_MONITOR') {
          items.push(...monitorItems(page.text, page.url));
        }
      } catch (error) {
        warnings.push({ code: 'PAGE_PARSE_FAILED', message: (error as Error).message.slice(0, 300) });
      }
    }
    const withheld = items.filter(isRecoveryMeeting).length;
    if (withheld) {
      items = items.filter(item => !isRecoveryMeeting(item));
      warnings.push({ code: 'SENSITIVE_WITHHELD', message: `${withheld} recovery-meeting listing(s) were not collected from a general calendar` });
    }
    const deduplicated = [...new Map(items.map(item => [item.sourceItemKey, item])).values()]
      .slice(0, source.polling.maxItems);
    return {
      items: deduplicated,
      completeness: warnings.some(warning => warning.code !== 'SENSITIVE_WITHHELD') ? 'PARTIAL' : 'COMPLETE',
      warnings,
      metrics: {
        discovered: items.length,
        emitted: deduplicated.length,
        rejected: Math.max(0, items.length - deduplicated.length),
      },
    };
  }

  stableItemKey(item: ExtractedItem): string {
    return item.sourceItemKey;
  }
}
