import { load } from 'cheerio';
import { LiveSourceAdapter } from './adapters/live-source.js';
import { SourceDefinitionSchema, type HttpPolicy, type SourceDefinition } from './contracts.js';
import { SafeHttpClient, SafeHttpError } from './safe-http-client.js';
import { fetchSourceArtifact } from './source-execution.js';
import { findDates, kauaiToday } from './text-dates.js';
import { decodeBytes, repairMojibake } from './text-repair.js';

/**
 * Looking a site over the way a careful person would before adding it to the
 * register: may we (robots.txt, the terms of use), is there anything there
 * (upcoming events, counted), and how would a machine read it (a feed, an
 * API, schema.org, or the page itself). In September 2026 that work was done
 * by hand for sixty-five sites; this is the same checklist, in the same
 * order, without the hands. It proposes and never enables: the register's
 * rule that somebody puts their name to a source stays a person's.
 *
 * It does not work around a refusal. A site that answers a plain,
 * identified request with 403 has said no, whatever its robots.txt says.
 */
export const REGISTER_USER_AGENT = 'MatchBookCommunityRegister/0.2 (+https://christianjoudon.github.io/work/matchbook.html)';
const AGENT_TOKEN = 'matchbookcommunityregister';

const PROBE_MEDIA = ['text/html', 'text/plain', 'application/json', 'text/calendar', 'application/xml', 'text/xml',
  'application/rss+xml', 'application/atom+xml', 'application/ld+json', 'application/octet-stream', 'text/javascript'];

type RobotsGroup = { agents: string[]; rules: Array<{ allow: boolean; pattern: string }>; crawlDelay?: number };

export const parseRobots = (text: string): RobotsGroup[] => {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [key, value] = [match[1]!.toLowerCase(), match[2]!.trim()];
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'crawl-delay' && Number.isFinite(Number(value))) current.crawlDelay = Number(value);
  }
  return groups;
};

const robotsPattern = (pattern: string): RegExp => new RegExp(`^${pattern
  .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  .replace(/\*/g, '.*')
  .replace(/\\\$$/, '$')}`);

/** Whether our crawler may fetch a path: its own group if the file names it, else "*"; the longest matching rule wins, Allow on a tie. */
export const robotsAllows = (groups: RobotsGroup[], pathAndQuery: string): { allowed: boolean; crawlDelay?: number; rule?: string } => {
  const group = groups.find(candidate => candidate.agents.some(agent => agent !== '*' && AGENT_TOKEN.includes(agent)))
    ?? groups.find(candidate => candidate.agents.includes('*'));
  if (!group) return { allowed: true };
  const hit = group.rules
    .filter(rule => robotsPattern(rule.pattern).test(pathAndQuery))
    .sort((a, b) => b.pattern.length - a.pattern.length || Number(b.allow) - Number(a.allow))[0];
  return {
    allowed: hit ? hit.allow : true,
    ...(group.crawlDelay !== undefined ? { crawlDelay: group.crawlDelay } : {}),
    ...(hit ? { rule: `${hit.allow ? 'Allow' : 'Disallow'}: ${hit.pattern}` } : {}),
  };
};

