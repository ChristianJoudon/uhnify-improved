import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { ExtractedItem, SourceDefinition } from '../contracts.js';
import { findClock, findDates, findWeeklyRule, kauaiToday, occurrences, type DateOptions, type WeeklyRule } from '../text-dates.js';
import {
  asString,
  contextText,
  eventItem,
  hawaiiDateTime,
  inWindow,
  isRecord,
  safeVisibleText,
  textOnly,
  uniqueLabels,
  type JsonRecord,
} from './shared.js';

/**
 * Parsers that are told where things are rather than knowing it.
 *
 * The first dozen sources each had a parser written for them. The sweep of
 * September 2026 found sixty more sites, and most of what could not be read
 * was not hard to read — it was a JSON API with its own field names, a page
 * of <div class="eventitem"> rows, a church bulletin of dated lines, a blog
 * that announces events in its posts. None of that needs code per site. The
 * register entry says where the records are and which field is the title;
 * text-dates reads the date however it was typed; and these functions turn
 * that into candidates exactly as the hand-written parsers do.
 */
type FieldPath = string | string[] | undefined;

type JsonRecordsConfig = {
  path?: string;
  htmlJson?: { selector?: string; marker?: string; attribute?: string };
  fields: {
    id?: FieldPath; title: FieldPath; start?: FieldPath; end?: FieldPath; date?: FieldPath; endDate?: FieldPath;
    time?: FieldPath; endTime?: FieldPath; prose?: FieldPath; published?: FieldPath; location?: string[];
    description?: FieldPath; url?: FieldPath; categories?: FieldPath; status?: FieldPath; recurrence?: FieldPath;
  };
  recurrenceWeeks?: number;
  urlPrefix?: string;
  include?: { field: string; pattern: string };
  exclude?: { field: string; pattern: string };
};

/** Every value at a dotted path; "*" fans out over an array's items or an object's values. */
export const valuesAt = (root: unknown, path: string): unknown[] => path.split('.').reduce<unknown[]>((current, key) => (
  current.flatMap(value => {
    if (key === '*') return Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
    if (Array.isArray(value)) return /^\d+$/.test(key) ? [value[Number(key)]] : value.map(item => (isRecord(item) ? item[key] : undefined));
    return isRecord(value) ? [value[key]] : [];
  }).filter(value => value !== undefined && value !== null)
), [root]);

const firstAt = (record: unknown, path: FieldPath): unknown => {
  for (const candidate of (Array.isArray(path) ? path : path ? [path] : [])) {
    const value = valuesAt(record, candidate).find(found => found !== '' && found !== undefined);
    if (value !== undefined) return value;
  }
  return undefined;
};

const textAt = (record: unknown, path: FieldPath): string | undefined => {
  const value = firstAt(record, path);
  return typeof value === 'object' && value !== null ? asString(value) : asString(value);
};

const dayMs = 86_400_000;

/** "5:30 pm", "17:30:00", or 63000000 (milliseconds after midnight, as one events platform stores it). */
const clockOf = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < dayMs) {
    const minutes = Math.round(value / 60_000);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const text = asString(value);
  if (!text) return undefined;
  if (/^\d{5,8}$/.test(text)) return clockOf(Number(text));
  return findClock(text).start;
};

/**
 * A start written any way a publisher writes one: ISO, "2026-09-18 05:30
 * PM", epoch seconds or milliseconds, or prose with a date and a time in it.
 */
const startOf = (value: unknown, local: boolean, options: DateOptions): { start?: string; end?: string } => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 1e11 ? value : value * 1000;
    const shifted = new Date(millis - 10 * 3_600_000);
    return { start: `${shifted.toISOString().slice(0, 19)}-10:00` };
  }
  const raw = asString(value);
  if (!raw) return {};
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(raw)) {
    if (local || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
      const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/.exec(raw)!;
      const start = hawaiiDateTime(match[2] ? `${match[1]} ${match[2]}` : match[1]);
      return start ? { start } : {};
    }
    const instant = Date.parse(raw);
    if (Number.isNaN(instant)) return {};
    return { start: `${new Date(instant - 10 * 3_600_000).toISOString().slice(0, 19)}-10:00` };
  }
  const [hit] = findDates(raw, options);
  if (!hit) return {};
  const clock = findClock(raw.slice(0, hit.index) + raw.slice(hit.index + hit.length));
  const start = hawaiiDateTime(clock.start ? `${hit.date} ${clock.start}` : hit.date);
  const end = clock.end ? hawaiiDateTime(`${hit.endDate ?? hit.date} ${clock.end}`) : hit.endDate ? hawaiiDateTime(hit.endDate) : undefined;
  return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
};

