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

type JsonRecord = Record<string, unknown>;

const HAWAII_OFFSET = '-10:00';
const DAY_MS = 86_400_000;
export const SAFE_REVIEW_CONTEXT_VERSION = 'safe-review.v1' as const;
const WEEKDAY = new Map([
  ['SU', 0], ['MO', 1], ['TU', 2], ['WE', 3], ['TH', 4], ['FR', 5], ['SA', 6],
]);

const isRecord = (value: unknown): value is JsonRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const asString = (value: unknown): string | undefined => {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = `${value}`.trim();
    return text || undefined;
  }
  if (isRecord(value)) return asString(value.rendered ?? value.name ?? value.value);
  return undefined;
};

const textOnly = (value: unknown, limit = 2_000): string | undefined => {
  const source = asString(value);
  if (!source) return undefined;
  const text = load(`<div>${source}</div>`)('div').text().replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : undefined;
};

const EMAIL = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
const PHONE = /(?:\+?1[\s().-]*)?(?:\(?[2-9]\d{2}\)?[\s().-]*)?[2-9]\d{2}[\s.-]*\d{4}/g;
const WEB_URL = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+/gi;
const ACCESS_SECRET = /\b(?:meeting\s*(?:id|code)|passcode|password)\s*[:#-]?\s*[\w-]+/gi;

/**
 * Description and context are useful review evidence, but contact details and
 * private-access material are not classification inputs. Keep the public prose
 * around those fragments and replace only the unsafe fragment.
 */
const safeVisibleText = (value: unknown, limit = 2_000): string | undefined => {
  const visible = textOnly(value, limit * 2);
  if (!visible) return undefined;
  const redacted = visible
    .replace(EMAIL, '[contact removed]')
    .replace(PHONE, '[contact removed]')
    .replace(WEB_URL, '[link removed]')
    .replace(ACCESS_SECRET, '[access detail removed]')
    .replace(/(?:\[contact removed\]\s*){2,}/g, '[contact removed] ')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted ? redacted.slice(0, limit) : undefined;
};

const labelsFrom = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(labelsFrom);
  if (isRecord(value)) {
    const label = value.name ?? value.venue ?? value.label ?? value.title
      ?? value.rendered ?? value.value ?? value.slug;
    return labelsFrom(label).map(item => item.replace(/[-_]+/g, ' '));
  }
  const label = safeVisibleText(value, 240);
  return label ? [label] : [];
};

const uniqueLabels = (...values: unknown[]): string[] => {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const label of values.flatMap(labelsFrom)) {
    const key = label.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      labels.push(label);
    }
  }
  return labels;
};

const contextText = (
  values: unknown[],
  excluded: Array<string | undefined> = [],
): string | undefined => {
  const blocked = new Set(excluded.filter(Boolean).map(value => value!.toLocaleLowerCase()));
  const labels = uniqueLabels(...values).filter(label => !blocked.has(label.toLocaleLowerCase()));
  return safeVisibleText(labels.join(' · '), 1_500);
};

const LOCATION_SUFFIX = '(?:Beach(?:\\s+Park)?|Community(?:\\s+(?:Ag|Agricultural))?\\s+Center|Neighborhood\\s+Center|Civic\\s+Center|Church|Temple|Chapel|Library|Museum|Park|Hall|Theatre|Theater|Garden|Gardens|Farm|Market|School|College|University|Marina|Harbor|Pavilion|Playground|Trailhead|Studio|Cafe|Café|Restaurant|Resort|Hotel|Plaza|Ranch|Club|Arena|Field|Gym)';
const NAMED_LOCATION = new RegExp(
  `\\b((?:[\\p{Lu}\\d][\\p{L}\\p{N}’ʻ'&.-]*(?:\\s+|$)){1,6}${LOCATION_SUFFIX})\\b`,
  'gu',
);
const RELATIONAL_LOCATION = new RegExp(
  `\\b(?:at|near|inside|outside|venue|location)\\s*[:@-]?\\s*((?:[\\p{L}\\p{N}][\\p{L}\\p{N}’ʻ'&.-]*(?:\\s+|$)){1,6}${LOCATION_SUFFIX})\\b`,
  'giu',
);
const GENERIC_LOCATION_HINT = /^(?:farmers?|local|night|craft|makers?|goods|community)\s+market$/i;

