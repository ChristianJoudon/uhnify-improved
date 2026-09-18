import { load } from 'cheerio';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { MongoClient } from 'mongodb';
import { LiveSourceAdapter } from './adapters/live-source.js';
import { SourceDefinitionSchema, type SourceDefinition } from './contracts.js';
import { probeSite, REGISTER_USER_AGENT, type ProbeReport } from './probe.js';
import { SafeHttpClient } from './safe-http-client.js';
import { fetchSourceArtifact } from './source-execution.js';
import { DEFAULT_REGISTRY_PATH, loadSourceRegistry } from './source-registry.js';

/**
 * The operator's tools for a source that is not in the register yet, or not
 * working: read it without touching the database (dry-run), look a site
 * over (probe), find sites worth looking over (discover), and put a vetted
 * proposal into the register under somebody's name (adopt).
 */
export const PROPOSALS_DIR = resolve(fileURLToPath(new URL('../proposals', import.meta.url)));

/** A source from the register by id, or from a JSON file holding one entry. */
export const resolveSource = async (reference: string): Promise<SourceDefinition> => {
  if (/\.json$/i.test(reference)) return SourceDefinitionSchema.parse(JSON.parse(await readFile(reference, 'utf8')) as unknown);
  const registry = await loadSourceRegistry();
  const source = registry.sources.find(candidate => candidate.id === reference || candidate.slug === reference);
  if (!source) throw new Error(`No source ${reference} in the register`);
  return source;
};

/** Fetch and parse exactly as a run would, and say what came out; nothing is stored. */
export const dryRun = async (source: SourceDefinition, limit = 12) => {
  const client = new SafeHttpClient({ userAgent: process.env.MATCHBOOK_INGESTION_USER_AGENT ?? REGISTER_USER_AGENT });
  const artifact = await fetchSourceArtifact(source, client);
  const pages = artifact.mediaType === 'application/vnd.matchbook.source-pages+json'
    ? (JSON.parse(new TextDecoder().decode(artifact.bytes)) as { pages: Array<{ url: string; mediaType: string; text: string }> }).pages : [];
  const result = await new LiveSourceAdapter(source.adapterKind).extract(artifact, source);
  const rows = result.items
    .map(item => item.normalizedFields)
    .sort((a, b) => `${a.localStart ?? ''}`.localeCompare(`${b.localStart ?? ''}`));
  return {
    sourceId: source.id,
    pages,
    all: rows.map(fields => ({ start: fields.localStart, end: fields.localEnd, title: fields.title, location: fields.location, status: fields.realityStatus })),
    fetched: pages.map(page => ({ url: page.url, mediaType: page.mediaType, bytes: page.text.length })),
    completeness: result.completeness,
    warnings: result.warnings,
    items: result.items.length,
    sample: rows.slice(0, limit).map(fields => ({
      start: fields.localStart, end: fields.localEnd, title: fields.title, location: fields.location,
      status: fields.realityStatus, url: fields.sourceUrl, researchNeeded: fields.researchNeeded,
    })),
  };
};

const hostOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return undefined;
  try { return new URL(value).hostname.replace(/^www\./, '').toLowerCase(); } catch { return undefined; }
};

/** Places that host many people's pages, or that are not an organiser's own site. */
const NOT_A_PUBLISHER = /(?:^|\.)(?:facebook|instagram|fb|twitter|x|youtube|youtu|tiktok|linkedin|google|goo|bit|linktr|eventbrite|meetup|zoom|ticketmaster|brownpapertickets|eventbrite|paypal|venmo|square|squareup|forms|docs|drive|maps|apple|yelp|tripadvisor|wikipedia|amazon|constantcontact|mailchi|signupgenius|givebutter|zeffy|ticketleap|bandsintown|allevents|schema|opentable|evvnt|venuepilot|brightspotcdn|cloudfront|wp|gravatar|w3|cancer|hyatt|marriott|sonesta|outrigger|hilton)\./;