const htmlJsonOf = (text: string, config: NonNullable<JsonRecordsConfig['htmlJson']>): unknown => {
  if (config.selector) {
    const node = load(text)(config.selector).first();
    const raw = config.attribute ? node.attr(config.attribute) : node.text();
    return raw ? JSON.parse(raw) : undefined;
  }
  if (config.marker) {
    const at = text.indexOf(config.marker);
    if (at === -1) return undefined;
    const from = text.indexOf('{', at + config.marker.length);
    if (from === -1) return undefined;
    // Balanced braces, minding strings: the blob ends where its first brace closes.
    let depth = 0;
    let inString = false;
    for (let index = from; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (char === '\\') index += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return JSON.parse(text.slice(from, index + 1));
      }
    }
  }
  return undefined;
};

const matches = (record: unknown, filter: { field: string; pattern: string } | undefined): boolean | undefined => {
  if (!filter) return undefined;
  const text = valuesAt(record, filter.field).map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ');
  return new RegExp(filter.pattern, 'i').test(text);
};

/** STATIC_JSON with a `records` mapping: a publisher's own JSON, read by the register's description of it. */
export const mappedJsonEvents = (text: string, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  const config = source.adapterConfig as { records?: JsonRecordsConfig; timestampsAreLocal?: boolean };
  const mapping = config.records;
  if (!mapping) return [];
  const document: unknown = mapping.htmlJson ? htmlJsonOf(text, mapping.htmlJson) : JSON.parse(text);
  const records = mapping.path ? valuesAt(document, mapping.path) : Array.isArray(document) ? document : [document];
  const local = config.timestampsAreLocal === true;
  const options: DateOptions = { today: kauaiToday() };
  const { fields } = mapping;
  return records.flatMap((record, index) => {
    if (!isRecord(record)) return [];
    if (matches(record, mapping.include) === false || matches(record, mapping.exclude) === true) return [];
    const title = textOnly(textAt(record, fields.title), 300);
    if (!title) return [];

    let { start, end } = startOf(firstAt(record, fields.start), local, options);
    if (!start && fields.date) {
      const [hit] = findDates(textAt(record, fields.date) ?? '', options);
      const clock = clockOf(firstAt(record, fields.time));
      const endClock = clockOf(firstAt(record, fields.endTime)) ?? findClock(textAt(record, fields.time) ?? '').end;
      if (hit) {
        start = hawaiiDateTime(clock ? `${hit.date} ${clock}` : hit.date);
        const [endHit] = findDates(textAt(record, fields.endDate) ?? '', options);
        const endDay = endHit?.date ?? hit.endDate ?? hit.date;
        end = endClock ? hawaiiDateTime(`${endDay} ${endClock}`) : endDay !== hit.date ? hawaiiDateTime(endDay) : undefined;
      }
    }
    if (!end && fields.end) end = startOf(firstAt(record, fields.end), local, options).start;
    if (!start && fields.prose) {
      // A post that announces an event: the first date in it that is not
      // before the post itself. A date older than the post is history.
      const prose = textOnly(textAt(record, fields.prose), 20_000) ?? '';
      const published = startOf(firstAt(record, fields.published), local, options).start?.slice(0, 10);
      const hit = findDates(`${title}. ${prose}`, options).find(found => !published || found.date >= published);
      if (hit) {
        const around = `${title}. ${prose}`.slice(Math.max(0, hit.index - 40), hit.index + hit.length + 80);
        const clock = findClock(around.replace(`${title}. ${prose}`.slice(hit.index, hit.index + hit.length), ' '));
        start = hawaiiDateTime(clock.start ? `${hit.date} ${clock.start}` : hit.date);
        end = clock.end ? hawaiiDateTime(`${hit.endDate ?? hit.date} ${clock.end}`) : hit.endDate ? hawaiiDateTime(hit.endDate) : undefined;
      }
    }
    if (!start || !inWindow(start, source)) return [];

    const location = safeVisibleText((fields.location ?? []).map(path => textOnly(textAt(record, path), 200)).filter(Boolean).join(', '), 500);
    const description = safeVisibleText(textAt(record, fields.description), 2_000);
    const categoryValue = firstAt(record, fields.categories);
    const categories = uniqueLabels(typeof categoryValue === 'string' ? categoryValue.split(/\s*,\s*/) : categoryValue);
    const rawUrl = textAt(record, fields.url);
    const url = rawUrl ? new URL(rawUrl, mapping.urlPrefix ?? sourceUrl).toString() : sourceUrl;
    const status = textAt(record, fields.status);
    const identity = textAt(record, fields.id) ?? url;
    const recurrence = textAt(record, fields.recurrence);
    const rule = recurrence && mapping.recurrenceWeeks ? findWeeklyRule(recurrence) : undefined;
    // One start, or — for a record that says it repeats — the same clock on
    // each day its rule lands on, from the start the publisher gave.
    const clockOfStart = start.slice(10);
    const durationMs = end ? Date.parse(end) - Date.parse(start) : undefined;
    const starts = rule
      ? occurrences(rule, start.slice(0, 10), mapping.recurrenceWeeks! * 7).map(day => `${day}${clockOfStart}`)
      : [start];
    return starts.filter(each => inWindow(each, source)).map(each => eventItem({
      id: `${identity}#${each.slice(0, 10)}`,
      title,
      start: each,
      ...(end && durationMs !== undefined && durationMs > 0
        ? { end: `${new Date(Date.parse(each) + durationMs - 10 * 3_600_000).toISOString().slice(0, 19)}-10:00` } : {}),
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(categories.length ? { categories } : {}),
      ...(rule && recurrence ? { context: recurrence } : {}),
      sourceUrl: url,
      ...(status ? { status } : {}),
      raw: record as JsonRecord,
      locator: `${mapping.path ?? '$'}[${index}]`,
    }));
  });
};

