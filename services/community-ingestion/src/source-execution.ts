import { load } from 'cheerio';
import { formatDate } from './text-dates.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ManualSupportAdapter } from './adapters/manual-support.js';
import { LiveSourceAdapter } from './adapters/live-source.js';
import type { FetchArtifactInput, PlannedRequest, SourceDefinition, SourceRegistry } from './contracts.js';
import { FileArtifactStore } from './artifact-store.js';
import type { MongoIngestionRepository } from './repository.js';
import { IngestionRuntime } from './runtime.js';
import { SafeHttpClient, type SafeHttpResult } from './safe-http-client.js';

const DEFAULT_USER_AGENT = 'MatchBookCommunityRegister/0.2 (+https://christianjoudon.github.io/work/matchbook.html)';
const COMPOSITE_MEDIA_TYPE = 'application/vnd.matchbook.source-pages+json';

type Page = { url: string; mediaType: string; text: string };

const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

const kauaiDate = (offsetDays: number): string => {
  // Kauaʻi is UTC−10 all year; the date the island is on, plus an offset.
  const date = new Date(Date.now() - 10 * 3_600_000 + offsetDays * 86_400_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
};

/** The first of the month, `offset` months from this one, on Kauaʻi's calendar. */
const kauaiMonth = (offset: number): string => {
  const [year, month] = kauaiDate(0).split('-').map(Number) as [number, number];
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

const spell = (date: string, format: string | undefined): string => (format ? formatDate(date, format) : date);

/**
 * The dates a template may ask for: {START_DATE} and {END_DATE} are the
 * polling window's edges, {DATE+N} is N days from today, {MONTH+N} the first
 * of the month N months on; any of them may say how it is spelled —
 * {DATE+0|M-D-YYYY}, {MONTH+1|YYYY/MM}. A Tribe endpoint without an end_date
 * answers with two years of a weekly hula class; AlohaCalendar caps a call
 * at fifty rows, so its endpoints are windows; a chamber of commerce wants
 * year=2026&month=10 in a form post.
 */
const withDates = (template: string, source: SourceDefinition, variables: Record<string, string> = {}): string => template
  .replace(/[{]START_DATE(?:\|([^}]+))?[}]/g, (_match, format?: string) => spell(kauaiDate(-(source.polling.lookBackDays ?? 0)), format))
  .replace(/[{]END_DATE(?:\|([^}]+))?[}]/g, (_match, format?: string) => spell(kauaiDate(source.polling.lookAheadDays), format))
  .replace(/[{]DATE\+(\d+)(?:\|([^}]+))?[}]/g, (_match, days: string, format?: string) => spell(kauaiDate(Number(days)), format))
  .replace(/[{]MONTH\+(\d+)(?:\|([^}]+))?[}]/g, (_match, months: string, format?: string) => spell(kauaiMonth(Number(months)), format))
  .replace(/[{]([A-Z][A-Z0-9_]*)(?:\|([^}]+))?[}]/g, (whole, name: string, format?: string) => {
    const value = variables[name];
    if (value === undefined) return whole;
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? spell(value, format) : value;
  });

/** One endpoint, or the several it expands to: a day at a time, a month at a time, or a listed value at a time. */
const expansions = (endpoint: SourceDefinition['endpoints'][number]): Array<Record<string, string>> => {
  const { expand } = endpoint;
  if (!expand) return [{}];
  const values = expand.values
    ?? (expand.days ? Array.from({ length: expand.days }, (_unused, index) => kauaiDate(index))
      : expand.months ? Array.from({ length: expand.months }, (_unused, index) => kauaiMonth(index)) : []);
  return values.map(value => ({ [expand.variable]: value }));
};