/**
 * Sites worth probing, found in what has already been collected: the
 * organisers' and venues' own websites that the aggregators link to. An
 * island-wide calendar names the hālau, the theatre and the brewery it
 * lists; their own sites often carry more than the aggregator repeats.
 */
export const discoverHosts = async (client: MongoClient, limit = 40): Promise<Array<{ host: string; url: string; seen: number }>> => {
  const registry = await loadSourceRegistry();
  const known = new Set(registry.sources.flatMap(source => [source.publisherUrl, ...source.endpoints.map(endpoint => endpoint.urlTemplate)])
    .map(hostOf).filter(Boolean));
  const seen = new Map<string, { url: string; seen: number }>();
  const note = (value: unknown) => {
    const host = hostOf(value);
    // A host the register already reads, or a sub-site or parent of one, is not news.
    const related = [...known].some(other => other && (host === other || host?.endsWith(`.${other}`) || other.endsWith(`.${host}`)));
    if (!host || related || NOT_A_PUBLISHER.test(`.${host}`)) return;
    const entry = seen.get(host) ?? { url: `https://${new URL(value as string).hostname}/`, seen: 0 };
    entry.seen += 1;
    seen.set(host, entry);
  };
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 4) return;
    if (typeof value === 'string') note(value);
    else if (Array.isArray(value)) value.forEach(item => walk(item, depth + 1));
    else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, inner]) => {
        if (/image|img|photo|thumb|logo|avatar|icon/i.test(key)) return;
        walk(inner, depth + 1);
      });
    }
  };
  const observations = client.db().collection('source_observations').find({}, { projection: { rawFields: 1 } }).limit(20_000);
  for await (const observation of observations) walk(observation.rawFields);
  return [...seen.entries()].map(([host, entry]) => ({ host, ...entry }))
    .sort((a, b) => b.seen - a.seen).slice(0, limit);
};

const summary = (report: ProbeReport) => ({
  url: report.url,
  verdict: report.verdict,
  robots: report.robotsRule ? `${report.robots} (${report.robotsRule})` : report.robots,
  ...(report.crawlDelaySeconds ? { crawlDelaySeconds: report.crawlDelaySeconds } : {}),
  terms: report.termsExcerpt ? `${report.terms}: “${report.termsExcerpt}”` : report.terms,
  ...(report.refusal ? { refusal: `${report.refusal} — not worked around` } : {}),
  ...(report.platform ? { platform: report.platform } : {}),
  findings: report.findings.map(finding => ({ kind: finding.kind, upcoming: finding.upcoming, feed: finding.feedUrl, note: finding.note, samples: finding.samples })),
  ...(report.best ? { best: `${report.best.kind}: ${report.best.upcoming} upcoming` } : {}),
});

/** Probe sites and keep each ready one as a proposal file the operator can adopt. */
export const probeAndPropose = async (urls: string[]) => {
  await mkdir(PROPOSALS_DIR, { recursive: true });
  const client = new SafeHttpClient({ userAgent: process.env.MATCHBOOK_INGESTION_USER_AGENT ?? REGISTER_USER_AGENT });
  const out = [];
  for (const url of urls) {
    const report = await probeSite(url, { client });
    if (report.verdict === 'ready' && report.best) {
      const file = resolve(PROPOSALS_DIR, `${report.best.entry.slug}.json`);
      await writeFile(file, `${JSON.stringify({
        probedAt: new Date().toISOString(),
        evidence: summary(report),
        entry: report.best.entry,
      }, null, 2)}\n`);
      out.push({ ...summary(report), proposal: file });
    } else out.push(summary(report));
  }
  return out;
};

/**
 * Put a proposal in the register. This is the one step a person does: the
 * steward's name and today's date go on the entry, which is what the
 * register means by a source having been cleared.
 */