type HtmlSelectors = {
  item: string; title?: string; date?: string; dateAttr?: string; time?: string; location?: string; description?: string;
  link?: string; category?: string; dateFrom?: string; yearFrom?: string; weeklyWeeks?: number; include?: string;
  exclude?: string; stopAt?: string; defaultTitle?: string; defaultLocation?: string;
};

const clean = (value: string | undefined): string => (value ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();

/**
 * An element's text with a space wherever the markup breaks: cheerio's own
 * .text() reads <span>Sat</span><br><span>03</span><span>Oct</span> as
 * "Sat03Oct", which no date reader can do anything with.
 */
const spaced = ($: CheerioAPI, node: ReturnType<CheerioAPI>): string => {
  const parts: string[] = [];
  const walk = (elements: AnyNode[]) => elements.forEach(element => {
    if (element.type === 'text') parts.push(element.data);
    else if (element.type === 'tag' && !/^(?:script|style|svg|noscript)$/.test(element.name)) walk(element.children);
  });
  walk(node.toArray());
  return clean(parts.join(' ')).replace(/\s+([,.;:!?])/g, '$1');
};

/** Document order, so "the heading before this line" is a lookup and not a walk. */
const orderOf = ($: CheerioAPI): Map<AnyNode, number> => {
  const order = new Map<AnyNode, number>();
  $('*').each((index, element) => { order.set(element, index); });
  return order;
};

const tidyTitle = (text: string): string => clean(text
  .replace(/^[\s:|@,–—-]+|[\s:|@,–—-]+$/g, '')
  .replace(/\s+([:,])/g, '$1')
  .replace(/^\W*(?:on|at)\s+/i, ''));

/**
 * SOURCE_HTML with `selectors`: one element per event, the date wherever the
 * page keeps it. A dated item is an event; an undated one under a weekday
 * heading, or saying "every Friday", is a weekly series written out for
 * `weeklyWeeks` weeks — which is what a market directory or a bar's music
 * table is.
 */
export const mappedHtmlEvents = (html: string, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  const selectors = (source.adapterConfig as { selectors?: HtmlSelectors }).selectors;
  if (!selectors) return [];
  const $ = load(html);
  const order = orderOf($);
  const today = kauaiToday();
  const yearText = selectors.yearFrom ? spaced($, $(selectors.yearFrom).first()) : '';
  const yearHint = Number(/\b(20\d{2})\b/.exec(yearText)?.[1]) || undefined;
  const options: DateOptions = { today, ...(yearHint ? { yearHint } : {}) };
  const contexts = selectors.dateFrom
    ? $(selectors.dateFrom).toArray().map(element => ({ at: order.get(element) ?? 0, text: spaced($, $(element)) }))
    : [];
  const stop = selectors.stopAt ? new RegExp(selectors.stopAt, 'i') : undefined;
  const stopIndex = stop
    ? Math.min(...$('h1,h2,h3,h4,h5,h6,strong,b,p,li,td,div').toArray()
      .filter(element => $(element).children().length === 0 && stop.test(spaced($, $(element))))
      .map(element => order.get(element) ?? Infinity), Infinity)
    : Infinity;
  const include = selectors.include ? new RegExp(selectors.include, 'i') : undefined;
  const exclude = selectors.exclude ? new RegExp(selectors.exclude, 'i') : undefined;
  const horizon = (selectors.weeklyWeeks ?? 0) * 7;
  const items: ExtractedItem[] = [];

  $(selectors.item).each((index, element) => {
    if (items.length >= source.polling.maxItems) return;
    const at = order.get(element) ?? 0;
    if (at >= stopIndex) return;
    const root = $(element);
    const whole = spaced($, root);
    if (!whole || (include && !include.test(whole)) || (exclude && exclude.test(whole))) return;

    const context = contexts.filter(candidate => candidate.at < at).pop()?.text ?? '';
    const dateNode = selectors.date ? root.find(selectors.date).first() : undefined;
    const dateText = dateNode ? (selectors.dateAttr ? clean(dateNode.attr(selectors.dateAttr)) : spaced($, dateNode)) : '';
    const timeText = selectors.time ? spaced($, root.find(selectors.time).first()) : '';
    const titleNode = selectors.title ? root.find(selectors.title).first() : undefined;

    // Where the date is looked for, nearest first: its own element, the item's
    // text, then the heading over the group. A heading that holds only a month
    // and year ("September 2026") lends its year to a day written in the item.
    const contextYear = Number(/\b(20\d{2})\b/.exec(context)?.[1]) || undefined;
    const local: DateOptions = { ...options, ...(contextYear ? { yearHint: contextYear } : {}) };
    const monthOnly = /^[A-Za-z]+\.?\s+20\d{2}$/.test(context) ? context.replace(/\s+20\d{2}$/, '') : '';
    const candidates = [dateText, whole, monthOnly && /^\D*\d{1,2}\D*$/.test(dateText || whole) ? `${monthOnly} ${(dateText || whole)}` : '', context];
    let hits = [] as ReturnType<typeof findDates>;
    let from = '';
    for (const candidate of candidates) {
      if (!candidate) continue;
      hits = findDates(candidate, local);
      if (hits.length) { from = candidate; break; }
    }

    const clockSource = timeText || (dateText && findClock(dateText).start ? dateText : whole);
    const clock = findClock(hits[0] && clockSource === from
      ? clockSource.slice(0, hits[0].index) + ' '.repeat(hits[0].length) + clockSource.slice(hits[0].index + hits[0].length)
      : clockSource);

    let title = titleNode ? spaced($, titleNode) : '';
    // A heading that is only the date ("September 27th") is not the title;
    // the title is then whatever else the item says.
    if (title && findDates(title, local).length) {
      const bare = findDates(title, local).reduceRight((rest, hit) => rest.slice(0, hit.index) + rest.slice(hit.index + hit.length), title);
      if (!tidyTitle(bare.replace(/\b(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?\b\.?,?/gi, ' ').replace(/[&,]|\band\b/gi, ' '))) title = '';
    }
    if (!title) {
      // A line that is its own title: what is left when the date, the time and
      // the weekday are taken out.
      let rest = whole;
      if (from === whole) hits.slice().reverse().forEach(hit => { rest = rest.slice(0, hit.index) + rest.slice(hit.index + hit.length); });
      else if (dateText && rest.includes(dateText)) rest = rest.replace(dateText, ' ');
      if (timeText && rest.includes(timeText)) rest = rest.replace(timeText, ' ');
      rest = rest
        .replace(/\b(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?\b\.?,?/gi, ' ')
        .replace(/(?:\bfrom\s+|\bat\s+|@\s*)?\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?)?\s*(?:-|–|—|to)\s*\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?/gi, ' ')
        .replace(/(?:\bfrom\s+|\bat\s+|@\s*)?\b\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?/gi, ' ');
      title = tidyTitle(rest) || selectors.defaultTitle || '';
    }
    title = textOnly(title, 300) ?? '';
    if (!title) return;

    const href = (selectors.link ? root.find(selectors.link).first() : titleNode?.is('a') ? titleNode : root.find('a[href]').first())?.attr('href')
      ?? (root.is('a') ? root.attr('href') : undefined);
    const url = href && !/^(?:mailto|tel|javascript):/i.test(href) ? new URL(href, sourceUrl).toString() : sourceUrl;
    const location = safeVisibleText(selectors.location ? spaced($, root.find(selectors.location).first()) : selectors.defaultLocation, 500);
    const description = selectors.description ? safeVisibleText(spaced($, root.find(selectors.description).first()), 2_000) : undefined;
    const categories = selectors.category ? uniqueLabels(root.find(selectors.category).map((_i, node) => $(node).text()).get()) : [];

    const push = (day: string, endDay: string | undefined, series: boolean) => {
      const start = hawaiiDateTime(clock.start ? `${day} ${clock.start}` : day);
      if (!start || !inWindow(start, source)) return;
      const end = clock.end ? hawaiiDateTime(`${endDay ?? day} ${clock.end}`) : endDay ? hawaiiDateTime(endDay) : undefined;
      const note = series ? contextText([context, whole !== title ? whole : undefined], [title, description, location]) : undefined;
      items.push(eventItem({
        id: `${url}#${title}#${day}`,
        title,
        start,
        ...(end ? { end } : {}),
        ...(location ? { location } : {}),
        ...(description ? { description } : {}),
        ...(categories.length ? { categories } : {}),
        ...(note ? { context: note } : {}),
        sourceUrl: url,
        raw: { url, title, text: whole.slice(0, 1_000), ...(context ? { heading: context } : {}), date: day },
        locator: `${selectors.item}[${index}]`,
      }));
    };

    if (hits.length) {
      hits.forEach(hit => push(hit.date, hit.endDate, false));
      return;
    }
    if (!horizon) return;
    const rule: WeeklyRule | undefined = findWeeklyRule(dateText || whole) ?? findWeeklyRule(`every ${context}`);
    if (rule) occurrences(rule, today, horizon).forEach(day => push(day, undefined, true));
  });
  return items;
};

/**
 * RSS and Atom, for the sites whose "events" are posts. A post's own date is
 * when it was published, which is never the event; the event's date is in
 * the title or the body, and it is the first one written that does not fall
 * before the post. An item with no such date is an article, and is skipped.
 */
export const rssEvents = (xml: string, source: SourceDefinition, sourceUrl: string): ExtractedItem[] => {
  const $ = load(xml, { xmlMode: true });
  const config = source.adapterConfig as { identityField?: 'guid' | 'link'; include?: string };
  const include = config.include ? new RegExp(config.include, 'i') : undefined;
  const items: ExtractedItem[] = [];
  $('item, entry').each((index, element) => {
    const node = $(element as Element);
    const title = textOnly(node.children('title').first().text(), 300);
    if (!title) return;
    const link = clean(node.children('link').first().text()) || node.children('link[href]').first().attr('href') || sourceUrl;
    const categories = uniqueLabels(node.children('category').map((_i, category) => $(category).text() || $(category).attr('term')).get());
    if (include && !include.test(`${title} ${categories.join(' ')}`)) return;
    const body = textOnly(node.children('content\\:encoded, content, description, summary').first().text(), 20_000) ?? '';
    const publishedRaw = clean(node.children('pubDate, published, updated, dc\\:date').first().text());
    const publishedAt = Date.parse(publishedRaw);
    const published = Number.isNaN(publishedAt) ? undefined : kauaiToday(publishedAt);
    const options: DateOptions = { today: published ?? kauaiToday() };
    const text = `${title}. ${body}`;
    const hit = findDates(text, options).find(found => !published || found.date >= published);
    if (!hit) return;
    const around = text.slice(Math.max(0, hit.index - 40), hit.index + hit.length + 80);
    const clock = findClock(around.replace(text.slice(hit.index, hit.index + hit.length), ' '));
    const start = hawaiiDateTime(clock.start ? `${hit.date} ${clock.start}` : hit.date);
    if (!start || !inWindow(start, source)) return;
    const end = clock.end ? hawaiiDateTime(`${hit.endDate ?? hit.date} ${clock.end}`) : hit.endDate ? hawaiiDateTime(hit.endDate) : undefined;
    const identity = config.identityField === 'guid' ? clean(node.children('guid, id').first().text()) || link : link;
    const description = safeVisibleText(body, 2_000);
    items.push(eventItem({
      id: `${identity}#${hit.date}`,
      title,
      start,
      ...(end ? { end } : {}),
      ...(description ? { description } : {}),
      ...(categories.length ? { categories } : {}),
      sourceUrl: new URL(link, sourceUrl).toString(),
      raw: { title, link, published: publishedRaw, date: hit.date },
      locator: `item[${index}]`,
    }));
  });
  return items;
};