const cleanLocationHint = (value: string): string | undefined => {
  const hint = value
    .replace(/^(?:the|our|this|join|visit|meet|gather(?:ing)?)\s+/i, '')
    .replace(/[.,;:!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!hint || hint.length < 5 || hint.length > 160 || GENERIC_LOCATION_HINT.test(hint)) return undefined;
  return hint;
};

/**
 * A title-cased public place name is retained only as a clue. It never becomes
 * a canonical address, and it always leaves location research outstanding.
 */
const locationHintFrom = (description?: string, context?: string, title?: string): string | undefined => {
  for (const text of [description, context]) {
    if (!text) continue;
    NAMED_LOCATION.lastIndex = 0;
    for (const match of text.matchAll(NAMED_LOCATION)) {
      const hint = cleanLocationHint(match[1] ?? '');
      if (hint) return hint;
    }
    RELATIONAL_LOCATION.lastIndex = 0;
    for (const match of text.matchAll(RELATIONAL_LOCATION)) {
      const hint = cleanLocationHint(match[1] ?? '');
      if (hint) return hint;
    }
  }
  if (title) {
    RELATIONAL_LOCATION.lastIndex = 0;
    for (const match of title.matchAll(RELATIONAL_LOCATION)) {
      const hint = cleanLocationHint(match[1] ?? '');
      if (hint) return hint;
    }
  }
  return undefined;
};

const locationText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return safeVisibleText(value, 500);
  if (!isRecord(value)) return undefined;
  const address = isRecord(value.address) ? value.address : value;
  return safeVisibleText([
    asString(value.name ?? value.venue),
    asString(address.streetAddress ?? address.address),
    asString(address.addressLocality ?? address.city),
    asString(address.addressRegion ?? address.state),
    asString(address.postalCode ?? address.zip),
  ].filter(Boolean).join(', '), 500);
};