export const adoptProposal = async (reference: string, steward: string, options: { enable: boolean }) => {
  const file = /\.json$/i.test(reference) ? reference : resolve(PROPOSALS_DIR, `${reference}.json`);
  const proposal = JSON.parse(await readFile(file, 'utf8')) as { entry: SourceDefinition; evidence?: { terms?: string } };
  if (/forbids-automation/.test(proposal.evidence?.terms ?? '')) throw new Error('This site’s terms forbid automated access; it cannot be adopted.');
  const text = await readFile(DEFAULT_REGISTRY_PATH, 'utf8');
  const registry = JSON.parse(text) as { sources: SourceDefinition[] };
  const host = hostOf(proposal.entry.publisherUrl);
  if (registry.sources.some(source => hostOf(source.publisherUrl) === host)) throw new Error(`${host} is already in the register`);
  const next = Math.max(0, ...registry.sources.map(source => Number(/^SRC-(\d{3})$/.exec(source.id)?.[1] ?? 0))) + 1;
  const entry = SourceDefinitionSchema.parse({
    ...proposal.entry,
    id: `SRC-${String(next).padStart(3, '0')}`,
    permission: 'AUTOMATED_ALLOWED',
    enabled: options.enable,
    steward,
    lastVerifiedAt: new Date().toISOString(),
    nextRunAt: new Date().toISOString(),
  });
  const tail = '\n  ]\n}\n';
  if (!text.endsWith(tail)) throw new Error('The register does not end the way this tool expects; add the entry by hand.');
  await writeFile(DEFAULT_REGISTRY_PATH, `${text.slice(0, -tail.length)},\n${registerEntry(entry)}${tail}`);
  return entry;
};

const inline = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (value && typeof value === 'object') {
    const pairs = Object.entries(value).map(([key, inner]) => `${JSON.stringify(key)}: ${inline(inner)}`);
    return pairs.length ? `{ ${pairs.join(', ')} }` : '{}';
  }
  return JSON.stringify(value);
};

/** One entry in the register's own layout: a key a line, small objects inline, an endpoint a line. */
export const registerEntry = (source: SourceDefinition): string => {
  const keys = Object.keys(source) as Array<keyof SourceDefinition>;
  const lines = keys.map((key, index) => {
    const comma = index < keys.length - 1 ? ',' : '';
    if (key === 'endpoints') {
      const endpoints = source.endpoints.map((endpoint, at) => `        ${inline(endpoint)}${at < source.endpoints.length - 1 ? ',' : ''}`);
      return `      "endpoints": [\n${endpoints.join('\n')}\n      ]${comma}`;
    }
    return `      ${JSON.stringify(key)}: ${inline(source[key])}${comma}`;
  });
  return `    {\n${lines.join('\n')}\n    }`;
};

/**
 * Put an entry in the register: replace the one with the same id, or add it
 * at the end. The file keeps its own layout, so the diff is the entry.
 */
export const putEntry = async (entry: SourceDefinition): Promise<'replaced' | 'added'> => {
  const parsed = SourceDefinitionSchema.parse(entry);
  const text = await readFile(DEFAULT_REGISTRY_PATH, 'utf8');
  const block = new RegExp(`    \\{\\n      "id": "${parsed.id}",\\n[\\s\\S]*?\\n    \\}`);
  if (block.test(text)) {
    await writeFile(DEFAULT_REGISTRY_PATH, text.replace(block, () => registerEntry(parsed)));
    return 'replaced';
  }
  const tail = '\n  ]\n}\n';
  if (!text.endsWith(tail)) throw new Error('The register does not end the way this tool expects; add the entry by hand.');
  await writeFile(DEFAULT_REGISTRY_PATH, `${text.slice(0, -tail.length)},\n${registerEntry(parsed)}${tail}`);
  return 'added';
};

