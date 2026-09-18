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
  groupPath?: string;
  dateFrom?: string;
  labels?: { title?: string; date?: string; time?: string; location?: string; description?: string };
  titleStrip?: string;
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
    // One blob, or one per element (a schedule that hangs each lesson's JSON on its own button).
    const $ = load(text);
    const blobs = $(config.selector).toArray().flatMap(element => {
      const raw = config.attribute ? $(element).attr(config.attribute) : $(element).text();
      try { return raw ? [JSON.parse(raw) as unknown] : []; } catch { return []; }
    });
    return blobs.length > 1 ? blobs : blobs[0];
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
  const local = config.timestampsAreLocal === true;
  const { fields } = mapping;
  const recordsOf = (root: unknown): unknown[] => (mapping.path ? valuesAt(root, mapping.path) : Array.isArray(root) ? root : [root]);
  // A calendar page built as sections — "September 2026" over its cards — keeps
  // the month and year on the section and only "Saturday 19th" on the card.
  const groups = mapping.groupPath ? valuesAt(document, mapping.groupPath) : [document];
  return groups.flatMap(group => {
    const heading = mapping.dateFrom ? valuesAt(group, mapping.dateFrom).map(value => asString(value) ?? '').join(' ').replace(/\s+/g, ' ').trim() : '';
    return recordsOf(group).map(record => ({ record, heading }));
  }).flatMap(({ record, heading }, index) => {
    if (!isRecord(record)) return [];
    const headingYear = Number(/\b(20\d{2})\b/.exec(heading)?.[1]) || undefined;
    const options: DateOptions = { today: kauaiToday(), ...(headingYear ? { yearHint: headingYear } : {}) };
    const headingMonth = heading.replace(/\s+20\d{2}.*$/, '');
    /** "Saturday 19th" under "September 2026" is September 19, 2026. */
    const lend = (text: string): string => {
      if (!heading || findDates(text, options).length) return text;
      const day = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text)?.[1];
      return day && findDates(`${headingMonth} 1`, options).length ? `${headingMonth} ${day}` : text;
    };
    if (matches(record, mapping.include) === false || matches(record, mapping.exclude) === true) return [];
    // Labelled lines in the prose — "Where: Lydgate Pavilion<br>When: …" — read before the tags go.
    const proseHtml = textAt(record, fields.prose) ?? '';
    const { found: labelled } = mapping.labels ? readLabels(linesOf(load(`<div>${proseHtml}</div>`)('div')), mapping.labels) : { found: {} as NonNullable<JsonRecordsConfig['labels']> };
    let title = textOnly(labelled.title ?? textAt(record, fields.title), 300);
    if (!title) return [];
    let strippedStatus: string | undefined;
    if (mapping.titleStrip) {
      const stripped = new RegExp(mapping.titleStrip, 'i').exec(title);
      if (stripped) { strippedStatus = stripped[0].replace(/[\s:–-]+$/, '').trim(); title = title.replace(stripped[0], ' ').replace(/\s+/g, ' ').trim(); }
    }

    let { start, end } = startOf(firstAt(record, fields.start), local, options);
    if (!start && labelled.date) {
      const [hit] = findDates(lend(labelled.date), options);
      const clock = findClock(`${labelled.time ?? ''} ${labelled.date.replace(/\d{4}/, '')}`);
      if (hit) {
        start = hawaiiDateTime(clock.start ? `${hit.date} ${clock.start}` : hit.date);
        end = clock.end ? hawaiiDateTime(`${hit.endDate ?? hit.date} ${clock.end}`) : hit.endDate ? hawaiiDateTime(hit.endDate) : undefined;
      }
    }
    if (!start && fields.date) {
      const [hit] = findDates(lend(textAt(record, fields.date) ?? ''), options);
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
      // "Sunday, November 16" in a post from October 2025 is November 2025.
      // Read against today it became a phantom event a year later, every year.
      const hit = findDates(`${title}. ${prose}`, { ...options, today: published ?? options.today! }).find(found => !published || found.date >= published);
      if (hit) {
        const around = `${title}. ${prose}`.slice(Math.max(0, hit.index - 40), hit.index + hit.length + 80);
        const clock = findClock(around.replace(`${title}. ${prose}`.slice(hit.index, hit.index + hit.length), ' '));
        start = hawaiiDateTime(clock.start ? `${hit.date} ${clock.start}` : hit.date);
        end = clock.end ? hawaiiDateTime(`${hit.endDate ?? hit.date} ${clock.end}`) : hit.endDate ? hawaiiDateTime(hit.endDate) : undefined;
      }
    }
    if (!start || !inWindow(start, source)) return [];

    const location = safeVisibleText(labelled.location
      ?? (fields.location ?? []).map(path => textOnly(textAt(record, path), 200)).filter(Boolean).join(', '), 500);
    const description = safeVisibleText(labelled.description ?? textAt(record, fields.description), 2_000);
    const categoryValue = firstAt(record, fields.categories);
    const categories = uniqueLabels(typeof categoryValue === 'string' ? categoryValue.split(/\s*,\s*/) : categoryValue);
    const rawUrl = textAt(record, fields.url);
    const url = rawUrl ? new URL(rawUrl, mapping.urlPrefix ?? sourceUrl).toString() : sourceUrl;
    const status = textAt(record, fields.status) ?? strippedStatus;
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

type Labels = { title?: string; date?: string; time?: string; location?: string; description?: string };

type HtmlSelectors = {
  item: string; title?: string; date?: string; dateAttr?: string; time?: string; location?: string; description?: string;
  link?: string; category?: string; dateFrom?: string; yearFrom?: string; weeklyWeeks?: number; include?: string;
  exclude?: string; stopAt?: string; defaultTitle?: string; defaultLocation?: string; dateRequired?: boolean;
  dateFromWins?: boolean; titleFrom?: string; timeFrom?: string; locationFrom?: string; descriptionFrom?: string;
  titlePrefix?: string; titleLine?: boolean; titleAfter?: string; titleStrip?: string; locationPattern?: string;
  labels?: Labels; cellHeaders?: boolean;
};

const clean = (value: string | undefined): string => (value ?? '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

const INLINE = /^(?:strong|b|em|i|u|sup|sub|small|mark|font)$/;
const BLOCK = /^(?:p|div|li|tr|h[1-6]|ul|ol|table|section|article|blockquote|dd|dt)$/;

/**
 * An element's text as lines, with a space wherever the markup separates
 * words. cheerio's own .text() reads <span>Sat</span><br><span>03</span> as
 * "Sat03"; putting a space at every tag reads 3<sup>rd</sup> as "3 rd" and
 * loses the ordinal. So: typographic tags join, <br> and blocks break the
 * line, everything else is a space.
 */
const linesOf = (node: ReturnType<CheerioAPI>): string[] => {
  const lines: string[] = [''];
  const walk = (elements: AnyNode[]) => elements.forEach(element => {
    if (element.type === 'text') lines[lines.length - 1] += element.data;
    else if (element.type === 'tag' && !/^(?:script|style|svg|noscript)$/.test(element.name)) {
      if (element.name === 'br' || BLOCK.test(element.name)) lines.push('');
      else if (!INLINE.test(element.name)) lines[lines.length - 1] += ' ';
      walk(element.children);
      if (BLOCK.test(element.name)) lines.push('');
      else if (!INLINE.test(element.name)) lines[lines.length - 1] += ' ';
    }
  });
  walk(node.toArray());
  return lines.map(line => clean(line).replace(/\s+([,.;:!?])/g, '$1')).filter(Boolean);
};

const spaced = (_$: CheerioAPI, node: ReturnType<CheerioAPI>): string => linesOf(node).join(' ');

/** Document order, so "the heading before this line" is a lookup and not a walk. */
const orderOf = ($: CheerioAPI): Map<AnyNode, number> => {
  const order = new Map<AnyNode, number>();
  $('*').each((index, element) => { order.set(element, index); });
  return order;
};

const tidyTitle = (text: string): string => clean(text
  .replace(/\(\s*\)/g, ' ')
  .replace(/^(?:[\s:|@,&–—-]|and\b)+|[\s:|@,&–—-]+$/gi, '')
  .replace(/\s+([:,])/g, '$1')
  .replace(/^\W*(?:on|at)\s+/i, ''));

const WEEKDAY_WORDS = /\b(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?s?\b\.?,?/gi;
const CLOCK_WORDS = /(?:\bfrom\s+|\bat\s+|@\s*)?\b\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?)?\s*(?:-|–|—|to)\s*\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?|(?:\bfrom\s+|\bat\s+|@\s*)?\b\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?/gi;

/** "Where: Lydgate Pavilion" → { location: "Lydgate Pavilion" }, and the lines that were not labels. */
export const readLabels = (lines: string[], labels: Labels | undefined): { found: Labels; rest: string[] } => {
  const found: Labels = {};
  if (!labels) return { found, rest: lines };
  const rest: string[] = [];
  for (const line of lines) {
    const field = (Object.keys(labels) as Array<keyof Labels>).find(key => (
      new RegExp(`^\\W*(?:${labels[key]})\\s*[:\\-–—]\\s*\\S`, 'i').test(line)));
    if (field && !found[field]) found[field] = clean(line.replace(new RegExp(`^\\W*(?:${labels[field]})\\s*[:\\-–—]\\s*`, 'i'), ''));
    else rest.push(line);
  }
  return { found, rest };
};

/** For a table cell: the text of its column's header and of its row's header. */
const cellHeadersOf = ($: CheerioAPI, cell: ReturnType<CheerioAPI>): { column: string; row: string } => {
  const row = cell.parent();
  const position = (cells: ReturnType<CheerioAPI>, until: AnyNode | undefined): number => {
    let at = 0;
    for (const each of cells.toArray()) {
      if (each === until) return at;
      at += Number($(each).attr('colspan')) || 1;
    }
    return until ? -1 : at;
  };
  const index = position(row.children('td,th'), cell.get(0));
  const table = cell.closest('table');
  const headRow = table.find('thead tr').first().length ? table.find('thead tr').first() : table.find('tr').first();
  let column = '';
  let at = 0;
  for (const each of headRow.children('td,th').toArray()) {
    const span = Number($(each).attr('colspan')) || 1;
    if (index >= at && index < at + span) { column = spaced($, $(each)); break; }
    at += span;
  }
  const rowHead = row.children('th').first().length ? row.children('th').first() : row.children('td').first();
  return { column, row: rowHead.get(0) === cell.get(0) ? '' : spaced($, rowHead) };
};

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
  const before = (selector: string | undefined) => (selector
    ? $(selector).toArray().map(element => ({ at: order.get(element) ?? 0, text: spaced($, $(element)) })).filter(each => each.text)
    : []);
  const contexts = before(selectors.dateFrom);
  const titles = before(selectors.titleFrom);
  const pageClock = selectors.timeFrom ? findClock(spaced($, $(selectors.timeFrom).first())) : {};
  const pageLocation = selectors.locationFrom
    ? $(selectors.locationFrom).toArray().map(element => spaced($, $(element)).replace(/^\W*(?:venue|address|location|where|place)\s*:\s*/i, '')).filter(Boolean).join(', ')
    : '';
  const pageDescription = selectors.descriptionFrom ? spaced($, $(selectors.descriptionFrom).first()) : '';
  const stop = selectors.stopAt ? new RegExp(selectors.stopAt, 'i') : undefined;
  const stopIndex = stop
    ? Math.min(...$('h1,h2,h3,h4,h5,h6,strong,b,p,li,td,div').toArray()
      .filter(element => $(element).children().length === 0 && stop.test(spaced($, $(element))))
      .map(element => order.get(element) ?? Infinity), Infinity)
    : Infinity;
  const include = selectors.include ? new RegExp(selectors.include, 'i') : undefined;
  const exclude = selectors.exclude ? new RegExp(selectors.exclude, 'i') : undefined;
  const horizon = (selectors.weeklyWeeks ?? 0) * 7;
  const lookAhead = new Date(Date.now() - 10 * 3_600_000 + source.polling.lookAheadDays * 86_400_000).toISOString().slice(0, 10);
  const items: ExtractedItem[] = [];

  $(selectors.item).each((index, element) => {
    if (items.length >= source.polling.maxItems) return;
    const at = order.get(element) ?? 0;
    if (at >= stopIndex) return;
    const root = $(element);
    const { found: labelled, rest: lines } = readLabels(linesOf(root), selectors.labels);
    let whole = lines.join(' ');
    const headers = selectors.cellHeaders && root.is('td,th') ? cellHeadersOf($, root) : undefined;
    const context = headers ? headers.column : contexts.filter(candidate => candidate.at < at).pop()?.text ?? '';
    const borrowedTitle = titles.filter(candidate => candidate.at < at).pop()?.text ?? '';
    const tested = `${whole} ${borrowedTitle} ${context} ${Object.values(labelled).join(' ')}`;
    if (!clean(tested) || (include && !include.test(tested)) || (exclude && exclude.test(tested))) return;
    if (!whole && !labelled.title && !borrowedTitle && !selectors.defaultTitle) return;

    // `titleAfter` cuts the line in two: the "when" and the "what".
    let whenPart = '';
    if (selectors.titleAfter) {
      const cut = new RegExp(selectors.titleAfter, 'i').exec(whole);
      if (cut) { whenPart = whole.slice(0, cut.index); whole = whole.slice(cut.index + cut[0].length); }
    }

    const dateNode = selectors.date ? root.find(selectors.date).first() : selectors.dateAttr ? root : undefined;
    const dateText = labelled.date
      ?? (dateNode ? (selectors.dateAttr ? clean(dateNode.attr(selectors.dateAttr)) : spaced($, dateNode)) : '');
    const timeText = labelled.time ?? (selectors.time ? spaced($, root.find(selectors.time).first()) : '');
    const titleNode = selectors.title ? root.find(selectors.title).first() : undefined;

    // Where the date is looked for, nearest first: its own element, the "when"
    // part, the item's text, then the heading over the group. A heading that is
    // only a month and year lends them to a bare day number in the item.
    const contextYear = Number(/\b(20\d{2})\b/.exec(context)?.[1]) || undefined;
    const local: DateOptions = { ...options, ...(contextYear ? { yearHint: contextYear } : {}) };
    const monthOnly = /^[A-Za-z]+\.?(?:\s+20\d{2})?(?:\s+\w+)?$/.test(context) && findDates(`${context.replace(/\s+20\d{2}.*$/, '')} 1`, local).length
      ? context.replace(/\s+20\d{2}.*$/, '') : '';
    const bareDay = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(dateText || whenPart || whole)?.[1];
    const lent = monthOnly && bareDay && !findDates(dateText || whenPart || whole, local).length ? `${monthOnly} ${bareDay}` : '';
    const contextHits = context ? findDates(context, local) : [];
    const candidates = selectors.dateFromWins && contextHits.length ? [context]
      : selectors.dateRequired && (selectors.date || selectors.dateAttr || selectors.labels?.date) ? [dateText, lent]
        : [dateText, whenPart, whole, lent, context];
    let hits = [] as ReturnType<typeof findDates>;
    let from = '';
    for (const candidate of candidates) {
      if (!candidate) continue;
      hits = findDates(candidate, local);
      if (hits.length) { from = candidate; break; }
    }
    if (selectors.dateRequired && !hits.length && !horizon) return;

    const blank = (text: string) => (hits.length && text === from
      ? hits.reduceRight((rest, hit) => rest.slice(0, hit.index) + ' '.repeat(hit.length) + rest.slice(hit.index + hit.length), text)
      : text);
    // Where the entry says which element holds the time, the prose is not
    // searched for one: a festival's "September 20th to 26th" must not pick up
    // the 10 am of a church service mentioned in its description.
    const structured = Boolean(selectors.time || selectors.labels?.time);
    const ownClock = [timeText, dateText, whenPart, ...(structured ? [] : [whole])].map(text => findClock(blank(text))).find(found => found.start);
    const clock = ownClock ?? (headers ? findClock(headers.row) : undefined) ?? (pageClock.start ? pageClock : {});

    // The place: a labelled line, its own element, a pattern in the line, the page, the default.
    let location = labelled.location ?? (selectors.location ? spaced($, root.find(selectors.location).first()) : '');
    if (!location && selectors.locationPattern) {
      const placed = new RegExp(selectors.locationPattern, 'i').exec(whole);
      if (placed) { location = clean(placed[1] ?? placed[0]); whole = whole.replace(placed[0], ' '); }
    }
    location = location || pageLocation || selectors.defaultLocation || '';

    let title = labelled.title ?? (titleNode ? spaced($, titleNode) : '');
    // A heading that is only the date ("September 27th") is not the title;
    // the title is then whatever else the item says.
    if (title && findDates(title, local).length) {
      const bare = findDates(title, local).reduceRight((rest, hit) => rest.slice(0, hit.index) + rest.slice(hit.index + hit.length), title);
      if (!tidyTitle(bare.replace(WEEKDAY_WORDS, ' ').replace(/[&,]|\band\b/gi, ' '))) title = '';
    }
    if (!title) {
      // A line that is its own title: what is left when the date, the time and
      // the weekday are taken out. With `titleAfter` the date was in the other
      // half, so only the clock goes.
      let rest = selectors.titleLine ? (lines[0] ?? '') : whole;
      if (!selectors.titleAfter) {
        findDates(rest, local).reverse().forEach(hit => { rest = rest.slice(0, hit.index) + rest.slice(hit.index + hit.length); });
        if (dateText && rest.includes(dateText)) rest = rest.replace(dateText, ' ');
        rest = rest.replace(/\((?:every|each|weekly|monthly|daily)[^)]*\)/gi, ' ').replace(WEEKDAY_WORDS, ' ');
      }
      if (timeText && rest.includes(timeText)) rest = rest.replace(timeText, ' ');
      title = tidyTitle(rest.replace(CLOCK_WORDS, ' ')) || borrowedTitle || selectors.defaultTitle || '';
    }
    let status: string | undefined;
    if (selectors.titleStrip) {
      const stripped = new RegExp(selectors.titleStrip, 'i').exec(title);
      if (stripped) { status = clean(stripped[0]).replace(/[\s:–-]+$/, ''); title = tidyTitle(title.replace(stripped[0], ' ')); }
    }
    title = textOnly(`${selectors.titlePrefix ?? ''}${title}`, 300) ?? '';
    if (!title) return;

    const href = (selectors.link ? root.find(selectors.link).first() : titleNode?.is('a') ? titleNode : root.find('a[href]').first())?.attr('href')
      ?? (root.is('a') ? root.attr('href') : undefined);
    const url = href && !/^(?:mailto|tel|javascript):/i.test(href) ? new URL(href, sourceUrl).toString() : sourceUrl;
    const description = safeVisibleText(labelled.description
      ?? (selectors.description ? spaced($, root.find(selectors.description).first()) : '') ?? '', 2_000)
      ?? safeVisibleText(pageDescription, 2_000);
    const categories = selectors.category ? uniqueLabels(root.find(selectors.category).map((_i, node) => $(node).text()).get()) : [];
    const place = safeVisibleText(location, 500);

    const push = (day: string, endDay: string | undefined, series: boolean) => {
      const start = hawaiiDateTime(clock.start ? `${day} ${clock.start}` : day);
      if (!start) return;
      // A run that has opened and not closed is still on: "Jan 8 – 31" is an
      // event on the 20th, though its start is long past the look-back.
      const running = endDay !== undefined && day < today && endDay >= today && day <= lookAhead;
      if (!inWindow(start, source) && !running) return;
      const end = clock.end ? hawaiiDateTime(`${endDay ?? day} ${clock.end}`) : endDay ? hawaiiDateTime(endDay) : undefined;
      const note = series ? contextText([context, whole !== title ? whole : undefined], [title, description, place]) : undefined;
      items.push(eventItem({
        id: `${url}#${title}#${day}`,
        title,
        start,
        ...(end ? { end } : {}),
        ...(place ? { location: place } : {}),
        ...(description ? { description } : {}),
        ...(categories.length ? { categories } : {}),
        ...(note ? { context: note } : {}),
        ...(status ? { status } : {}),
        sourceUrl: url,
        raw: { url, title, text: whole.slice(0, 1_000), ...(context ? { heading: context } : {}), date: day },
        locator: `${selectors.item}[${index}]`,
      }));
    };

    const ruleText = `${dateText} ${whenPart} ${lines[0] ?? ''} ${whole}`;
    // A weekly market stored as one long run ("01/07/2026 to 12/31/2026") with
    // its weekday in the title is a series, not an eleven-month event.
    const [first] = hits;
    if (first?.endDate && horizon && Date.parse(first.endDate) - Date.parse(first.date) > 7 * 86_400_000) {
      const rule = findWeeklyRule(ruleText);
      if (rule) {
        const from_ = first.date > today ? first.date : today;
        occurrences(rule, from_, horizon).filter(day => day <= first.endDate!).forEach(day => push(day, undefined, true));
        return;
      }
    }
    if (hits.length) {
      hits.forEach(hit => push(hit.date, hit.endDate, false));
      return;
    }
    if (!horizon) return;
    const rule: WeeklyRule | undefined = findWeeklyRule(ruleText) ?? (context ? findWeeklyRule(`every ${context}`) : undefined);
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
    // WordPress writes the excerpt (<description>) before the post
    // (<content:encoded>); the post is where "Date & Time:" is.
    const body = ['content\\:encoded', 'content', 'description', 'summary']
      .map(name => textOnly(node.children(name).first().text(), 20_000) ?? '')
      .sort((a, b) => b.length - a.length)[0] ?? '';
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