const hawaiiDateTime = (value: unknown): string | undefined => {
  const raw = asString(value);
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00${HAWAII_OFFSET}`;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)) {
    const [date = '', clock = '00:00:00'] = raw.replace(' ', 'T').split('T');
    return `${date}T${clock.length === 5 ? `${clock}:00` : clock}${HAWAII_OFFSET}`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

const inWindow = (value: string | undefined, source: SourceDefinition): boolean => {
  if (!value) return false;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  const now = Date.now();
  return time >= now - source.polling.lookBackDays * DAY_MS
    && time <= now + source.polling.lookAheadDays * DAY_MS;
};

const itemKey = (...parts: Array<string | number | undefined>): string => (
  sha256(parts.filter(part => part !== undefined).join('|'))
);

const usableEnd = (start: string | undefined, end: string | undefined): string | undefined => {
  if (!end) return undefined;
  const startTime = Date.parse(start ?? '');
  const endTime = Date.parse(end);
  if (Number.isNaN(endTime)) return undefined;
  if (Number.isNaN(startTime)) return end;
  const duration = endTime - startTime;
  return duration > 0 && duration <= 31 * DAY_MS ? end : undefined;
};

const eventItem = (input: {
  id?: string | number | undefined;
  title: string;
  start?: string | undefined;
  end?: string | undefined;
  location?: string | undefined;
  description?: string | undefined;
  sourceUrl: string;
  timeZone?: string | undefined;
  status?: string | undefined;
  attendanceMode?: string | undefined;
  categories?: string[] | undefined;
  context?: string | undefined;
  raw: JsonRecord;
  locator: string;
}): ExtractedItem => {
  const title = safeVisibleText(input.title, 300) ?? input.title;
  const description = safeVisibleText(input.description, 2_000);
  const location = safeVisibleText(input.location, 500);
  const categories = uniqueLabels(input.categories);
  const context = safeVisibleText(input.context, 1_500);
  const locationHint = location ? undefined : locationHintFrom(description, context, title);
  const end = usableEnd(input.start, input.end);
  const researchNeeded = [
    ...(!location ? ['location' as const] : []),
    ...(!input.start || (input.end && !end) ? ['schedule' as const] : []),
  ];
  const reality = /cancel/i.test(input.status ?? '') ? 'CANCELLED'
    : /postpon/i.test(input.status ?? '') ? 'POSTPONED' : 'SCHEDULED';
  return {
    // Stable identity continues to depend only on the publisher identity and
    // schedule—not on enrichment fields that may improve on a later parser run.
    sourceItemKey: itemKey(input.id, input.sourceUrl, title, input.start),
    canonicalSourceUrl: input.sourceUrl,
    entityHint: 'event',
    rawFields: input.raw,
    normalizedFields: {
      title,
      ...(input.start ? { localStart: input.start } : {}),
      ...(end ? { localEnd: end } : {}),
      ...(location ? { location } : {}),
      ...(locationHint ? { locationHint } : {}),
      ...(description ? { description } : {}),
      ...(description ? { reviewDescription: description } : {}),
      ...(categories.length ? { categories } : {}),
      ...(context ? { context } : {}),
      ...(researchNeeded.length ? { researchNeeded } : {}),
      reviewContextVersion: SAFE_REVIEW_CONTEXT_VERSION,
      timeZone: input.timeZone || 'Pacific/Honolulu',
      sourceUrl: input.sourceUrl,
      ...(input.attendanceMode ? { attendanceMode: input.attendanceMode } : {}),
      realityStatus: reality,
    },
    evidence: [{
      locatorKind: 'json_path',
      locator: input.locator,
      excerpt: [title, description, context, locationHint].filter(Boolean).join(' · ').slice(0, 500),
    }],
    explicitRealityHint: reality,
  };
};

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

const expandIcs = (
  start: string,
  rule: string | undefined,
  source: SourceDefinition,
): string[] => {
  if (!rule) return inWindow(start, source) ? [start] : [];
  const parts = Object.fromEntries(rule.split(';').map(part => {
    const [name = '', value = ''] = part.split('=', 2);
    return [name, value];
  }));
  const frequency = parts.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency ?? '')) return inWindow(start, source) ? [start] : [];
  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const count = Math.min(source.polling.maxItems, Number(parts.COUNT) || Number.POSITIVE_INFINITY);
  const until = parts.UNTIL ? Date.parse(parseIcsDate(parts.UNTIL) ?? '') : Number.POSITIVE_INFINITY;
  const byDays = new Set((parts.BYDAY || '').split(',').map(value => WEEKDAY.get(value.slice(-2))).filter(value => value !== undefined));
  const origin = new Date(start);
  const floor = new Date(Math.max(origin.getTime(), Date.now() - source.polling.lookBackDays * DAY_MS));
  floor.setUTCHours(origin.getUTCHours(), origin.getUTCMinutes(), origin.getUTCSeconds(), 0);
  const ceiling = Math.min(Date.now() + source.polling.lookAheadDays * DAY_MS, until);
  const occurrences: string[] = [];
  let generated = 0;
  for (const probe = new Date(origin); probe.getTime() <= ceiling && generated < count; probe.setUTCDate(probe.getUTCDate() + 1)) {
    const days = Math.floor((probe.getTime() - origin.getTime()) / DAY_MS);
    let match = false;
    if (frequency === 'DAILY') match = days % interval === 0;
    if (frequency === 'WEEKLY') {
      match = Math.floor(days / 7) % interval === 0
        && (byDays.size ? byDays.has(probe.getUTCDay()) : probe.getUTCDay() === origin.getUTCDay());
    }
    if (frequency === 'MONTHLY') {
      const months = (probe.getUTCFullYear() - origin.getUTCFullYear()) * 12
        + probe.getUTCMonth() - origin.getUTCMonth();
      match = months >= 0 && months % interval === 0 && probe.getUTCDate() === origin.getUTCDate();
    }
    if (!match) continue;
    generated += 1;
    if (probe >= floor) occurrences.push(probe.toISOString());
    if (occurrences.length >= source.polling.maxItems) break;
  }
  return occurrences;
};

const icsEvents = (text: string, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  const blocks = unfoldIcs(text).join('\n').split('BEGIN:VEVENT').slice(1)
    .map(block => block.split('END:VEVENT')[0] ?? '');
  return blocks.flatMap((block, blockIndex) => {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const key = line.slice(0, colon).split(';')[0]?.toUpperCase();
      if (key && !fields.has(key)) fields.set(key, icsValue(line.slice(colon + 1)));
    }
    const title = textOnly(fields.get('SUMMARY'), 300);
    const baseStart = parseIcsDate(fields.get('DTSTART') ?? '');
    if (!title || !baseStart) return [];
    const starts = expandIcs(baseStart, fields.get('RRULE'), source);
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
          items.push(...staticJsonEvents(JSON.parse(page.text), source, page.url));
        } else if (this.kind === 'ICS') {
          items.push(...icsEvents(page.text, source, page.url));
        } else if (this.kind === 'COUNTY_OPENCITIES') {
          items.push(...openCitiesEvents(JSON.parse(page.text), source, page.url));
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
    const deduplicated = [...new Map(items.map(item => [item.sourceItemKey, item])).values()]
      .slice(0, source.polling.maxItems);
    return {
      items: deduplicated,
      completeness: warnings.length ? 'PARTIAL' : 'COMPLETE',
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