/** The next free SRC-### id. */
export const nextSourceId = async (): Promise<string> => {
  const registry = JSON.parse(await readFile(DEFAULT_REGISTRY_PATH, 'utf8')) as { sources: Array<{ id: string }> };
  const next = Math.max(0, ...registry.sources.map(source => Number(/^SRC-(\d{3})$/.exec(source.id)?.[1] ?? 0))) + 1;
  return `SRC-${String(next).padStart(3, '0')}`;
};

export const listProposals = async (): Promise<string[]> => {
  try { return (await readdir(PROPOSALS_DIR)).filter(name => name.endsWith('.json')); } catch { return []; }
};

/**
 * Keep what a dry run fetched and found as a test: test/sites/<slug>/ holds
 * the entry, the pages as they were, and what was read from them on that
 * day. sites.test.ts replays every such folder with the clock set back to
 * the capture, so a parser change that breaks a site fails by name. Trim
 * pages.json by hand to a few events before committing it — the test only
 * compares what the trimmed pages still yield once `expected.json` is
 * regenerated with --expect-only.
 */
export const saveSiteFixture = async (source: SourceDefinition, directory: string, options: { expectOnly: boolean }) => {
  await mkdir(directory, { recursive: true });
  const now = new Date().toISOString();
  if (options.expectOnly) {
    const pages = JSON.parse(await readFile(resolve(directory, 'pages.json'), 'utf8')) as { capturedAt: string; pages: Array<{ url: string; mediaType: string; text: string }> };
    const items = await replaySite(source, pages.pages);
    // The clock the test is pinned to is the one these were read under: now, not the day of capture.
    await writeFile(resolve(directory, 'expected.json'), `${JSON.stringify({ now, items }, null, 1)}\n`);
    return { directory, items: items.length };
  }
  const run = await dryRun(source, 10_000);
  const pages = await trimPages(source, run.pages);
  const items = await replaySite(source, pages);
  await writeFile(resolve(directory, 'entry.json'), `${JSON.stringify(source, null, 1)}\n`);
  await writeFile(resolve(directory, 'pages.json'), `${JSON.stringify({ capturedAt: now, pages }, null, 1)}\n`);
  await writeFile(resolve(directory, 'expected.json'), `${JSON.stringify({ now, items }, null, 1)}\n`);
  return { directory, live: run.all.length, kept: items.length, bytes: JSON.stringify(pages).length };
};

const REDACT_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const REDACT_PHONE = /(?:\+?1[\s().-]*)?\(?[2-9]\d{2}\)?[\s.-]+[2-9]\d{2}[\s.-]+\d{4}|\+1[2-9]\d{9}\b|(?<=tel:)\+?\d{10,11}/g;
const redact = (text: string): string => text.replace(REDACT_EMAIL, 'someone@example.org').replace(REDACT_PHONE, '808-555-0100');

const trimJson = (value: unknown, keep: number, depth = 0): unknown => {
  if (Array.isArray(value)) return value.slice(0, keep).map(item => trimJson(item, keep, depth + 1));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    // An object used as a list (keyed by slug or by date) is trimmed like one.
    const listLike = entries.length > 12 && entries.every(([, inner]) => inner && typeof inner === 'object');
    return Object.fromEntries((listLike ? entries.slice(0, keep) : entries).map(([key, inner]) => [key, trimJson(inner, keep, depth + 1)]));
  }
  return typeof value === 'string' && value.length > 1_500 ? `${value.slice(0, 1_500)}…` : value;
};

/** The indexes of the `selectors.item` elements on a page that yield an event. */
const producingItems = async (source: SourceDefinition, page: { url: string; mediaType: string; text: string }): Promise<Set<number>> => {
  const result = await new LiveSourceAdapter(source.adapterKind).extract({
    bytes: new TextEncoder().encode(JSON.stringify({ pages: [page] })),
    mediaType: 'application/vnd.matchbook.source-pages+json', sourceUrl: source.publisherUrl, statusCode: 200, responseHeaders: {},
  }, source);
  return new Set(result.items.map(item => Number(/\[(\d+)\]$/.exec(item.evidence[0]?.locator ?? '')?.[1])).filter(Number.isInteger));
};