const requestsFor = (source: SourceDefinition, purpose: string): PlannedRequest[] => source.endpoints
  .filter(candidate => candidate.purpose === purpose)
  .flatMap(endpoint => expansions(endpoint).map(variables => ({
    method: endpoint.method,
    url: withDates(endpoint.urlTemplate, source, variables),
    ...(endpoint.headers ? { headers: endpoint.headers } : {}),
    ...(typeof endpoint.bodyTemplate === 'string' ? { body: withDates(endpoint.bodyTemplate, source, variables) } : {}),
  })));

const requestFor = (source: SourceDefinition, purpose: string): PlannedRequest | undefined => requestsFor(source, purpose)[0];

const fetchedPage = (result: SafeHttpResult): Page => ({
  url: result.sourceUrl,
  mediaType: result.mediaType,
  text: decode(result.bytes),
});

const composite = (source: SourceDefinition, pages: Page[]): FetchArtifactInput => ({
  bytes: new TextEncoder().encode(JSON.stringify({ pages })),
  mediaType: COMPOSITE_MEDIA_TYPE,
  sourceUrl: source.publisherUrl,
  statusCode: 200,
  responseHeaders: { 'content-type': COMPOSITE_MEDIA_TYPE },
});

const safeUrl = (raw: string): string | null => {
  try {
    return new URL(raw).toString();
  } catch {
    return null;
  }
};

const sitemapLinks = (xml: string, source: SourceDefinition): string[] => {
  const links = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map(match => match[1]?.replaceAll('&amp;', '&'))
    .filter((value): value is string => Boolean(value))
    .map(safeUrl)
    .filter((value): value is string => Boolean(value));
  const likelyEvent = links.filter(url => /\/(event|events|calendar|community-calendar|tribe_events|press-release|news)\b/i.test(new URL(url).pathname));
  return (likelyEvent.length ? likelyEvent : links).slice(0, Math.min(source.polling.maxPages, 8));
};

const fetchTribe = async (
  source: SourceDefinition,
  client: SafeHttpClient,
): Promise<FetchArtifactInput> => {
  const first = requestFor(source, 'COLLECTION');
  if (!first) throw new Error(`${source.id} has no collection endpoint`);
  let request: PlannedRequest | undefined = first;
  const events: unknown[] = [];
  let lastUrl = first.url;
  for (let page = 0; request && page < source.polling.maxPages; page += 1) {
    const response = await client.fetch(request, source.httpPolicy);
    lastUrl = response.sourceUrl;
    const document: unknown = JSON.parse(decode(response.bytes));
    if (!document || typeof document !== 'object' || Array.isArray(document)) break;
    const record = document as Record<string, unknown>;
    const pageEvents = Array.isArray(record.events) ? record.events : [];
    events.push(...pageEvents);
    const next = typeof record.next_rest_url === 'string' ? safeUrl(record.next_rest_url) : null;
    request = next && pageEvents.length && events.length < source.polling.maxItems
      ? { method: 'GET', url: next }
      : undefined;
  }
  return composite(source, [{
    url: lastUrl,
    mediaType: 'application/json',
    text: JSON.stringify({ events: events.slice(0, source.polling.maxItems) }),
  }]);
};

const substitute = (template: string, values: Record<string, string>): string => (
  Object.entries(values).reduce((url, [key, value]) => url.replaceAll(`{${key}}`, value), template)
);