/** A place on Kauaʻi, by name or by ZIP code. */
const KAUAI = /kaua[ʻ'’‘`]?i|l[iī]hu[ʻ'’‘`]?e|kapa[ʻ'’‘`]?a\b|hanalei|princeville|k[iī]lauea|k[oō]loa|po[ʻ'’‘`]?ip[uū]|waimea|hanap[eē]p[eē]|kekaha|anahola|wailua|kal[aā]heo|l[aā]wa[ʻ'’‘`]?i|[ʻ'’‘`]?ele[ʻ'’‘`]?ele|hanam[aā][ʻ'’‘`]?ulu|n[aā]wiliwili|kalapaki|k[oō]ke[ʻ'’‘`]?e|h[aā][ʻ'’‘`]?ena|\b967(?:03|05|14|15|16|22|41|46|47|51|52|54|56|65|66|69|96)\b/i;

const FORBIDS = /(?:may\s+not|shall\s+not|must\s+not|not\s+permitted|prohibit\w*|agree\s+not\s+to|without\s+(?:our\s+)?(?:prior\s+)?(?:express\s+)?(?:written\s+)?(?:consent|permission))[^.]{0,220}?(?:scrap\w+|crawl\w*|spider\w*|\brobots?\b|\bbots?\b|automated\s+(?:means|access|system\w*|quer\w+)|data\s+min\w+|harvest\w*)|(?:scrap\w+|crawl\w*|spider\w*|automated\s+(?:means|access|system\w*)|data\s+min\w+)[^.]{0,160}?(?:is|are)\s+(?:strictly\s+)?prohibited/i;

export type ProbeFinding = {
  kind: SourceDefinition['adapterKind'];
  feedUrl: string;
  upcoming: number;
  samples: string[];
  note: string;
  entry: SourceDefinition;
};

export type ProbeReport = {
  url: string;
  host: string;
  reachable: boolean;
  refusal?: string;
  robots: 'allowed' | 'disallowed' | 'no-robots' | 'unknown';
  robotsRule?: string;
  crawlDelaySeconds?: number;
  terms: 'none-found' | 'forbids-automation';
  termsUrl?: string;
  termsExcerpt?: string;
  platform?: string;
  findings: ProbeFinding[];
  best?: ProbeFinding;
  onKauai?: boolean;
  verdict: 'ready' | 'nothing-upcoming' | 'no-readable-feed' | 'not-permitted' | 'refused' | 'off-island';
};

const slugOf = (host: string): string => host.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

const policyFor = (hosts: string[], delayMs: number): HttpPolicy => ({
  allowedHosts: [...new Set(hosts)],
  allowedRedirectHosts: [...new Set(hosts.flatMap(host => [host.replace(/^www\./, ''), `www.${host.replace(/^www\./, '')}`]))],
  allowedMediaTypes: PROBE_MEDIA,
  timeoutMs: 20_000,
  maxResponseBytes: 12_000_000,
  maxRedirects: 3,
  minimumDelayMs: delayMs,
});

const baseEntry = (page: URL, title: string, delayMs: number): Omit<SourceDefinition, 'adapterKind' | 'adapterConfig' | 'endpoints' | 'parser' | 'fieldAllowlist'> => ({
  id: 'SRC-000',
  slug: slugOf(page.hostname),
  displayName: title || page.hostname,
  publisherName: title || page.hostname,
  publisherUrl: page.toString(),
  tier: 'C',
  trust: 'OFFICIAL_ORGANIZER',
  permission: 'PROBE_REQUIRED',
  contentKinds: ['event', 'venue', 'organization'],
  polling: { intervalMinutes: 720, jitterPercent: 15, lookBackDays: 7, lookAheadDays: 120, maxPages: 10, maxItems: 1000 },
  httpPolicy: { ...policyFor([page.hostname], delayMs), allowedMediaTypes: ['text/html'], maxResponseBytes: 10_000_000, maxRedirects: 2 },
  authorityByField: { title: 'OFFICIAL_ORGANIZER', start: 'OFFICIAL_ORGANIZER', location: 'OFFICIAL_ORGANIZER', status: 'OFFICIAL_ORGANIZER' },
  enabled: false,
  nextRunAt: new Date().toISOString(),
  lastVerifiedAt: new Date().toISOString(),
  steward: 'unassigned',
});

/** Google Calendar ids on a page: an embed's src= parameters, or the base64 ids site builders hide them in. */
const googleCalendarIds = (html: string): string[] => {
  const ids = new Set<string>();
  for (const match of html.matchAll(/calendar\.google\.com\/calendar\/(?:u\/\d\/)?embed\?([^"'\s<>]+)/gi)) {
    for (const src of match[1]!.replaceAll('&amp;', '&').split('&').filter(part => part.startsWith('src='))) {
      const value = decodeURIComponent(src.slice(4));
      ids.add(value.includes('@') ? value : Buffer.from(value, 'base64').toString('utf8'));
    }
  }
  // A calendar drawn by the site's own script through Google's API names its id in the page.
  for (const match of html.matchAll(/calendarId["']?\s*[:=]\s*["']([^"'\s]+@[^"'\s]+)["']|googleapis\.com\/calendar\/v3\/calendars\/([^/"'\s]+)\/events/gi)) {
    ids.add(decodeURIComponent(match[1] ?? match[2]!));
  }
  for (const match of html.matchAll(/data-public-calendar-id="([^"]+)"/gi)) {
    const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
    ids.add(decoded.includes('@') ? decoded : match[1]!);
  }
  return [...ids].filter(id => /@/.test(id) && !/#holiday@/.test(id) && /^[\w.%+#-]+@[\w.-]+$/.test(id));
};

/**
 * The repeated element that carries the dates on a page, if there is one:
 * the elements whose own text has a date are grouped by what they are
 * (tag and classes, under what), and the largest family wins.
 */
export const inferSelectors = (html: string): { item: string; title?: string } | undefined => {
  const $ = load(html);
  $('script, style, noscript, nav, footer, header').remove();
  const families = new Map<string, number>();
  const today = kauaiToday();
  $('body *').each((_index, element) => {
    const node = $(element);
    if (node.children().filter((_i, child) => /^(?:div|li|article|section|tr|ul|ol|table|p)$/.test(child.tagName)).length) return;
    const text = node.text().replace(/\s+/g, ' ').trim();
    if (text.length < 6 || text.length > 400 || !findDates(text, { today }).some(hit => hit.date >= today)) return;
    // Climb to the nearest ancestor that has same-shaped siblings: that is the row.
    let row = node;
    for (let depth = 0; depth < 7; depth += 1) {
      const tag = row.prop('tagName')?.toLowerCase();
      // Classes that name this one element (an id suffix, a position) are no use for finding its siblings.
      const classes = (row.attr('class') ?? '').split(/\s+/)
        .filter(name => name && !/\d{3,}|-[0-9a-f]{5,}$|^(?:is|has)-|^(?:active|current|first|last|odd|even)$/.test(name)).slice(0, 2);
      const selector = `${tag}${classes.map(name => `.${name}`).join('')}`;
      const siblings = row.parent().children(selector).length;
      if (siblings >= 2 && (classes.length || /^(?:li|tr|article|p|h\d)$/.test(tag ?? ''))) {
        const parent = row.parent();
        const parentTag = parent.prop('tagName')?.toLowerCase() ?? '';
        const parentClass = (parent.attr('class') ?? '').split(/\s+/).filter(Boolean)[0];
        const scoped = classes.length ? selector : `${parentTag}${parentClass ? `.${parentClass}` : ''} > ${selector}`;
        families.set(scoped, (families.get(scoped) ?? 0) + 1);
        return;
      }
      if (!row.parent().length || row.parent().is('body')) return;
      row = row.parent();
    }
  });
  const [item] = [...families.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!item) return undefined;
  const first = $(item).first();
  const titleNode = first.find('h1,h2,h3,h4,h5,[class*="title"],[class*="name"],strong,a').filter((_i, node) => $(node).text().trim().length > 3).first();
  const titleTag = titleNode.prop('tagName')?.toLowerCase();
  const titleClass = (titleNode.attr('class') ?? '').split(/\s+/).filter(Boolean)[0];
  return { item, ...(titleTag ? { title: titleClass ? `${titleTag}.${titleClass}` : titleTag } : {}) };
};

const TRIBE_FIELDS = ['id', 'url', 'title', 'description', 'start_date', 'end_date', 'timezone', 'all_day', 'cost', 'venue', 'organizer', 'categories', 'status'];
const ICS_FIELDS = ['UID', 'RECURRENCE-ID', 'DTSTART', 'DTEND', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL', 'RRULE', 'RDATE', 'EXDATE', 'STATUS', 'SEQUENCE', 'DTSTAMP'];
const HTML_FIELDS = ['url', 'title', 'text', 'heading', 'date', 'name', 'description', 'startDate', 'endDate', 'location', 'eventStatus'];

export const probeSite = async (rawUrl: string, options: { client?: SafeHttpClient } = {}): Promise<ProbeReport> => {
  const page = new URL(rawUrl);
  const client = options.client ?? new SafeHttpClient({ userAgent: REGISTER_USER_AGENT });
  const report: ProbeReport = { url: page.toString(), host: page.hostname, reachable: false, robots: 'unknown', terms: 'none-found', findings: [], verdict: 'no-readable-feed' };
  const text = async (url: string, policy: HttpPolicy): Promise<{ body: string; type: string } | undefined> => {
    try {
      const result = await client.fetch({ method: 'GET', url }, policy);
      return { body: repairMojibake(decodeBytes(result.bytes, result.responseHeaders['content-type'])), type: result.mediaType };
    } catch (error) {
      if (error instanceof SafeHttpError && /returned (?:401|403|429)/.test(error.message)) report.refusal ??= `${new URL(url).pathname}: ${error.message}`;
      return undefined;
    }
  };

  let policy = policyFor([page.hostname], 1_000);
  const robotsFile = await text(`${page.origin}/robots.txt`, policy);
  const groups = robotsFile && /text\/plain/.test(robotsFile.type) ? parseRobots(robotsFile.body) : [];
  const allows = (url: string) => robotsAllows(groups, `${new URL(url).pathname}${new URL(url).search}`);
  const onPage = allows(page.toString());
  report.robots = !robotsFile ? (report.refusal ? 'unknown' : 'no-robots') : onPage.allowed ? 'allowed' : 'disallowed';
  if (onPage.rule) report.robotsRule = onPage.rule;
  if (onPage.crawlDelay !== undefined) report.crawlDelaySeconds = onPage.crawlDelay;
  const delayMs = Math.max(1_000, (onPage.crawlDelay ?? 1) * 1_000);
  policy = policyFor([page.hostname], delayMs);

  const html = onPage.allowed ? await text(page.toString(), policy) : undefined;
  if (!html) {
    report.verdict = report.refusal ? 'refused' : onPage.allowed ? 'no-readable-feed' : 'not-permitted';
    return report;
  }
  report.reachable = true;
  const $ = load(html.body);
  const title = ($('meta[property="og:site_name"]').attr('content') ?? $('title').first().text()).replace(/\s+/g, ' ').trim().slice(0, 80);
  report.platform = $('meta[name="generator"]').attr('content')
    ?? (/squarespace/i.test(html.body) ? 'Squarespace' : /wix\.com|wixstatic/i.test(html.body) ? 'Wix' : /wp-content|wp-json/i.test(html.body) ? 'WordPress' : undefined) as string;
  if (!report.platform) delete report.platform;

  // Terms of use: the page a footer links to, read for a plain prohibition.
  const termsHref = $('a').filter((_i, a) => /terms|conditions of use|legal notice|acceptable use/i.test($(a).text())).first().attr('href');
  if (termsHref) {
    const termsUrl = new URL(termsHref, page).toString();
    if (new URL(termsUrl).hostname === page.hostname && allows(termsUrl).allowed) {
      const terms = await text(termsUrl, policy);
      const prose = terms ? load(terms.body)('body').text().replace(/\s+/g, ' ') : '';
      const hit = FORBIDS.exec(prose);
      report.termsUrl = termsUrl;
      if (hit) { report.terms = 'forbids-automation'; report.termsExcerpt = hit[0].slice(0, 300); }
    }
  }

  const landing = page;
  const siteBase = baseEntry(page, title, delayMs);
  const attempt = async (entry: SourceDefinition, feedUrl: string, note: string) => {
    const parsed = SourceDefinitionSchema.safeParse(entry);
    if (!parsed.success) return;
    try {
      const artifact = await fetchSourceArtifact(parsed.data, client);
      const result = await new LiveSourceAdapter(parsed.data.adapterKind).extract(artifact, parsed.data);
      const today = kauaiToday();
      const upcoming = result.items.filter(item => `${item.normalizedFields.localStart ?? ''}`.slice(0, 10) >= today);
      const titles = [...new Set(upcoming.map(item => `${item.normalizedFields.title}`))];
      // "Addison: Election Dinner", "Thomas: 2nd Fridays" — a room's booking
      // sheet, with the names of the people who booked it. Public by
      // accident is not public by intent; a person decides.
      const bookings = titles.filter(title => /^[A-Z][a-z]+(?:\s[A-Z]\.?)?:\s/.test(title)).length;
      const caution = titles.length >= 5 && bookings / titles.length > 0.3
        ? ' — CAUTION: many titles read like a person\u2019s name and a booking; this may be a room calendar, not an events calendar' : '';
      report.findings.push({
        kind: parsed.data.adapterKind,
        feedUrl,
        upcoming: upcoming.length,
        samples: titles.slice(0, 5),
        note: `${note}${caution}`,
        entry: parsed.data,
      });
    } catch {
      // A candidate that cannot be fetched or parsed is simply not a finding.
    }
  };

  // What one page offers. The landing page first; then, if that was not where
  // the events are, the pages it points to as its calendar — which is how a
  // person looks a site over.
  const inspect = async (page: URL, $: ReturnType<typeof load>, body: string): Promise<void> => {
    const base = { ...siteBase, publisherUrl: page.toString() };
    // 1. The Events Calendar's REST API.
    const tribe = `${page.origin}/wp-json/tribe/events/v1/events?per_page=50&start_date={START_DATE}&end_date={END_DATE}`;
    if (/wp-content|wp-json/i.test(body) && allows(tribe.replace(/[{}]/g, '')).allowed) {
      await attempt({ ...base, adapterKind: 'TRIBE_REST', adapterConfig: { kind: 'TRIBE_REST', perPage: 50 },
        endpoints: [{ purpose: 'COLLECTION', method: 'GET', urlTemplate: tribe }],
        httpPolicy: { ...base.httpPolicy, allowedMediaTypes: ['application/json'] },
        parser: { parserId: 'tribe-events', parserVersion: '1.0.0', fixtureVersion: kauaiToday() }, fieldAllowlist: TRIBE_FIELDS }, tribe, 'The Events Calendar REST API');
    }

    // 2. Calendar feeds: linked .ics, an iCal export, embedded Google or CalendarWiz calendars.
    const ics = new Set<string>();
    $('a[href], link[href]').each((_i, node) => {
      const href = $(node).attr('href') ?? '';
      if (/\.ics(?:$|\?)|[?&]ical=1|format=ical|^webcal:/i.test(href)) ics.add(new URL(href.replace(/^webcal:/i, 'https:'), page).toString());
    });
    googleCalendarIds(body).forEach(id => ics.add(`https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`));
    for (const match of body.matchAll(/calendarwiz\.com\/calendars\/calendar\.php\?crd=([\w-]+)/gi)) ics.add(`https://www.calendarwiz.com/CalendarWiz_iCal.php?crd=${match[1]}`);
    const feeds = [...ics].filter(url => new URL(url).hostname !== page.hostname || allows(url).allowed).slice(0, 6);
    if (feeds.length) {
      const hosts = [...new Set(feeds.map(url => new URL(url).hostname))];
      await attempt({ ...base, adapterKind: 'ICS', adapterConfig: { kind: 'ICS', materializationDays: 120 },
        endpoints: feeds.map(url => ({ purpose: 'COLLECTION' as const, method: 'GET' as const, urlTemplate: url })),
        httpPolicy: { ...policyFor(hosts, delayMs), allowedMediaTypes: ['text/calendar'], maxResponseBytes: 10_000_000, maxRedirects: 2 },
        polling: { ...base.polling, maxPages: 1, maxItems: 3000 },
        parser: { parserId: 'icalendar', parserVersion: '1.0.0', fixtureVersion: kauaiToday() }, fieldAllowlist: ICS_FIELDS }, feeds.join(' '),
      hosts.includes('calendar.google.com') ? 'public Google Calendar subscription feed (its owner embeds it on this page)' : 'iCalendar feed');
    }

    // 3. RSS or Atom.
    const rss = $('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]').map((_i, node) => $(node).attr('href')).get()
      .map(href => new URL(href, page).toString()).filter(url => new URL(url).hostname === page.hostname && allows(url).allowed && !/comments/i.test(url))[0];
    if (rss) {
      await attempt({ ...base, adapterKind: 'RSS_ATOM', adapterConfig: { kind: 'RSS_ATOM', identityField: 'link' },
        endpoints: [{ purpose: 'COLLECTION', method: 'GET', urlTemplate: rss }],
        httpPolicy: { ...base.httpPolicy, allowedMediaTypes: ['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml'] },
        parser: { parserId: 'rss-prose-dates', parserVersion: '1.0.0', fixtureVersion: kauaiToday() }, fieldAllowlist: ['title', 'link', 'published', 'date'] }, rss, 'posts that announce events; dates read from the text');
    }

    // 4. schema.org Event, on the page or on the pages it links to.
    const detail = $('a[href]').map((_i, a) => $(a).attr('href')).get()
      .find(href => /\/(?:events?|event-details|calendar|community-calendar)\/[^/?#]+/i.test(href ?? ''));
    const detailSelector = detail ? `a[href*='${/\/((?:events?|event-details|calendar|community-calendar))\//i.exec(detail)![0]}']` : 'a[href*="/event"]';
    await attempt({ ...base, adapterKind: 'JSON_LD_HTML', adapterConfig: { kind: 'JSON_LD_HTML', detailLinkSelector: detailSelector },
      endpoints: [{ purpose: 'COLLECTION', method: 'GET', urlTemplate: page.toString() }],
      polling: { ...base.polling, maxPages: 6 },
      parser: { parserId: 'jsonld-event-detail', parserVersion: '1.0.0', fixtureVersion: kauaiToday() }, fieldAllowlist: HTML_FIELDS }, page.toString(), 'schema.org Event in the page or its event pages');

    // 5. The page itself, by the repeated element that carries its dates.
    const selectors = inferSelectors(body);
    if (selectors) {
      await attempt({ ...base, adapterKind: 'SOURCE_HTML',
        adapterConfig: { kind: 'SOURCE_HTML', detailLinkSelector: 'a', sitemap: false, followDetails: false, selectors },
        endpoints: [{ purpose: 'COLLECTION', method: 'GET', urlTemplate: page.toString() }],
        parser: { parserId: 'mapped-html', parserVersion: '1.0.0', fixtureVersion: kauaiToday() }, fieldAllowlist: HTML_FIELDS }, page.toString(),
      `server-rendered list; selectors inferred (${selectors.item}${selectors.title ? ` / ${selectors.title}` : ''}) — check them`);
    }

  };

  await inspect(landing, $, html.body);
  if (!report.findings.some(finding => finding.upcoming > 0)) {
    const elsewhere = [...new Set($('a[href]').toArray()
      .filter(a => /event|calendar|what.?s\s?(?:on|happening)|happenings|schedule|classes|workshops|shows|concerts|performances/i.test(`${$(a).text()} ${$(a).attr('href')}`))
      .map(a => { try { return new URL($(a).attr('href') ?? '', landing).toString().split('#')[0]!; } catch { return ''; } })
      .filter(url => url && new URL(url).hostname === landing.hostname && url !== landing.toString() && allows(url).allowed
        && !/\.(?:pdf|jpe?g|png|ics)(?:$|\?)|\/(?:tag|category|author)\//i.test(url)))].slice(0, 3);
    for (const url of elsewhere) {
      const linked = await text(url, policy);
      if (linked && /html/.test(linked.type)) await inspect(new URL(url), load(linked.body), linked.body);
      if (report.findings.some(finding => finding.upcoming > 0)) break;
    }
  }

  // A structured feed is better evidence than a page read by inference, so it
  // wins unless the page found far more.
  const rank: Record<string, number> = { TRIBE_REST: 5, ICS: 4, JSON_LD_HTML: 3, RSS_ATOM: 2, SOURCE_HTML: 1 };
  const [best] = report.findings.filter(finding => finding.upcoming > 0)
    .sort((a, b) => (b.upcoming >= a.upcoming * 3 ? 1 : a.upcoming >= b.upcoming * 3 ? -1 : (rank[b.kind] ?? 0) - (rank[a.kind] ?? 0)));
  if (best) report.best = best;
  // An organiser's site that never names a place on the island is somebody else's island.
  report.onKauai = KAUAI.test(load(html.body)('body').text()) || report.findings.some(finding => finding.samples.some(sample => KAUAI.test(sample)));
  if (best && !report.onKauai) { delete report.best; report.verdict = 'off-island'; return report; }
  report.verdict = report.terms === 'forbids-automation' ? 'not-permitted'
    : best ? 'ready'
      : report.findings.length ? 'nothing-upcoming' : 'no-readable-feed';
  return report;
};
