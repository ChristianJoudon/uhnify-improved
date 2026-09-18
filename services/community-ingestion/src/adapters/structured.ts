import { load } from 'cheerio';
import { asString, isRecord, locationText, safeVisibleText, textOnly, type JsonRecord } from './shared.js';

/**
 * What a page says about its events in the ways meant for machines:
 * schema.org as JSON-LD, and schema.org as microdata (itemscope/itemprop),
 * which a good many hand-built and site-builder pages use instead and which
 * nothing here used to read. Facts only — no windows, no candidates — so the
 * list parser, the detail-page reader and the prober can all ask the same
 * question of a page.
 */
export type StructuredEvent = {
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
  url?: string;
  status?: string;
  attendanceMode?: string;
  raw: JsonRecord;
  locator: string;
};

export const jsonLdNodes = (value: unknown): JsonRecord[] => {
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes);
  if (!isRecord(value)) return [];
  return [value, ...Object.values(value).flatMap(jsonLdNodes)];
};

const isEventType = (value: unknown): boolean => (Array.isArray(value) ? value : [value])
  .some(kind => typeof kind === 'string' && /event/i.test(kind) && !/eventseries|eventstatus|eventattendance/i.test(kind));

const absolute = (raw: string | undefined, base: string): string | undefined => {
  if (!raw) return undefined;
  try { return new URL(raw, base).toString(); } catch { return undefined; }
};

const fromJsonLd = (html: string, pageUrl: string): StructuredEvent[] => {
  const $ = load(html);
  const nodes: JsonRecord[] = [];
  $('script[type="application/ld+json"]').each((_index, element) => {
    // Publishers paste JSON-LD with trailing commas, comments and stray
    // control characters; one bad block must not cost the page its others.
    const text = $(element).text();
    for (const attempt of [text, text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001F]+/g, ' ')]) {
      try { nodes.push(...jsonLdNodes(JSON.parse(attempt))); break; } catch { /* try the repaired text, then give up on this block */ }
    }
  });
  return nodes.flatMap((node, index) => {
    if (!isEventType(node['@type'])) return [];
    const url = absolute(asString(node.url ?? node['@id']), pageUrl);
    return [{
      ...(textOnly(node.name ?? node.headline, 300) ? { title: textOnly(node.name ?? node.headline, 300)! } : {}),
      ...(asString(node.startDate) ? { start: asString(node.startDate)! } : {}),
      ...(asString(node.endDate) ? { end: asString(node.endDate)! } : {}),
      ...(locationText(node.location) ? { location: locationText(node.location)! } : {}),
      ...(safeVisibleText(node.description ?? node.abstract, 2_000) ? { description: safeVisibleText(node.description ?? node.abstract, 2_000)! } : {}),
      ...(url ? { url } : {}),
      ...(asString(node.eventStatus) ? { status: asString(node.eventStatus)! } : {}),
      ...(asString(node.eventAttendanceMode) ? { attendanceMode: asString(node.eventAttendanceMode)! } : {}),
      raw: node,
      locator: `$jsonld[${index}]`,
    }];
  });
};

const fromMicrodata = (html: string, pageUrl: string): StructuredEvent[] => {
  const $ = load(html);
  const events: StructuredEvent[] = [];
  $('[itemscope][itemtype]').each((index, element) => {
    const scope = $(element);
    if (!/schema\.org\/\w*Event\b/i.test(scope.attr('itemtype') ?? '')) return;
    // A property belongs to the nearest enclosing scope: the venue's "name"
    // is not the event's.
    const prop = (name: string) => scope.find(`[itemprop~="${name}"]`).filter((_i, node) => $(node).parent().closest('[itemscope]').get(0) === element).first();
    const value = (name: string): string | undefined => {
      const node = prop(name);
      if (!node.length) return undefined;
      return asString(node.attr('content') ?? node.attr('datetime') ?? node.attr('href') ?? node.text().replace(/\s+/g, ' ').trim());
    };
    const place = prop('location');
    const placeText = place.length
      ? (place.is('[itemscope]')
        ? [place.find('[itemprop~="name"]').first().text(), place.find('[itemprop~="streetAddress"]').first().text(),
          place.find('[itemprop~="addressLocality"]').first().text()].map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ')
        : (place.attr('content') ?? place.text()).replace(/\s+/g, ' ').trim())
      : '';
    const title = textOnly(value('name') ?? value('headline'), 300);
    const url = absolute(prop('url').attr('href') ?? prop('url').attr('content'), pageUrl);
    events.push({
      ...(title ? { title } : {}),
      ...(value('startDate') ? { start: value('startDate')! } : {}),
      ...(value('endDate') ? { end: value('endDate')! } : {}),
      ...(safeVisibleText(placeText, 500) ? { location: safeVisibleText(placeText, 500)! } : {}),
      ...(safeVisibleText(value('description'), 2_000) ? { description: safeVisibleText(value('description'), 2_000)! } : {}),
      ...(url ? { url } : {}),
      ...(value('eventStatus') ? { status: value('eventStatus')! } : {}),
      raw: { microdata: true, name: title ?? '', startDate: value('startDate') ?? '', location: placeText },
      locator: `$microdata[${index}]`,
    });
  });
  return events;
};

/** Every schema.org Event a page declares, JSON-LD first; a microdata event JSON-LD already gave is not given twice. */
export const structuredEvents = (html: string, pageUrl: string): StructuredEvent[] => {
  const linked = fromJsonLd(html, pageUrl);
  const seen = new Set(linked.map(event => `${event.title}|${event.start?.slice(0, 10)}`));
  return [...linked, ...fromMicrodata(html, pageUrl).filter(event => !seen.has(`${event.title}|${event.start?.slice(0, 10)}`))];
};