/**
 * Captured pages cut down to a fixture: the pages and rows that yield events
 * (and a couple that do not, so a filter is proved too), no scripts or
 * styles, and no one's email address or phone number — a fixture is
 * committed, and a calendar's submitters did not agree to that.
 */
export const trimPages = async (source: SourceDefinition, pages: Array<{ url: string; mediaType: string; text: string }>, keep = 4) => {
  const yielding: typeof pages = [];
  for (const page of pages) {
    if (yielding.length >= 3) break;
    if ((await replaySite(source, [page])).length) yielding.push(page);
  }
  const today = new Date(Date.now() - 10 * 3_600_000).toISOString().slice(0, 10).replaceAll('-', '');
  return Promise.all((yielding.length ? yielding : pages.slice(0, 1)).map(async page => {
    let text = page.text;
    if (/json|octet-stream/.test(page.mediaType) || /^\s*[[{]/.test(text)) {
      try { text = JSON.stringify(trimJson(JSON.parse(text), keep)); } catch { /* not JSON after all */ }
    } else if (/calendar/.test(page.mediaType)) {
      const [head = '', ...events] = text.split(/(?=BEGIN:VEVENT)/);
      // The events that can still happen: a rule, or a start that is not past.
      const live = events.filter(event => /\nRRULE:/.test(event) || (/\nDTSTART[^:]*:(\d{8})/.exec(event)?.[1] ?? '') >= today);
      const kept = [...live.slice(0, keep * 2), ...events.filter(event => !live.includes(event)).slice(0, 2)].join('');
      text = `${head}${kept}${/END:VCALENDAR/.test(kept) ? '' : 'END:VCALENDAR\r\n'}`;
    } else if (/xml|rss|atom/.test(page.mediaType)) {
      const $ = load(text, { xmlMode: true });
      $('item, entry').slice(keep).remove();
      text = $.xml();
    } else if (/html/.test(page.mediaType)) {
      const config = source.adapterConfig as { selectors?: { item?: string }; records?: { htmlJson?: unknown } };
      const producing = config.selectors?.item ? await producingItems(source, page) : new Set<number>();
      const $ = load(text);
      if (config.selectors?.item) {
        let spare = 2;
        let kept = 0;
        $(config.selectors.item).each((index, element) => {
          if (producing.has(index) && kept < keep * 2) { kept += 1; return; }
          if (!producing.has(index) && spare > 0) { spare -= 1; return; }
          $(element).remove();
        });
      }
      if (!config.records?.htmlJson) $('script:not([type="application/ld+json"])').remove();
      $('style, svg, noscript, link, meta, iframe, img, picture, source, input, select, header nav, footer').remove();
      $('*').contents().filter((_index, node) => node.type === 'comment').remove();
      $('[style]').removeAttr('style');
      text = $.html().replace(/\n\s*\n+/g, '\n').replace(/[ \t]{2,}/g, ' ');
    }
    return { url: page.url, mediaType: page.mediaType, text: redact(text) };
  }));
};

/** What the parser reads from stored pages — the half of a run that needs no network. */
export const replaySite = async (source: SourceDefinition, pages: Array<{ url: string; mediaType: string; text: string }>) => {
  const result = await new LiveSourceAdapter(source.adapterKind).extract({
    bytes: new TextEncoder().encode(JSON.stringify({ pages })),
    mediaType: 'application/vnd.matchbook.source-pages+json',
    sourceUrl: source.publisherUrl,
    statusCode: 200,
    responseHeaders: {},
  }, source);
  return result.items.map(item => item.normalizedFields)
    .sort((a, b) => `${a.localStart ?? ''}${a.title}`.localeCompare(`${b.localStart ?? ''}${b.title}`))
    .map(fields => ({ start: fields.localStart, end: fields.localEnd, title: fields.title, location: fields.location, status: fields.realityStatus }));
};