const fetchFilteredTribe = async (
  source: SourceDefinition,
  client: SafeHttpClient,
): Promise<FetchArtifactInput> => {
  const discovery = requestFor(source, 'DISCOVERY');
  const collection = requestFor(source, 'COLLECTION');
  const hydration = requestFor(source, 'HYDRATION');
  if (!discovery || !collection || !hydration) throw new Error(`${source.id} has an incomplete filtered-events plan`);
  const discovered = await client.fetch(discovery, source.httpPolicy);
  const taxonomies: unknown = JSON.parse(decode(discovered.bytes));
  const taxonomy = Array.isArray(taxonomies) ? taxonomies.find(value => (
    value && typeof value === 'object' && 'id' in value
  )) as { id?: unknown } | undefined : undefined;
  const taxonomyId = Number(taxonomy?.id);
  if (!Number.isInteger(taxonomyId)) throw new Error(`${source.id} did not resolve its Kauaʻi taxonomy`);

  const ids: string[] = [];
  for (let page = 1; page <= source.polling.maxPages && ids.length < source.polling.maxItems; page += 1) {
    const response = await client.fetch({
      ...collection,
      url: substitute(collection.url, { RESOLVED_ID: `${taxonomyId}`, N: `${page}` }),
    }, source.httpPolicy);
    const rows: unknown = JSON.parse(decode(response.bytes));
    if (!Array.isArray(rows)) throw new Error(`${source.id} collection page was not an array`);
    ids.push(...rows.flatMap(row => {
      if (!row || typeof row !== 'object' || !('id' in row)) return [];
      const id = (row as { id?: unknown }).id;
      return typeof id === 'number' || typeof id === 'string' ? [`${id}`] : [];
    }));
    if (rows.length < 100) break;
  }

  const events: unknown[] = [];
  const batchSize = source.adapterConfig.kind === 'WP_FILTERED_TRIBE'
    ? source.adapterConfig.batchSize : 50;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const include = ids.slice(offset, offset + batchSize).join(',');
    const response = await client.fetch({
      ...hydration,
      url: substitute(hydration.url, { COMMA_SEPARATED_IDS: include }),
    }, source.httpPolicy);
    const document: unknown = JSON.parse(decode(response.bytes));
    if (document && typeof document === 'object' && !Array.isArray(document)) {
      const pageEvents = (document as Record<string, unknown>).events;
      if (Array.isArray(pageEvents)) events.push(...pageEvents);
    }
  }
  return composite(source, [{
    url: source.publisherUrl,
    mediaType: 'application/json',
    text: JSON.stringify({ events: events.slice(0, source.polling.maxItems) }),
  }]);
};

const fetchPages = async (
  source: SourceDefinition,
  client: SafeHttpClient,
): Promise<FetchArtifactInput> => {
  // A source whose config says `sitemap: true` is read from its sitemap —
  // the DISCOVERY endpoint — because its index page lists nothing a parser
  // can date; the county press-release index is a list of titles. The
  // generic order took the collection page first and found nothing in it.
  const bySitemap = (source.adapterConfig as { sitemap?: boolean }).sitemap === true;
  const fallback = requestFor(source, 'FALLBACK');
  // Every COLLECTION endpoint is fetched, not the first: an arts council with
  // four public calendars is one source, and an API that answers fifty rows a
  // call is asked in windows.
  const discovery = bySitemap ? requestFor(source, 'DISCOVERY') : undefined;
  const requests = discovery ? [discovery]
    : fallback ? [fallback]
      : requestsFor(source, 'COLLECTION').length ? requestsFor(source, 'COLLECTION')
        : requestsFor(source, 'DISCOVERY').slice(0, 1);
  if (!requests.length) throw new Error(`${source.id} has no fetchable endpoint`);
  const pages: Page[] = [];
  let firstError: unknown;
  for (const [index, request] of requests.entries()) {
    if (/[{][A-Z0-9_+|-]+[}]/.test(request.url)) throw new Error(`${source.id} endpoint requires an unimplemented discovery substitution`);
    let page: Page;
    try {
      page = fetchedPage(await client.fetch(request, source.httpPolicy));
    } catch (error) {
      // One window or one day's file missing is a partial read, and the pages
      // in hand are still worth reviewing; every request failing is the
      // source failing, and says so with the first reason.
      firstError ??= error;
      if (index === requests.length - 1 && pages.length === 0) throw firstError;
      continue;
    }
    pages.push(page);
    if (/xml/.test(page.mediaType)) {
      for (const url of sitemapLinks(page.text, source)) {
        try {
          const detail = await client.fetch({ method: 'GET', url }, source.httpPolicy);
          pages.push(fetchedPage(detail));
        } catch {
          // A partial sitemap still yields review candidates from the detail
          // pages that were independently available.
        }
      }
    } else if (/html/.test(page.mediaType) && (source.adapterConfig as { followDetails?: boolean }).followDetails !== false) {
      for (const url of detailLinks(page, source)) {
        try {
          const detail = await client.fetch({ method: 'GET', url }, source.httpPolicy);
          pages.push(fetchedPage(detail));
        } catch {
          // Same as a sitemap: what could be read is read.
        }
      }
    }
  }
  return composite(source, pages);
};

