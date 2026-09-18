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

const requestFor = (source: SourceDefinition, purpose: string): PlannedRequest | undefined => {
  const endpoint = source.endpoints.find(candidate => candidate.purpose === purpose);
  if (!endpoint) return undefined;
  return {
    method: endpoint.method,
    url: endpoint.urlTemplate,
    ...(endpoint.headers ? { headers: endpoint.headers } : {}),
    ...(typeof endpoint.bodyTemplate === 'string' ? { body: endpoint.bodyTemplate } : {}),
  };
};

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
  const fallback = requestFor(source, 'FALLBACK');
  const request = fallback ?? requestFor(source, 'COLLECTION') ?? requestFor(source, 'DISCOVERY');
  if (!request) throw new Error(`${source.id} has no fetchable endpoint`);
  if (/[{][A-Z0-9_]+[}]/.test(request.url)) throw new Error(`${source.id} endpoint requires an unimplemented discovery substitution`);
  const first = await client.fetch(request, source.httpPolicy);
  const pages = [fetchedPage(first)];
  if (/xml/.test(first.mediaType)) {
    for (const url of sitemapLinks(pages[0]?.text ?? '', source)) {
      try {
        const detail = await client.fetch({ method: 'GET', url }, source.httpPolicy);
        pages.push(fetchedPage(detail));
      } catch {
        // A partial sitemap still yields review candidates from the detail
        // pages that were independently available.
      }
    }
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
