import { load } from 'cheerio';
import type { ExtractedItem, SourceDefinition } from '../contracts.js';
import { sha256 } from '../hash.js';

/**
 * What every parser in this directory stands on: reading a publisher's
 * value as text a reviewer may safely see, a time as a Kauaʻi instant, a
 * place as a line, and the one constructor — eventItem — that turns those
 * into a candidate. Moved out of live-source.ts when the parsers outgrew
 * one file; nothing here knows about any particular publisher.
 */
export type JsonRecord = Record<string, unknown>;

export const HAWAII_OFFSET = '-10:00';
export const DAY_MS = 86_400_000;
export const SAFE_REVIEW_CONTEXT_VERSION = 'safe-review.v1' as const;
export const WEEKDAY = new Map([
  ['SU', 0], ['MO', 1], ['TU', 2], ['WE', 3], ['TH', 4], ['FR', 5], ['SA', 6],
]);

export const isRecord = (value: unknown): value is JsonRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

export const asString = (value: unknown): string | undefined => {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = `${value}`.trim();
    return text || undefined;
  }
  if (isRecord(value)) return asString(value.rendered ?? value.name ?? value.value);
  return undefined;
};

export const textOnly = (value: unknown, limit = 2_000): string | undefined => {
  const source = asString(value);
  if (!source) return undefined;
  const text = load(`<div>${source}</div>`)('div').text().replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : undefined;
};

export const EMAIL = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
export const PHONE = /(?:\+?1[\s().-]*)?(?:\(?[2-9]\d{2}\)?[\s().-]*)?[2-9]\d{2}[\s.-]*\d{4}/g;
export const WEB_URL = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+/gi;
export const ACCESS_SECRET = /\b(?:meeting\s*(?:id|code)|passcode|password)\s*[:#-]?\s*[\w-]+/gi;

/**
 * Description and context are useful review evidence, but contact details and
 * private-access material are not classification inputs. Keep the public prose
 * around those fragments and replace only the unsafe fragment.
 */
export const safeVisibleText = (value: unknown, limit = 2_000): string | undefined => {
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

export const labelsFrom = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(labelsFrom);
  if (isRecord(value)) {
    const label = value.name ?? value.venue ?? value.label ?? value.title
      ?? value.rendered ?? value.value ?? value.slug;
    return labelsFrom(label).map(item => item.replace(/[-_]+/g, ' '));
  }
  const label = safeVisibleText(value, 240);
  return label ? [label] : [];
};

export const uniqueLabels = (...values: unknown[]): string[] => {
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

export const contextText = (
  values: unknown[],
  excluded: Array<string | undefined> = [],
): string | undefined => {
  const blocked = new Set(excluded.filter(Boolean).map(value => value!.toLocaleLowerCase()));
  const labels = uniqueLabels(...values).filter(label => !blocked.has(label.toLocaleLowerCase()));
  return safeVisibleText(labels.join(' · '), 1_500);
};

export const LOCATION_SUFFIX = '(?:Beach(?:\\s+Park)?|Community(?:\\s+(?:Ag|Agricultural))?\\s+Center|Neighborhood\\s+Center|Civic\\s+Center|Church|Temple|Chapel|Library|Museum|Park|Hall|Theatre|Theater|Garden|Gardens|Farm|Market|School|College|University|Marina|Harbor|Pavilion|Playground|Trailhead|Studio|Cafe|Café|Restaurant|Resort|Hotel|Plaza|Ranch|Club|Arena|Field|Gym)';
export const NAMED_LOCATION = new RegExp(
  `\\b((?:[\\p{Lu}\\d][\\p{L}\\p{N}’ʻ'&.-]*(?:\\s+|$)){1,6}${LOCATION_SUFFIX})\\b`,
  'gu',
);
export const RELATIONAL_LOCATION = new RegExp(
  `\\b(?:at|near|inside|outside|venue|location)\\s*[:@-]?\\s*((?:[\\p{L}\\p{N}][\\p{L}\\p{N}’ʻ'&.-]*(?:\\s+|$)){1,6}${LOCATION_SUFFIX})\\b`,
  'giu',
);
export const GENERIC_LOCATION_HINT = /^(?:farmers?|local|night|craft|makers?|goods|community)\s+market$/i;

export const cleanLocationHint = (value: string): string | undefined => {
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
export const locationHintFrom = (description?: string, context?: string, title?: string): string | undefined => {
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

export const locationText = (value: unknown): string | undefined => {
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

export const hawaiiDateTime = (value: unknown): string | undefined => {
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

export const inWindow = (value: string | undefined, source: SourceDefinition): boolean => {
  if (!value) return false;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  const now = Date.now();
  return time >= now - source.polling.lookBackDays * DAY_MS
    && time <= now + source.polling.lookAheadDays * DAY_MS;
};

export const itemKey = (...parts: Array<string | number | undefined>): string => (
  sha256(parts.filter(part => part !== undefined).join('|'))
);

export const usableEnd = (start: string | undefined, end: string | undefined): string | undefined => {
  if (!end) return undefined;
  const startTime = Date.parse(start ?? '');
  const endTime = Date.parse(end);
  if (Number.isNaN(endTime)) return undefined;
  if (Number.isNaN(startTime)) return end;
  const duration = endTime - startTime;
  return duration > 0 && duration <= 31 * DAY_MS ? end : undefined;
};

export const eventItem = (input: {
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
  // A publisher with no status field says it in the title: "CANCELLED –
  // Harvest Festival", "Trashion Show (postponed, new date TBD)". Dropping
  // such a row would leave the old date standing on the app.
  const stated = `${input.status ?? ''} ${/\b(?:cancel+ed|postponed|rescheduled)\b/i.exec(title)?.[0] ?? ''}`;
  const reality = /cancel/i.test(stated) ? 'CANCELLED'
    : /postpon|reschedul/i.test(stated) ? 'POSTPONED' : 'SCHEDULED';
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

/**
 * Recovery meetings are never collected from a general calendar. The
 * register reads them only from the fellowships' own lists, by hand, into a
 * lane with its own privacy review (the SEN sources); a church hall's
 * calendar that happens to list "Thursday N/A" is not that, and publishing
 * it beside the hula show would put a meeting's time and room on a public
 * feed nobody in it chose.
 */
const RECOVERY_MEETING = /\b(?:alcoholics\s+anonymous|narcotics\s+anonymous|al[- ]?anon|alateen|nar[- ]?anon|overeaters\s+anonymous|gamblers\s+anonymous|12[- ]step|recovery\s+meeting|(?:aa|na|oa|ga|ca)\s+meeting|n\/a\b)/i;

export const isRecoveryMeeting = (item: ExtractedItem): boolean => (
  RECOVERY_MEETING.test(`${item.normalizedFields.title ?? ''}`)
);