/**
 * The event pages a list page links to, for a site whose list carries no
 * dates a parser can read but whose detail pages carry schema.org Event
 * (Squarespace and Wix event lists both work this way). The register's
 * `detailLinkSelector` says which links; the same host as the list, no
 * repeats, and at most the polling page budget, so a directory of a
 * thousand links is not a thousand fetches.
 */
const detailLinks = (page: Page, source: SourceDefinition): string[] => {
  const selector = (source.adapterConfig as { detailLinkSelector?: string }).detailLinkSelector;
  if (!selector || !['JSON_LD_HTML', 'SOURCE_HTML'].includes(source.adapterKind)) return [];
  const $ = load(page.text);
  const host = new URL(page.url).host;
  const links = new Set<string>();
  $(selector).each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const url = safeUrl(new URL(href, page.url).toString());
    if (url && new URL(url).host === host && url.split('#')[0] !== page.url.split('#')[0]) links.add(url.split('#')[0]!);
  });
  return [...links].slice(0, Math.min(source.polling.maxPages, 20));
};

/**
 * The County of Kauaʻi's OpenCities calendar, the way its own page reads it.
 *
 * The registry's endpoints were right and nothing used them: the discovery
 * URL lists the calendars, the collection URL is a POST that wants those ids
 * and a date range, and each item then has a detail call with the venue, the
 * page it lives on, and whether it was cancelled. The generic page fetch took
 * the FALLBACK — the human directory page — and found nothing in it. Read the
 * way the page's own script reads it (oc_main.js: {LanguageCode, Ids,
 * StartDate, EndDate} to getcalendaritems; contentinfo for a detail), with
 * every request going through the same safe client and host policy.
 */
const fetchOpenCities = async (
  source: SourceDefinition,
  client: SafeHttpClient,
): Promise<FetchArtifactInput> => {
  const discovery = requestFor(source, 'DISCOVERY');
  const collection = requestFor(source, 'COLLECTION');
  if (!discovery || !collection) throw new Error(`${source.id} needs DISCOVERY and COLLECTION endpoints`);
  const calendars = await client.fetch(discovery, source.httpPolicy);
  const listing: unknown = JSON.parse(decode(calendars.bytes));
  const rows = (listing as { data?: Array<{ Id?: string; Label?: string }> })?.data ?? [];
  const ids = rows.map(row => row.Id).filter((id): id is string => typeof id === 'string');
  const labels = new Map(rows.map(row => [row.Id, row.Label]));
  if (!ids.length) return composite(source, [fetchedPage(calendars)]);

  const stamp = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}T00:00:00`;
  const today = new Date(Date.now() - 10 * 3_600_000); // Kauaʻi is UTC−10, all year
  const start = new Date(today.getTime() - (source.polling.lookBackDays ?? 0) * 86_400_000);
  const end = new Date(today.getTime() + source.polling.lookAheadDays * 86_400_000);
  const items = await client.fetch({
    method: 'POST',
    url: collection.url,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ LanguageCode: 'en-US', Ids: ids, StartDate: stamp(start), EndDate: stamp(end) }),
  }, source.httpPolicy);
  const days = (JSON.parse(decode(items.bytes)) as { data?: Array<{ Items?: Array<Record<string, unknown>> }> })?.data ?? [];
  const flat = days.flatMap(day => day.Items ?? []).slice(0, source.polling.maxItems);

  const origin = new URL(collection.url).origin;
  const pages: Page[] = [];
  for (const item of flat) {
    const calendarId = String(item.CalendarId ?? '');
    const query = new URLSearchParams({
      calendarId,
      contentId: String(item.Id ?? ''),
      language: 'en-US',
      currentDateTime: String(item.DateTime ?? ''),
      mainContentId: String(item.MainContentId ?? ''),
    });
    let detail: unknown = null;
    try {
      const response = await client.fetch({ method: 'GET', url: `${origin}/ocapi/get/contentinfo?${query}` }, source.httpPolicy);
      detail = JSON.parse(decode(response.bytes));
    } catch {
      // The list already says what and when; the detail only adds where.
    }
    pages.push({
      url: `${collection.url}#${item.Id}`,
      mediaType: 'application/json',
      text: JSON.stringify({ item, calendar: labels.get(calendarId) ?? null, detail }),
    });
  }
  return composite(source, pages);
};

/**
 * Fetch a governed source without persisting or promoting anything.
 *
 * Research uses this same boundary so its fallback cannot widen source hosts,
 * media types, redirects, response limits, or pacing beyond the registry.
 */
export const fetchSourceArtifact = async (
  source: SourceDefinition,
  client: SafeHttpClient,
): Promise<FetchArtifactInput> => (
  source.adapterKind === 'TRIBE_REST'
    ? fetchTribe(source, client)
    : source.adapterKind === 'WP_FILTERED_TRIBE'
      ? fetchFilteredTribe(source, client)
      : source.adapterKind === 'COUNTY_OPENCITIES'
        ? fetchOpenCities(source, client)
        : fetchPages(source, client)
);

export type SourceExecutionResult = {
  runId: string;
  completeness: 'COMPLETE' | 'PARTIAL';
  metrics: {
    discovered: number;
    emitted: number;
    rejected: number;
    artifactsCreated: number;
    observationsCreated: number;
    candidatesCreated: number;
    unchanged: boolean;
  };
};

export const executeSource = async (options: {
  source: SourceDefinition;
  registry: SourceRegistry;
  repository: MongoIngestionRepository;
  artifactRoot?: string;
  userAgent?: string;
}): Promise<SourceExecutionResult> => {
  const { source, registry, repository } = options;
  await repository.upsertSource(source, registry.registryVersion);
  const root = options.artifactRoot
    ?? fileURLToPath(new URL('../.artifacts/community', import.meta.url));
  const runtime = new IngestionRuntime(repository, new FileArtifactStore(root));
  if (source.adapterKind === 'MANUAL_CLIP') {
    const bytes = new Uint8Array(await readFile(new URL(`../fixtures/support/${source.id}.json`, import.meta.url)));
    return runtime.runArtifact({
      bytes,
      mediaType: 'application/json',
      sourceUrl: source.publisherUrl,
      statusCode: 200,
      responseHeaders: { 'content-type': 'application/json' },
      source,
      adapter: new ManualSupportAdapter(),
      execution: 'manual',
    });
  }

  const client = new SafeHttpClient({ userAgent: options.userAgent ?? DEFAULT_USER_AGENT });
  const artifact = await fetchSourceArtifact(source, client);
  // The permission decides the execution, not the caller: a source cleared for
  // automation runs as 'automatic' (which the runtime allows only when it is
  // also enabled), and one still awaiting its probe runs as 'practice'. This
  // always said 'practice', which meant a source could be probed forever and
  // never once run for real after it was cleared.
  return runtime.runArtifact({
    ...artifact,
    source,
    adapter: new LiveSourceAdapter(source.adapterKind),
    execution: source.permission === 'AUTOMATED_ALLOWED' ? 'automatic' : 'practice',
  });
};
